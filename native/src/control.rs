//! Bounded stdio controller with an independent reader, response writer, and one Win32 worker.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{self, BufReader, Read, Write};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::thread;
use std::time::{Duration, Instant};

use crate::content::{ContentStore, PayloadType, PreparedContent, StageData, StageError};
use crate::paste::{JobGate, PasteOutcome, PasteSpec, PasteSpecError, run_paste};
use crate::platform::{NativePlatform, PhysicalKey, PlatformError, WindowIdentity, WritePayload};
use crate::protocol::{
    NativeResult, Request, RequestKind, ResultStatus, Target, TriggerKey, decode_request,
    read_frame, write_result,
};

const EVENT_CAPACITY: usize = 2;
const OUTPUT_CAPACITY: usize = 3;
const MAX_REQUEST_IDS: usize = 4096;
const RESULT_CACHE_SIZE: usize = MAX_REQUEST_IDS;
const SELECTION_WINDOW: Duration = Duration::from_millis(500);

#[derive(Debug)]
pub enum ControlError {
    Io(io::Error),
    Protocol,
    WorkerUnavailable,
    OutputBackpressure,
    Internal(&'static str),
}

impl From<io::Error> for ControlError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl std::fmt::Display for ControlError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Io(_) => "io_error",
            Self::Protocol => "protocol_error",
            Self::WorkerUnavailable => "worker_unavailable",
            Self::OutputBackpressure => "output_backpressure",
            Self::Internal(_) => "internal_error",
        })
    }
}

impl std::error::Error for ControlError {}

enum Event {
    Frame(Vec<u8>),
    InputClosed,
    InputFailed,
    OutputFlushed(u64),
    OutputFailed,
    WorkerFinished(WorkerReply),
    WorkerExited,
}

struct OutputMessage {
    id: u64,
    result: NativeResult,
}

enum WorkerCommand {
    Capture(Request),
    Write {
        request: Request,
        payload: WritePayload,
        baseline: u32,
        trigger_keys: Vec<TriggerKey>,
        release_deadline: Instant,
        absolute_deadline_tick_ms: Option<u64>,
        selection_check_only: bool,
        gate: JobGate,
    },
    Paste {
        request: Request,
        spec: PasteSpec,
        target: Target,
        gate: JobGate,
    },
}

enum WorkerReply {
    Captured {
        request: Request,
        result: Result<Option<WindowIdentity>, PlatformError>,
    },
    Written {
        request: Request,
        result: WriteOutcome,
    },
    Pasted {
        request: Request,
        target: Target,
        outcome: PasteOutcome,
    },
}

enum WriteOutcome {
    Cancelled,
    KeyHeld,
    DeadlineExpired,
    Finished(Result<u32, PlatformError>),
}

struct ActiveJob {
    id: String,
    generation: String,
    register_request_id: String,
    selection_started: Instant,
    selection_deadline_tick_ms: Option<u64>,
    selection_check_only: bool,
    gate: JobGate,
    prepared: Option<PreparedContent>,
    write_attempted: bool,
    clipboard_sequence: Option<u32>,
    trigger_keys: Option<Vec<TriggerKey>>,
    terminal_queued: bool,
}

enum InFlight {
    Capture,
    Write(String),
    Paste(String),
}

enum FlushAction {
    ContentAck(String),
    ReleaseJob(String),
    FatalReleaseJob(String),
}

struct Controller {
    instance_id: String,
    store: ContentStore,
    generation: Option<String>,
    // Each admitted generation consumes a unique request ID, so this history is
    // bounded by MAX_REQUEST_IDS for the lifetime of the helper.
    seen_generations: HashSet<String>,
    active: Option<ActiveJob>,
    in_flight: Option<InFlight>,
    in_flight_request_id: Option<String>,
    request_ids: HashSet<String>,
    cached: HashMap<String, NativeResult>,
    cache_order: VecDeque<String>,
    flush_actions: HashMap<u64, FlushAction>,
    next_output_id: u64,
    cancel_deadline: Option<Instant>,
    pending_content_ack: Option<String>,
}

/// Runs the helper protocol. Platform work never runs on the input or output thread.
pub fn run<P, R, W>(
    instance_id: String,
    helper_pid: u32,
    helper_process_created_at: u64,
    stable_profile_id: String,
    platform: P,
    input: R,
    output: W,
) -> Result<(), ControlError>
where
    P: NativePlatform,
    R: Read + Send + 'static,
    W: Write + Send + 'static,
{
    let (events_tx, events_rx) = mpsc::sync_channel(EVENT_CAPACITY);
    let (output_tx, output_rx) = mpsc::sync_channel(OUTPUT_CAPACITY);
    spawn_output_writer(output, output_rx, events_tx.clone())?;

    let (worker_tx, worker_rx) = mpsc::sync_channel(1);
    let worker_events = events_tx.clone();
    thread::Builder::new()
        .name("clipnest-win32-worker".into())
        .spawn(move || {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                worker_loop(platform, worker_rx, worker_events.clone());
            }))
            .is_err()
            {
                let _ = worker_events.send(Event::WorkerExited);
            }
        })?;

    output_tx
        .try_send(OutputMessage {
            id: 0,
            result: NativeResult::ready(instance_id.clone(), helper_pid, helper_process_created_at),
        })
        .map_err(|_| ControlError::OutputBackpressure)?;
    match events_rx
        .recv()
        .map_err(|_| ControlError::WorkerUnavailable)?
    {
        Event::OutputFlushed(0) => {}
        Event::OutputFailed => {
            return Err(ControlError::Io(io::Error::other("stdout write failed")));
        }
        _ => return Err(ControlError::Internal("unexpected startup event")),
    }

    let reader_events = events_tx.clone();
    thread::Builder::new()
        .name("clipnest-stdin-reader".into())
        .spawn(move || {
            input_loop(input, reader_events);
        })?;

    let mut controller = Controller::new(instance_id, stable_profile_id);
    let mut deferred_content: Option<Request> = None;
    loop {
        let event = if let Some(deadline) = controller.cancel_deadline {
            events_rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(|_| ControlError::WorkerUnavailable)?
        } else {
            events_rx
                .recv()
                .map_err(|_| ControlError::WorkerUnavailable)?
        };
        if controller
            .cancel_deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(ControlError::WorkerUnavailable);
        }
        match event {
            Event::Frame(frame) => {
                let request = decode_request(&frame, &controller.instance_id)
                    .map_err(|_| ControlError::Protocol)?;
                if controller.pending_content_ack.is_some() && is_content_request(&request) {
                    if deferred_content.as_ref().is_some_and(|deferred| {
                        deferred.envelope.request_id == request.envelope.request_id
                    }) {
                        // Coalesce retries of the one deferred frame. Its original result will
                        // satisfy every retry after the preceding content ACK is flushed.
                    } else if deferred_content.is_none() {
                        deferred_content = Some(request);
                    } else {
                        // Route other frames through normal request-ID accounting. ContentStore
                        // returns a bounded Busy/awaiting_ack result without mutating its state.
                        controller.handle(request, &worker_tx, &output_tx)?;
                    }
                } else {
                    controller.handle(request, &worker_tx, &output_tx)?;
                }
            }
            Event::OutputFlushed(id) => {
                controller.output_flushed(id)?;
                if controller.pending_content_ack.is_none() {
                    if let Some(request) = deferred_content.take() {
                        controller.handle(request, &worker_tx, &output_tx)?;
                    }
                }
            }
            Event::WorkerFinished(reply) => {
                controller.worker_finished(reply, &worker_tx, &output_tx)?
            }
            Event::InputClosed => {
                if let Some(job) = controller.active.as_ref() {
                    job.gate.cancel();
                }
                return Ok(());
            }
            Event::InputFailed => return Err(ControlError::Protocol),
            Event::OutputFailed => {
                return Err(ControlError::Io(io::Error::other("stdout write failed")));
            }
            Event::WorkerExited => return Err(ControlError::WorkerUnavailable),
        }
    }
}

fn input_loop<R: Read>(input: R, events: SyncSender<Event>) {
    let mut reader = BufReader::with_capacity(8 * 1024, input);
    loop {
        match read_frame(&mut reader) {
            Ok(Some(frame)) => {
                if events.send(Event::Frame(frame)).is_err() {
                    return;
                }
            }
            Ok(None) => {
                let _ = events.send(Event::InputClosed);
                return;
            }
            Err(_) => {
                let _ = events.send(Event::InputFailed);
                return;
            }
        }
    }
}

fn spawn_output_writer<W: Write + Send + 'static>(
    output: W,
    messages: Receiver<OutputMessage>,
    events: SyncSender<Event>,
) -> io::Result<()> {
    thread::Builder::new()
        .name("clipnest-stdout-writer".into())
        .spawn(move || {
            let mut writer = output;
            while let Ok(message) = messages.recv() {
                match write_result(&mut writer, &message.result) {
                    Ok(()) => {
                        if events.send(Event::OutputFlushed(message.id)).is_err() {
                            return;
                        }
                    }
                    Err(_) => {
                        let _ = events.send(Event::OutputFailed);
                        return;
                    }
                }
            }
        })
        .map(|_| ())
}

fn absolute_selection_deadline_expired<P: NativePlatform>(
    platform: &mut P,
    deadline_tick_ms: u64,
) -> bool {
    let now = platform.tick_count_ms();
    now >= deadline_tick_ms
        || deadline_tick_ms.saturating_sub(now) > SELECTION_WINDOW.as_millis() as u64
}

fn expired_write_deadline<P: NativePlatform>(
    platform: &mut P,
    relative_deadline: Instant,
    absolute_deadline_tick_ms: Option<u64>,
) -> Option<WriteOutcome> {
    if absolute_deadline_tick_ms
        .is_some_and(|deadline| absolute_selection_deadline_expired(platform, deadline))
    {
        Some(WriteOutcome::DeadlineExpired)
    } else if Instant::now() >= relative_deadline {
        Some(WriteOutcome::KeyHeld)
    } else {
        None
    }
}

fn write_release_keys(trigger_keys: &[TriggerKey]) -> Vec<PhysicalKey> {
    let mut keys: Vec<PhysicalKey> = trigger_keys
        .iter()
        .map(|key| match key {
            TriggerKey::Enter => PhysicalKey::Enter,
            TriggerKey::V => PhysicalKey::V,
        })
        .collect();
    keys.extend([
        PhysicalKey::LeftControl,
        PhysicalKey::RightControl,
        PhysicalKey::LeftAlt,
        PhysicalKey::RightAlt,
        PhysicalKey::LeftShift,
        PhysicalKey::RightShift,
        PhysicalKey::LeftWindows,
        PhysicalKey::RightWindows,
    ]);
    keys
}

fn write_keys_released<P: NativePlatform>(
    platform: &mut P,
    trigger_keys: &[TriggerKey],
) -> Result<bool, PlatformError> {
    for key in write_release_keys(trigger_keys) {
        if platform.is_key_down(key)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn wait_for_write_key_release<P: NativePlatform>(
    platform: &mut P,
    trigger_keys: &[TriggerKey],
    relative_deadline: Instant,
    absolute_deadline_tick_ms: Option<u64>,
    selection_check_only: bool,
    gate: &JobGate,
) -> Result<(), WriteOutcome> {
    if selection_check_only {
        if gate.cancelled() {
            return Err(WriteOutcome::Cancelled);
        }
        return match write_keys_released(platform, trigger_keys) {
            Ok(true) => Ok(()),
            Ok(false) => Err(WriteOutcome::KeyHeld),
            Err(error) => Err(WriteOutcome::Finished(Err(error))),
        };
    }

    let keys = write_release_keys(trigger_keys);
    loop {
        if gate.cancelled() {
            return Err(WriteOutcome::Cancelled);
        }
        if let Some(outcome) =
            expired_write_deadline(platform, relative_deadline, absolute_deadline_tick_ms)
        {
            return Err(outcome);
        }

        let mut held = false;
        for key in &keys {
            match platform.is_key_down(*key) {
                Ok(is_down) => held |= is_down,
                Err(error) => return Err(WriteOutcome::Finished(Err(error))),
            }
        }
        if let Some(outcome) =
            expired_write_deadline(platform, relative_deadline, absolute_deadline_tick_ms)
        {
            return Err(outcome);
        }
        if !held {
            return Ok(());
        }

        let relative_remaining = relative_deadline.saturating_duration_since(Instant::now());
        let absolute_remaining = absolute_deadline_tick_ms.map(|deadline| {
            Duration::from_millis(deadline.saturating_sub(platform.tick_count_ms()))
        });
        if absolute_remaining.is_some_and(|remaining| remaining.is_zero()) {
            return Err(WriteOutcome::DeadlineExpired);
        }
        if relative_remaining.is_zero() {
            return Err(WriteOutcome::KeyHeld);
        }
        let remaining = absolute_remaining
            .map(|absolute| absolute.min(relative_remaining))
            .unwrap_or(relative_remaining);
        thread::sleep(Duration::from_millis(5).min(remaining));
    }
}

fn worker_loop<P: NativePlatform>(
    mut platform: P,
    commands: Receiver<WorkerCommand>,
    events: SyncSender<Event>,
) {
    while let Ok(command) = commands.recv() {
        let reply = match command {
            WorkerCommand::Capture(request) => WorkerReply::Captured {
                request,
                result: platform.foreground_window(),
            },
            WorkerCommand::Write {
                request,
                payload,
                baseline,
                trigger_keys,
                release_deadline,
                absolute_deadline_tick_ms,
                selection_check_only,
                gate,
            } => WorkerReply::Written {
                request,
                result: match wait_for_write_key_release(
                    &mut platform,
                    &trigger_keys,
                    release_deadline,
                    absolute_deadline_tick_ms,
                    selection_check_only,
                    &gate,
                ) {
                    Err(outcome) => outcome,
                    Ok(()) => {
                        let expired = if selection_check_only {
                            None
                        } else {
                            expired_write_deadline(
                                &mut platform,
                                release_deadline,
                                absolute_deadline_tick_ms,
                            )
                        };
                        if let Some(outcome) = expired {
                            outcome
                        } else if !gate.begin_clipboard_commit() {
                            WriteOutcome::Cancelled
                        } else if selection_check_only {
                            match write_keys_released(&mut platform, &trigger_keys) {
                                Ok(false) => WriteOutcome::KeyHeld,
                                Err(error) => WriteOutcome::Finished(Err(error)),
                                Ok(true) => WriteOutcome::Finished(
                                    platform.write_clipboard_if_sequence(baseline, &payload),
                                ),
                            }
                        } else {
                            match platform.write_clipboard_if_sequence_before_deadline(
                                baseline,
                                &payload,
                                release_deadline,
                                absolute_deadline_tick_ms,
                            ) {
                                Err(PlatformError::DeadlineExpired) => {
                                    WriteOutcome::DeadlineExpired
                                }
                                result => WriteOutcome::Finished(result),
                            }
                        }
                    }
                },
            },
            WorkerCommand::Paste {
                request,
                spec,
                target,
                gate,
            } => WorkerReply::Pasted {
                request,
                target,
                outcome: run_paste(&mut platform, &spec, &gate),
            },
        };
        if events.send(Event::WorkerFinished(reply)).is_err() {
            return;
        }
    }
    let _ = events.send(Event::WorkerExited);
}

impl Controller {
    fn new(instance_id: String, stable_profile_id: String) -> Self {
        Self {
            store: ContentStore::new_for_profile(instance_id.clone(), stable_profile_id),
            instance_id,
            generation: None,
            seen_generations: HashSet::new(),
            active: None,
            in_flight: None,
            in_flight_request_id: None,
            request_ids: HashSet::new(),
            cached: HashMap::new(),
            cache_order: VecDeque::new(),
            flush_actions: HashMap::new(),
            next_output_id: 1,
            cancel_deadline: None,
            pending_content_ack: None,
        }
    }

    fn handle(
        &mut self,
        request: Request,
        worker: &SyncSender<WorkerCommand>,
        output: &SyncSender<OutputMessage>,
    ) -> Result<(), ControlError> {
        let id = request.envelope.request_id.clone();
        if let Some(result) = self.cached.get(&id).cloned() {
            return self.queue_result(result, None, output).map(|_| ());
        }
        if self.request_ids.contains(&id) {
            if self.in_flight_request_id.as_deref() == Some(id.as_str()) {
                // Do not queue a synthetic duplicate_request result while the original is
                // running. The one eventual result is correlated by this same request ID.
                return Ok(());
            }
            return self
                .respond(
                    &request,
                    ResultStatus::HelperUnavailable,
                    Some("duplicate_request"),
                    None,
                    output,
                )
                .map(|_| ());
        }
        if self.request_ids.len() >= MAX_REQUEST_IDS {
            return Err(ControlError::WorkerUnavailable);
        }
        self.request_ids.insert(id);
        if self.generation.as_deref() != Some(request.envelope.generation.as_str()) {
            let generation = request.envelope.generation.clone();
            if self.seen_generations.contains(&generation) {
                self.respond(
                    &request,
                    ResultStatus::HelperUnavailable,
                    Some("stale_generation"),
                    None,
                    output,
                )?;
                return Ok(());
            }
            if self.generation.is_some()
                && (self.active.is_some()
                    || self.in_flight.is_some()
                    || self.pending_content_ack.is_some())
            {
                self.respond(
                    &request,
                    ResultStatus::Busy,
                    Some("generation_transition_pending"),
                    None,
                    output,
                )?;
                return Ok(());
            }
            self.generation = Some(generation.clone());
            self.seen_generations.insert(generation);
        }

        match &request.kind {
            RequestKind::Capture {} => self.capture(request, worker, output),
            RequestKind::RegisterContent { job_id, .. } => {
                let job_id = job_id.clone();
                self.content(request, &job_id, output)
            }
            RequestKind::ContentChunk { job_id, .. }
            | RequestKind::FinishContent { job_id, .. }
            | RequestKind::Prepare { job_id, .. } => {
                let job_id = job_id.clone();
                self.content(request, &job_id, output)
            }
            RequestKind::CommitWrite {
                job_id,
                prepare_token,
                baseline_clipboard_sequence,
                selection_budget_ms,
                selection_deadline_tick_ms,
                trigger_keys,
            } => {
                let (job_id, prepare_token, baseline, budget_ms, deadline_tick_ms, triggers) = (
                    job_id.clone(),
                    prepare_token.clone(),
                    baseline_clipboard_sequence.clone(),
                    *selection_budget_ms,
                    *selection_deadline_tick_ms,
                    trigger_keys.to_vec(),
                );
                self.commit_write(
                    request,
                    &job_id,
                    &prepare_token,
                    &baseline,
                    budget_ms,
                    deadline_tick_ms,
                    &triggers,
                    worker,
                    output,
                )
            }
            RequestKind::Paste {
                job_id,
                prepare_token,
                host_window,
                target,
                expected_clipboard_sequence,
                trigger_keys,
            } => {
                let (job_id, prepare_token, host, target, sequence, triggers) = (
                    job_id.clone(),
                    prepare_token.clone(),
                    host_window.clone(),
                    target.clone(),
                    expected_clipboard_sequence.clone(),
                    trigger_keys.to_vec(),
                );
                self.paste(
                    request,
                    &job_id,
                    &prepare_token,
                    &host,
                    &target,
                    &sequence,
                    &triggers,
                    worker,
                    output,
                )
            }
            RequestKind::Cancel { job_id } => {
                let job_id = job_id.clone();
                self.cancel(request, job_id.as_deref(), output)
            }
        }
    }

    fn capture(
        &mut self,
        request: Request,
        worker: &SyncSender<WorkerCommand>,
        output: &SyncSender<OutputMessage>,
    ) -> Result<(), ControlError> {
        if self.active.is_some() || self.in_flight.is_some() {
            return self
                .respond(
                    &request,
                    ResultStatus::Busy,
                    Some("worker_busy"),
                    None,
                    output,
                )
                .map(|_| ());
        }
        let request_id = request.envelope.request_id.clone();
        self.in_flight = Some(InFlight::Capture);
        worker
            .try_send(WorkerCommand::Capture(request))
            .map_err(|_| ControlError::WorkerUnavailable)?;
        self.in_flight_request_id = Some(request_id);
        Ok(())
    }

    fn content(
        &mut self,
        request: Request,
        job_id: &str,
        output: &SyncSender<OutputMessage>,
    ) -> Result<(), ControlError> {
        if self.in_flight.is_some() || self.terminal_pending() {
            return self
                .respond(
                    &request,
                    ResultStatus::Busy,
                    Some("worker_busy"),
                    None,
                    output,
                )
                .map(|_| ());
        }
        if matches!(request.kind, RequestKind::RegisterContent { .. }) && self.active.is_some() {
            return self
                .respond(
                    &request,
                    ResultStatus::Busy,
                    Some("active_job"),
                    None,
                    output,
                )
                .map(|_| ());
        }
        let response_id = request.envelope.request_id.clone();
        let result = self.store.process(&request);
        let needs_ack = !matches!(&result, Err(StageError::RequestUnacknowledged));
        let (status, response, failure) = match result {
            Ok(StageData::ContentRegistered {
                job_id,
                object_token,
            }) => {
                if matches!(request.kind, RequestKind::RegisterContent { .. }) {
                    self.active = Some(ActiveJob {
                        id: job_id.clone(),
                        generation: request.envelope.generation.clone(),
                        register_request_id: request.envelope.request_id.clone(),
                        selection_started: Instant::now(),
                        selection_deadline_tick_ms: None,
                        selection_check_only: false,
                        gate: JobGate::new(),
                        prepared: None,
                        write_attempted: false,
                        clipboard_sequence: None,
                        trigger_keys: None,
                        terminal_queued: false,
                    });
                }
                (ResultStatus::ContentRegistered, Some(object_token), None)
            }
            Ok(StageData::ChunkAccepted { job_id, .. }) => {
                let token = self
                    .active
                    .as_ref()
                    .filter(|job| job.id == job_id)
                    .map(|_| match &request.kind {
                        RequestKind::ContentChunk { object_token, .. } => object_token.clone(),
                        _ => String::new(),
                    })
                    .unwrap_or_default();
                (ResultStatus::ChunkAccepted, Some(token), None)
            }
            Ok(StageData::ContentComplete { job_id }) => {
                let token = self
                    .active
                    .as_ref()
                    .filter(|job| job.id == job_id)
                    .map(|_job| match &request.kind {
                        RequestKind::FinishContent { object_token, .. } => object_token.clone(),
                        _ => String::new(),
                    })
                    .unwrap_or_default();
                (ResultStatus::ContentRegistered, Some(token), None)
            }
            Ok(StageData::Prepared(prepared)) => {
                let token = prepared.prepare_token.clone();
                if let Some(job) = self.active.as_mut().filter(|job| job.id == prepared.job_id) {
                    job.prepared = Some(prepared);
                }
                (ResultStatus::Prepared, Some(token), None)
            }
            Ok(StageData::Cancelled { .. }) => (ResultStatus::Cancelled, None, None),
            Err(error) => {
                let (status, reason) = stage_error(error);
                (status, None, Some(reason))
            }
        };
        let mut result = NativeResult::for_request(&request, status);
        if status == ResultStatus::Prepared {
            if let Some(token) = response {
                result = result.with_prepare_token(token);
            }
        } else if matches!(
            status,
            ResultStatus::ContentRegistered | ResultStatus::ChunkAccepted
        ) {
            if let Some(token) = response {
                result = result.with_object_token(token);
            }
        }
        if let Some(reason) = failure {
            result = result.with_reason(reason);
        }
        if status == ResultStatus::Cancelled {
            result = result.with_worker_quiescent(true);
        }
        self.cache_result(&response_id, result.clone());
        let action = needs_ack.then(|| FlushAction::ContentAck(response_id));
        self.queue_result(result, action, output)?;
        if !self.store.has_active_job() && self.active.is_some() {
            self.queue_terminal(output, false)?;
        }
        let _ = job_id;
        Ok(())
    }

    fn commit_write(
        &mut self,
        request: Request,
        job_id: &str,
        prepare_token: &str,
        baseline: &str,
        selection_budget_ms: u16,
        selection_deadline_tick_ms: Option<u64>,
        trigger_keys: &[TriggerKey],
        worker: &SyncSender<WorkerCommand>,
        output: &SyncSender<OutputMessage>,
    ) -> Result<(), ControlError> {
        if self.in_flight.is_some() {
            return self
                .respond(
                    &request,
                    ResultStatus::Busy,
                    Some("worker_busy"),
                    None,
                    output,
                )
                .map(|_| ());
        }
        let Some(job) = self.active.as_mut().filter(|job| job.id == job_id) else {
            return self
                .respond(
                    &request,
                    ResultStatus::PayloadInvalid,
                    Some("unknown_job"),
                    None,
                    output,
                )
                .map(|_| ());
        };
        if job.terminal_queued {
            return self
                .respond(
                    &request,
                    ResultStatus::Busy,
                    Some("job_closing"),
                    None,
                    output,
                )
                .map(|_| ());
        }
        let Some(prepared) = job
            .prepared
            .as_ref()
            .filter(|content| content.prepare_token == prepare_token)
        else {
            return self
                .respond(
                    &request,
                    ResultStatus::PayloadInvalid,
                    Some("prepare_token_mismatch"),
                    None,
                    output,
                )
                .map(|_| ());
        };
        if job.write_attempted {
            return self
                .respond(
                    &request,
                    ResultStatus::Busy,
                    Some("write_already_attempted"),
                    None,
                    output,
                )
                .map(|_| ());
        }
        let Ok(baseline) = baseline.parse::<u32>() else {
            return self
                .respond(
                    &request,
                    ResultStatus::PayloadInvalid,
                    Some("invalid_clipboard_sequence"),
                    None,
                    output,
                )
                .map(|_| ());
        };
        let release_deadline =
            Instant::now() + Duration::from_millis(u64::from(selection_budget_ms));
        job.selection_started = release_deadline - SELECTION_WINDOW;
        job.selection_deadline_tick_ms = selection_deadline_tick_ms;
        job.selection_check_only = selection_budget_ms == 0;
        job.write_attempted = true;
        job.trigger_keys = Some(trigger_keys.to_vec());
        let payload = match prepared.content_type {
            PayloadType::Text => WritePayload::TextUtf8(prepared.bytes.to_vec()),
            PayloadType::Image => WritePayload::ImageDib(prepared.bytes.to_vec()),
        };
        let gate = job.gate.clone();
        let request_id = request.envelope.request_id.clone();
        self.in_flight = Some(InFlight::Write(job_id.to_owned()));
        worker
            .try_send(WorkerCommand::Write {
                request,
                payload,
                baseline,
                trigger_keys: trigger_keys.to_vec(),
                release_deadline,
                absolute_deadline_tick_ms: selection_deadline_tick_ms,
                selection_check_only: selection_budget_ms == 0,
                gate,
            })
            .map_err(|_| ControlError::WorkerUnavailable)?;
        self.in_flight_request_id = Some(request_id);
        Ok(())
    }

    fn paste(
        &mut self,
        request: Request,
        job_id: &str,
        prepare_token: &str,
        host: &Target,
        target: &Target,
        sequence: &str,
        triggers: &[TriggerKey],
        worker: &SyncSender<WorkerCommand>,
        output: &SyncSender<OutputMessage>,
    ) -> Result<(), ControlError> {
        if self.in_flight.is_some() {
            return self
                .respond(
                    &request,
                    ResultStatus::Busy,
                    Some("worker_busy"),
                    None,
                    output,
                )
                .map(|_| ());
        }
        let Some(job) = self.active.as_mut().filter(|job| job.id == job_id) else {
            return self
                .respond(
                    &request,
                    ResultStatus::PayloadInvalid,
                    Some("unknown_job"),
                    None,
                    output,
                )
                .map(|_| ());
        };
        if job.terminal_queued || job.gate.cancelled() {
            return self
                .respond(
                    &request,
                    ResultStatus::Cancelled,
                    Some("job_cancelled"),
                    Some(true),
                    output,
                )
                .map(|_| ());
        }
        if job
            .prepared
            .as_ref()
            .is_none_or(|content| content.prepare_token != prepare_token)
            || job.write_attempted == false
            || job
                .clipboard_sequence
                .is_none_or(|own| sequence.parse::<u32>().ok() != Some(own))
            || job.trigger_keys.as_deref() != Some(triggers)
        {
            return self
                .respond(
                    &request,
                    ResultStatus::PayloadInvalid,
                    Some("paste_binding_mismatch"),
                    None,
                    output,
                )
                .map(|_| ());
        }
        let mut spec = match PasteSpec::from_protocol_with_deadline(
            host,
            target,
            sequence,
            triggers,
            job.selection_started,
            job.selection_deadline_tick_ms,
        ) {
            Ok(spec) => spec,
            Err(PasteSpecError::InvalidTarget) => {
                return self
                    .respond(
                        &request,
                        ResultStatus::TargetInvalid,
                        Some("invalid_target"),
                        None,
                        output,
                    )
                    .map(|_| ());
            }
            Err(PasteSpecError::InvalidClipboardSequence | PasteSpecError::InvalidTriggerKeys) => {
                return self
                    .respond(
                        &request,
                        ResultStatus::PayloadInvalid,
                        Some("invalid_paste_request"),
                        None,
                        output,
                    )
                    .map(|_| ());
            }
        };
        spec.selection_check_only = job.selection_check_only;
        let request_id = request.envelope.request_id.clone();
        self.in_flight = Some(InFlight::Paste(job_id.to_owned()));
        worker
            .try_send(WorkerCommand::Paste {
                request,
                spec,
                target: target.clone(),
                gate: job.gate.clone(),
            })
            .map_err(|_| ControlError::WorkerUnavailable)?;
        self.in_flight_request_id = Some(request_id);
        Ok(())
    }

    fn cancel(
        &mut self,
        request: Request,
        requested_job: Option<&str>,
        output: &SyncSender<OutputMessage>,
    ) -> Result<(), ControlError> {
        let Some(job) = self.active.as_mut() else {
            if self.in_flight.is_some() {
                return self
                    .respond(
                        &request,
                        ResultStatus::Busy,
                        Some("capture_in_progress"),
                        None,
                        output,
                    )
                    .map(|_| ());
            }
            return self
                .respond(&request, ResultStatus::Cancelled, None, Some(true), output)
                .map(|_| ());
        };
        if requested_job != Some(job.id.as_str()) {
            return self
                .respond(
                    &request,
                    ResultStatus::HelperUnavailable,
                    Some("cancel_job_mismatch"),
                    None,
                    output,
                )
                .map(|_| ());
        }
        let accepted = job.gate.cancel();
        let cancelled = accepted || job.gate.cancelled();
        let quiescent = !matches!(self.in_flight, Some(InFlight::Write(ref id) | InFlight::Paste(ref id)) if id == &job.id);
        if accepted && !quiescent {
            self.cancel_deadline = Some(Instant::now() + Duration::from_millis(50));
        }
        let status = if cancelled {
            ResultStatus::Cancelled
        } else {
            ResultStatus::TooLate
        };
        let reason = if cancelled {
            "cancelled"
        } else {
            "input_commit_started"
        };
        let mut result = NativeResult::for_request(&request, status)
            .with_worker_quiescent(quiescent)
            .with_reason(reason);
        if request_job_id(&request).is_none() {
            result = result.with_reason("cancel_job_mismatch");
        }
        self.cache_result(&request.envelope.request_id, result.clone());
        self.queue_result(result, None, output)?;
        if cancelled && quiescent {
            self.queue_terminal(output, false)?;
        }
        Ok(())
    }

    fn worker_finished(
        &mut self,
        reply: WorkerReply,
        worker: &SyncSender<WorkerCommand>,
        output: &SyncSender<OutputMessage>,
    ) -> Result<(), ControlError> {
        let flight = self.in_flight.take().ok_or(ControlError::Internal(
            "worker reply without in-flight task",
        ))?;
        if self.active.as_ref().is_some_and(|job| job.gate.cancelled()) {
            self.cancel_deadline = None;
        }
        match (flight, reply) {
            (InFlight::Capture, WorkerReply::Captured { request, result }) => {
                let mut result = match result {
                    Ok(Some(identity)) => {
                        NativeResult::for_request(&request, ResultStatus::Captured)
                            .with_target(target_for(identity))
                    }
                    Ok(None) | Err(PlatformError::InvalidTarget) => {
                        NativeResult::for_request(&request, ResultStatus::TargetInvalid)
                            .with_reason("no_foreground_target")
                    }
                    Err(_) => NativeResult::for_request(&request, ResultStatus::HelperUnavailable)
                        .with_reason("capture_failed"),
                };
                result = result.with_duration_ms(0.0);
                self.respond_with_result(&request, result, output)?;
            }
            (InFlight::Write(expected), WorkerReply::Written { request, result })
                if request_job_id(&request) == Some(expected.as_str()) =>
            {
                let job_id = expected;
                match result {
                    WriteOutcome::KeyHeld => {
                        let result = NativeResult::for_request(&request, ResultStatus::KeyHeld)
                            .with_reason("trigger_key_held_or_deadline_expired");
                        self.respond_with_result(&request, result, output)?;
                        self.queue_terminal(output, false)?;
                    }
                    WriteOutcome::DeadlineExpired => {
                        let result = NativeResult::for_request(&request, ResultStatus::KeyHeld)
                            .with_reason("selection_deadline_expired");
                        self.respond_with_result(&request, result, output)?;
                        self.queue_terminal(output, false)?;
                    }
                    WriteOutcome::Cancelled => {
                        let result = NativeResult::for_request(&request, ResultStatus::Cancelled)
                            .with_reason("cancelled_before_clipboard_write")
                            .with_worker_quiescent(true);
                        self.respond_with_result(&request, result, output)?;
                        self.queue_terminal(output, false)?;
                    }
                    WriteOutcome::Finished(result) => match result {
                        Ok(sequence) => {
                            if let Some(job) = self.active.as_mut().filter(|job| job.id == job_id) {
                                job.clipboard_sequence = Some(sequence);
                            }
                            let result =
                                NativeResult::for_request(&request, ResultStatus::ClipboardWritten)
                                    .with_clipboard_sequence(sequence);
                            self.respond_with_result(&request, result, output)?;
                            if self.active.as_ref().is_some_and(|job| job.gate.cancelled()) {
                                self.queue_terminal(output, false)?;
                            }
                        }
                        Err(PlatformError::ClipboardChanged) => {
                            let result =
                                NativeResult::for_request(&request, ResultStatus::ClipboardChanged)
                                    .with_reason("baseline_changed");
                            self.respond_with_result(&request, result, output)?;
                            self.queue_terminal(output, false)?;
                        }
                        Err(PlatformError::DeadlineExpired) => {
                            let result = NativeResult::for_request(&request, ResultStatus::KeyHeld)
                                .with_reason("selection_deadline_expired");
                            self.respond_with_result(&request, result, output)?;
                            self.queue_terminal(output, false)?;
                        }
                        Err(PlatformError::ClipboardBusy) => {
                            let result = NativeResult::for_request(
                                &request,
                                ResultStatus::HelperUnavailable,
                            )
                            .with_reason("clipboard_busy");
                            self.respond_with_result(&request, result, output)?;
                            self.queue_terminal(output, false)?;
                        }
                        Err(PlatformError::InvalidTarget) => {
                            let result =
                                NativeResult::for_request(&request, ResultStatus::PayloadInvalid)
                                    .with_reason("invalid_clipboard_payload");
                            self.respond_with_result(&request, result, output)?;
                            self.queue_terminal(output, false)?;
                        }
                        Err(_) => {
                            let result = NativeResult::for_request(
                                &request,
                                ResultStatus::HelperUnavailable,
                            )
                            .with_reason("clipboard_write_failed");
                            self.cache_result(&request.envelope.request_id, result.clone());
                            self.queue_result(result, None, output)?;
                            self.queue_terminal(output, true)?;
                        }
                    },
                }
            }
            (
                InFlight::Paste(expected),
                WorkerReply::Pasted {
                    request,
                    target,
                    outcome,
                },
            ) if request_job_id(&request) == Some(expected.as_str()) => {
                let result = paste_result(&request, target, outcome);
                self.respond_with_result(&request, result, output)?;
                self.queue_terminal(output, false)?;
            }
            _ => {
                return Err(ControlError::Internal(
                    "worker reply does not match active task",
                ));
            }
        }
        self.in_flight_request_id = None;
        let _ = worker;
        Ok(())
    }

    fn output_flushed(&mut self, id: u64) -> Result<(), ControlError> {
        match self.flush_actions.remove(&id) {
            Some(FlushAction::ContentAck(request_id)) => {
                if self.pending_content_ack.as_deref() != Some(request_id.as_str()) {
                    return Err(ControlError::Internal("content ACK order mismatch"));
                }
                self.store
                    .acknowledge(&request_id)
                    .map_err(|_| ControlError::Internal("content ACK order mismatch"))?;
                self.pending_content_ack = None;
            }
            Some(FlushAction::ReleaseJob(job_id)) => self.release_job(&job_id)?,
            Some(FlushAction::FatalReleaseJob(job_id)) => {
                self.release_job(&job_id)?;
                return Err(ControlError::WorkerUnavailable);
            }
            None => {}
        }
        Ok(())
    }

    fn queue_terminal(
        &mut self,
        output: &SyncSender<OutputMessage>,
        fatal: bool,
    ) -> Result<(), ControlError> {
        let Some(job) = self.active.as_mut() else {
            return Ok(());
        };
        if job.terminal_queued {
            return Ok(());
        }
        job.terminal_queued = true;
        let job_id = job.id.clone();
        let finished = NativeResult::job_finished(
            job.register_request_id.clone(),
            job.generation.clone(),
            self.instance_id.clone(),
            job_id.clone(),
        );
        let action = if fatal {
            FlushAction::FatalReleaseJob(job_id)
        } else {
            FlushAction::ReleaseJob(job_id)
        };
        self.queue_result(finished, Some(action), output)
            .map(|_| ())
    }

    fn release_job(&mut self, job_id: &str) -> Result<(), ControlError> {
        let Some(job) = self.active.as_ref().filter(|job| job.id == job_id) else {
            return Err(ControlError::Internal("terminal event for stale job"));
        };
        if self.store.has_active_job() {
            self.store
                .release_job(&job.generation, &self.instance_id, job_id)
                .map_err(|_| ControlError::Internal("content release binding mismatch"))?;
        }
        self.active = None;
        Ok(())
    }

    fn terminal_pending(&self) -> bool {
        self.active.as_ref().is_some_and(|job| job.terminal_queued)
    }

    fn respond(
        &mut self,
        request: &Request,
        status: ResultStatus,
        reason: Option<&'static str>,
        quiescent: Option<bool>,
        output: &SyncSender<OutputMessage>,
    ) -> Result<u64, ControlError> {
        let mut result = NativeResult::for_request(request, status);
        if let Some(reason) = reason {
            result = result.with_reason(reason);
        }
        if let Some(value) = quiescent {
            result = result.with_worker_quiescent(value);
        }
        self.respond_with_result(request, result, output)
    }

    fn respond_with_result(
        &mut self,
        request: &Request,
        result: NativeResult,
        output: &SyncSender<OutputMessage>,
    ) -> Result<u64, ControlError> {
        self.cache_result(&request.envelope.request_id, result.clone());
        self.queue_result(result, None, output)
    }

    fn cache_result(&mut self, request_id: &str, result: NativeResult) {
        if self.cached.contains_key(request_id) {
            return;
        }
        if self.cache_order.len() == RESULT_CACHE_SIZE {
            if let Some(expired) = self.cache_order.pop_front() {
                self.cached.remove(&expired);
            }
        }
        self.cache_order.push_back(request_id.to_owned());
        self.cached.insert(request_id.to_owned(), result);
    }

    fn queue_result(
        &mut self,
        result: NativeResult,
        action: Option<FlushAction>,
        output: &SyncSender<OutputMessage>,
    ) -> Result<u64, ControlError> {
        let id = self.next_output_id;
        self.next_output_id = id.checked_add(1).ok_or(ControlError::OutputBackpressure)?;
        output
            .try_send(OutputMessage { id, result })
            .map_err(|error| match error {
                TrySendError::Full(_) | TrySendError::Disconnected(_) => {
                    ControlError::OutputBackpressure
                }
            })?;
        if let Some(FlushAction::ContentAck(request_id)) = action {
            if self.pending_content_ack.is_some() {
                return Err(ControlError::Internal("multiple content ACKs in flight"));
            }
            self.pending_content_ack = Some(request_id.clone());
            self.flush_actions
                .insert(id, FlushAction::ContentAck(request_id));
        } else if let Some(action) = action {
            self.flush_actions.insert(id, action);
        }
        Ok(id)
    }
}

fn request_job_id(request: &Request) -> Option<&str> {
    match &request.kind {
        RequestKind::RegisterContent { job_id, .. }
        | RequestKind::ContentChunk { job_id, .. }
        | RequestKind::FinishContent { job_id, .. }
        | RequestKind::Prepare { job_id, .. }
        | RequestKind::CommitWrite { job_id, .. }
        | RequestKind::Paste { job_id, .. } => Some(job_id),
        RequestKind::Cancel { job_id } => job_id.as_deref(),
        RequestKind::Capture {} => None,
    }
}

fn is_content_request(request: &Request) -> bool {
    matches!(
        &request.kind,
        RequestKind::RegisterContent { .. }
            | RequestKind::ContentChunk { .. }
            | RequestKind::FinishContent { .. }
            | RequestKind::Prepare { .. }
    )
}

fn stage_error(error: StageError) -> (ResultStatus, &'static str) {
    match error {
        StageError::Busy => (ResultStatus::Busy, "active_job"),
        StageError::CapacityExceeded => (ResultStatus::PayloadInvalid, "capacity_exceeded"),
        StageError::InvalidContent => (ResultStatus::PayloadInvalid, "invalid_content"),
        StageError::OutOfOrder => (ResultStatus::PayloadInvalid, "chunk_out_of_order"),
        StageError::Incomplete => (ResultStatus::PayloadInvalid, "content_incomplete"),
        StageError::StaleItemVersion => (ResultStatus::PayloadInvalid, "stale_item_version"),
        StageError::AlreadyPrepared => (ResultStatus::PayloadInvalid, "already_prepared"),
        StageError::RequestUnacknowledged => (ResultStatus::Busy, "awaiting_ack"),
        StageError::NoActiveJob => (ResultStatus::PayloadInvalid, "no_active_job"),
        StageError::NotContentStage => (ResultStatus::PayloadInvalid, "invalid_stage"),
        StageError::InvalidIdentity => (ResultStatus::PayloadInvalid, "invalid_identity"),
        StageError::WrongHelperInstance => {
            (ResultStatus::HelperUnavailable, "wrong_helper_instance")
        }
        StageError::StaleGeneration => (ResultStatus::HelperUnavailable, "stale_generation"),
        StageError::WrongJob => (ResultStatus::PayloadInvalid, "wrong_job"),
        StageError::StaleObjectToken => (ResultStatus::PayloadInvalid, "stale_object_token"),
        StageError::DuplicateRequest => (ResultStatus::HelperUnavailable, "duplicate_request"),
        StageError::WrongAcknowledgement => (ResultStatus::HelperUnavailable, "ack_mismatch"),
    }
}

fn target_for(identity: WindowIdentity) -> Target {
    Target {
        hwnd: identity.handle.to_string(),
        pid: identity.process_id,
        process_created_at: identity.process_created_at.to_string(),
    }
}

fn paste_result(request: &Request, target: Target, outcome: PasteOutcome) -> NativeResult {
    match outcome {
        PasteOutcome::InputSubmitted => {
            NativeResult::for_request(request, ResultStatus::InputSubmitted)
                .with_inserted_inputs(4)
                .with_target(target)
        }
        PasteOutcome::InputRejected { inserted_inputs } => {
            NativeResult::for_request(request, ResultStatus::InputRejected)
                .with_inserted_inputs(inserted_inputs.min(4) as u8)
                .with_reason("send_input_partial_or_rejected")
        }
        PasteOutcome::Cancelled => NativeResult::for_request(request, ResultStatus::Cancelled)
            .with_reason("cancelled_or_external_foreground")
            .with_worker_quiescent(true),
        PasteOutcome::TargetInvalid => {
            NativeResult::for_request(request, ResultStatus::TargetInvalid)
                .with_reason("target_identity_changed")
        }
        PasteOutcome::FocusDenied => NativeResult::for_request(request, ResultStatus::FocusDenied)
            .with_reason("focus_not_confirmed"),
        PasteOutcome::ClipboardChanged => {
            NativeResult::for_request(request, ResultStatus::ClipboardChanged)
                .with_reason("clipboard_sequence_changed")
        }
        PasteOutcome::KeyHeld => NativeResult::for_request(request, ResultStatus::KeyHeld)
            .with_reason("trigger_or_modifier_held"),
        PasteOutcome::PlatformFailure(_) => {
            NativeResult::for_request(request, ResultStatus::HelperUnavailable)
                .with_reason("platform_call_failed")
        }
    }
}

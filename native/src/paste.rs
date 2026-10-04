use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use crate::platform::{
    ClipboardSequence, InputEvent, KeyState, NativePlatform, PhysicalKey, PlatformError,
    WindowIdentity,
};
use crate::protocol::{Target, TriggerKey};

const FOCUS_WAIT: Duration = Duration::from_millis(250);
const RELEASE_WAIT: Duration = Duration::from_millis(500);
const POLL_INTERVAL: Duration = Duration::from_millis(5);

#[derive(Debug, Clone)]
pub struct PasteSpec {
    pub host_window: WindowIdentity,
    pub target: WindowIdentity,
    pub expected_clipboard_sequence: ClipboardSequence,
    pub trigger_keys: Vec<PhysicalKey>,
    pub selection_started: Instant,
    pub selection_deadline_tick_ms: Option<u64>,
    pub selection_check_only: bool,
}

impl PasteSpec {
    /// Builds the native identity and sequence values from a validated protocol Paste request.
    pub fn from_protocol(
        host_window: &Target,
        target: &Target,
        expected_clipboard_sequence: &str,
        trigger_keys: &[TriggerKey],
        selection_started: Instant,
    ) -> Result<Self, PasteSpecError> {
        Self::from_protocol_with_deadline(
            host_window,
            target,
            expected_clipboard_sequence,
            trigger_keys,
            selection_started,
            None,
        )
    }

    /// Builds a paste spec carrying the same host-wide deadline used by commit_write.
    pub fn from_protocol_with_deadline(
        host_window: &Target,
        target: &Target,
        expected_clipboard_sequence: &str,
        trigger_keys: &[TriggerKey],
        selection_started: Instant,
        selection_deadline_tick_ms: Option<u64>,
    ) -> Result<Self, PasteSpecError> {
        // An empty list represents click execution. The protocol validator also
        // rejects duplicate and contradictory physical triggers before this point.
        if trigger_keys.len() > 1 {
            return Err(PasteSpecError::InvalidTriggerKeys);
        }
        let host_window = parse_target(host_window)?;
        let target = parse_target(target)?;
        let sequence = expected_clipboard_sequence
            .parse::<u32>()
            .map_err(|_| PasteSpecError::InvalidClipboardSequence)?;
        Ok(Self {
            host_window,
            target,
            expected_clipboard_sequence: sequence,
            trigger_keys: trigger_keys
                .iter()
                .map(|key| match key {
                    TriggerKey::Enter => PhysicalKey::Enter,
                    TriggerKey::V => PhysicalKey::V,
                })
                .collect(),
            selection_started,
            selection_deadline_tick_ms,
            selection_check_only: false,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteSpecError {
    InvalidTarget,
    InvalidClipboardSequence,
    InvalidTriggerKeys,
}

fn parse_target(target: &Target) -> Result<WindowIdentity, PasteSpecError> {
    let handle = target
        .hwnd
        .parse::<usize>()
        .map_err(|_| PasteSpecError::InvalidTarget)?;
    let process_created_at = target
        .process_created_at
        .parse::<u64>()
        .map_err(|_| PasteSpecError::InvalidTarget)?;
    if handle == 0 || target.pid == 0 {
        return Err(PasteSpecError::InvalidTarget);
    }
    Ok(WindowIdentity {
        handle,
        process_id: target.pid,
        process_created_at,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobPhase {
    Preparing,
    ClipboardCommit,
    WaitingForFocus,
    WaitingForKeys,
    InputCommit,
    Completed,
    Cancelled,
}

#[derive(Debug)]
struct GateState {
    phase: JobPhase,
    cancelled: bool,
}

/// Coordinates cancellation with one-way clipboard and input commits.
/// No platform call is made while this gate's mutex is held.
#[derive(Debug, Clone)]
pub struct JobGate {
    state: Arc<Mutex<GateState>>,
}

impl Default for JobGate {
    fn default() -> Self {
        Self::new()
    }
}

impl JobGate {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(GateState {
                phase: JobPhase::Preparing,
                cancelled: false,
            })),
        }
    }

    /// Returns true only when this call won the cancellation race.
    pub fn cancel(&self) -> bool {
        let mut state = self.lock();
        if state.cancelled || matches!(state.phase, JobPhase::InputCommit | JobPhase::Completed) {
            return false;
        }
        state.cancelled = true;
        state.phase = JobPhase::Cancelled;
        true
    }

    pub fn phase(&self) -> JobPhase {
        self.lock().phase
    }

    pub fn cancelled(&self) -> bool {
        self.lock().cancelled
    }

    /// Atomically closes the pre-write cancellation window. Cancellation remains accepted
    /// after this transition, but the write itself cannot be rolled back.
    pub fn begin_clipboard_commit(&self) -> bool {
        let mut state = self.lock();
        if state.cancelled || state.phase != JobPhase::Preparing {
            return false;
        }
        state.phase = JobPhase::ClipboardCommit;
        true
    }

    /// Atomically closes the cancellation window. The mutex is released before this returns.
    pub fn begin_input_commit(&self) -> bool {
        let mut state = self.lock();
        if state.cancelled
            || matches!(
                state.phase,
                JobPhase::InputCommit | JobPhase::Completed | JobPhase::Cancelled
            )
        {
            return false;
        }
        state.phase = JobPhase::InputCommit;
        true
    }

    fn set_phase(&self, phase: JobPhase) -> bool {
        let mut state = self.lock();
        if state.cancelled || matches!(state.phase, JobPhase::InputCommit | JobPhase::Completed) {
            return false;
        }
        state.phase = phase;
        true
    }

    fn complete(&self) {
        let mut state = self.lock();
        if !state.cancelled {
            state.phase = JobPhase::Completed;
        }
    }

    fn lock(&self) -> MutexGuard<'_, GateState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteOutcome {
    InputSubmitted,
    InputRejected { inserted_inputs: usize },
    Cancelled,
    TargetInvalid,
    FocusDenied,
    ClipboardChanged,
    KeyHeld,
    PlatformFailure(PlatformError),
}

/// Focuses the captured target, waits for selection and modifier keys to be released, then
/// submits one Ctrl+V SendInput batch. A short/partial batch is reported and never retried.
pub fn run_paste<P: NativePlatform>(
    platform: &mut P,
    spec: &PasteSpec,
    gate: &JobGate,
) -> PasteOutcome {
    match run_paste_inner(platform, spec, gate) {
        Ok(()) => {
            gate.complete();
            PasteOutcome::InputSubmitted
        }
        Err(outcome) => {
            if outcome == PasteOutcome::Cancelled {
                gate.cancel();
            } else {
                gate.complete();
            }
            outcome
        }
    }
}

fn run_paste_inner<P: NativePlatform>(
    platform: &mut P,
    spec: &PasteSpec,
    gate: &JobGate,
) -> Result<(), PasteOutcome> {
    if gate.cancelled() {
        return Err(PasteOutcome::Cancelled);
    }
    if selection_deadline_expired(platform, spec) {
        return Err(PasteOutcome::KeyHeld);
    }
    gate.set_phase(JobPhase::WaitingForFocus);

    require_identity(platform, gate, spec.host_window)?;
    require_identity(platform, gate, spec.target)?;
    let sequence = platform_call(gate, || platform.clipboard_sequence())?;
    if sequence != spec.expected_clipboard_sequence {
        return Err(PasteOutcome::ClipboardChanged);
    }

    allowed_foreground(platform, spec, gate)?;
    let target_minimized = platform_call(gate, || platform.is_window_minimized(spec.target))?;
    let focus_deadline = Instant::now() + FOCUS_WAIT;

    if target_minimized {
        // Recheck both the target identity and foreground immediately before restoring it.
        require_identity(platform, gate, spec.target)?;
        allowed_foreground(platform, spec, gate)?;
        platform_call(gate, || platform.restore_window(spec.target))?;

        // Restoring a minimized window can race with the user's foreground switch. Recheck
        // immediately after the restore and abort before any explicit focus or input call.
        allowed_foreground(platform, spec, gate)?;
    }

    // Never raise the target over an unrelated foreground window. Only this captured host
    // window may hand focus back to the captured target.
    let foreground = allowed_foreground(platform, spec, gate)?;
    if foreground == spec.host_window && spec.host_window != spec.target {
        require_identity(platform, gate, spec.target)?;
        allowed_foreground(platform, spec, gate)?;
        platform_call(gate, || platform.set_foreground_window(spec.target))?;
    } else if foreground != spec.target {
        // The only remaining allowed state is host == target, which is already the target.
        return Err(PasteOutcome::FocusDenied);
    }

    wait_for_focus(platform, spec, gate, focus_deadline)?;
    gate.set_phase(JobPhase::WaitingForKeys);
    wait_for_release(platform, spec, gate, focus_deadline)?;

    // Revalidate the HWND/PID/process creation time, foreground, and clipboard just before
    // entering the cancellation gate. The platform's input method repeats the sequence check
    // atomically adjacent to its single SendInput call.
    require_identity(platform, gate, spec.target)?;
    if allowed_foreground(platform, spec, gate)? != spec.target {
        return Err(PasteOutcome::FocusDenied);
    }
    let sequence = platform_call(gate, || platform.clipboard_sequence())?;
    if sequence != spec.expected_clipboard_sequence {
        return Err(PasteOutcome::ClipboardChanged);
    }
    if selection_deadline_expired(platform, spec) {
        return Err(PasteOutcome::KeyHeld);
    }
    let events = [
        InputEvent {
            key: PhysicalKey::LeftControl,
            state: KeyState::Down,
        },
        InputEvent {
            key: PhysicalKey::V,
            state: KeyState::Down,
        },
        InputEvent {
            key: PhysicalKey::V,
            state: KeyState::Up,
        },
        InputEvent {
            key: PhysicalKey::LeftControl,
            state: KeyState::Up,
        },
    ];
    if selection_deadline_expired(platform, spec) {
        return Err(PasteOutcome::KeyHeld);
    }
    if spec.selection_check_only {
        check_release_keys(platform, spec, gate)?;
    }
    if !gate.begin_input_commit() {
        return Err(PasteOutcome::Cancelled);
    }
    let relative_deadline = spec
        .selection_deadline_tick_ms
        .map(|_| spec.selection_started + RELEASE_WAIT);
    match platform_call(gate, || {
        platform.send_input_if_sequence_before_deadline(
            spec.expected_clipboard_sequence,
            &events,
            relative_deadline,
            spec.selection_deadline_tick_ms,
        )
    }) {
        Ok(4) => Ok(()),
        Ok(inserted_inputs) => Err(PasteOutcome::InputRejected { inserted_inputs }),
        Err(PasteOutcome::PlatformFailure(PlatformError::ClipboardChanged)) => {
            Err(PasteOutcome::ClipboardChanged)
        }
        Err(PasteOutcome::PlatformFailure(PlatformError::InputRejected)) => {
            Err(PasteOutcome::InputRejected { inserted_inputs: 0 })
        }
        Err(error) => Err(error),
    }
}

fn wait_for_focus<P: NativePlatform>(
    platform: &mut P,
    spec: &PasteSpec,
    gate: &JobGate,
    deadline: Instant,
) -> Result<(), PasteOutcome> {
    loop {
        if allowed_foreground(platform, spec, gate)? == spec.target {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(PasteOutcome::FocusDenied);
        }
        pause_until(deadline);
    }
}

fn absolute_selection_deadline_expired<P: NativePlatform>(
    platform: &mut P,
    spec: &PasteSpec,
) -> bool {
    let Some(deadline) = spec.selection_deadline_tick_ms else {
        return false;
    };
    let now = platform.tick_count_ms();
    now >= deadline || deadline.saturating_sub(now) > RELEASE_WAIT.as_millis() as u64
}

fn selection_deadline_expired<P: NativePlatform>(platform: &mut P, spec: &PasteSpec) -> bool {
    if absolute_selection_deadline_expired(platform, spec) {
        return true;
    }
    spec.selection_deadline_tick_ms.is_some()
        && Instant::now() >= spec.selection_started + RELEASE_WAIT
}

fn absolute_selection_deadline_remaining<P: NativePlatform>(
    platform: &mut P,
    spec: &PasteSpec,
) -> Option<Duration> {
    spec.selection_deadline_tick_ms
        .map(|deadline| Duration::from_millis(deadline.saturating_sub(platform.tick_count_ms())))
}

fn wait_for_release<P: NativePlatform>(
    platform: &mut P,
    spec: &PasteSpec,
    gate: &JobGate,
    focus_deadline: Instant,
) -> Result<(), PasteOutcome> {
    if spec.selection_check_only {
        return check_release_keys(platform, spec, gate);
    }
    let release_deadline = spec.selection_started + RELEASE_WAIT;
    loop {
        if selection_deadline_expired(platform, spec) {
            return Err(PasteOutcome::KeyHeld);
        }

        let foreground = allowed_foreground(platform, spec, gate)?;
        if foreground != spec.target {
            if Instant::now() >= focus_deadline {
                return Err(PasteOutcome::FocusDenied);
            }
            // Poll the host tick deadline even while focus is elsewhere.
            pause_until(focus_deadline);
            continue;
        }

        let mut a_key_is_down = false;
        for key in released_keys(spec) {
            if platform_call(gate, || platform.is_key_down(key))? {
                a_key_is_down = true;
            }
        }
        if selection_deadline_expired(platform, spec) {
            return Err(PasteOutcome::KeyHeld);
        }
        if !a_key_is_down {
            return Ok(());
        }
        let relative_remaining = release_deadline.saturating_duration_since(Instant::now());
        if spec.selection_deadline_tick_ms.is_none() && relative_remaining.is_zero() {
            return Err(PasteOutcome::KeyHeld);
        }
        let absolute_remaining = absolute_selection_deadline_remaining(platform, spec);
        if absolute_remaining.is_some_and(|remaining| remaining.is_zero()) {
            return Err(PasteOutcome::KeyHeld);
        }
        let remaining = absolute_remaining
            .map(|absolute| absolute.min(relative_remaining))
            .unwrap_or(relative_remaining);
        thread::sleep(POLL_INTERVAL.min(remaining));
    }
}

fn check_release_keys<P: NativePlatform>(
    platform: &mut P,
    spec: &PasteSpec,
    gate: &JobGate,
) -> Result<(), PasteOutcome> {
    for key in released_keys(spec) {
        if platform_call(gate, || platform.is_key_down(key))? {
            return Err(PasteOutcome::KeyHeld);
        }
    }
    Ok(())
}

fn released_keys(spec: &PasteSpec) -> Vec<PhysicalKey> {
    let mut keys = Vec::with_capacity(9);
    keys.extend(spec.trigger_keys.iter().copied());
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

fn require_identity<P: NativePlatform>(
    platform: &mut P,
    gate: &JobGate,
    expected: WindowIdentity,
) -> Result<(), PasteOutcome> {
    match platform_call(gate, || platform.window_identity(expected.handle))? {
        Some(actual) if actual == expected => Ok(()),
        _ => Err(PasteOutcome::TargetInvalid),
    }
}

fn allowed_foreground<P: NativePlatform>(
    platform: &mut P,
    spec: &PasteSpec,
    gate: &JobGate,
) -> Result<WindowIdentity, PasteOutcome> {
    let foreground = platform_call(gate, || platform.foreground_window())?;
    match foreground {
        Some(identity) if identity == spec.target || identity == spec.host_window => Ok(identity),
        // In particular, do not restore or steal focus back after the user activates another
        // application while selecting an item (P27).
        _ => {
            gate.cancel();
            Err(PasteOutcome::Cancelled)
        }
    }
}

fn platform_call<T>(
    gate: &JobGate,
    call: impl FnOnce() -> Result<T, PlatformError>,
) -> Result<T, PasteOutcome> {
    if gate.cancelled() {
        return Err(PasteOutcome::Cancelled);
    }
    call().map_err(map_platform_error)
}

fn map_platform_error(error: PlatformError) -> PasteOutcome {
    match error {
        PlatformError::InvalidTarget => PasteOutcome::TargetInvalid,
        PlatformError::ForegroundDenied => PasteOutcome::FocusDenied,
        PlatformError::ClipboardChanged => PasteOutcome::ClipboardChanged,
        PlatformError::InputRejected => PasteOutcome::InputRejected { inserted_inputs: 0 },
        PlatformError::DeadlineExpired => PasteOutcome::KeyHeld,
        other => PasteOutcome::PlatformFailure(other),
    }
}

fn pause_until(deadline: Instant) {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if !remaining.is_zero() {
        thread::sleep(POLL_INTERVAL.min(remaining));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet, VecDeque};

    const HOST: WindowIdentity = WindowIdentity {
        handle: 10,
        process_id: 1,
        process_created_at: 100,
    };
    const TARGET: WindowIdentity = WindowIdentity {
        handle: 20,
        process_id: 2,
        process_created_at: 200,
    };
    const EXTERNAL: WindowIdentity = WindowIdentity {
        handle: 30,
        process_id: 3,
        process_created_at: 300,
    };

    #[derive(Default)]
    struct FakePlatform {
        sequence: u32,
        windows: HashMap<usize, WindowIdentity>,
        minimized: HashSet<usize>,
        foreground: Option<WindowIdentity>,
        down_keys: HashSet<PhysicalKey>,
        restore_calls: Vec<WindowIdentity>,
        foreground_calls: Vec<WindowIdentity>,
        input_calls: usize,
        last_input: Vec<InputEvent>,
        input_result: Option<usize>,
        external_foreground_during_restore: bool,
        foreground_after_focus_request: Option<VecDeque<Option<WindowIdentity>>>,
        focus_confirmation_reads: usize,
        tick_ms: u64,
        expire_after_input_conversion: bool,
    }

    impl FakePlatform {
        fn ready(foreground: WindowIdentity) -> Self {
            Self {
                sequence: 77,
                windows: [HOST, TARGET, EXTERNAL]
                    .into_iter()
                    .map(|id| (id.handle, id))
                    .collect(),
                foreground: Some(foreground),
                ..Self::default()
            }
        }
    }

    impl NativePlatform for FakePlatform {
        fn clipboard_sequence(&mut self) -> Result<ClipboardSequence, PlatformError> {
            Ok(self.sequence)
        }

        fn tick_count_ms(&mut self) -> u64 {
            self.tick_ms
        }

        fn write_clipboard_if_sequence(
            &mut self,
            _baseline: ClipboardSequence,
            _payload: &crate::platform::WritePayload,
        ) -> Result<ClipboardSequence, PlatformError> {
            Err(PlatformError::BackendUnavailable)
        }

        fn window_identity(
            &mut self,
            handle: usize,
        ) -> Result<Option<WindowIdentity>, PlatformError> {
            Ok(self.windows.get(&handle).copied())
        }

        fn foreground_window(&mut self) -> Result<Option<WindowIdentity>, PlatformError> {
            if !self.foreground_calls.is_empty() {
                if let Some(observations) = self.foreground_after_focus_request.as_mut() {
                    self.focus_confirmation_reads += 1;
                    if let Some(foreground) = observations.pop_front() {
                        self.foreground = foreground;
                    }
                }
            }
            Ok(self.foreground)
        }

        fn is_window_minimized(&mut self, target: WindowIdentity) -> Result<bool, PlatformError> {
            if self.windows.get(&target.handle) != Some(&target) {
                return Err(PlatformError::InvalidTarget);
            }
            Ok(self.minimized.contains(&target.handle))
        }

        fn restore_window(&mut self, target: WindowIdentity) -> Result<(), PlatformError> {
            if self.windows.get(&target.handle) != Some(&target) {
                return Err(PlatformError::InvalidTarget);
            }
            self.restore_calls.push(target);
            self.minimized.remove(&target.handle);
            if self.external_foreground_during_restore {
                self.foreground = Some(EXTERNAL);
            }
            Ok(())
        }

        fn set_foreground_window(&mut self, target: WindowIdentity) -> Result<(), PlatformError> {
            if self.windows.get(&target.handle) != Some(&target) {
                return Err(PlatformError::InvalidTarget);
            }
            self.foreground_calls.push(target);
            if self.foreground_after_focus_request.is_none() {
                self.foreground = Some(target);
            }
            Ok(())
        }

        fn is_key_down(&mut self, key: PhysicalKey) -> Result<bool, PlatformError> {
            Ok(self.down_keys.contains(&key))
        }

        fn send_input_if_sequence(
            &mut self,
            expected_sequence: ClipboardSequence,
            events: &[InputEvent],
        ) -> Result<usize, PlatformError> {
            if self.sequence != expected_sequence {
                return Err(PlatformError::ClipboardChanged);
            }
            self.input_calls += 1;
            self.last_input = events.to_vec();
            Ok(self.input_result.unwrap_or(events.len()))
        }

        fn send_input_if_sequence_before_deadline(
            &mut self,
            expected_sequence: ClipboardSequence,
            events: &[InputEvent],
            relative_deadline: Option<Instant>,
            deadline_tick_ms: Option<u64>,
        ) -> Result<usize, PlatformError> {
            if relative_deadline.is_some_and(|deadline| Instant::now() >= deadline)
                || deadline_tick_ms.is_some_and(|deadline| self.tick_ms >= deadline)
            {
                return Err(PlatformError::DeadlineExpired);
            }

            // Model the delay that can occur while native INPUT values are constructed.
            if self.expire_after_input_conversion {
                if let Some(deadline) = deadline_tick_ms {
                    self.tick_ms = deadline;
                } else {
                    return Err(PlatformError::DeadlineExpired);
                }
            }
            if relative_deadline.is_some_and(|deadline| Instant::now() >= deadline)
                || deadline_tick_ms.is_some_and(|deadline| self.tick_ms >= deadline)
            {
                return Err(PlatformError::DeadlineExpired);
            }
            self.send_input_if_sequence(expected_sequence, events)
        }
    }

    fn protocol_target(identity: WindowIdentity) -> Target {
        Target {
            hwnd: identity.handle.to_string(),
            pid: identity.process_id,
            process_created_at: identity.process_created_at.to_string(),
        }
    }

    fn spec(trigger: TriggerKey, selection_started: Instant) -> PasteSpec {
        PasteSpec::from_protocol(
            &protocol_target(HOST),
            &protocol_target(TARGET),
            "77",
            &[trigger],
            selection_started,
        )
        .unwrap()
    }

    #[test]
    fn gate_cancellation_wins_before_commit_and_blocks_the_commit_gate() {
        let gate = JobGate::new();
        assert!(gate.cancel());
        assert!(gate.cancelled());
        assert_eq!(gate.phase(), JobPhase::Cancelled);
        assert!(!gate.begin_clipboard_commit());
        assert!(!gate.begin_input_commit());
    }

    #[test]
    fn clipboard_commit_gate_wins_then_cancel_blocks_input_commit() {
        let gate = JobGate::new();
        assert!(gate.begin_clipboard_commit());
        assert_eq!(gate.phase(), JobPhase::ClipboardCommit);

        // The native clipboard write may already be in progress and cannot be rolled back,
        // but cancellation still wins over any later input commit.
        assert!(gate.cancel());
        assert!(gate.cancelled());
        assert_eq!(gate.phase(), JobPhase::Cancelled);
        assert!(!gate.begin_input_commit());
    }

    #[test]
    fn entering_commit_makes_later_cancellation_too_late() {
        let gate = JobGate::new();
        assert!(gate.begin_input_commit());
        assert_eq!(gate.phase(), JobPhase::InputCommit);
        assert!(!gate.cancel());
        assert!(!gate.cancelled());
    }

    #[test]
    fn external_foreground_cancels_without_restoring_or_sending_input() {
        let mut platform = FakePlatform::ready(EXTERNAL);
        platform.minimized.insert(TARGET.handle);
        let gate = JobGate::new();

        let outcome = run_paste(
            &mut platform,
            &spec(TriggerKey::Enter, Instant::now()),
            &gate,
        );

        assert_eq!(outcome, PasteOutcome::Cancelled);
        assert!(gate.cancelled());
        assert!(platform.restore_calls.is_empty());
        assert!(platform.foreground_calls.is_empty());
        assert_eq!(platform.input_calls, 0);
    }

    #[test]
    fn external_foreground_during_restore_cancels_before_focus_or_input() {
        let mut platform = FakePlatform::ready(HOST);
        platform.minimized.insert(TARGET.handle);
        platform.external_foreground_during_restore = true;
        let gate = JobGate::new();

        let outcome = run_paste(
            &mut platform,
            &spec(TriggerKey::Enter, Instant::now()),
            &gate,
        );

        assert_eq!(outcome, PasteOutcome::Cancelled);
        assert!(gate.cancelled());
        assert_eq!(platform.restore_calls, vec![TARGET]);
        assert!(platform.foreground_calls.is_empty());
        assert_eq!(platform.foreground, Some(EXTERNAL));
        assert_eq!(platform.input_calls, 0);
    }

    #[test]
    fn non_minimized_target_is_not_restored() {
        let mut platform = FakePlatform::ready(HOST);
        let gate = JobGate::new();

        let outcome = run_paste(
            &mut platform,
            &spec(TriggerKey::Enter, Instant::now()),
            &gate,
        );

        assert_eq!(outcome, PasteOutcome::InputSubmitted);
        assert!(platform.restore_calls.is_empty());
        assert_eq!(platform.foreground_calls, vec![TARGET]);
        assert_eq!(platform.input_calls, 1);
    }

    #[test]
    fn asynchronous_foreground_handoff_waits_for_target_then_submits_once() {
        let mut platform = FakePlatform::ready(HOST);
        platform.foreground_after_focus_request = Some(VecDeque::from([
            Some(HOST),
            Some(HOST),
            Some(HOST),
            Some(TARGET),
        ]));
        let gate = JobGate::new();

        let outcome = run_paste(
            &mut platform,
            &spec(TriggerKey::Enter, Instant::now()),
            &gate,
        );

        assert_eq!(outcome, PasteOutcome::InputSubmitted);
        assert!(platform.focus_confirmation_reads >= 4);
        assert_eq!(platform.foreground_calls, vec![TARGET]);
        assert_eq!(platform.input_calls, 1);
        assert_eq!(platform.last_input.len(), 4);
        assert_eq!(platform.foreground, Some(TARGET));
    }

    #[test]
    fn asynchronous_foreground_handoff_timeout_never_submits_or_retries() {
        let mut platform = FakePlatform::ready(HOST);
        platform.foreground_after_focus_request = Some(VecDeque::new());
        let gate = JobGate::new();

        let outcome = run_paste(
            &mut platform,
            &spec(TriggerKey::Enter, Instant::now()),
            &gate,
        );

        assert_eq!(outcome, PasteOutcome::FocusDenied);
        assert!(platform.focus_confirmation_reads > 1);
        assert_eq!(platform.foreground_calls, vec![TARGET]);
        assert_eq!(platform.input_calls, 0);
        assert!(platform.last_input.is_empty());
    }

    #[test]
    fn external_window_during_asynchronous_foreground_handoff_cancels_input() {
        let mut platform = FakePlatform::ready(HOST);
        platform.foreground_after_focus_request =
            Some(VecDeque::from([Some(HOST), Some(EXTERNAL)]));
        let gate = JobGate::new();

        let outcome = run_paste(
            &mut platform,
            &spec(TriggerKey::Enter, Instant::now()),
            &gate,
        );

        assert_eq!(outcome, PasteOutcome::Cancelled);
        assert!(gate.cancelled());
        assert_eq!(platform.foreground_calls, vec![TARGET]);
        assert_eq!(platform.input_calls, 0);
        assert!(platform.last_input.is_empty());
        assert_eq!(platform.foreground, Some(EXTERNAL));
    }

    #[test]
    fn click_with_empty_trigger_keys_still_checks_modifiers_before_input() {
        let selection_started = Instant::now() - RELEASE_WAIT;
        let click_spec = PasteSpec::from_protocol(
            &protocol_target(HOST),
            &protocol_target(TARGET),
            "77",
            &[],
            selection_started,
        )
        .unwrap();
        assert!(click_spec.trigger_keys.is_empty());

        let mut platform = FakePlatform::ready(HOST);
        platform.down_keys.insert(PhysicalKey::LeftShift);
        let outcome = run_paste(&mut platform, &click_spec, &JobGate::new());
        assert_eq!(outcome, PasteOutcome::KeyHeld);
        assert_eq!(platform.input_calls, 0);

        platform.down_keys.clear();
        let outcome = run_paste(&mut platform, &click_spec, &JobGate::new());
        assert_eq!(outcome, PasteOutcome::InputSubmitted);
        assert_eq!(platform.input_calls, 1);
        assert_eq!(platform.last_input.len(), 4);
    }

    #[test]
    fn paste_restores_only_the_target_then_submits_one_four_event_batch() {
        let mut platform = FakePlatform::ready(HOST);
        platform.minimized.insert(TARGET.handle);
        let gate = JobGate::new();

        let outcome = run_paste(&mut platform, &spec(TriggerKey::V, Instant::now()), &gate);

        assert_eq!(outcome, PasteOutcome::InputSubmitted);
        assert_eq!(platform.restore_calls, vec![TARGET]);
        assert_eq!(platform.foreground_calls, vec![TARGET]);
        assert_eq!(platform.input_calls, 1);
        assert_eq!(platform.last_input.len(), 4);
        assert_eq!(
            platform.last_input[0],
            InputEvent {
                key: PhysicalKey::LeftControl,
                state: KeyState::Down
            }
        );
        assert_eq!(
            platform.last_input[1],
            InputEvent {
                key: PhysicalKey::V,
                state: KeyState::Down
            }
        );
        assert_eq!(
            platform.last_input[2],
            InputEvent {
                key: PhysicalKey::V,
                state: KeyState::Up
            }
        );
        assert_eq!(
            platform.last_input[3],
            InputEvent {
                key: PhysicalKey::LeftControl,
                state: KeyState::Up
            }
        );
        assert_eq!(gate.phase(), JobPhase::Completed);
    }

    #[test]
    fn process_creation_mismatch_blocks_focus_and_input() {
        let mut platform = FakePlatform::ready(HOST);
        platform.windows.insert(
            TARGET.handle,
            WindowIdentity {
                process_created_at: 201,
                ..TARGET
            },
        );
        let gate = JobGate::new();

        let outcome = run_paste(
            &mut platform,
            &spec(TriggerKey::Enter, Instant::now()),
            &gate,
        );

        assert_eq!(outcome, PasteOutcome::TargetInvalid);
        assert!(platform.restore_calls.is_empty());
        assert!(platform.foreground_calls.is_empty());
        assert_eq!(platform.input_calls, 0);
    }

    #[test]
    fn partial_input_batch_is_reported_once_without_retry() {
        let mut platform = FakePlatform::ready(TARGET);
        platform.input_result = Some(2);
        let gate = JobGate::new();

        let outcome = run_paste(
            &mut platform,
            &spec(TriggerKey::Enter, Instant::now()),
            &gate,
        );

        assert_eq!(outcome, PasteOutcome::InputRejected { inserted_inputs: 2 });
        assert_eq!(platform.input_calls, 1);
        assert_eq!(platform.last_input.len(), 4);
        assert_eq!(gate.phase(), JobPhase::Completed);
    }

    #[test]
    fn expired_absolute_deadline_blocks_input_even_when_trigger_is_released() {
        let mut platform = FakePlatform::ready(TARGET);
        let spec = PasteSpec::from_protocol_with_deadline(
            &protocol_target(HOST),
            &protocol_target(TARGET),
            "77",
            &[TriggerKey::Enter],
            Instant::now(),
            Some(0),
        )
        .unwrap();

        let outcome = run_paste(&mut platform, &spec, &JobGate::new());

        assert_eq!(outcome, PasteOutcome::KeyHeld);
        assert_eq!(platform.input_calls, 0);
        assert!(platform.foreground_calls.is_empty());
    }

    #[test]
    fn send_deadline_expiring_during_native_input_construction_sends_nothing() {
        let mut platform = FakePlatform::ready(TARGET);
        platform.expire_after_input_conversion = true;
        let spec = PasteSpec::from_protocol_with_deadline(
            &protocol_target(HOST),
            &protocol_target(TARGET),
            "77",
            &[TriggerKey::Enter],
            Instant::now(),
            Some(1),
        )
        .unwrap();

        let outcome = run_paste(&mut platform, &spec, &JobGate::new());

        assert_eq!(outcome, PasteOutcome::KeyHeld);
        assert_eq!(platform.input_calls, 0);
        assert!(platform.last_input.is_empty());
    }

    #[test]
    fn held_trigger_at_shared_release_deadline_does_not_send_input() {
        let mut platform = FakePlatform::ready(TARGET);
        platform.down_keys.insert(PhysicalKey::V);
        let gate = JobGate::new();
        let started = Instant::now() - RELEASE_WAIT - Duration::from_millis(1);

        let outcome = run_paste(&mut platform, &spec(TriggerKey::V, started), &gate);

        assert_eq!(outcome, PasteOutcome::KeyHeld);
        assert_eq!(platform.input_calls, 0);
    }
}

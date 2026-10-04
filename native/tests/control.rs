use std::collections::HashSet;
use std::io::{self, Read, Write};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use clipnest_native_helper::control::{self, ControlError};
use clipnest_native_helper::platform::{
    ClipboardSequence, InputEvent, NativePlatform, PhysicalKey, PlatformError, WindowHandle,
    WindowIdentity, WritePayload,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

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

struct InputPipe {
    receiver: mpsc::Receiver<Vec<u8>>,
    current: Vec<u8>,
    offset: usize,
}

impl Read for InputPipe {
    fn read(&mut self, target: &mut [u8]) -> io::Result<usize> {
        if self.offset == self.current.len() {
            self.current = match self.receiver.recv() {
                Ok(bytes) => bytes,
                Err(_) => return Ok(0),
            };
            self.offset = 0;
        }
        let count = target.len().min(self.current.len() - self.offset);
        target[..count].copy_from_slice(&self.current[self.offset..self.offset + count]);
        self.offset += count;
        Ok(count)
    }
}

struct OutputPipe {
    sender: mpsc::Sender<Value>,
    buffer: Vec<u8>,
}

impl Write for OutputPipe {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.buffer.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        while let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<_> = self.buffer.drain(..=end).collect();
            let value = serde_json::from_slice(&line[..line.len() - 1])
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            self.sender
                .send(value)
                .map_err(|_| io::Error::other("test response closed"))?;
        }
        Ok(())
    }
}

#[derive(Default)]
struct Counts {
    open_attempts: usize,
    empty: usize,
    set: usize,
    send_input: usize,
    restore: usize,
}

#[derive(Default)]
struct BlockState {
    entered: bool,
    released: bool,
}

struct FakePlatform {
    sequence: Arc<Mutex<u32>>,
    counts: Arc<Mutex<Counts>>,
    foreground: Arc<Mutex<Option<WindowIdentity>>>,
    block: Arc<(Mutex<BlockState>, Condvar)>,
    keys_down: Arc<Mutex<HashSet<PhysicalKey>>>,
    clock: Arc<Mutex<FakeClock>>,
}

#[derive(Default)]
struct FakeClock {
    tick_ms: u64,
    advance_on_clipboard_lock: bool,
    advance_per_tick_read: u64,
}

impl FakePlatform {
    fn write_with_deadline(
        &mut self,
        baseline: u32,
        relative_deadline: Instant,
        deadline_tick_ms: Option<u64>,
    ) -> Result<u32, PlatformError> {
        self.counts.lock().unwrap().open_attempts += 1;
        let (lock, changed) = &*self.block;
        let mut state = lock.lock().unwrap();
        state.entered = true;
        changed.notify_all();
        while !state.released {
            state = changed.wait(state).unwrap();
        }
        drop(state);

        let mut sequence = self.sequence.lock().unwrap();
        if *sequence != baseline {
            return Err(PlatformError::ClipboardChanged);
        }
        {
            let mut clock = self.clock.lock().unwrap();
            if clock.advance_on_clipboard_lock {
                clock.tick_ms = clock.tick_ms.saturating_add(1);
                clock.advance_on_clipboard_lock = false;
            }
            if Instant::now() >= relative_deadline
                || deadline_tick_ms.is_some_and(|deadline| clock.tick_ms >= deadline)
            {
                return Err(PlatformError::DeadlineExpired);
            }
        }
        let mut counts = self.counts.lock().unwrap();
        counts.empty += 1;
        counts.set += 1;
        *sequence = sequence.wrapping_add(1);
        Ok(*sequence)
    }
}

impl NativePlatform for FakePlatform {
    fn clipboard_sequence(&mut self) -> Result<ClipboardSequence, PlatformError> {
        Ok(*self.sequence.lock().unwrap())
    }

    fn tick_count_ms(&mut self) -> u64 {
        let mut clock = self.clock.lock().unwrap();
        let current = clock.tick_ms;
        clock.tick_ms = clock.tick_ms.saturating_add(clock.advance_per_tick_read);
        current
    }

    fn write_clipboard_if_sequence(
        &mut self,
        baseline: u32,
        _payload: &WritePayload,
    ) -> Result<u32, PlatformError> {
        self.write_with_deadline(baseline, Instant::now() + Duration::from_secs(10), None)
    }

    fn write_clipboard_if_sequence_before_deadline(
        &mut self,
        baseline: u32,
        _payload: &WritePayload,
        relative_deadline: Instant,
        deadline_tick_ms: Option<u64>,
    ) -> Result<u32, PlatformError> {
        self.write_with_deadline(baseline, relative_deadline, deadline_tick_ms)
    }

    fn window_identity(
        &mut self,
        handle: WindowHandle,
    ) -> Result<Option<WindowIdentity>, PlatformError> {
        Ok([HOST, TARGET]
            .into_iter()
            .find(|identity| identity.handle == handle))
    }

    fn foreground_window(&mut self) -> Result<Option<WindowIdentity>, PlatformError> {
        let (lock, changed) = &*self.block;
        let mut state = lock.lock().unwrap();
        state.entered = true;
        changed.notify_all();
        while !state.released {
            state = changed.wait(state).unwrap();
        }
        Ok(*self.foreground.lock().unwrap())
    }

    fn is_window_minimized(&mut self, _target: WindowIdentity) -> Result<bool, PlatformError> {
        Ok(false)
    }
    fn restore_window(&mut self, _target: WindowIdentity) -> Result<(), PlatformError> {
        self.counts.lock().unwrap().restore += 1;
        Ok(())
    }
    fn set_foreground_window(&mut self, target: WindowIdentity) -> Result<(), PlatformError> {
        *self.foreground.lock().unwrap() = Some(target);
        Ok(())
    }
    fn is_key_down(&mut self, key: PhysicalKey) -> Result<bool, PlatformError> {
        Ok(self.keys_down.lock().unwrap().contains(&key))
    }
    fn send_input_if_sequence(
        &mut self,
        expected: u32,
        events: &[InputEvent],
    ) -> Result<usize, PlatformError> {
        if *self.sequence.lock().unwrap() != expected {
            return Err(PlatformError::ClipboardChanged);
        }
        self.counts.lock().unwrap().send_input += 1;
        Ok(events.len())
    }
}

struct Running {
    input: Option<mpsc::Sender<Vec<u8>>>,
    output: mpsc::Receiver<Value>,
    thread: JoinHandle<Result<(), ControlError>>,
    sequence: Arc<Mutex<u32>>,
    counts: Arc<Mutex<Counts>>,
    block: Arc<(Mutex<BlockState>, Condvar)>,
    keys_down: Arc<Mutex<HashSet<PhysicalKey>>>,
    clock: Arc<Mutex<FakeClock>>,
}

fn start() -> Running {
    let (input_tx, input_rx) = mpsc::channel();
    let (output_tx, output_rx) = mpsc::channel();
    let sequence = Arc::new(Mutex::new(41));
    let counts = Arc::new(Mutex::new(Counts::default()));
    let foreground = Arc::new(Mutex::new(Some(TARGET)));
    let keys_down = Arc::new(Mutex::new(HashSet::new()));
    let clock = Arc::new(Mutex::new(FakeClock {
        tick_ms: 1_000,
        ..FakeClock::default()
    }));
    let block = Arc::new((
        Mutex::new(BlockState {
            released: true,
            ..Default::default()
        }),
        Condvar::new(),
    ));
    let platform = FakePlatform {
        sequence: sequence.clone(),
        counts: counts.clone(),
        foreground,
        block: block.clone(),
        keys_down: keys_down.clone(),
        clock: clock.clone(),
    };
    let thread = thread::spawn(move || {
        control::run(
            "helper-test".into(),
            4242,
            1337,
            "a".repeat(64),
            platform,
            InputPipe {
                receiver: input_rx,
                current: Vec::new(),
                offset: 0,
            },
            OutputPipe {
                sender: output_tx,
                buffer: Vec::new(),
            },
        )
    });
    let running = Running {
        input: Some(input_tx),
        output: output_rx,
        thread,
        sequence,
        counts,
        block,
        keys_down,
        clock,
    };
    let ready = running.next().expect("READY");
    assert_eq!(ready["status"], "ready");
    assert_eq!(ready["helperPid"], 4242);
    assert_eq!(ready["helperProcessCreatedAt"], "1337");
    running
}

impl Running {
    fn send(&self, request: Value) {
        let mut frame = serde_json::to_vec(&request).unwrap();
        frame.push(b'\n');
        self.input.as_ref().unwrap().send(frame).unwrap();
    }

    fn next(&self) -> Option<Value> {
        self.output.recv_timeout(Duration::from_secs(2)).ok()
    }

    fn register_and_prepare(&self) -> String {
        let bytes = b"hello ClipNest";
        self.send(json!({
            "v": 1, "requestId": "register-1", "generation": "generation-1", "helperInstanceId": "helper-test",
            "kind": "register_content", "jobId": "job-1", "objectToken": "object-1", "itemRef": "item-1",
            "expectedItemVersion": "version-1", "contentType": "text", "totalBytes": bytes.len(),
            "totalHash": hex(&Sha256::digest(bytes)), "inlineBase64": STANDARD.encode(bytes)
        }));
        assert_eq!(self.next().unwrap()["status"], "content_registered");
        self.send(json!({
            "v": 1, "requestId": "prepare-1", "generation": "generation-1", "helperInstanceId": "helper-test",
            "kind": "prepare", "jobId": "job-1", "objectToken": "object-1",
            "expectedItemVersion": "version-1"
        }));
        self.next().unwrap()["prepareToken"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn write_clipboard(&self, token: &str, baseline: &str) -> Value {
        self.send(json!({
            "v": 1, "requestId": "write-1", "generation": "generation-1", "helperInstanceId": "helper-test",
            "kind": "commit_write", "jobId": "job-1", "prepareToken": token,
            "baselineClipboardSequence": baseline, "selectionBudgetMs": 500, "triggerKeys": ["Enter"]
        }));
        self.next().expect("clipboard write result")
    }

    fn close_and_join(mut self) {
        self.input.take();
        assert!(self.thread.join().unwrap().is_ok());
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn absolute_deadline_from_commit_is_enforced_at_paste_release_check() {
    let running = start();
    let token = running.register_and_prepare();
    running.send(json!({
        "v": 1, "requestId": "deadline-write", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "commit_write", "jobId": "job-1", "prepareToken": token,
        "baselineClipboardSequence": "41", "selectionBudgetMs": 500,
        "selectionDeadlineTickMs": 1_100, "triggerKeys": ["Enter"]
    }));
    assert_eq!(
        running.next().expect("clipboard commit")["status"],
        "clipboard_written"
    );
    *running.clock.lock().unwrap() = FakeClock {
        tick_ms: 1_100,
        ..FakeClock::default()
    };
    running.send(json!({
        "v": 1, "requestId": "deadline-paste", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "paste", "jobId": "job-1", "prepareToken": token,
        "hostWindow": { "hwnd": HOST.handle.to_string(), "pid": HOST.process_id, "processCreatedAt": HOST.process_created_at.to_string() },
        "target": { "hwnd": TARGET.handle.to_string(), "pid": TARGET.process_id, "processCreatedAt": TARGET.process_created_at.to_string() },
        "expectedClipboardSequence": "42", "triggerKeys": ["Enter"]
    }));
    let result = running.next().expect("expired paste result");
    assert_eq!(result["status"], "key_held");
    assert_eq!(result["reasonCode"], "trigger_or_modifier_held");
    let counts = running.counts.lock().unwrap();
    assert_eq!(counts.send_input, 0);
    drop(counts);
    assert_eq!(
        running.next().expect("job terminal")["status"],
        "job_finished"
    );
    running.close_and_join();
}

#[test]
fn late_commit_arrival_after_absolute_deadline_rejects_even_when_trigger_is_released() {
    let running = start();
    let token = running.register_and_prepare();
    running.clock.lock().unwrap().tick_ms = 1_001;
    running.send(json!({
        "v": 1, "requestId": "late-write", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "commit_write", "jobId": "job-1", "prepareToken": token,
        "baselineClipboardSequence": "41", "selectionBudgetMs": 500,
        "selectionDeadlineTickMs": 1_000, "triggerKeys": ["Enter"]
    }));

    let result = running.next().expect("expired write result");
    assert_eq!(result["status"], "key_held");
    assert_eq!(result["reasonCode"], "selection_deadline_expired");
    let counts = running.counts.lock().unwrap();
    assert_eq!(counts.open_attempts, 0);
    assert_eq!(counts.empty, 0);
    assert_eq!(counts.set, 0);
    assert_eq!(counts.send_input, 0);
    drop(counts);
    assert_eq!(
        running.next().expect("job terminal")["status"],
        "job_finished"
    );
    running.close_and_join();
}

#[test]
fn deadline_expiring_after_clipboard_lock_still_prevents_empty_clipboard_and_input() {
    let running = start();
    let token = running.register_and_prepare();
    {
        let mut clock = running.clock.lock().unwrap();
        clock.tick_ms = 2_000;
        clock.advance_on_clipboard_lock = true;
    }
    running.send(json!({
        "v": 1, "requestId": "lock-late-write", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "commit_write", "jobId": "job-1", "prepareToken": token,
        "baselineClipboardSequence": "41", "selectionBudgetMs": 500,
        "selectionDeadlineTickMs": 2_001, "triggerKeys": ["Enter"]
    }));

    let result = running.next().expect("deadline result");
    assert_eq!(result["status"], "key_held");
    assert_eq!(result["reasonCode"], "selection_deadline_expired");
    let counts = running.counts.lock().unwrap();
    assert_eq!(counts.open_attempts, 1);
    assert_eq!(counts.empty, 0);
    assert_eq!(counts.set, 0);
    assert_eq!(counts.send_input, 0);
    drop(counts);
    assert_eq!(
        running.next().expect("job terminal")["status"],
        "job_finished"
    );
    running.close_and_join();
}

#[test]
fn held_trigger_before_write_blocks_clipboard_commit_and_respects_remaining_budget() {
    let running = start();
    let token = running.register_and_prepare();
    running.keys_down.lock().unwrap().insert(PhysicalKey::Enter);
    running.send(json!({
        "v": 1, "requestId": "write-held", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "commit_write", "jobId": "job-1", "prepareToken": token,
        "baselineClipboardSequence": "41", "selectionBudgetMs": 200, "triggerKeys": ["Enter"]
    }));
    thread::sleep(Duration::from_millis(20));
    assert_eq!(running.counts.lock().unwrap().open_attempts, 0);

    running
        .keys_down
        .lock()
        .unwrap()
        .remove(&PhysicalKey::Enter);
    let written = running.next().expect("write after trigger release");
    assert_eq!(written["status"], "clipboard_written");
    assert_eq!(running.counts.lock().unwrap().open_attempts, 1);
    assert_eq!(running.counts.lock().unwrap().send_input, 0);
    running.close_and_join();
}

#[test]
fn check_only_selection_budget_rechecks_keys_without_waiting() {
    let running = start();
    let token = running.register_and_prepare();
    running.send(json!({
        "v": 1, "requestId": "write-check-only", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "commit_write", "jobId": "job-1", "prepareToken": token,
        "baselineClipboardSequence": "41", "selectionBudgetMs": 0, "triggerKeys": ["Enter"]
    }));
    let written = running
        .next()
        .expect("released check-only clipboard commit");
    assert_eq!(written["status"], "clipboard_written");

    running.keys_down.lock().unwrap().insert(PhysicalKey::Enter);
    running.send(json!({
        "v": 1, "requestId": "paste-check-only", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "paste", "jobId": "job-1", "prepareToken": token,
        "hostWindow": { "hwnd": HOST.handle.to_string(), "pid": HOST.process_id, "processCreatedAt": HOST.process_created_at.to_string() },
        "target": { "hwnd": TARGET.handle.to_string(), "pid": TARGET.process_id, "processCreatedAt": TARGET.process_created_at.to_string() },
        "expectedClipboardSequence": "42", "triggerKeys": ["Enter"]
    }));
    let pasted = running.next().expect("re-pressed trigger is rejected");
    assert_eq!(pasted["status"], "key_held");
    assert_eq!(pasted["reasonCode"], "trigger_or_modifier_held");
    assert_eq!(running.counts.lock().unwrap().send_input, 0);
    running.close_and_join();

    let held = start();
    let token = held.register_and_prepare();
    held.keys_down.lock().unwrap().insert(PhysicalKey::Enter);
    held.send(json!({
        "v": 1, "requestId": "write-check-only-held", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "commit_write", "jobId": "job-1", "prepareToken": token,
        "baselineClipboardSequence": "41", "selectionBudgetMs": 0, "triggerKeys": ["Enter"]
    }));
    let result = held.next().expect("held check-only trigger is rejected");
    assert_eq!(result["status"], "key_held");
    assert_eq!(result["reasonCode"], "trigger_key_held_or_deadline_expired");
    assert_eq!(held.counts.lock().unwrap().open_attempts, 0);
    assert_eq!(held.next().unwrap()["status"], "job_finished");
    held.close_and_join();
}

#[test]
fn held_trigger_at_remaining_deadline_returns_key_held_without_clipboard_write() {
    let running = start();
    let token = running.register_and_prepare();
    running.keys_down.lock().unwrap().insert(PhysicalKey::Enter);
    running.send(json!({
        "v": 1, "requestId": "write-expired", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "commit_write", "jobId": "job-1", "prepareToken": token,
        "baselineClipboardSequence": "41", "selectionBudgetMs": 30, "triggerKeys": ["Enter"]
    }));
    let result = running.next().expect("held key result");
    assert_eq!(result["status"], "key_held");
    assert_eq!(result["reasonCode"], "trigger_key_held_or_deadline_expired");
    assert_eq!(running.counts.lock().unwrap().open_attempts, 0);
    assert_eq!(running.counts.lock().unwrap().send_input, 0);
    assert_eq!(
        running.next().expect("job terminal")["status"],
        "job_finished"
    );
    running.close_and_join();
}

#[test]
fn local_budget_expiry_precedes_a_later_shared_deadline() {
    let running = start();
    let token = running.register_and_prepare();
    running.keys_down.lock().unwrap().insert(PhysicalKey::Enter);
    {
        let mut clock = running.clock.lock().unwrap();
        clock.tick_ms = 1_000;
        clock.advance_per_tick_read = 1;
    }
    running.send(json!({
        "v": 1, "requestId": "write-local-deadline", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "commit_write", "jobId": "job-1", "prepareToken": token,
        "baselineClipboardSequence": "41", "selectionBudgetMs": 30,
        "selectionDeadlineTickMs": 1_100, "triggerKeys": ["Enter"]
    }));

    let result = running.next().expect("local budget result");
    assert_eq!(result["status"], "key_held");
    assert_eq!(result["reasonCode"], "trigger_key_held_or_deadline_expired");
    let counts = running.counts.lock().unwrap();
    assert_eq!(counts.open_attempts, 0);
    assert_eq!(counts.empty, 0);
    assert_eq!(counts.set, 0);
    assert_eq!(counts.send_input, 0);
    drop(counts);
    assert_eq!(
        running.next().expect("job terminal")["status"],
        "job_finished"
    );
    running.close_and_join();
}

#[test]
fn controller_writes_then_submits_one_correlated_input_batch() {
    let running = start();
    let token = running.register_and_prepare();
    let written = running.write_clipboard(&token, "41");
    assert_eq!(written["status"], "clipboard_written");
    assert_eq!(written["clipboardSequence"], "42");

    running.send(json!({
        "v": 1, "requestId": "paste-1", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "paste", "jobId": "job-1", "prepareToken": token,
        "hostWindow": { "hwnd": HOST.handle.to_string(), "pid": HOST.process_id, "processCreatedAt": HOST.process_created_at.to_string() },
        "target": { "hwnd": TARGET.handle.to_string(), "pid": TARGET.process_id, "processCreatedAt": TARGET.process_created_at.to_string() },
        "expectedClipboardSequence": "42", "triggerKeys": ["Enter"]
    }));
    let submitted = running.next().expect("input result");
    assert_eq!(submitted["status"], "input_submitted");
    assert_eq!(submitted["insertedInputs"], 4);
    assert_eq!(running.next().unwrap()["status"], "job_finished");
    assert_eq!(running.counts.lock().unwrap().empty, 1);
    assert_eq!(running.counts.lock().unwrap().send_input, 1);
    running.close_and_join();
}

#[test]
fn click_execution_commits_and_pastes_with_empty_physical_trigger_keys() {
    let running = start();
    let token = running.register_and_prepare();
    running.send(json!({
        "v": 1, "requestId": "click-write", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "commit_write", "jobId": "job-1", "prepareToken": token,
        "baselineClipboardSequence": "41", "selectionBudgetMs": 500, "triggerKeys": []
    }));
    let written = running.next().expect("click clipboard write");
    assert_eq!(written["status"], "clipboard_written");
    assert_eq!(written["clipboardSequence"], "42");

    running.send(json!({
        "v": 1, "requestId": "click-paste", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "paste", "jobId": "job-1", "prepareToken": token,
        "hostWindow": { "hwnd": HOST.handle.to_string(), "pid": HOST.process_id, "processCreatedAt": HOST.process_created_at.to_string() },
        "target": { "hwnd": TARGET.handle.to_string(), "pid": TARGET.process_id, "processCreatedAt": TARGET.process_created_at.to_string() },
        "expectedClipboardSequence": "42", "triggerKeys": []
    }));
    let pasted = running.next().expect("click paste");
    assert_eq!(pasted["status"], "input_submitted");
    assert_eq!(pasted["insertedInputs"], 4);
    assert_eq!(running.next().unwrap()["status"], "job_finished");
    let counts = running.counts.lock().unwrap();
    assert_eq!(counts.open_attempts, 1);
    assert_eq!(counts.send_input, 1);
    drop(counts);
    running.close_and_join();
}

#[test]
fn external_clipboard_change_blocks_destructive_write_and_input() {
    let running = start();
    let token = running.register_and_prepare();
    *running.sequence.lock().unwrap() = 42;
    let result = running.write_clipboard(&token, "41");
    assert_eq!(result["status"], "clipboard_changed");
    assert_eq!(running.next().unwrap()["status"], "job_finished");
    let counts = running.counts.lock().unwrap();
    assert_eq!(counts.empty, 0);
    assert_eq!(counts.set, 0);
    assert_eq!(counts.send_input, 0);
    drop(counts);
    running.close_and_join();
}

#[test]
fn cancel_ack_does_not_wait_for_a_blocked_focus_worker() {
    let running = start();
    let token = running.register_and_prepare();
    assert_eq!(
        running.write_clipboard(&token, "41")["status"],
        "clipboard_written"
    );
    {
        let (lock, _) = &*running.block;
        *lock.lock().unwrap() = BlockState {
            released: false,
            ..Default::default()
        };
    }
    running.send(json!({
        "v": 1, "requestId": "paste-1", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "paste", "jobId": "job-1", "prepareToken": token,
        "hostWindow": { "hwnd": HOST.handle.to_string(), "pid": HOST.process_id, "processCreatedAt": HOST.process_created_at.to_string() },
        "target": { "hwnd": TARGET.handle.to_string(), "pid": TARGET.process_id, "processCreatedAt": TARGET.process_created_at.to_string() },
        "expectedClipboardSequence": "42", "triggerKeys": ["Enter"]
    }));
    {
        let (lock, changed) = &*running.block;
        let state = lock.lock().unwrap();
        let (state, timeout) = changed
            .wait_timeout_while(state, Duration::from_secs(1), |state| !state.entered)
            .unwrap();
        assert!(!timeout.timed_out() && state.entered);
    }
    let start = std::time::Instant::now();
    running.send(json!({
        "v": 1, "requestId": "cancel-1", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "cancel", "jobId": "job-1"
    }));
    let cancelled = running.next().expect("cancel ACK");
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(cancelled["workerQuiescent"], false);
    assert!(start.elapsed() < Duration::from_millis(50));
    {
        let (lock, changed) = &*running.block;
        lock.lock().unwrap().released = true;
        changed.notify_all();
    }
    assert_eq!(running.next().unwrap()["status"], "cancelled");
    assert_eq!(running.next().unwrap()["status"], "job_finished");
    assert_eq!(running.counts.lock().unwrap().send_input, 0);
    running.close_and_join();
}

#[test]
fn blocked_worker_trips_cancel_watchdog_and_cannot_send_input_after_release() {
    let running = start();
    let token = running.register_and_prepare();
    assert_eq!(
        running.write_clipboard(&token, "41")["status"],
        "clipboard_written"
    );
    {
        let (lock, _) = &*running.block;
        *lock.lock().unwrap() = BlockState {
            released: false,
            ..Default::default()
        };
    }
    running.send(json!({
        "v": 1, "requestId": "watchdog-paste", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "paste", "jobId": "job-1", "prepareToken": token,
        "hostWindow": { "hwnd": HOST.handle.to_string(), "pid": HOST.process_id, "processCreatedAt": HOST.process_created_at.to_string() },
        "target": { "hwnd": TARGET.handle.to_string(), "pid": TARGET.process_id, "processCreatedAt": TARGET.process_created_at.to_string() },
        "expectedClipboardSequence": "42", "triggerKeys": ["Enter"]
    }));
    {
        let (lock, changed) = &*running.block;
        let state = lock.lock().unwrap();
        let (state, timeout) = changed
            .wait_timeout_while(state, Duration::from_secs(1), |state| !state.entered)
            .unwrap();
        assert!(!timeout.timed_out() && state.entered);
    }
    let watchdog_started = std::time::Instant::now();
    running.send(json!({
        "v": 1, "requestId": "watchdog-cancel", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "cancel", "jobId": "job-1"
    }));
    let cancelled = running.next().expect("cancel ACK before watchdog");
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(cancelled["workerQuiescent"], false);

    let result = running.thread.join().expect("controller thread panicked");
    assert!(matches!(result, Err(ControlError::WorkerUnavailable)));
    let watchdog_elapsed = watchdog_started.elapsed();
    assert!(watchdog_elapsed >= Duration::from_millis(40));
    assert!(watchdog_elapsed < Duration::from_millis(500));
    assert!(
        running
            .output
            .recv_timeout(Duration::from_millis(10))
            .is_err()
    );

    {
        let (lock, changed) = &*running.block;
        lock.lock().unwrap().released = true;
        changed.notify_all();
    }
    assert_eq!(running.counts.lock().unwrap().send_input, 0);
    drop(running.input);
}

#[test]
fn repeated_in_flight_request_ids_coalesce_to_one_original_result() {
    let running = start();
    let token = running.register_and_prepare();
    {
        let (lock, _) = &*running.block;
        *lock.lock().unwrap() = BlockState {
            released: false,
            ..Default::default()
        };
    }
    let request = json!({
        "v": 1, "requestId": "write-replay", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "commit_write", "jobId": "job-1", "prepareToken": token,
        "baselineClipboardSequence": "41", "selectionBudgetMs": 500, "triggerKeys": ["Enter"]
    });
    running.send(request.clone());
    {
        let (lock, changed) = &*running.block;
        let state = lock.lock().unwrap();
        let (state, timeout) = changed
            .wait_timeout_while(state, Duration::from_secs(1), |state| !state.entered)
            .unwrap();
        assert!(!timeout.timed_out() && state.entered);
    }

    running.send(request.clone());
    running.send(request);
    // A distinct request forms a FIFO barrier: seeing its immediate Busy result
    // proves the reader has already processed both replay frames while the write
    // is still blocked in the fake platform.
    running.send(json!({
        "v": 1, "requestId": "write-replay-barrier", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "capture"
    }));
    let barrier = running.next().expect("barrier response");
    assert_eq!(barrier["requestId"], "write-replay-barrier");
    assert_eq!(barrier["status"], "busy");
    {
        let (lock, changed) = &*running.block;
        lock.lock().unwrap().released = true;
        changed.notify_all();
    }

    let result = running.next().expect("original write result");
    assert_eq!(result["requestId"], "write-replay");
    assert_eq!(result["status"], "clipboard_written");
    assert!(
        running
            .output
            .recv_timeout(Duration::from_millis(50))
            .is_err()
    );
    let counts = running.counts.lock().unwrap();
    assert_eq!(counts.open_attempts, 1);
    assert_eq!(counts.empty, 1);
    assert_eq!(counts.set, 1);
    drop(counts);
    running.close_and_join();
}

#[test]
fn completed_results_remain_replayable_through_the_request_id_limit() {
    let running = start();
    let token = running.register_and_prepare();
    assert_eq!(
        running.write_clipboard(&token, "41")["status"],
        "clipboard_written"
    );

    // register, prepare, and write consume three unique ids. Fill the full
    // remaining request-ID budget before replaying the first completed result.
    const MAX_REQUEST_IDS: usize = 4096;
    for index in 0..(MAX_REQUEST_IDS - 3) {
        running.send(json!({
            "v": 1, "requestId": format!("cache-capture-{index}"), "generation": "generation-1", "helperInstanceId": "helper-test",
            "kind": "capture"
        }));
        let result = running.next().expect("busy capture result");
        assert_eq!(result["requestId"], format!("cache-capture-{index}"));
        assert_eq!(result["status"], "busy");
    }

    running.send(json!({
        "v": 1, "requestId": "write-1", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "commit_write", "jobId": "job-1", "prepareToken": token,
        "baselineClipboardSequence": "41", "selectionBudgetMs": 500, "triggerKeys": ["Enter"]
    }));
    let replay = running.next().expect("cached write replay");
    assert_eq!(replay["requestId"], "write-1");
    assert_eq!(replay["status"], "clipboard_written");
    assert_eq!(replay["clipboardSequence"], "42");
    let counts = running.counts.lock().unwrap();
    assert_eq!(counts.open_attempts, 1);
    assert_eq!(counts.empty, 1);
    assert_eq!(counts.set, 1);
    drop(counts);
    running.close_and_join();
}

#[test]
fn generation_advances_only_after_old_work_quiesces_and_retires_previous_ids() {
    let running = start();
    {
        let (lock, _) = &*running.block;
        *lock.lock().unwrap() = BlockState {
            released: false,
            ..Default::default()
        };
    }
    running.send(json!({
        "v": 1, "requestId": "capture-generation-1", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "capture"
    }));
    {
        let (lock, changed) = &*running.block;
        let state = lock.lock().unwrap();
        let (state, timeout) = changed
            .wait_timeout_while(state, Duration::from_secs(1), |state| !state.entered)
            .unwrap();
        assert!(!timeout.timed_out() && state.entered);
    }

    running.send(json!({
        "v": 1, "requestId": "early-generation-2", "generation": "generation-2", "helperInstanceId": "helper-test",
        "kind": "capture"
    }));
    let early = running.next().expect("early generation response");
    assert_eq!(early["status"], "busy");
    assert_eq!(early["reasonCode"], "generation_transition_pending");

    {
        let (lock, changed) = &*running.block;
        lock.lock().unwrap().released = true;
        changed.notify_all();
    }
    let old_result = running.next().expect("old generation capture");
    assert_eq!(old_result["requestId"], "capture-generation-1");
    assert_eq!(old_result["generation"], "generation-1");
    assert_eq!(old_result["status"], "captured");

    running.send(json!({
        "v": 1, "requestId": "capture-generation-2", "generation": "generation-2", "helperInstanceId": "helper-test",
        "kind": "capture"
    }));
    let new_result = running.next().expect("new generation capture");
    assert_eq!(new_result["requestId"], "capture-generation-2");
    assert_eq!(new_result["generation"], "generation-2");
    assert_eq!(new_result["status"], "captured");

    running.send(json!({
        "v": 1, "requestId": "late-generation-1", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "capture"
    }));
    let stale = running.next().expect("retired generation response");
    assert_eq!(stale["status"], "helper_unavailable");
    assert_eq!(stale["reasonCode"], "stale_generation");
    running.close_and_join();
}

#[test]
fn generation_transition_waits_for_active_job_terminal_flush() {
    let running = start();
    let _token = running.register_and_prepare();
    running.send(json!({
        "v": 1, "requestId": "early-panel-reopen", "generation": "generation-2", "helperInstanceId": "helper-test",
        "kind": "capture"
    }));
    let early = running.next().expect("active generation response");
    assert_eq!(early["status"], "busy");
    assert_eq!(early["reasonCode"], "generation_transition_pending");

    running.send(json!({
        "v": 1, "requestId": "cancel-generation-1", "generation": "generation-1", "helperInstanceId": "helper-test",
        "kind": "cancel", "jobId": "job-1"
    }));
    let cancel = running.next().expect("cancel ACK");
    assert_eq!(cancel["status"], "cancelled");
    assert_eq!(cancel["workerQuiescent"], true);
    let terminal = running.next().expect("terminal event");
    assert_eq!(terminal["status"], "job_finished");
    assert_eq!(terminal["generation"], "generation-1");

    running.send(json!({
        "v": 1, "requestId": "panel-reopen-after-terminal", "generation": "generation-2", "helperInstanceId": "helper-test",
        "kind": "capture"
    }));
    let mut reopened = running.next().expect("generation-2 capture");
    for attempt in 1..=4 {
        if reopened["status"] != "busy" {
            break;
        }
        // The terminal frame can reach the harness just before its flush event is
        // delivered to the controller. A Busy result is stable for its requestId;
        // retry with a fresh id after the flush barrier.
        assert_eq!(reopened["reasonCode"], "generation_transition_pending");
        running.send(json!({
            "v": 1, "requestId": format!("panel-reopen-after-terminal-retry-{attempt}"), "generation": "generation-2", "helperInstanceId": "helper-test",
            "kind": "capture"
        }));
        reopened = running.next().expect("generation-2 retry");
    }
    assert_eq!(reopened["status"], "captured");
    assert_eq!(reopened["generation"], "generation-2");
    running.close_and_join();
}

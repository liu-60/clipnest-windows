use std::fmt;
use std::time::Instant;

pub type WindowHandle = usize;
pub type ClipboardSequence = u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformError {
    ClipboardBusy,
    ClipboardChanged,
    InvalidTarget,
    ForegroundDenied,
    InputRejected,
    BackendUnavailable,
    DeadlineExpired,
}

impl fmt::Display for PlatformError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ClipboardBusy => "clipboard_busy",
            Self::ClipboardChanged => "clipboard_changed",
            Self::InvalidTarget => "target_invalid",
            Self::ForegroundDenied => "focus_denied",
            Self::InputRejected => "input_rejected",
            Self::BackendUnavailable => "backend_unavailable",
            Self::DeadlineExpired => "selection_deadline_expired",
        })
    }
}

impl std::error::Error for PlatformError {}

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq)]
pub enum PhysicalKey {
    Enter,
    V,
    LeftControl,
    RightControl,
    LeftAlt,
    RightAlt,
    LeftShift,
    RightShift,
    LeftWindows,
    RightWindows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyState {
    Down,
    Up,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InputEvent {
    pub key: PhysicalKey,
    pub state: KeyState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WritePayload {
    TextUtf8(Vec<u8>),
    ImageDib(Vec<u8>),
}

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq)]
pub struct WindowIdentity {
    pub handle: WindowHandle,
    pub process_id: u32,
    pub process_created_at: u64,
}

pub trait NativePlatform: Send + 'static {
    fn clipboard_sequence(&mut self) -> Result<ClipboardSequence, PlatformError>;

    /// Returns the host-wide monotonic tick count in milliseconds.
    fn tick_count_ms(&mut self) -> u64;

    /// Performs a conditional write only while the absolute host deadline is still live.
    /// Win32 implementations must repeat the check after acquiring the clipboard lock and
    /// immediately before EmptyClipboard; fake platforms should model that boundary.
    fn write_clipboard_if_sequence_before_deadline(
        &mut self,
        baseline: ClipboardSequence,
        payload: &WritePayload,
        relative_deadline: Instant,
        deadline_tick_ms: Option<u64>,
    ) -> Result<ClipboardSequence, PlatformError> {
        if Instant::now() >= relative_deadline
            || deadline_tick_ms.is_some_and(|deadline| self.tick_count_ms() >= deadline)
        {
            return Err(PlatformError::DeadlineExpired);
        }
        self.write_clipboard_if_sequence(baseline, payload)
    }

    /// Compares the sequence while holding the native clipboard lock, then writes only on a match.
    /// The returned value is the sequence after the payload has been installed.
    fn write_clipboard_if_sequence(
        &mut self,
        baseline: ClipboardSequence,
        payload: &WritePayload,
    ) -> Result<ClipboardSequence, PlatformError>;

    fn window_identity(
        &mut self,
        handle: WindowHandle,
    ) -> Result<Option<WindowIdentity>, PlatformError>;
    fn foreground_window(&mut self) -> Result<Option<WindowIdentity>, PlatformError>;
    fn is_window_minimized(&mut self, target: WindowIdentity) -> Result<bool, PlatformError>;
    fn restore_window(&mut self, target: WindowIdentity) -> Result<(), PlatformError>;
    fn set_foreground_window(&mut self, target: WindowIdentity) -> Result<(), PlatformError>;
    fn is_key_down(&mut self, key: PhysicalKey) -> Result<bool, PlatformError>;

    /// Rechecks the clipboard sequence immediately before issuing SendInput.
    /// A mismatch must return ClipboardChanged without making any input call.
    fn send_input_if_sequence(
        &mut self,
        expected_sequence: ClipboardSequence,
        events: &[InputEvent],
    ) -> Result<usize, PlatformError>;

    /// Checks both selection budgets before sending input. Native implementations should
    /// repeat the checks after constructing platform INPUT values and immediately before
    /// SendInput; fake platforms should model that boundary.
    fn send_input_if_sequence_before_deadline(
        &mut self,
        expected_sequence: ClipboardSequence,
        events: &[InputEvent],
        relative_deadline: Option<Instant>,
        deadline_tick_ms: Option<u64>,
    ) -> Result<usize, PlatformError> {
        if relative_deadline.is_some_and(|deadline| Instant::now() >= deadline)
            || deadline_tick_ms.is_some_and(|deadline| self.tick_count_ms() >= deadline)
        {
            return Err(PlatformError::DeadlineExpired);
        }
        self.send_input_if_sequence(expected_sequence, events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::time::Duration;

    #[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
    struct CallCounts {
        clipboard_sequence: usize,
        empty_clipboard: usize,
        set_clipboard_data: usize,
        window_identity: usize,
        foreground_window: usize,
        minimized_check: usize,
        restore_window: usize,
        set_foreground_window: usize,
        key_query: usize,
        send_input: usize,
    }

    struct FakeWindow {
        identity: WindowIdentity,
        minimized: bool,
    }

    /// Deterministic simulation; it never calls Win32 and never records clipboard contents.
    #[derive(Default)]
    struct FakePlatform {
        sequence: ClipboardSequence,
        windows: HashMap<WindowHandle, FakeWindow>,
        foreground: Option<WindowIdentity>,
        down_keys: HashSet<PhysicalKey>,
        counts: CallCounts,
    }

    impl FakePlatform {
        fn at_sequence(sequence: ClipboardSequence) -> Self {
            Self {
                sequence,
                ..Self::default()
            }
        }

        fn external_clipboard_change(&mut self) {
            self.sequence = self.sequence.wrapping_add(1);
        }

        fn counts(&self) -> CallCounts {
            self.counts
        }
    }

    impl NativePlatform for FakePlatform {
        fn clipboard_sequence(&mut self) -> Result<ClipboardSequence, PlatformError> {
            self.counts.clipboard_sequence += 1;
            Ok(self.sequence)
        }

        fn tick_count_ms(&mut self) -> u64 {
            0
        }

        fn write_clipboard_if_sequence(
            &mut self,
            baseline: ClipboardSequence,
            _payload: &WritePayload,
        ) -> Result<ClipboardSequence, PlatformError> {
            if self.sequence != baseline {
                return Err(PlatformError::ClipboardChanged);
            }
            self.counts.empty_clipboard += 1;
            self.counts.set_clipboard_data += 1;
            self.sequence = self.sequence.wrapping_add(1);
            Ok(self.sequence)
        }

        fn window_identity(
            &mut self,
            handle: WindowHandle,
        ) -> Result<Option<WindowIdentity>, PlatformError> {
            self.counts.window_identity += 1;
            Ok(self.windows.get(&handle).map(|window| window.identity))
        }

        fn foreground_window(&mut self) -> Result<Option<WindowIdentity>, PlatformError> {
            self.counts.foreground_window += 1;
            Ok(self.foreground)
        }

        fn is_window_minimized(&mut self, target: WindowIdentity) -> Result<bool, PlatformError> {
            self.counts.minimized_check += 1;
            let window = self
                .windows
                .get(&target.handle)
                .ok_or(PlatformError::InvalidTarget)?;
            if window.identity != target {
                return Err(PlatformError::InvalidTarget);
            }
            Ok(window.minimized)
        }

        fn restore_window(&mut self, target: WindowIdentity) -> Result<(), PlatformError> {
            self.counts.restore_window += 1;
            let window = self
                .windows
                .get_mut(&target.handle)
                .ok_or(PlatformError::InvalidTarget)?;
            if window.identity != target {
                return Err(PlatformError::InvalidTarget);
            }
            window.minimized = false;
            Ok(())
        }

        fn set_foreground_window(&mut self, target: WindowIdentity) -> Result<(), PlatformError> {
            self.counts.set_foreground_window += 1;
            let window = self
                .windows
                .get(&target.handle)
                .ok_or(PlatformError::InvalidTarget)?;
            if window.identity != target {
                return Err(PlatformError::InvalidTarget);
            }
            self.foreground = Some(target);
            Ok(())
        }

        fn is_key_down(&mut self, key: PhysicalKey) -> Result<bool, PlatformError> {
            self.counts.key_query += 1;
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
            if events.is_empty() {
                return Err(PlatformError::InputRejected);
            }
            self.counts.send_input += 1;
            Ok(events.len())
        }
    }

    #[test]
    fn expired_deadline_prevents_default_conditional_write() {
        let mut platform = FakePlatform::at_sequence(41);
        assert_eq!(
            platform.write_clipboard_if_sequence_before_deadline(
                41,
                &WritePayload::TextUtf8(b"private".to_vec()),
                Instant::now() + Duration::from_secs(1),
                Some(0),
            ),
            Err(PlatformError::DeadlineExpired)
        );
        let counts = platform.counts();
        assert_eq!(counts.empty_clipboard, 0);
        assert_eq!(counts.set_clipboard_data, 0);
    }

    #[test]
    fn external_change_before_conditional_write_has_no_clipboard_or_input_calls() {
        let mut platform = FakePlatform::at_sequence(41);
        platform.external_clipboard_change();

        assert_eq!(
            platform.write_clipboard_if_sequence(41, &WritePayload::TextUtf8(b"private".to_vec())),
            Err(PlatformError::ClipboardChanged)
        );
        assert_eq!(
            platform.send_input_if_sequence(
                41,
                &[InputEvent {
                    key: PhysicalKey::V,
                    state: KeyState::Down
                }]
            ),
            Err(PlatformError::ClipboardChanged)
        );
        let counts = platform.counts();
        assert_eq!(counts.empty_clipboard, 0);
        assert_eq!(counts.set_clipboard_data, 0);
        assert_eq!(counts.send_input, 0);
    }

    #[test]
    fn successful_conditional_write_advances_sequence_and_external_change_blocks_input() {
        let mut platform = FakePlatform::at_sequence(41);
        let written = platform
            .write_clipboard_if_sequence(41, &WritePayload::TextUtf8(b"private".to_vec()))
            .unwrap();
        assert_eq!(written, 42);

        platform.external_clipboard_change();
        assert_eq!(
            platform.send_input_if_sequence(
                written,
                &[InputEvent {
                    key: PhysicalKey::V,
                    state: KeyState::Down
                }]
            ),
            Err(PlatformError::ClipboardChanged)
        );
        let counts = platform.counts();
        assert_eq!(counts.empty_clipboard, 1);
        assert_eq!(counts.set_clipboard_data, 1);
        assert_eq!(counts.send_input, 0);
    }

    #[test]
    fn matching_sequence_allows_one_conditional_write_and_input_call() {
        let mut platform = FakePlatform::at_sequence(41);
        let written = platform
            .write_clipboard_if_sequence(41, &WritePayload::TextUtf8(b"private".to_vec()))
            .unwrap();
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
        let accepted = platform.send_input_if_sequence(written, &events).unwrap();
        assert_eq!(written, 42);
        assert_eq!(accepted, 4);
        let counts = platform.counts();
        assert_eq!(counts.empty_clipboard, 1);
        assert_eq!(counts.set_clipboard_data, 1);
        assert_eq!(counts.send_input, 1);
    }
}

#![cfg(windows)]

use std::mem::size_of;
use std::ptr::{null, null_mut};
use std::time::Instant;

use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, GlobalFree, HANDLE, HGLOBAL, HWND};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardOwner, GetClipboardSequenceNumber, OpenClipboard,
    SetClipboardData,
};
use windows_sys::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
use windows_sys::Win32::System::SystemInformation::GetTickCount64;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
    KEYEVENTF_KEYUP, SendInput, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_RCONTROL, VK_RETURN,
    VK_RMENU, VK_RSHIFT, VK_RWIN, VK_V,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, GetForegroundWindow, GetWindowThreadProcessId, IsIconic, IsWindow,
    SW_SHOWNOACTIVATE, SetForegroundWindow, ShowWindow, WS_DISABLED, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_POPUP,
};

use crate::dib::is_supported_dib;
use crate::platform::{
    ClipboardSequence, InputEvent, KeyState, NativePlatform, PhysicalKey, PlatformError,
    WindowHandle, WindowIdentity, WritePayload,
};
use crate::protocol::MAX_IMAGE_DIB_BYTES;

const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
const MAX_INPUT_EVENTS: usize = 32;

// CF_DIB and CF_UNICODETEXT are standard clipboard formats. windows-sys exposes
// these constants from Win32_System_Ole, which this helper intentionally does
// not enable just for two numeric format IDs.
const FORMAT_DIB: u32 = 8;
const FORMAT_UNICODETEXT: u32 = 13;

/// Win32 implementation for the helper's dedicated worker thread.
///
/// The hidden STATIC window is retained for this object's lifetime because
/// OpenClipboard(NULL) followed by EmptyClipboard makes SetClipboardData fail.
pub struct Win32Platform {
    clipboard_owner: usize,
}

impl Win32Platform {
    /// Returns the creation FILETIME of this helper process for READY identity binding.
    pub fn current_process_created_at() -> Result<u64, PlatformError> {
        let process = unsafe { GetCurrentProcess() };
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if process.is_null()
            || unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) }
                == 0
        {
            return Err(PlatformError::BackendUnavailable);
        }
        Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
    }

    /// Creates an invisible, non-activating system STATIC window to own writes.
    pub fn new() -> Result<Self, PlatformError> {
        const STATIC_CLASS: [u16; 7] = [
            b'S' as u16,
            b'T' as u16,
            b'A' as u16,
            b'T' as u16,
            b'I' as u16,
            b'C' as u16,
            0,
        ];
        const EMPTY_TITLE: [u16; 1] = [0];

        // STATIC is a built-in USER32 class, so CreateWindowExW needs no module
        // lookup or class registration (and no additional windows-sys feature).
        let owner = unsafe {
            CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                STATIC_CLASS.as_ptr(),
                EMPTY_TITLE.as_ptr(),
                WS_POPUP | WS_DISABLED,
                0,
                0,
                0,
                0,
                null_mut(),
                null_mut(),
                null_mut(),
                null(),
            )
        };
        if owner.is_null() {
            return Err(PlatformError::BackendUnavailable);
        }
        Ok(Self {
            clipboard_owner: owner as usize,
        })
    }

    fn owner_hwnd(&self) -> HWND {
        self.clipboard_owner as HWND
    }

    fn write_clipboard_checked(
        &mut self,
        baseline: ClipboardSequence,
        payload: &WritePayload,
        relative_deadline: Option<Instant>,
        deadline_tick_ms: Option<u64>,
    ) -> Result<ClipboardSequence, PlatformError> {
        if selection_deadline_expired(relative_deadline, deadline_tick_ms) {
            return Err(PlatformError::DeadlineExpired);
        }
        let (format, bytes) = clipboard_bytes(payload)?;
        let mut allocation = GlobalAllocation::copy_from(&bytes)?;

        let mut clipboard = ClipboardLock::open(self.owner_hwnd())?;
        // OpenClipboard serializes writers. The baseline and deadline are checked
        // while holding the lock, immediately before the first destructive call.
        if unsafe { GetClipboardSequenceNumber() } != baseline {
            return Err(PlatformError::ClipboardChanged);
        }
        if selection_deadline_expired(relative_deadline, deadline_tick_ms) {
            return Err(PlatformError::DeadlineExpired);
        }
        if unsafe { EmptyClipboard() } == 0 {
            return Err(PlatformError::BackendUnavailable);
        }

        let transferred = unsafe { SetClipboardData(format, allocation.handle as HANDLE) };
        if transferred.is_null() {
            // The clipboard was emptied, but the process retains allocation
            // ownership on failure; GlobalAllocation frees it on drop.
            return Err(PlatformError::BackendUnavailable);
        }

        // SetClipboardData transfers the movable global block to Windows only
        // on success. It was unlocked before transfer as required by Win32.
        allocation.transfer_to_system();
        clipboard.close()?;

        // CloseClipboard can synthesize additional formats and advance the sequence.
        // A value sampled inside the write lock is therefore not the committed
        // sequence that the later paste must compare against.
        self.committed_clipboard_sequence()
    }

    fn committed_clipboard_sequence(&self) -> Result<ClipboardSequence, PlatformError> {
        let owner = self.owner_hwnd();
        let mut clipboard = ClipboardLock::open(owner)?;
        // Another writer may have acquired the clipboard after our first close.
        // Serialize with it and reject its contents instead of acknowledging its
        // sequence as ours. Opening the lock alone never changes clipboard owner.
        if unsafe { GetClipboardOwner() } != owner {
            return Err(PlatformError::ClipboardChanged);
        }
        let sequence = unsafe { GetClipboardSequenceNumber() };
        clipboard.close()?;
        Ok(sequence)
    }

    fn validate_identity(&mut self, expected: WindowIdentity) -> Result<HWND, PlatformError> {
        if expected.handle == 0 {
            return Err(PlatformError::InvalidTarget);
        }
        let hwnd = expected.handle as HWND;
        if self.window_identity(expected.handle)? != Some(expected) {
            return Err(PlatformError::InvalidTarget);
        }
        Ok(hwnd)
    }
}

fn selection_deadline_expired(
    relative_deadline: Option<Instant>,
    deadline_tick_ms: Option<u64>,
) -> bool {
    relative_deadline.is_some_and(|deadline| Instant::now() >= deadline)
        || deadline_tick_ms.is_some_and(|deadline| unsafe { GetTickCount64() } >= deadline)
}

fn send_input_checked(
    expected_sequence: ClipboardSequence,
    events: &[InputEvent],
    relative_deadline: Option<Instant>,
    deadline_tick_ms: Option<u64>,
) -> Result<usize, PlatformError> {
    if events.is_empty() || events.len() > MAX_INPUT_EVENTS {
        return Err(PlatformError::InputRejected);
    }

    let inputs: Vec<INPUT> = events.iter().copied().map(input_event).collect();
    let count = u32::try_from(inputs.len()).map_err(|_| PlatformError::InputRejected)?;
    let input_size = i32::try_from(size_of::<INPUT>()).map_err(|_| PlatformError::InputRejected)?;

    // Check the deadlines after native INPUT construction. Keep the clipboard sequence
    // read immediately adjacent to the single SendInput call.
    if selection_deadline_expired(relative_deadline, deadline_tick_ms) {
        return Err(PlatformError::DeadlineExpired);
    }
    if unsafe { GetClipboardSequenceNumber() } != expected_sequence {
        return Err(PlatformError::ClipboardChanged);
    }
    let inserted = unsafe { SendInput(count, inputs.as_ptr(), input_size) };
    Ok(inserted as usize)
}

impl NativePlatform for Win32Platform {
    fn clipboard_sequence(&mut self) -> Result<ClipboardSequence, PlatformError> {
        Ok(unsafe { GetClipboardSequenceNumber() })
    }

    fn tick_count_ms(&mut self) -> u64 {
        unsafe { GetTickCount64() }
    }

    fn write_clipboard_if_sequence(
        &mut self,
        baseline: ClipboardSequence,
        payload: &WritePayload,
    ) -> Result<ClipboardSequence, PlatformError> {
        self.write_clipboard_checked(baseline, payload, None, None)
    }

    fn write_clipboard_if_sequence_before_deadline(
        &mut self,
        baseline: ClipboardSequence,
        payload: &WritePayload,
        relative_deadline: Instant,
        deadline_tick_ms: Option<u64>,
    ) -> Result<ClipboardSequence, PlatformError> {
        self.write_clipboard_checked(baseline, payload, Some(relative_deadline), deadline_tick_ms)
    }

    fn window_identity(
        &mut self,
        handle: WindowHandle,
    ) -> Result<Option<WindowIdentity>, PlatformError> {
        if handle == 0 {
            return Ok(None);
        }
        let hwnd = handle as HWND;
        if unsafe { IsWindow(hwnd) } == 0 {
            return Ok(None);
        }

        let mut process_id = 0u32;
        let thread_id = unsafe { GetWindowThreadProcessId(hwnd, &mut process_id) };
        if thread_id == 0 || process_id == 0 {
            return Ok(None);
        }

        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
        if process.is_null() {
            return Ok(None);
        }
        let _process = ProcessHandle(process);

        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) }
            == 0
        {
            return Ok(None);
        }

        // Detect destruction or HWND reuse during the process-time query.
        let mut confirmed_process_id = 0u32;
        if unsafe { IsWindow(hwnd) } == 0
            || unsafe { GetWindowThreadProcessId(hwnd, &mut confirmed_process_id) } != thread_id
            || confirmed_process_id != process_id
        {
            return Ok(None);
        }

        let created_at =
            (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
        Ok(Some(WindowIdentity {
            handle,
            process_id,
            process_created_at: created_at,
        }))
    }

    fn foreground_window(&mut self) -> Result<Option<WindowIdentity>, PlatformError> {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_null() {
            return Ok(None);
        }
        self.window_identity(hwnd as usize)
    }

    fn is_window_minimized(&mut self, target: WindowIdentity) -> Result<bool, PlatformError> {
        let hwnd = self.validate_identity(target)?;
        Ok(unsafe { IsIconic(hwnd) } != 0)
    }

    fn restore_window(&mut self, target: WindowIdentity) -> Result<(), PlatformError> {
        let hwnd = self.validate_identity(target)?;
        // ShowWindow's return value reports prior visibility, not success.
        unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
        if self.window_identity(target.handle)? != Some(target) {
            return Err(PlatformError::InvalidTarget);
        }
        if unsafe { IsIconic(hwnd) } != 0 {
            return Err(PlatformError::BackendUnavailable);
        }
        Ok(())
    }

    fn set_foreground_window(&mut self, target: WindowIdentity) -> Result<(), PlatformError> {
        let hwnd = self.validate_identity(target)?;
        if unsafe { SetForegroundWindow(hwnd) } == 0 {
            return Err(PlatformError::ForegroundDenied);
        }
        // Cross-thread input queues process activation asynchronously. A successful
        // request may still leave GetForegroundWindow reporting the host briefly;
        // run_paste's bounded wait and final foreground checks confirm the handoff.
        Ok(())
    }

    fn is_key_down(&mut self, key: PhysicalKey) -> Result<bool, PlatformError> {
        let virtual_key = virtual_key(key);
        Ok((unsafe { GetAsyncKeyState(i32::from(virtual_key)) } as u16 & 0x8000) != 0)
    }

    fn send_input_if_sequence(
        &mut self,
        expected_sequence: ClipboardSequence,
        events: &[InputEvent],
    ) -> Result<usize, PlatformError> {
        send_input_checked(expected_sequence, events, None, None)
    }

    fn send_input_if_sequence_before_deadline(
        &mut self,
        expected_sequence: ClipboardSequence,
        events: &[InputEvent],
        relative_deadline: Option<Instant>,
        deadline_tick_ms: Option<u64>,
    ) -> Result<usize, PlatformError> {
        send_input_checked(
            expected_sequence,
            events,
            relative_deadline,
            deadline_tick_ms,
        )
    }
}

struct ClipboardLock {
    open: bool,
}

impl ClipboardLock {
    fn open(owner: HWND) -> Result<Self, PlatformError> {
        if owner.is_null() {
            return Err(PlatformError::BackendUnavailable);
        }
        if unsafe { OpenClipboard(owner) } == 0 {
            return Err(PlatformError::ClipboardBusy);
        }
        Ok(Self { open: true })
    }

    fn close(&mut self) -> Result<(), PlatformError> {
        if !self.open {
            return Ok(());
        }
        self.open = false;
        if unsafe { CloseClipboard() } == 0 {
            Err(PlatformError::BackendUnavailable)
        } else {
            Ok(())
        }
    }
}

impl Drop for ClipboardLock {
    fn drop(&mut self) {
        if self.open {
            self.open = false;
            unsafe { CloseClipboard() };
        }
    }
}

struct GlobalAllocation {
    handle: HGLOBAL,
    owned_by_process: bool,
}

impl GlobalAllocation {
    fn copy_from(bytes: &[u8]) -> Result<Self, PlatformError> {
        if bytes.is_empty() {
            return Err(PlatformError::InvalidTarget);
        }
        let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) };
        if handle.is_null() {
            return Err(PlatformError::BackendUnavailable);
        }
        let allocation = Self {
            handle,
            owned_by_process: true,
        };
        let destination = unsafe { GlobalLock(handle) };
        if destination.is_null() {
            return Err(PlatformError::BackendUnavailable);
        }
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), destination.cast::<u8>(), bytes.len());
            // For a fresh movable allocation, the single successful lock is
            // balanced by this unlock. A zero result is also the normal value
            // when the lock count reaches zero.
            GlobalUnlock(handle);
        }
        Ok(allocation)
    }

    fn transfer_to_system(&mut self) {
        self.owned_by_process = false;
    }
}

impl Drop for GlobalAllocation {
    fn drop(&mut self) {
        if self.owned_by_process && !self.handle.is_null() {
            unsafe { GlobalFree(self.handle) };
        }
    }
}

struct ProcessHandle(HANDLE);

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

fn clipboard_bytes(payload: &WritePayload) -> Result<(u32, Vec<u8>), PlatformError> {
    match payload {
        WritePayload::TextUtf8(utf8) => {
            if utf8.len() > MAX_TEXT_BYTES {
                return Err(PlatformError::InvalidTarget);
            }
            let text = std::str::from_utf8(utf8).map_err(|_| PlatformError::InvalidTarget)?;
            if text.contains('\0') {
                return Err(PlatformError::InvalidTarget);
            }
            let mut utf16: Vec<u16> = text.encode_utf16().collect();
            utf16.push(0);
            let mut bytes = Vec::with_capacity(utf16.len() * size_of::<u16>());
            for unit in utf16 {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
            Ok((FORMAT_UNICODETEXT, bytes))
        }
        WritePayload::ImageDib(dib) => {
            if dib.len() > MAX_IMAGE_DIB_BYTES || !is_supported_dib(dib) {
                return Err(PlatformError::InvalidTarget);
            }
            Ok((FORMAT_DIB, dib.clone()))
        }
    }
}

fn virtual_key(key: PhysicalKey) -> u16 {
    match key {
        PhysicalKey::Enter => VK_RETURN,
        PhysicalKey::V => VK_V,
        PhysicalKey::LeftControl => VK_LCONTROL,
        PhysicalKey::RightControl => VK_RCONTROL,
        PhysicalKey::LeftAlt => VK_LMENU,
        PhysicalKey::RightAlt => VK_RMENU,
        PhysicalKey::LeftShift => VK_LSHIFT,
        PhysicalKey::RightShift => VK_RSHIFT,
        PhysicalKey::LeftWindows => VK_LWIN,
        PhysicalKey::RightWindows => VK_RWIN,
    }
}

fn input_event(event: InputEvent) -> INPUT {
    let virtual_key = virtual_key(event.key);
    let mut flags = if event.state == KeyState::Up {
        KEYEVENTF_KEYUP
    } else {
        0
    };
    if matches!(
        event.key,
        PhysicalKey::RightControl
            | PhysicalKey::RightAlt
            | PhysicalKey::LeftWindows
            | PhysicalKey::RightWindows
    ) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: virtual_key,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::thread;
    use std::time::Duration;
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetFocus, SetFocus};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, DestroyWindow, DispatchMessageW, ES_MULTILINE, GUITHREADINFO,
        GetGUIThreadInfo, GetWindowTextW, MSG, PM_REMOVE, PeekMessageW, SW_SHOWNORMAL,
        SendMessageW, TranslateMessage, WS_EX_APPWINDOW, WS_OVERLAPPEDWINDOW,
    };

    use crate::paste::{JobGate, PasteOutcome, PasteSpec, run_paste};
    use crate::protocol::Target;

    // Explicit Windows regressions use synthetic clipboard fixtures. The final
    // integration test sends input only to editable windows it creates and owns.
    static CLIPBOARD_TEST_LOCK: Mutex<()> = Mutex::new(());

    struct OwnedTestWindow(HWND);

    impl Drop for OwnedTestWindow {
        fn drop(&mut self) {
            unsafe { DestroyWindow(self.0) };
        }
    }

    fn owned_edit_window(text: &str, position: i32) -> OwnedTestWindow {
        let class: Vec<u16> = "EDIT\0".encode_utf16().collect();
        let text: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_APPWINDOW,
                class.as_ptr(),
                text.as_ptr(),
                WS_OVERLAPPEDWINDOW | ES_MULTILINE as u32,
                position,
                position,
                540,
                180,
                null_mut(),
                null_mut(),
                null_mut(),
                null(),
            )
        };
        assert!(
            !hwnd.is_null(),
            "create an editable window owned by this test"
        );
        OwnedTestWindow(hwnd)
    }

    fn pump_owned_window_messages() {
        let mut message = MSG::default();
        while unsafe { PeekMessageW(&mut message, null_mut(), 0, 0, PM_REMOVE) } != 0 {
            // Dispatch only this thread's own created windows; never inspect or
            // operate any pre-existing application window.
            if !message.hwnd.is_null() {
                unsafe {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
        }
    }

    fn owned_window_text(window: &OwnedTestWindow) -> String {
        let mut text = [0u16; 128];
        let count = unsafe { GetWindowTextW(window.0, text.as_mut_ptr(), text.len() as i32) };
        String::from_utf16(&text[..count as usize]).unwrap()
    }

    #[test]
    #[ignore = "explicit Windows regression: writes synthetic clipboard text, no SendInput"]
    fn windows_text_commit_returns_the_post_close_sequence() {
        let _serial = CLIPBOARD_TEST_LOCK.lock().unwrap();
        let mut platform = Win32Platform::new().unwrap();
        let baseline = platform.clipboard_sequence().unwrap();
        let committed = platform
            .write_clipboard_if_sequence(
                baseline,
                &WritePayload::TextUtf8(b"CLIPNEST_SYNTHETIC_SEQUENCE_TEXT".to_vec()),
            )
            .unwrap();

        assert_eq!(committed, unsafe { GetClipboardSequenceNumber() });
        assert_eq!(unsafe { GetClipboardOwner() }, platform.owner_hwnd());
        assert_eq!(platform.committed_clipboard_sequence().unwrap(), committed);
    }

    #[test]
    #[ignore = "explicit Windows regression: writes a synthetic 2x1 DIB, no SendInput"]
    fn windows_dib_commit_returns_the_post_close_sequence() {
        let _serial = CLIPBOARD_TEST_LOCK.lock().unwrap();
        let mut platform = Win32Platform::new().unwrap();
        let mut dib = vec![0u8; 48];
        dib[0..4].copy_from_slice(&40u32.to_le_bytes());
        dib[4..8].copy_from_slice(&2i32.to_le_bytes());
        dib[8..12].copy_from_slice(&(-1i32).to_le_bytes());
        dib[12..14].copy_from_slice(&1u16.to_le_bytes());
        dib[14..16].copy_from_slice(&32u16.to_le_bytes());
        dib[20..24].copy_from_slice(&8u32.to_le_bytes());
        dib[40..48].copy_from_slice(&[0, 0, 255, 255, 0, 255, 0, 255]);
        let baseline = platform.clipboard_sequence().unwrap();
        let committed = platform
            .write_clipboard_if_sequence(baseline, &WritePayload::ImageDib(dib))
            .unwrap();

        assert_eq!(committed, unsafe { GetClipboardSequenceNumber() });
        assert_eq!(unsafe { GetClipboardOwner() }, platform.owner_hwnd());
        assert_eq!(platform.committed_clipboard_sequence().unwrap(), committed);
    }

    #[test]
    #[ignore = "explicit Windows regression: two synthetic clipboard writers, no SendInput"]
    fn windows_post_close_sample_rejects_a_different_clipboard_writer() {
        let _serial = CLIPBOARD_TEST_LOCK.lock().unwrap();
        let mut helper = Win32Platform::new().unwrap();
        let mut external = Win32Platform::new().unwrap();
        let baseline = helper.clipboard_sequence().unwrap();
        let helper_sequence = helper
            .write_clipboard_if_sequence(
                baseline,
                &WritePayload::TextUtf8(b"CLIPNEST_SYNTHETIC_HELPER_WRITE".to_vec()),
            )
            .unwrap();
        let external_sequence = external
            .write_clipboard_if_sequence(
                helper_sequence,
                &WritePayload::TextUtf8(b"CLIPNEST_SYNTHETIC_EXTERNAL_WRITE".to_vec()),
            )
            .unwrap();

        // Recreate the competing ownership state at the exact post-close
        // sampler used by the production writer.
        assert_eq!(
            helper.committed_clipboard_sequence(),
            Err(PlatformError::ClipboardChanged)
        );
        assert_eq!(unsafe { GetClipboardOwner() }, external.owner_hwnd());
        assert_eq!(unsafe { GetClipboardSequenceNumber() }, external_sequence);
        assert_eq!(
            external.committed_clipboard_sequence().unwrap(),
            external_sequence
        );
    }

    #[test]
    #[ignore = "explicit Windows product integration: SendInput only to test-owned EDIT windows"]
    fn windows_owned_edit_receives_one_native_paste_at_the_original_caret() {
        let _serial = CLIPBOARD_TEST_LOCK.lock().unwrap();
        let mut platform = Win32Platform::new().unwrap();
        let _clipboard_owner = OwnedTestWindow(platform.owner_hwnd());
        let target_window = owned_edit_window("LEFT|RIGHT", 120);
        let host_window = owned_edit_window("ClipNest native integration host", 160);

        unsafe { ShowWindow(target_window.0, SW_SHOWNORMAL) };
        assert_ne!(unsafe { SetForegroundWindow(target_window.0) }, 0);
        unsafe { SetFocus(target_window.0) };
        pump_owned_window_messages();
        assert_eq!(unsafe { GetForegroundWindow() }, target_window.0);
        assert_eq!(unsafe { GetFocus() }, target_window.0);

        // Standard EDIT selection messages need no additional Controls feature.
        const EM_SETSEL: u32 = 0x00b1;
        const EM_GETSEL: u32 = 0x00b0;
        unsafe { SendMessageW(target_window.0, EM_SETSEL, 4, 4) };
        let original_selection = unsafe { SendMessageW(target_window.0, EM_GETSEL, 0, 0) } as u32;
        assert_eq!(
            (original_selection & 0xffff, original_selection >> 16),
            (4, 4)
        );
        let mut caret_info = GUITHREADINFO {
            cbSize: size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        assert_ne!(unsafe { GetGUIThreadInfo(0, &mut caret_info) }, 0);
        assert_eq!(
            caret_info.hwndCaret, target_window.0,
            "use a real Windows EDIT caret"
        );
        let target = platform.foreground_window().unwrap().unwrap();

        unsafe { ShowWindow(host_window.0, SW_SHOWNORMAL) };
        assert_ne!(unsafe { SetForegroundWindow(host_window.0) }, 0);
        unsafe { SetFocus(host_window.0) };
        pump_owned_window_messages();
        assert_eq!(unsafe { GetForegroundWindow() }, host_window.0);
        let host = platform.foreground_window().unwrap().unwrap();
        let process_id = unsafe { GetCurrentProcessId() };
        assert_eq!(target.process_id, process_id);
        assert_eq!(host.process_id, process_id);

        let baseline = platform.clipboard_sequence().unwrap();
        let sequence = platform
            .write_clipboard_if_sequence(
                baseline,
                &WritePayload::TextUtf8(b"CLIPNEST_NATIVE_PASTE".to_vec()),
            )
            .unwrap();
        assert_eq!(unsafe { GetClipboardOwner() }, platform.owner_hwnd());
        assert_ne!(unsafe { AllowSetForegroundWindow(process_id) }, 0);
        let identity = |window: WindowIdentity| Target {
            hwnd: window.handle.to_string(),
            pid: window.process_id,
            process_created_at: window.process_created_at.to_string(),
        };
        let spec = PasteSpec::from_protocol(
            &identity(host),
            &identity(target),
            &sequence.to_string(),
            &[],
            Instant::now(),
        )
        .unwrap();
        assert_eq!(
            run_paste(&mut platform, &spec, &JobGate::new()),
            PasteOutcome::InputSubmitted
        );

        let expected = "LEFTCLIPNEST_NATIVE_PASTE|RIGHT";
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            pump_owned_window_messages();
            if owned_window_text(&target_window) == expected || Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(unsafe { GetForegroundWindow() }, target_window.0);
        assert_eq!(unsafe { GetFocus() }, target_window.0);
        assert_eq!(owned_window_text(&target_window), expected);
        assert_eq!(
            owned_window_text(&host_window),
            "ClipNest native integration host"
        );

        let target_handle = target_window.0;
        let host_handle = host_window.0;
        drop(host_window);
        drop(target_window);
        assert_eq!(unsafe { IsWindow(target_handle) }, 0);
        assert_eq!(unsafe { IsWindow(host_handle) }, 0);
        println!(
            "PASS: owned EDIT HWND/PID/creation identities, actual caret at 4, stable clipboard owner/sequence, authorized native focus handoff, one SendInput Ctrl+V, exact inserted text, owned windows destroyed"
        );
    }
}

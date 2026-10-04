use std::io::{self, Write};
use std::time::{SystemTime, UNIX_EPOCH};

use clipnest_native_helper::control;
use clipnest_native_helper::win32::Win32Platform;

fn helper_instance_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}-{nanos}", std::process::id())
}

fn stable_profile_id() -> Result<String, &'static str> {
    let value = std::env::var("CLIPNEST_STABLE_PROFILE_ID").map_err(|_| "profile_id_missing")?;
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("profile_id_invalid");
    }
    Ok(value)
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let profile_id = stable_profile_id().map_err(io::Error::other)?;
    let helper_pid = std::process::id();
    let helper_process_created_at = Win32Platform::current_process_created_at()
        .map_err(|_| io::Error::other("process_identity_unavailable"))?;
    let platform = Win32Platform::new().map_err(|_| io::Error::other("win32_setup_failed"))?;
    control::run(
        helper_instance_id(),
        helper_pid,
        helper_process_created_at,
        profile_id,
        platform,
        io::stdin(),
        io::stdout(),
    )?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        // Only fixed error labels are written; protocol payloads and profile IDs are never logged.
        let _ = writeln!(io::stderr(), "clipnest-helper unavailable: {error}");
        std::process::exit(2);
    }
}

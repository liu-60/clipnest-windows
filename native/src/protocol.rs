use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};

use base64::Engine as _;
use serde::{Deserialize, Serialize, de::Visitor};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub const MAX_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_BUFFER_BYTES: usize = 256 * 1024;
pub const MAX_RAW_CHUNK_BYTES: usize = 32 * 1024;
pub const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
/// The compressed source-image limit is enforced before conversion by the host provider.
pub const MAX_COMPRESSED_IMAGE_SOURCE_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_IMAGE_PIXELS: u64 = 16_000_000;
/// Worst-case 32bpp BITMAPINFOHEADER DIB size for the accepted pixel limit.
pub const MAX_IMAGE_DIB_BYTES: usize = MAX_IMAGE_PIXELS as usize * 4 + 40;
const MAX_ID_BYTES: usize = 128;

#[derive(Debug)]
pub enum ProtocolError {
    Io(io::Error),
    InvalidFrame(&'static str),
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "I/O failure: {error}"),
            Self::InvalidFrame(reason) => write!(formatter, "{reason}"),
        }
    }
}

impl std::error::Error for ProtocolError {}

impl From<io::Error> for ProtocolError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Envelope {
    pub request_id: String,
    pub generation: String,
    pub helper_instance_id: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RequestKind {
    Capture {},
    RegisterContent {
        job_id: String,
        object_token: String,
        item_ref: String,
        expected_item_version: String,
        content_type: ContentType,
        total_bytes: u64,
        total_hash: String,
        inline_base64: Option<String>,
    },
    ContentChunk {
        job_id: String,
        object_token: String,
        index: u32,
        offset: u64,
        base64: String,
        chunk_hash: String,
    },
    FinishContent {
        job_id: String,
        object_token: String,
        total_hash: String,
    },
    Prepare {
        job_id: String,
        object_token: String,
        expected_item_version: String,
    },
    CommitWrite {
        job_id: String,
        prepare_token: String,
        baseline_clipboard_sequence: String,
        // Zero requests an immediate key-state check after the original cutoff.
        #[serde(default = "default_selection_budget_ms")]
        selection_budget_ms: u16,
        #[serde(default)]
        selection_deadline_tick_ms: Option<u64>,
        trigger_keys: Vec<TriggerKey>,
    },
    Paste {
        job_id: String,
        prepare_token: String,
        host_window: Target,
        target: Target,
        expected_clipboard_sequence: String,
        trigger_keys: Vec<TriggerKey>,
    },
    Cancel {
        job_id: Option<String>,
    },
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContentType {
    Text,
    Image,
}

#[derive(Debug, Deserialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "PascalCase")]
pub enum TriggerKey {
    Enter,
    V,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub hwnd: String,
    pub pid: u32,
    pub process_created_at: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Request {
    pub envelope: Envelope,
    pub kind: RequestKind,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeResult {
    v: u8,
    request_id: String,
    generation: String,
    helper_instance_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    helper_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    helper_process_created_at: Option<String>,
    status: ResultStatus,
    duration_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    object_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prepare_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    clipboard_sequence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<Target>,
    #[serde(skip_serializing_if = "Option::is_none")]
    inserted_inputs: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    worker_quiescent: Option<bool>,
}

impl NativeResult {
    pub fn ready(instance_id: String, helper_pid: u32, helper_process_created_at: u64) -> Self {
        Self {
            v: 1,
            request_id: "startup".to_owned(),
            generation: "startup".to_owned(),
            helper_instance_id: instance_id,
            helper_pid: Some(helper_pid),
            helper_process_created_at: Some(helper_process_created_at.to_string()),
            status: ResultStatus::Ready,
            duration_ms: 0.0,
            job_id: None,
            object_token: None,
            prepare_token: None,
            clipboard_sequence: None,
            target: None,
            inserted_inputs: None,
            reason_code: None,
            worker_quiescent: None,
        }
    }

    pub fn for_request(request: &Request, status: ResultStatus) -> Self {
        let job_id = request.kind.job_id().map(str::to_owned);
        Self {
            v: 1,
            request_id: request.envelope.request_id.clone(),
            generation: request.envelope.generation.clone(),
            helper_instance_id: request.envelope.helper_instance_id.clone(),
            helper_pid: None,
            helper_process_created_at: None,
            status,
            duration_ms: 0.0,
            job_id,
            object_token: None,
            prepare_token: None,
            clipboard_sequence: None,
            target: None,
            inserted_inputs: None,
            reason_code: None,
            worker_quiescent: None,
        }
    }

    pub fn job_finished(
        request_id: String,
        generation: String,
        helper_instance_id: String,
        job_id: String,
    ) -> Self {
        Self {
            v: 1,
            request_id,
            generation,
            helper_instance_id,
            helper_pid: None,
            helper_process_created_at: None,
            status: ResultStatus::JobFinished,
            duration_ms: 0.0,
            job_id: Some(job_id),
            object_token: None,
            prepare_token: None,
            clipboard_sequence: None,
            target: None,
            inserted_inputs: None,
            reason_code: None,
            worker_quiescent: Some(true),
        }
    }

    pub fn with_object_token(mut self, token: String) -> Self {
        self.object_token = Some(token);
        self
    }

    pub fn with_prepare_token(mut self, token: String) -> Self {
        self.prepare_token = Some(token);
        self
    }

    pub fn with_clipboard_sequence(mut self, sequence: u32) -> Self {
        self.clipboard_sequence = Some(sequence.to_string());
        self
    }

    pub fn with_target(mut self, target: Target) -> Self {
        self.target = Some(target);
        self
    }

    pub fn with_inserted_inputs(mut self, inserted_inputs: u8) -> Self {
        self.inserted_inputs = Some(inserted_inputs);
        self
    }

    pub fn with_worker_quiescent(mut self, quiescent: bool) -> Self {
        self.worker_quiescent = Some(quiescent);
        self
    }

    pub fn with_duration_ms(mut self, duration_ms: f64) -> Self {
        self.duration_ms = duration_ms.max(0.0);
        self
    }

    pub fn with_reason(mut self, reason: &'static str) -> Self {
        self.reason_code = Some(reason.to_owned());
        self
    }
}

#[derive(Debug, Serialize, PartialEq, Eq, Copy, Clone)]
#[serde(rename_all = "snake_case")]
pub enum ResultStatus {
    Ready,
    Captured,
    ContentRegistered,
    ChunkAccepted,
    Prepared,
    ClipboardWritten,
    InputSubmitted,
    Busy,
    PayloadInvalid,
    KeyHeld,
    CopiedOnly,
    TargetInvalid,
    FocusDenied,
    ModifierHeld,
    ClipboardChanged,
    InputRejected,
    HelperUnavailable,
    Cancelled,
    TooLate,
    JobFinished,
}

impl RequestKind {
    fn job_id(&self) -> Option<&str> {
        match self {
            Self::Capture {} => None,
            Self::RegisterContent { job_id, .. }
            | Self::ContentChunk { job_id, .. }
            | Self::FinishContent { job_id, .. }
            | Self::Prepare { job_id, .. }
            | Self::CommitWrite { job_id, .. }
            | Self::Paste { job_id, .. } => Some(job_id),
            Self::Cancel { job_id } => job_id.as_deref(),
        }
    }
}

enum StrictJson {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<StrictJson>),
    Object(BTreeMap<String, StrictJson>),
}

impl StrictJson {
    fn into_value(self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Bool(value) => Value::Bool(value),
            Self::Number(value) => Value::Number(value),
            Self::String(value) => Value::String(value),
            Self::Array(values) => Value::Array(values.into_iter().map(Self::into_value).collect()),
            Self::Object(values) => Value::Object(Map::from_iter(
                values
                    .into_iter()
                    .map(|(key, value)| (key, value.into_value())),
            )),
        }
    }
}

impl<'de> Deserialize<'de> for StrictJson {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct StrictValueVisitor;
        impl<'de> Visitor<'de> for StrictValueVisitor {
            type Value = StrictJson;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("strict JSON without duplicate object keys")
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(StrictJson::Null)
            }

            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
                Ok(StrictJson::Bool(value))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
                Ok(StrictJson::Number(value.into()))
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
                Ok(StrictJson::Number(value.into()))
            }

            fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                serde_json::Number::from_f64(value)
                    .map(StrictJson::Number)
                    .ok_or_else(|| E::custom("invalid JSON number"))
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(StrictJson::String(value.to_owned()))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
                Ok(StrictJson::String(value))
            }

            fn visit_seq<M>(self, mut sequence: M) -> Result<Self::Value, M::Error>
            where
                M: serde::de::SeqAccess<'de>,
            {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<StrictJson>()? {
                    values.push(value);
                }
                Ok(StrictJson::Array(values))
            }

            fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
            where
                M: serde::de::MapAccess<'de>,
            {
                let mut values = BTreeMap::new();
                while let Some((key, value)) = map.next_entry::<String, StrictJson>()? {
                    if values.insert(key, value).is_some() {
                        return Err(serde::de::Error::custom("duplicate field"));
                    }
                }
                Ok(StrictJson::Object(values))
            }
        }
        deserializer.deserialize_any(StrictValueVisitor)
    }
}

pub fn read_frame<R: BufRead>(reader: &mut R) -> Result<Option<Vec<u8>>, ProtocolError> {
    let mut frame = Vec::with_capacity(1024);
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if frame.is_empty() {
                return Ok(None);
            }
            return Err(ProtocolError::InvalidFrame("unterminated JSON line"));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let segment_len = newline.unwrap_or(available.len());
        if frame.len() + segment_len > MAX_FRAME_BYTES {
            return Err(ProtocolError::InvalidFrame("frame exceeds 64 KiB"));
        }
        frame.extend_from_slice(&available[..segment_len]);
        let consumed = segment_len + usize::from(newline.is_some());
        reader.consume(consumed);
        if newline.is_some() {
            if frame.last() == Some(&b'\r') {
                frame.pop();
            }
            if frame.is_empty() {
                return Err(ProtocolError::InvalidFrame("empty JSON line"));
            }
            return Ok(Some(frame));
        }
    }
}

pub fn decode_request(bytes: &[u8], instance_id: &str) -> Result<Request, ProtocolError> {
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::InvalidFrame("frame exceeds 64 KiB"));
    }
    let mut object = match serde_json::from_slice(bytes)
        .map_err(|_| ProtocolError::InvalidFrame("malformed JSON object"))?
    {
        StrictJson::Object(object) => object,
        _ => return Err(ProtocolError::InvalidFrame("request must be a JSON object")),
    };
    let version = take_u64(&mut object, "v")?;
    if version != 1 {
        return Err(ProtocolError::InvalidFrame("unsupported protocol version"));
    }
    let request_id = take_string(&mut object, "requestId", MAX_ID_BYTES)?;
    let generation = take_string(&mut object, "generation", MAX_ID_BYTES)?;
    let helper_instance_id = take_string(&mut object, "helperInstanceId", MAX_ID_BYTES)?;
    let kind = serde_json::from_value::<RequestKind>(Value::Object(Map::from_iter(
        object
            .into_iter()
            .map(|(key, value)| (key, value.into_value())),
    )))
    .map_err(|_| ProtocolError::InvalidFrame("unknown kind or fields"))?;
    validate_request(&kind)?;
    if helper_instance_id != instance_id {
        return Err(ProtocolError::InvalidFrame("helper instance mismatch"));
    }
    Ok(Request {
        envelope: Envelope {
            request_id,
            generation,
            helper_instance_id,
        },
        kind,
    })
}

fn take_string(
    object: &mut BTreeMap<String, StrictJson>,
    key: &'static str,
    max_bytes: usize,
) -> Result<String, ProtocolError> {
    let Some(StrictJson::String(value)) = object.remove(key) else {
        return Err(ProtocolError::InvalidFrame(
            "missing or invalid envelope field",
        ));
    };
    if value.is_empty() || value.len() > max_bytes {
        return Err(ProtocolError::InvalidFrame("invalid envelope field length"));
    }
    Ok(value)
}

fn take_u64(
    object: &mut BTreeMap<String, StrictJson>,
    key: &'static str,
) -> Result<u64, ProtocolError> {
    object
        .remove(key)
        .and_then(|value| match value {
            StrictJson::Number(number) => number.as_u64(),
            _ => None,
        })
        .ok_or(ProtocolError::InvalidFrame(
            "missing or invalid protocol version",
        ))
}

fn validate_request(kind: &RequestKind) -> Result<(), ProtocolError> {
    let bad = || ProtocolError::InvalidFrame("invalid request field");
    match kind {
        RequestKind::Capture {} => Ok(()),
        RequestKind::RegisterContent {
            job_id,
            object_token,
            item_ref,
            expected_item_version,
            content_type,
            total_bytes,
            total_hash,
            inline_base64,
        } => {
            if !valid_id(job_id)
                || !valid_id(object_token)
                || !valid_id(item_ref)
                || !valid_id(expected_item_version)
                || !valid_hash(total_hash)
            {
                return Err(bad());
            }
            let limit = match content_type {
                ContentType::Text => MAX_TEXT_BYTES,
                ContentType::Image => MAX_IMAGE_DIB_BYTES,
            };
            if *total_bytes > limit as u64 {
                return Err(bad());
            }
            if let Some(encoded) = inline_base64 {
                let raw = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| bad())?;
                if raw.len() > MAX_RAW_CHUNK_BYTES
                    || raw.len() as u64 != *total_bytes
                    || sha256_hex(&raw) != *total_hash
                {
                    return Err(bad());
                }
            }
            Ok(())
        }
        RequestKind::ContentChunk {
            job_id,
            object_token,
            index: _,
            offset: _,
            base64: encoded,
            chunk_hash,
        } => {
            if !valid_id(job_id) || !valid_id(object_token) || !valid_hash(chunk_hash) {
                return Err(bad());
            }
            let raw = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| bad())?;
            if raw.is_empty() || raw.len() > MAX_RAW_CHUNK_BYTES || sha256_hex(&raw) != *chunk_hash
            {
                return Err(bad());
            }
            Ok(())
        }
        RequestKind::FinishContent {
            job_id,
            object_token,
            total_hash,
        } => {
            if valid_id(job_id) && valid_id(object_token) && valid_hash(total_hash) {
                Ok(())
            } else {
                Err(bad())
            }
        }
        RequestKind::Prepare {
            job_id,
            object_token,
            expected_item_version,
        } => {
            if valid_id(job_id) && valid_id(object_token) && valid_id(expected_item_version) {
                Ok(())
            } else {
                Err(bad())
            }
        }
        RequestKind::CommitWrite {
            job_id,
            prepare_token,
            baseline_clipboard_sequence,
            selection_budget_ms,
            selection_deadline_tick_ms,
            trigger_keys,
        } => {
            if valid_id(job_id)
                && valid_id(prepare_token)
                && valid_u64_decimal(baseline_clipboard_sequence, false)
                && (0..=500).contains(selection_budget_ms)
                && selection_deadline_tick_ms
                    .is_none_or(|deadline| deadline <= 9_007_199_254_740_991)
                && valid_triggers(trigger_keys)
            {
                Ok(())
            } else {
                Err(bad())
            }
        }
        RequestKind::Paste {
            job_id,
            prepare_token,
            host_window,
            target,
            expected_clipboard_sequence,
            trigger_keys,
        } => {
            if valid_id(job_id)
                && valid_id(prepare_token)
                && valid_u64_decimal(expected_clipboard_sequence, false)
                && valid_target(host_window)
                && valid_target(target)
                && valid_triggers(trigger_keys)
            {
                Ok(())
            } else {
                Err(bad())
            }
        }
        RequestKind::Cancel { job_id } => {
            if job_id.as_ref().is_none_or(|value| valid_id(value)) {
                Ok(())
            } else {
                Err(bad())
            }
        }
    }
}

fn default_selection_budget_ms() -> u16 {
    500
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_ID_BYTES
}

fn valid_decimal(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
}

fn valid_u64_decimal(value: &str, nonzero: bool) -> bool {
    valid_decimal(value) && value.parse::<u64>().is_ok() && (!nonzero || value != "0")
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_target(target: &Target) -> bool {
    valid_u64_decimal(&target.hwnd, true)
        && target.pid > 0
        && valid_u64_decimal(&target.process_created_at, false)
}

fn valid_triggers(keys: &[TriggerKey]) -> bool {
    keys.len() <= 2
        && !(keys.contains(&TriggerKey::Enter) && keys.contains(&TriggerKey::V))
        && keys
            .iter()
            .enumerate()
            .all(|(index, key)| !keys[..index].contains(key))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn write_result<W: Write>(writer: &mut W, result: &NativeResult) -> Result<(), ProtocolError> {
    let bytes = serde_json::to_vec(result)
        .map_err(|_| ProtocolError::InvalidFrame("result serialization failed"))?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::InvalidFrame("result exceeds 64 KiB"));
    }
    writer.write_all(&bytes)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

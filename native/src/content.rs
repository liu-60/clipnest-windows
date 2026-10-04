//! Bounded, single-job content staging. The caller must flush each correlated result and call
//! `acknowledge` before reading the next frame; no path or external resource is read here.

use std::collections::HashSet;
use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};

use crate::protocol::{
    ContentType, MAX_IMAGE_DIB_BYTES, MAX_RAW_CHUNK_BYTES, MAX_TEXT_BYTES, Request, RequestKind,
};

#[derive(Debug, PartialEq, Eq)]
pub enum StageError {
    NoActiveJob,
    Busy,
    NotContentStage,
    InvalidIdentity,
    WrongHelperInstance,
    StaleGeneration,
    WrongJob,
    StaleObjectToken,
    DuplicateRequest,
    InvalidContent,
    OutOfOrder,
    CapacityExceeded,
    Incomplete,
    StaleItemVersion,
    AlreadyPrepared,
    RequestUnacknowledged,
    WrongAcknowledgement,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum PayloadType {
    Text,
    Image,
}

#[derive(Debug, PartialEq, Eq)]
pub struct PreparedContent {
    pub job_id: String,
    pub object_token: String,
    pub prepare_token: String,
    pub item_ref: String,
    pub item_version: String,
    pub content_type: PayloadType,
    pub bytes: Arc<[u8]>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StageData {
    ContentRegistered {
        job_id: String,
        object_token: String,
    },
    ChunkAccepted {
        job_id: String,
        index: u32,
        next_offset: u64,
    },
    ContentComplete {
        job_id: String,
    },
    Prepared(PreparedContent),
    Cancelled {
        job_id: Option<String>,
    },
}

pub struct ContentStore {
    helper_instance_id: String,
    stable_profile_id: String,
    active: Option<JobState>,
    pending_ack: Option<String>,
}

struct JobState {
    generation: String,
    helper_instance_id: String,
    stable_profile_id: String,
    job_id: String,
    object_token: String,
    item_ref: String,
    item_version: String,
    content_type: PayloadType,
    total_bytes: usize,
    total_hash: String,
    next_index: u32,
    hasher: Sha256,
    staged: Vec<u8>,
    content: Option<Arc<[u8]>>,
    prepared: bool,
    request_ids: HashSet<String>,
}

impl ContentStore {
    pub fn new(helper_instance_id: impl Into<String>) -> Self {
        Self::new_for_profile(helper_instance_id, "")
    }

    pub fn new_for_profile(
        helper_instance_id: impl Into<String>,
        stable_profile_id: impl Into<String>,
    ) -> Self {
        Self {
            helper_instance_id: helper_instance_id.into(),
            stable_profile_id: stable_profile_id.into(),
            active: None,
            pending_ack: None,
        }
    }

    pub fn process(&mut self, request: &Request) -> Result<StageData, StageError> {
        if self.pending_ack.is_some() {
            return Err(StageError::RequestUnacknowledged);
        }
        if request.envelope.helper_instance_id != self.helper_instance_id {
            return Err(StageError::WrongHelperInstance);
        }
        if !matches!(
            request.kind,
            RequestKind::RegisterContent { .. }
                | RequestKind::ContentChunk { .. }
                | RequestKind::FinishContent { .. }
                | RequestKind::Prepare { .. }
                | RequestKind::Cancel { .. }
        ) {
            return Err(StageError::NotContentStage);
        }
        let result = match &request.kind {
            RequestKind::RegisterContent {
                job_id,
                object_token,
                item_ref,
                expected_item_version,
                content_type,
                total_bytes,
                total_hash,
                inline_base64,
            } => self.register(
                request,
                job_id,
                object_token,
                item_ref,
                expected_item_version,
                content_type,
                *total_bytes,
                total_hash,
                inline_base64.as_deref(),
            ),
            RequestKind::ContentChunk {
                job_id,
                object_token,
                index,
                offset,
                base64,
                chunk_hash,
            } => self.chunk(
                request,
                job_id,
                object_token,
                *index,
                *offset,
                base64,
                chunk_hash,
            ),
            RequestKind::FinishContent {
                job_id,
                object_token,
                total_hash,
            } => self.finish(request, job_id, object_token, total_hash),
            RequestKind::Prepare {
                job_id,
                object_token,
                expected_item_version,
            } => self.prepare(request, job_id, object_token, expected_item_version),
            RequestKind::Cancel { job_id } => self.cancel(request, job_id.as_deref()),
            _ => unreachable!("content stage matched above"),
        };
        // The caller must flush a correlated result and acknowledge it before processing another
        // request. This applies to rejected stages too, so an error reply cannot be overtaken.
        self.pending_ack = Some(request.envelope.request_id.clone());
        result
    }

    pub fn acknowledge(&mut self, request_id: &str) -> Result<(), StageError> {
        match self.pending_ack.as_deref() {
            Some(expected) if expected == request_id => {
                self.pending_ack = None;
                Ok(())
            }
            Some(_) => Err(StageError::WrongAcknowledgement),
            None => Err(StageError::WrongAcknowledgement),
        }
    }

    /// Drop the payload when its owning job reaches a terminal result.
    pub fn release_job(
        &mut self,
        generation: &str,
        helper_instance_id: &str,
        job_id: &str,
    ) -> Result<(), StageError> {
        let state = self.active.as_ref().ok_or(StageError::NoActiveJob)?;
        if helper_instance_id != self.helper_instance_id
            || helper_instance_id != state.helper_instance_id
        {
            return Err(StageError::WrongHelperInstance);
        }
        if generation != state.generation {
            return Err(StageError::StaleGeneration);
        }
        if job_id != state.job_id {
            return Err(StageError::WrongJob);
        }
        self.active = None;
        Ok(())
    }

    /// A restart invalidates every generation-bound object and token.
    pub fn restart(&mut self, helper_instance_id: impl Into<String>) {
        self.active = None;
        self.pending_ack = None;
        self.helper_instance_id = helper_instance_id.into();
    }

    pub fn has_active_job(&self) -> bool {
        self.active.is_some()
    }

    fn register(
        &mut self,
        request: &Request,
        job_id: &str,
        object_token: &str,
        item_ref: &str,
        item_version: &str,
        content_type: &ContentType,
        total_bytes: u64,
        total_hash: &str,
        inline: Option<&str>,
    ) -> Result<StageData, StageError> {
        if self.active.is_some() {
            return Err(StageError::Busy);
        }
        if !valid_id(&request.envelope.generation)
            || !valid_id(&request.envelope.request_id)
            || !valid_id(job_id)
            || !valid_id(object_token)
            || !valid_id(item_ref)
            || !valid_id(item_version)
            || !valid_hash(total_hash)
        {
            return Err(StageError::InvalidIdentity);
        }
        let content_type = match content_type {
            ContentType::Text => PayloadType::Text,
            ContentType::Image => PayloadType::Image,
        };
        let limit = match content_type {
            PayloadType::Text => MAX_TEXT_BYTES,
            PayloadType::Image => MAX_IMAGE_DIB_BYTES,
        };
        if total_bytes > limit as u64 {
            return Err(StageError::CapacityExceeded);
        }
        let total_bytes = total_bytes as usize;
        let mut hasher = Sha256::new();
        let (staged, content) = if let Some(encoded) = inline {
            let raw = STANDARD
                .decode(encoded)
                .map_err(|_| StageError::InvalidContent)?;
            if raw.len() > MAX_RAW_CHUNK_BYTES
                || raw.len() != total_bytes
                || sha256_hex(&raw) != total_hash
            {
                return Err(StageError::InvalidContent);
            }
            hasher.update(&raw);
            (Vec::new(), Some(Arc::from(raw)))
        } else {
            let mut staged = Vec::new();
            staged
                .try_reserve_exact(total_bytes)
                .map_err(|_| StageError::CapacityExceeded)?;
            (staged, None)
        };
        let mut request_ids = HashSet::new();
        request_ids.insert(request.envelope.request_id.clone());
        self.active = Some(JobState {
            generation: request.envelope.generation.clone(),
            helper_instance_id: self.helper_instance_id.clone(),
            stable_profile_id: self.stable_profile_id.clone(),
            job_id: job_id.to_owned(),
            object_token: object_token.to_owned(),
            item_ref: item_ref.to_owned(),
            item_version: item_version.to_owned(),
            content_type,
            total_bytes,
            total_hash: total_hash.to_owned(),
            next_index: 0,
            hasher,
            staged,
            content,
            prepared: false,
            request_ids,
        });
        Ok(StageData::ContentRegistered {
            job_id: job_id.to_owned(),
            object_token: object_token.to_owned(),
        })
    }

    fn chunk(
        &mut self,
        request: &Request,
        job_id: &str,
        token: &str,
        index: u32,
        offset: u64,
        encoded: &str,
        chunk_hash: &str,
    ) -> Result<StageData, StageError> {
        let result = self.bound_state(request, job_id, token).and_then(|state| {
            if state.prepared {
                return Err(StageError::AlreadyPrepared);
            }
            let raw = STANDARD
                .decode(encoded)
                .map_err(|_| StageError::InvalidContent)?;
            if raw.is_empty()
                || raw.len() > MAX_RAW_CHUNK_BYTES
                || !valid_hash(chunk_hash)
                || sha256_hex(&raw) != chunk_hash
            {
                return Err(StageError::InvalidContent);
            }
            if index != state.next_index || offset != state.staged.len() as u64 {
                return Err(StageError::OutOfOrder);
            }
            if raw.len() > state.total_bytes.saturating_sub(state.staged.len()) {
                return Err(StageError::CapacityExceeded);
            }
            state.hasher.update(&raw);
            state.staged.extend_from_slice(&raw);
            state.next_index = state
                .next_index
                .checked_add(1)
                .ok_or(StageError::CapacityExceeded)?;
            Ok(StageData::ChunkAccepted {
                job_id: job_id.to_owned(),
                index,
                next_offset: state.staged.len() as u64,
            })
        });
        if invalidates(&result) {
            self.active = None;
        }
        result
    }

    fn finish(
        &mut self,
        request: &Request,
        job_id: &str,
        token: &str,
        claimed_hash: &str,
    ) -> Result<StageData, StageError> {
        let result = self.bound_state(request, job_id, token).and_then(|state| {
            if state.prepared {
                return Err(StageError::AlreadyPrepared);
            }
            if state.staged.len() != state.total_bytes {
                return Err(StageError::Incomplete);
            }
            let actual_hash = hex(&state.hasher.clone().finalize());
            if !valid_hash(claimed_hash)
                || claimed_hash != state.total_hash
                || actual_hash != state.total_hash
            {
                return Err(StageError::InvalidContent);
            }
            let bytes = std::mem::take(&mut state.staged);
            state.content = Some(Arc::from(bytes));
            Ok(StageData::ContentComplete {
                job_id: job_id.to_owned(),
            })
        });
        if invalidates(&result) {
            self.active = None;
        }
        result
    }

    fn prepare(
        &mut self,
        request: &Request,
        job_id: &str,
        token: &str,
        version: &str,
    ) -> Result<StageData, StageError> {
        let result = self.bound_state(request, job_id, token).and_then(|state| {
            if state.prepared {
                return Err(StageError::AlreadyPrepared);
            }
            if version != state.item_version {
                return Err(StageError::StaleItemVersion);
            }
            let bytes = state.content.clone().ok_or(StageError::Incomplete)?;
            let prepare_token = make_prepare_token(state, &request.envelope.request_id);
            state.prepared = true;
            Ok(StageData::Prepared(PreparedContent {
                job_id: state.job_id.clone(),
                object_token: state.object_token.clone(),
                prepare_token,
                item_ref: state.item_ref.clone(),
                item_version: state.item_version.clone(),
                content_type: state.content_type,
                bytes,
            }))
        });
        if invalidates(&result) {
            self.active = None;
        }
        result
    }

    fn cancel(
        &mut self,
        request: &Request,
        requested_job_id: Option<&str>,
    ) -> Result<StageData, StageError> {
        let Some(state) = self.active.as_mut() else {
            return Ok(StageData::Cancelled {
                job_id: requested_job_id.map(str::to_owned),
            });
        };
        if request.envelope.generation != state.generation {
            return Err(StageError::StaleGeneration);
        }
        if let Some(job_id) = requested_job_id {
            if job_id != state.job_id {
                return Err(StageError::WrongJob);
            }
        }
        if !state
            .request_ids
            .insert(request.envelope.request_id.clone())
        {
            self.active = None;
            return Err(StageError::DuplicateRequest);
        }
        let job_id = Some(state.job_id.clone());
        self.active = None;
        Ok(StageData::Cancelled { job_id })
    }

    fn bound_state<'a>(
        &'a mut self,
        request: &Request,
        job_id: &str,
        token: &str,
    ) -> Result<&'a mut JobState, StageError> {
        let state = self.active.as_mut().ok_or(StageError::NoActiveJob)?;
        if state.helper_instance_id != request.envelope.helper_instance_id {
            return Err(StageError::WrongHelperInstance);
        }
        if state.generation != request.envelope.generation {
            return Err(StageError::StaleGeneration);
        }
        if state.job_id != job_id {
            return Err(StageError::WrongJob);
        }
        if state.object_token != token {
            return Err(StageError::StaleObjectToken);
        }
        if !valid_id(&request.envelope.request_id) {
            return Err(StageError::InvalidIdentity);
        }
        if !state
            .request_ids
            .insert(request.envelope.request_id.clone())
        {
            return Err(StageError::DuplicateRequest);
        }
        Ok(state)
    }
}

fn invalidates<T>(result: &Result<T, StageError>) -> bool {
    matches!(
        result,
        Err(StageError::DuplicateRequest
            | StageError::InvalidContent
            | StageError::OutOfOrder
            | StageError::CapacityExceeded
            | StageError::Incomplete
            | StageError::StaleItemVersion)
    )
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn make_prepare_token(state: &JobState, request_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"clipnest-prepare-v1\0");
    for value in [
        &state.generation,
        &state.helper_instance_id,
        &state.stable_profile_id,
        &state.job_id,
        &state.object_token,
        &state.item_ref,
        &state.item_version,
        &state.total_hash,
        &request_id.to_owned(),
    ] {
        hash.update((value.len() as u64).to_be_bytes());
        hash.update(value.as_bytes());
    }
    format!("p1_{}", hex(&hash.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Envelope, RequestKind};

    const INSTANCE: &str = "instance-1";
    fn hash(bytes: &[u8]) -> String {
        sha256_hex(bytes)
    }
    fn req(id: &str, kind: RequestKind) -> Request {
        Request {
            envelope: Envelope {
                request_id: id.into(),
                generation: "generation-1".into(),
                helper_instance_id: INSTANCE.into(),
            },
            kind,
        }
    }
    fn register(id: &str, bytes: &[u8], inline: Option<String>) -> Request {
        req(
            id,
            RequestKind::RegisterContent {
                job_id: "job-1".into(),
                object_token: "object-1".into(),
                item_ref: "item-1".into(),
                expected_item_version: "version-1".into(),
                content_type: ContentType::Text,
                total_bytes: bytes.len() as u64,
                total_hash: hash(bytes),
                inline_base64: inline,
            },
        )
    }
    fn prepare(id: &str, version: &str, token: &str) -> Request {
        req(
            id,
            RequestKind::Prepare {
                job_id: "job-1".into(),
                object_token: token.into(),
                expected_item_version: version.into(),
            },
        )
    }
    fn apply(store: &mut ContentStore, request: &Request) -> Result<StageData, StageError> {
        let request_id = request.envelope.request_id.clone();
        let result = store.process(request);
        if store.pending_ack.as_deref() == Some(request_id.as_str()) {
            store.acknowledge(&request_id).unwrap();
        }
        result
    }
    fn chunk(
        id: &str,
        bytes: &[u8],
        index: u32,
        offset: u64,
        token: &str,
        claimed_hash: Option<&str>,
    ) -> Request {
        req(
            id,
            RequestKind::ContentChunk {
                job_id: "job-1".into(),
                object_token: token.into(),
                index,
                offset,
                base64: STANDARD.encode(bytes),
                chunk_hash: claimed_hash.unwrap_or(&hash(bytes)).into(),
            },
        )
    }

    #[test]
    fn inline_content_is_bound_and_prepared_immutably() {
        let bytes = b"safe text";
        let mut store = ContentStore::new(INSTANCE);
        assert!(matches!(
            apply(
                &mut store,
                &register("r1", bytes, Some(STANDARD.encode(bytes)))
            ),
            Ok(StageData::ContentRegistered { .. })
        ));
        let StageData::Prepared(prepared) =
            apply(&mut store, &prepare("r2", "version-1", "object-1")).unwrap()
        else {
            panic!()
        };
        assert_eq!(&*prepared.bytes, bytes);
        assert!(prepared.prepare_token.starts_with("p1_"));
        assert_eq!(
            apply(&mut store, &chunk("r3", b"x", 0, 0, "object-1", None)),
            Err(StageError::AlreadyPrepared)
        );
    }

    #[test]
    fn next_stage_waits_for_correlated_acknowledgement() {
        let mut store = ContentStore::new(INSTANCE);
        let registration = register("r1", b"x", None);
        store.process(&registration).unwrap();
        let next = chunk("r2", b"x", 0, 0, "object-1", None);
        assert_eq!(store.process(&next), Err(StageError::RequestUnacknowledged));
        assert_eq!(
            store.acknowledge("wrong-id"),
            Err(StageError::WrongAcknowledgement)
        );
        store.acknowledge("r1").unwrap();
        assert!(matches!(
            store.process(&next),
            Ok(StageData::ChunkAccepted { .. })
        ));
        store.acknowledge("r2").unwrap();
    }

    #[test]
    fn chunked_content_requires_contiguous_acked_chunks_and_total_hash() {
        let bytes = vec![b'x'; 40_000];
        let mut store = ContentStore::new(INSTANCE);
        apply(&mut store, &register("r1", &bytes, None)).unwrap();
        assert_eq!(
            apply(
                &mut store,
                &chunk("r2", &bytes[..32_768], 0, 0, "object-1", None)
            ),
            Ok(StageData::ChunkAccepted {
                job_id: "job-1".into(),
                index: 0,
                next_offset: 32_768
            })
        );
        apply(
            &mut store,
            &chunk("r3", &bytes[32_768..], 1, 32_768, "object-1", None),
        )
        .unwrap();
        let finish = req(
            "r4",
            RequestKind::FinishContent {
                job_id: "job-1".into(),
                object_token: "object-1".into(),
                total_hash: hash(&bytes),
            },
        );
        assert_eq!(
            apply(&mut store, &finish),
            Ok(StageData::ContentComplete {
                job_id: "job-1".into()
            })
        );
        let StageData::Prepared(prepared) =
            apply(&mut store, &prepare("r5", "version-1", "object-1")).unwrap()
        else {
            panic!()
        };
        assert_eq!(&*prepared.bytes, bytes.as_slice());
    }

    #[test]
    fn gaps_replays_and_hash_failures_invalidate_the_record() {
        let bytes = b"ab";
        let mut store = ContentStore::new(INSTANCE);
        apply(&mut store, &register("r1", bytes, None)).unwrap();
        assert_eq!(
            apply(&mut store, &chunk("r2", b"a", 1, 0, "object-1", None)),
            Err(StageError::OutOfOrder)
        );
        assert!(!store.has_active_job());
        assert_eq!(
            apply(&mut store, &prepare("r3", "version-1", "object-1")),
            Err(StageError::NoActiveJob)
        );

        apply(&mut store, &register("r4", bytes, None)).unwrap();
        apply(&mut store, &chunk("replay", b"a", 0, 0, "object-1", None)).unwrap();
        assert_eq!(
            apply(&mut store, &chunk("replay", b"b", 1, 1, "object-1", None)),
            Err(StageError::DuplicateRequest)
        );
        assert_eq!(
            apply(&mut store, &prepare("r5", "version-1", "object-1")),
            Err(StageError::NoActiveJob)
        );

        apply(&mut store, &register("r6", bytes, None)).unwrap();
        assert_eq!(
            apply(
                &mut store,
                &chunk("r7", b"a", 0, 0, "object-1", Some(&hash(b"wrong")))
            ),
            Err(StageError::InvalidContent)
        );
        assert!(!store.has_active_job());
    }

    #[test]
    fn stale_token_is_rejected_without_poisoning_valid_state() {
        let bytes = b"z";
        let mut store = ContentStore::new(INSTANCE);
        apply(&mut store, &register("r1", bytes, None)).unwrap();
        assert_eq!(
            apply(&mut store, &chunk("r2", bytes, 0, 0, "old-token", None)),
            Err(StageError::StaleObjectToken)
        );
        apply(&mut store, &chunk("r3", bytes, 0, 0, "object-1", None)).unwrap();
        apply(
            &mut store,
            &req(
                "r4",
                RequestKind::FinishContent {
                    job_id: "job-1".into(),
                    object_token: "object-1".into(),
                    total_hash: hash(bytes),
                },
            ),
        )
        .unwrap();
        assert!(matches!(
            apply(&mut store, &prepare("r5", "version-1", "object-1")),
            Ok(StageData::Prepared(_))
        ));
    }

    #[test]
    fn capacity_item_version_and_instance_are_bound() {
        let mut store = ContentStore::new(INSTANCE);
        let too_big = Request {
            envelope: req("large", RequestKind::Capture {}).envelope,
            kind: RequestKind::RegisterContent {
                job_id: "job-1".into(),
                object_token: "object-1".into(),
                item_ref: "item-1".into(),
                expected_item_version: "version-1".into(),
                content_type: ContentType::Image,
                total_bytes: (MAX_IMAGE_DIB_BYTES as u64) + 1,
                total_hash: hash(b""),
                inline_base64: None,
            },
        };
        assert_eq!(
            apply(&mut store, &too_big),
            Err(StageError::CapacityExceeded)
        );
        assert!(!store.has_active_job());

        let bytes = b"v";
        apply(
            &mut store,
            &register("r1", bytes, Some(STANDARD.encode(bytes))),
        )
        .unwrap();
        let mut wrong_instance = prepare("r2", "version-1", "object-1");
        wrong_instance.envelope.helper_instance_id = "instance-old".into();
        assert_eq!(
            apply(&mut store, &wrong_instance),
            Err(StageError::WrongHelperInstance)
        );
        // Prepare intentionally carries no itemRef. The registration snapshot
        // already binds the item, and the resulting token retains that binding.
        assert!(matches!(
            apply(&mut store, &prepare("r3", "version-1", "object-1")),
            Ok(StageData::Prepared(_))
        ));
        store
            .release_job("generation-1", INSTANCE, "job-1")
            .unwrap();

        apply(
            &mut store,
            &register("r4", bytes, Some(STANDARD.encode(bytes))),
        )
        .unwrap();
        assert_eq!(
            apply(&mut store, &prepare("r5", "version-old", "object-1")),
            Err(StageError::StaleItemVersion)
        );
        assert_eq!(
            apply(&mut store, &prepare("r6", "version-1", "object-1")),
            Err(StageError::NoActiveJob)
        );
    }

    #[test]
    fn prepare_tokens_are_scoped_to_the_stable_profile_and_registered_item() {
        fn token_for(profile_id: &str, item_ref: &str) -> String {
            let mut store = ContentStore::new_for_profile(INSTANCE, profile_id);
            let bytes = b"profile content";
            let mut registration = register("r1", bytes, Some(STANDARD.encode(bytes)));
            if let RequestKind::RegisterContent {
                item_ref: registered_item,
                ..
            } = &mut registration.kind
            {
                *registered_item = item_ref.to_owned();
            }
            apply(&mut store, &registration).unwrap();
            let StageData::Prepared(result) =
                apply(&mut store, &prepare("r2", "version-1", "object-1")).unwrap()
            else {
                panic!()
            };
            result.prepare_token
        }
        assert_ne!(
            token_for("profile-a", "item-1"),
            token_for("profile-b", "item-1")
        );
        assert_ne!(token_for("", "item-1"), token_for("profile-a", "item-1"));
        assert_ne!(
            token_for("profile-a", "item-1"),
            token_for("profile-a", "item-2")
        );
    }

    #[test]
    fn cancel_completion_and_restart_release_bound_payloads() {
        let mut store = ContentStore::new(INSTANCE);
        apply(
            &mut store,
            &register("r1", b"x", Some(STANDARD.encode(b"x"))),
        )
        .unwrap();
        apply(
            &mut store,
            &req(
                "r2",
                RequestKind::Cancel {
                    job_id: Some("job-1".into()),
                },
            ),
        )
        .unwrap();
        assert!(!store.has_active_job());
        apply(
            &mut store,
            &register("r3", b"x", Some(STANDARD.encode(b"x"))),
        )
        .unwrap();
        store
            .release_job("generation-1", INSTANCE, "job-1")
            .unwrap();
        assert!(!store.has_active_job());
        apply(
            &mut store,
            &register("r4", b"x", Some(STANDARD.encode(b"x"))),
        )
        .unwrap();
        store.restart("instance-2");
        assert!(!store.has_active_job());
        assert_eq!(
            apply(&mut store, &req("r5", RequestKind::Capture {})),
            Err(StageError::WrongHelperInstance)
        );
    }
}

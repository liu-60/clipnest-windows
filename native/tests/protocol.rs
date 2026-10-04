use std::io::Cursor;

use clipnest_native_helper::protocol::{
    MAX_FRAME_BYTES, MAX_IMAGE_DIB_BYTES, ProtocolError, decode_request, read_frame,
};

fn frame(kind: &str, extra: &str) -> Vec<u8> {
    format!(
        "{{\"v\":1,\"requestId\":\"r1\",\"generation\":\"g1\",\"helperInstanceId\":\"i1\",\"kind\":\"{kind}\"{extra}}}"
    )
    .into_bytes()
}

#[test]
fn reads_one_bounded_line_and_rejects_missing_terminator() {
    let mut input = Cursor::new(b"{\"ok\":true}\n".to_vec());
    assert_eq!(read_frame(&mut input).unwrap().unwrap(), b"{\"ok\":true}");
    assert!(read_frame(&mut input).unwrap().is_none());

    let mut unterminated = Cursor::new(b"{\"ok\":true}".to_vec());
    assert!(matches!(
        read_frame(&mut unterminated),
        Err(ProtocolError::InvalidFrame(_))
    ));
}

#[test]
fn rejects_frames_over_the_limit_before_deserializing() {
    let input = vec![b'a'; MAX_FRAME_BYTES + 1];
    let mut cursor = Cursor::new(input);
    assert!(matches!(
        read_frame(&mut cursor),
        Err(ProtocolError::InvalidFrame(_))
    ));
}

#[test]
fn rejects_duplicate_unknown_stale_and_unsupported_envelopes() {
    let duplicate = br#"{"v":1,"requestId":"first","requestId":"second","generation":"g1","helperInstanceId":"i1","kind":"capture"}"#;
    assert!(decode_request(duplicate, "i1").is_err());
    assert!(decode_request(&frame("capture", ",\"unexpected\":true"), "i1").is_err());
    assert!(decode_request(&frame("capture", ""), "different-instance").is_err());
    let unsupported =
        br#"{"v":2,"requestId":"r1","generation":"g1","helperInstanceId":"i1","kind":"capture"}"#;
    assert!(decode_request(unsupported, "i1").is_err());

    let nested_duplicate = br#"{"v":1,"requestId":"r1","generation":"g1","helperInstanceId":"i1","kind":"paste","jobId":"j1","prepareToken":"p1","hostWindow":{"hwnd":"28","pid":27,"processCreatedAt":"30"},"target":{"hwnd":"18","hwnd":"19","pid":10,"processCreatedAt":"20"},"expectedClipboardSequence":"7","triggerKeys":["Enter"]}"#;
    assert!(decode_request(nested_duplicate, "i1").is_err());
}

#[test]
fn validates_decimal_window_identity_and_chunk_hash() {
    let bad_target = frame(
        "paste",
        ",\"jobId\":\"j1\",\"prepareToken\":\"p1\",\"hostWindow\":{\"hwnd\":\"28\",\"pid\":27,\"processCreatedAt\":\"30\"},\"target\":{\"hwnd\":\"01\",\"pid\":10,\"processCreatedAt\":\"20\"},\"expectedClipboardSequence\":\"7\",\"triggerKeys\":[\"Enter\"]",
    );
    assert!(decode_request(&bad_target, "i1").is_err());

    let bad_chunk = frame(
        "content_chunk",
        ",\"jobId\":\"j1\",\"objectToken\":\"o1\",\"index\":0,\"offset\":0,\"base64\":\"aGVsbG8=\",\"chunkHash\":\"0000000000000000000000000000000000000000000000000000000000000000\"",
    );
    assert!(decode_request(&bad_chunk, "i1").is_err());
}

#[test]
fn rejects_out_of_range_targets_and_duplicate_trigger_keys() {
    let wide_target = frame(
        "paste",
        ",\"jobId\":\"j1\",\"prepareToken\":\"p1\",\"hostWindow\":{\"hwnd\":\"28\",\"pid\":27,\"processCreatedAt\":\"30\"},\"target\":{\"hwnd\":\"18446744073709551616\",\"pid\":10,\"processCreatedAt\":\"20\"},\"expectedClipboardSequence\":\"7\",\"triggerKeys\":[\"Enter\"]",
    );
    assert!(decode_request(&wide_target, "i1").is_err());

    let duplicate_trigger = frame(
        "paste",
        ",\"jobId\":\"j1\",\"prepareToken\":\"p1\",\"hostWindow\":{\"hwnd\":\"28\",\"pid\":27,\"processCreatedAt\":\"30\"},\"target\":{\"hwnd\":\"18\",\"pid\":10,\"processCreatedAt\":\"20\"},\"expectedClipboardSequence\":\"7\",\"triggerKeys\":[\"Enter\",\"Enter\"]",
    );
    assert!(decode_request(&duplicate_trigger, "i1").is_err());
}

#[test]
fn prepare_uses_the_canonical_item_version_shape_without_item_ref() {
    let canonical = frame(
        "prepare",
        ",\"jobId\":\"j1\",\"objectToken\":\"o1\",\"expectedItemVersion\":\"version-1\"",
    );
    assert!(decode_request(&canonical, "i1").is_ok());

    let legacy_item_ref = frame(
        "prepare",
        ",\"jobId\":\"j1\",\"objectToken\":\"o1\",\"itemRef\":\"item-1\",\"expectedItemVersion\":\"version-1\"",
    );
    assert!(decode_request(&legacy_item_ref, "i1").is_err());
}

#[test]
fn click_execution_accepts_empty_trigger_keys_but_keeps_strict_values() {
    let unrelated = frame("capture", ",\"triggerKeys\":[]");
    assert!(decode_request(&unrelated, "i1").is_err());

    let commit_write = frame(
        "commit_write",
        ",\"jobId\":\"j1\",\"prepareToken\":\"p1\",\"baselineClipboardSequence\":\"7\",\"triggerKeys\":[]",
    );
    assert!(decode_request(&commit_write, "i1").is_ok());

    let check_only_write = frame(
        "commit_write",
        ",\"jobId\":\"j1\",\"prepareToken\":\"p1\",\"baselineClipboardSequence\":\"7\",\"selectionBudgetMs\":0,\"triggerKeys\":[\"Enter\"]",
    );
    assert!(decode_request(&check_only_write, "i1").is_ok());

    let invalid_budget = frame(
        "commit_write",
        ",\"jobId\":\"j1\",\"prepareToken\":\"p1\",\"baselineClipboardSequence\":\"7\",\"selectionBudgetMs\":501,\"triggerKeys\":[\"Enter\"]",
    );
    assert!(decode_request(&invalid_budget, "i1").is_err());

    let paste = frame(
        "paste",
        ",\"jobId\":\"j1\",\"prepareToken\":\"p1\",\"hostWindow\":{\"hwnd\":\"28\",\"pid\":27,\"processCreatedAt\":\"30\"},\"target\":{\"hwnd\":\"18\",\"pid\":10,\"processCreatedAt\":\"20\"},\"expectedClipboardSequence\":\"7\",\"triggerKeys\":[]",
    );
    assert!(decode_request(&paste, "i1").is_ok());

    let contradictory = frame(
        "commit_write",
        ",\"jobId\":\"j1\",\"prepareToken\":\"p1\",\"baselineClipboardSequence\":\"7\",\"triggerKeys\":[\"Enter\",\"V\"]",
    );
    assert!(decode_request(&contradictory, "i1").is_err());

    let unknown = frame(
        "paste",
        ",\"jobId\":\"j1\",\"prepareToken\":\"p1\",\"hostWindow\":{\"hwnd\":\"28\",\"pid\":27,\"processCreatedAt\":\"30\"},\"target\":{\"hwnd\":\"18\",\"pid\":10,\"processCreatedAt\":\"20\"},\"expectedClipboardSequence\":\"7\",\"triggerKeys\":[\"Click\"]",
    );
    assert!(decode_request(&unknown, "i1").is_err());
}

#[test]
fn commit_write_accepts_optional_absolute_deadline_and_preserves_legacy_frames() {
    let with_absolute_deadline = frame(
        "commit_write",
        ",\"jobId\":\"j1\",\"prepareToken\":\"p1\",\"baselineClipboardSequence\":\"7\",\"selectionDeadlineTickMs\":0,\"triggerKeys\":[]",
    );
    assert!(decode_request(&with_absolute_deadline, "i1").is_ok());

    let legacy = frame(
        "commit_write",
        ",\"jobId\":\"j1\",\"prepareToken\":\"p1\",\"baselineClipboardSequence\":\"7\",\"triggerKeys\":[]",
    );
    assert!(decode_request(&legacy, "i1").is_ok());

    let unsafe_json_tick = frame(
        "commit_write",
        ",\"jobId\":\"j1\",\"prepareToken\":\"p1\",\"baselineClipboardSequence\":\"7\",\"selectionDeadlineTickMs\":9007199254740992,\"triggerKeys\":[]",
    );
    assert!(decode_request(&unsafe_json_tick, "i1").is_err());
}

#[test]
fn image_register_limit_is_the_expanded_dib_transfer_capacity() {
    let image = |total_bytes: usize| {
        frame(
            "register_content",
            &format!(
                ",\"jobId\":\"j1\",\"objectToken\":\"o1\",\"itemRef\":\"item-1\",\"expectedItemVersion\":\"version-1\",\"contentType\":\"image\",\"totalBytes\":{total_bytes},\"totalHash\":\"{}\"",
                "a".repeat(64)
            ),
        )
    };

    assert!(decode_request(&image(MAX_IMAGE_DIB_BYTES), "i1").is_ok());
    assert!(decode_request(&image(MAX_IMAGE_DIB_BYTES + 1), "i1").is_err());
}

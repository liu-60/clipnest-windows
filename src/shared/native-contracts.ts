export type NativeTriggerKey = "Enter" | "V";

/** Compressed source limit is checked by the host before DIB conversion. */
export const MAX_COMPRESSED_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_000_000;
/** RegisterContent.image carries an expanded 32bpp DIB, not the compressed source. */
export const MAX_IMAGE_DIB_BYTES = MAX_IMAGE_PIXELS * 4 + 40;

export interface NativeTarget {
  hwnd: string;
  pid: number;
  processCreatedAt: string;
}

export interface NativeEnvelope {
  v: 1;
  requestId: string;
  generation: string;
  helperInstanceId: string;
}

export type NativeRequest = NativeEnvelope &
  (
    | { kind: "capture" }
    | {
        kind: "register_content";
        jobId: string;
        objectToken: string;
        itemRef: string;
        expectedItemVersion: string;
        contentType: "text" | "image";
        totalBytes: number;
        totalHash: string;
        inlineBase64?: string;
      }
    | {
        kind: "content_chunk";
        jobId: string;
        objectToken: string;
        index: number;
        offset: number;
        base64: string;
        chunkHash: string;
      }
    | { kind: "finish_content"; jobId: string; objectToken: string; totalHash: string }
    | { kind: "prepare"; jobId: string; objectToken: string; expectedItemVersion: string }
    | {
        kind: "commit_write";
        jobId: string;
        prepareToken: string;
        baselineClipboardSequence: string;
        /** Zero performs an immediate key-state check without reopening the wait window. */
        selectionBudgetMs?: number;
        /** Shared Windows monotonic deadline in GetTickCount64 milliseconds. */
        selectionDeadlineTickMs?: number;
        triggerKeys: NativeTriggerKey[];
      }
    | {
        kind: "paste";
        jobId: string;
        prepareToken: string;
        hostWindow: NativeTarget;
        target: NativeTarget;
        expectedClipboardSequence: string;
        triggerKeys: NativeTriggerKey[];
      }
    | { kind: "cancel"; jobId?: string }
  );

export type NativeRequestCommand = {
  [Kind in NativeRequest["kind"]]: Omit<
    Extract<NativeRequest, { kind: Kind }>,
    keyof NativeEnvelope
  >;
}[NativeRequest["kind"]];

export type NativeResultStatus =
  | "ready"
  | "captured"
  | "content_registered"
  | "chunk_accepted"
  | "prepared"
  | "clipboard_written"
  | "input_submitted"
  | "busy"
  | "payload_invalid"
  | "key_held"
  | "copied_only"
  | "target_invalid"
  | "focus_denied"
  | "modifier_held"
  | "clipboard_changed"
  | "input_rejected"
  | "helper_unavailable"
  | "cancelled"
  | "too_late"
  | "job_finished";

type NativeResultBase = NativeEnvelope & { durationMs: number };

export type NativeResult =
  | (NativeResultBase & { status: "ready"; helperPid: number; helperProcessCreatedAt: string })
  | (NativeResultBase & { status: "captured"; target: NativeTarget })
  | (NativeResultBase & { status: "content_registered" | "chunk_accepted"; jobId: string; objectToken: string })
  | (NativeResultBase & { status: "prepared"; jobId: string; prepareToken: string })
  | (NativeResultBase & { status: "clipboard_written"; jobId: string; clipboardSequence: string })
  | (NativeResultBase & { status: "input_submitted"; jobId: string; insertedInputs: 4; target: NativeTarget })
  | (NativeResultBase & { status: "input_rejected"; jobId: string; insertedInputs: number; reasonCode?: string })
  | (NativeResultBase & {
      status: "cancelled" | "too_late";
      jobId?: string;
      reasonCode?: string;
      workerQuiescent: boolean;
    })
  | (NativeResultBase & { status: "job_finished"; jobId: string; workerQuiescent: true })
  | (NativeResultBase & {
      status:
        | "busy"
        | "payload_invalid"
        | "key_held"
        | "copied_only"
        | "target_invalid"
        | "focus_denied"
        | "modifier_held"
        | "clipboard_changed"
        | "helper_unavailable";
      jobId?: string;
      reasonCode?: string;
    });

const commonResultKeys = [
  "v",
  "requestId",
  "generation",
  "helperInstanceId",
  "status",
  "durationMs",
] as const;

const optionalResultKeys = [
  "helperPid",
  "helperProcessCreatedAt",
  "jobId",
  "objectToken",
  "prepareToken",
  "clipboardSequence",
  "target",
  "insertedInputs",
  "reasonCode",
  "workerQuiescent",
] as const;

const resultStatuses = new Set<NativeResultStatus>([
  "ready",
  "captured",
  "content_registered",
  "chunk_accepted",
  "prepared",
  "clipboard_written",
  "input_submitted",
  "busy",
  "payload_invalid",
  "key_held",
  "copied_only",
  "target_invalid",
  "focus_denied",
  "modifier_held",
  "clipboard_changed",
  "input_rejected",
  "helper_unavailable",
  "cancelled",
  "too_late",
  "job_finished",
]);

function isNonEmptyString(value: unknown, maxLength = 128): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isDecimalString(value: unknown, max = "18446744073709551615"): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
  return value.length < max.length || (value.length === max.length && value <= max);
}

function owns(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNativeTarget(value: unknown): value is NativeTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return (
    Object.keys(target).length === 3 &&
    Object.keys(target).every((key) => ["hwnd", "pid", "processCreatedAt"].includes(key)) &&
    isDecimalString(target.hwnd) &&
    target.hwnd !== "0" &&
    typeof target.pid === "number" &&
    Number.isInteger(target.pid) &&
    target.pid > 0 &&
    target.pid <= 0xffffffff &&
    isDecimalString(target.processCreatedAt)
  );
}

const requestFields: Record<NativeRequest["kind"], readonly string[]> = {
  capture: [],
  register_content: [
    "jobId",
    "objectToken",
    "itemRef",
    "expectedItemVersion",
    "contentType",
    "totalBytes",
    "totalHash",
    "inlineBase64",
  ],
  content_chunk: ["jobId", "objectToken", "index", "offset", "base64", "chunkHash"],
  finish_content: ["jobId", "objectToken", "totalHash"],
  prepare: ["jobId", "objectToken", "expectedItemVersion"],
  commit_write: ["jobId", "prepareToken", "baselineClipboardSequence", "selectionBudgetMs", "selectionDeadlineTickMs", "triggerKeys"],
  paste: [
    "jobId",
    "prepareToken",
    "hostWindow",
    "target",
    "expectedClipboardSequence",
    "triggerKeys",
  ],
  cancel: ["jobId"],
};

const requestEnvelopeKeys = ["v", "requestId", "generation", "helperInstanceId", "kind"] as const;
const requestIdPattern = /^[^\u0000-\u001f]{1,128}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && requestIdPattern.test(value);
}

function isTriggerKeys(value: unknown): value is NativeTriggerKey[] {
  return Array.isArray(value) &&
    value.length <= 2 &&
    value.every((key) => key === "Enter" || key === "V") &&
    new Set(value).size === value.length &&
    !(value.includes("Enter") && value.includes("V"));
}

/** Validates the complete JSON-lines request shape before it reaches the helper pipe. */
export function isNativeRequest(value: unknown): value is NativeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  const kind = request.kind;
  if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(requestFields, kind)) return false;
  const allowed = new Set<string>([...requestEnvelopeKeys, ...requestFields[kind as NativeRequest["kind"]]]);
  if (Object.keys(request).some((key) => !allowed.has(key))) return false;
  if (
    request.v !== 1 ||
    !isRequestId(request.requestId) ||
    !isRequestId(request.generation) ||
    !isRequestId(request.helperInstanceId)
  ) return false;

  const has = (...fields: string[]) => fields.every((field) => Object.prototype.hasOwnProperty.call(request, field));
  const validJobAndToken = () => isRequestId(request.jobId) && isRequestId(request.objectToken);
  const validDecimal = (input: unknown, nonzero = false) =>
    typeof input === "string" &&
    /^(0|[1-9][0-9]*)$/.test(input) &&
    input.length <= 20 &&
    BigInt(input) <= 0xffffffffffffffffn &&
    (!nonzero || input !== "0");

  switch (kind as NativeRequest["kind"]) {
    case "capture":
      return Object.keys(request).length === requestEnvelopeKeys.length;
    case "register_content": {
      const limit = request.contentType === "text" ? 2 * 1024 * 1024 : MAX_IMAGE_DIB_BYTES;
      return has("jobId", "objectToken", "itemRef", "expectedItemVersion", "contentType", "totalBytes", "totalHash") &&
        validJobAndToken() &&
        isRequestId(request.itemRef) &&
        isRequestId(request.expectedItemVersion) &&
        (request.contentType === "text" || request.contentType === "image") &&
        typeof request.totalBytes === "number" && Number.isSafeInteger(request.totalBytes) &&
        request.totalBytes >= 0 && request.totalBytes <= limit &&
        typeof request.totalHash === "string" && hashPattern.test(request.totalHash) &&
        (!has("inlineBase64") || (
          typeof request.inlineBase64 === "string" &&
          base64Pattern.test(request.inlineBase64) &&
          request.inlineBase64.length <= 4 * Math.ceil(32 * 1024 / 3) &&
          Math.floor(request.inlineBase64.length * 3 / 4) <= 32 * 1024
        ));
    }
    case "content_chunk":
      return has("jobId", "objectToken", "index", "offset", "base64", "chunkHash") &&
        validJobAndToken() &&
        typeof request.index === "number" && Number.isInteger(request.index) && request.index >= 0 && request.index <= 0xffffffff &&
        validDecimal(String(request.offset)) &&
        typeof request.base64 === "string" && base64Pattern.test(request.base64) && request.base64.length > 0 &&
        request.base64.length <= 4 * Math.ceil(32 * 1024 / 3) &&
        Math.floor(request.base64.length * 3 / 4) <= 32 * 1024 &&
        typeof request.chunkHash === "string" && hashPattern.test(request.chunkHash);
    case "finish_content":
      return has("jobId", "objectToken", "totalHash") && validJobAndToken() &&
        typeof request.totalHash === "string" && hashPattern.test(request.totalHash);
    case "prepare":
      return has("jobId", "objectToken", "expectedItemVersion") && validJobAndToken() &&
        isRequestId(request.expectedItemVersion);
    case "commit_write":
      return has("jobId", "prepareToken", "baselineClipboardSequence", "triggerKeys") &&
        isRequestId(request.jobId) && isRequestId(request.prepareToken) &&
        validDecimal(request.baselineClipboardSequence) &&
        (!owns(request, "selectionBudgetMs") || (
          typeof request.selectionBudgetMs === "number" &&
          Number.isInteger(request.selectionBudgetMs) &&
          request.selectionBudgetMs >= 0 && request.selectionBudgetMs <= 500
        )) &&
        (!owns(request, "selectionDeadlineTickMs") || (
          typeof request.selectionDeadlineTickMs === "number" &&
          Number.isSafeInteger(request.selectionDeadlineTickMs) &&
          request.selectionDeadlineTickMs >= 0
        )) && isTriggerKeys(request.triggerKeys);
    case "paste":
      return has("jobId", "prepareToken", "hostWindow", "target", "expectedClipboardSequence", "triggerKeys") &&
        isRequestId(request.jobId) && isRequestId(request.prepareToken) &&
        isNativeTarget(request.hostWindow) && isNativeTarget(request.target) &&
        validDecimal(request.expectedClipboardSequence) && isTriggerKeys(request.triggerKeys);
    case "cancel":
      return (!has("jobId") || isRequestId(request.jobId));
  }
}

export function isNativeResult(
  value: unknown,
  expected: Pick<NativeEnvelope, "requestId" | "generation" | "helperInstanceId">,
): value is NativeResult {
  if (
    !expected ||
    !isNonEmptyString(expected.requestId) ||
    !isNonEmptyString(expected.generation) ||
    !isNonEmptyString(expected.helperInstanceId)
  ) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  const keys = Object.keys(result);

  if (
    !commonResultKeys.every((key) => owns(result, key)) ||
    result.v !== 1 ||
    !isNonEmptyString(result.requestId) ||
    !isNonEmptyString(result.generation) ||
    !isNonEmptyString(result.helperInstanceId) ||
    typeof result.status !== "string" ||
    !resultStatuses.has(result.status as NativeResultStatus) ||
    typeof result.durationMs !== "number" ||
    !Number.isFinite(result.durationMs) ||
    result.durationMs < 0
  ) {
    return false;
  }

  if (
    expected &&
    (result.requestId !== expected.requestId ||
      result.generation !== expected.generation ||
      result.helperInstanceId !== expected.helperInstanceId)
  ) {
    return false;
  }

  for (const field of ["jobId", "objectToken", "prepareToken", "reasonCode"] as const) {
    if (owns(result, field) && !isNonEmptyString(result[field])) return false;
  }
  if (owns(result, "clipboardSequence") && !isDecimalString(result.clipboardSequence)) return false;
  if (owns(result, "target") && !isNativeTarget(result.target)) return false;
  if (
    owns(result, "insertedInputs") &&
    (typeof result.insertedInputs !== "number" ||
      !Number.isInteger(result.insertedInputs) ||
      result.insertedInputs < 0 ||
      result.insertedInputs > 4)
  ) {
    return false;
  }
  if (
    owns(result, "helperPid") &&
    (typeof result.helperPid !== "number" ||
      !Number.isInteger(result.helperPid) ||
      result.helperPid <= 0 ||
      result.helperPid > 0xffffffff)
  ) return false;
  if (owns(result, "helperProcessCreatedAt") && !isDecimalString(result.helperProcessCreatedAt)) return false;

  const status = result.status as NativeResultStatus;
  const allowedByStatus: Record<NativeResultStatus, readonly string[]> = {
    ready: ["helperPid", "helperProcessCreatedAt"],
    captured: ["target"],
    content_registered: ["jobId", "objectToken"],
    chunk_accepted: ["jobId", "objectToken"],
    prepared: ["jobId", "prepareToken"],
    clipboard_written: ["jobId", "clipboardSequence"],
    input_submitted: ["jobId", "insertedInputs", "target"],
    busy: ["jobId", "reasonCode"],
    payload_invalid: ["jobId", "reasonCode"],
    key_held: ["jobId", "reasonCode"],
    copied_only: ["jobId", "reasonCode"],
    target_invalid: ["jobId", "reasonCode"],
    focus_denied: ["jobId", "reasonCode"],
    modifier_held: ["jobId", "reasonCode"],
    clipboard_changed: ["jobId", "reasonCode"],
    input_rejected: ["jobId", "insertedInputs", "reasonCode"],
    helper_unavailable: ["jobId", "reasonCode"],
    cancelled: ["jobId", "reasonCode", "workerQuiescent"],
    too_late: ["jobId", "reasonCode", "workerQuiescent"],
    job_finished: ["jobId", "workerQuiescent"],
  };
  const allowed = allowedByStatus[status];
  if (keys.some((key) => !(commonResultKeys as readonly string[]).includes(key) && !allowed.includes(key))) return false;

  const requiredByStatus: Partial<Record<NativeResultStatus, readonly string[]>> = {
    ready: ["helperPid", "helperProcessCreatedAt"],
    captured: ["target"],
    content_registered: ["jobId", "objectToken"],
    chunk_accepted: ["jobId", "objectToken"],
    prepared: ["jobId", "prepareToken"],
    clipboard_written: ["jobId", "clipboardSequence"],
    input_submitted: ["jobId", "insertedInputs", "target"],
    input_rejected: ["jobId", "insertedInputs"],
    cancelled: ["workerQuiescent"],
    too_late: ["workerQuiescent"],
    job_finished: ["jobId", "workerQuiescent"],
  };
  if ((requiredByStatus[status] ?? []).some((field) => !owns(result, field))) return false;

  if (owns(result, "workerQuiescent") && typeof result.workerQuiescent !== "boolean") return false;
  if (status === "job_finished" && result.workerQuiescent !== true) return false;
  if ((status === "cancelled" || status === "too_late") && typeof result.workerQuiescent !== "boolean") return false;
  if ((status === "captured" || status === "input_submitted") && !isNativeTarget(result.target)) return false;
  if (status === "input_submitted" && result.insertedInputs !== 4) return false;
  if (status === "input_rejected" && (!Number.isInteger(result.insertedInputs) || (result.insertedInputs as number) > 3)) return false;
  if ((status === "content_registered" || status === "chunk_accepted") && !isNonEmptyString(result.objectToken)) return false;
  if (status === "prepared" && !isNonEmptyString(result.prepareToken)) return false;
  if (status === "clipboard_written" && !isDecimalString(result.clipboardSequence)) return false;
  return true;
}

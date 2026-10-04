import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";
import { randomUUID } from "node:crypto";
import {
  isNativeRequest,
  isNativeResult,
  type NativeEnvelope,
  type NativeRequest,
  type NativeRequestCommand,
  type NativeResult,
} from "../../shared/native-contracts";
import type { HelperReady } from "./host-authorization";

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_BUFFER_BYTES = 256 * 1024;
const MAX_PENDING_REQUESTS = 4;
const DEFAULT_DEADLINE_MS: Record<NativeRequestCommand["kind"], number> = {
  capture: 100,
  register_content: 3_000,
  content_chunk: 3_000,
  finish_content: 3_000,
  prepare: 3_000,
  commit_write: 500,
  paste: 750,
  cancel: 50,
};
const DEFAULT_READY_TIMEOUT_MS = 5_000;

export interface HelperChildProcess {
  pid?: number;
  stdin: {
    writableLength?: number;
    write(data: string, callback?: (error?: Error | null) => void): boolean;
    on(event: "error", callback: (error: Error) => void): unknown;
  };
  stdout: {
    on(event: "data", callback: (chunk: Buffer | string) => void): unknown;
  };
  once(event: "error", callback: (error: Error) => void): unknown;
  once(event: "exit", callback: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface NativeHelperClientOptions {
  spawnHelper?: (
    executablePath: string,
    env?: NodeJS.ProcessEnv,
  ) => HelperChildProcess;
  acceptReady: (ready: HelperReady, childPid: number) => boolean;
  createRequestId?: () => string;
  onCurrentResult?: (result: NativeResult) => void;
  onUnavailable?: (error: Error) => void;
  onProcessExit?: () => void;
  readyTimeoutMs?: number;
}

export interface NativeRequestDeadline {
  /** Monotonic absolute deadline, such as panelSelectionStartedAt + 500ms. */
  deadlineAt?: number;
  /** Overrides the per-kind default when there is no absolute deadline. */
  timeoutMs?: number;
}

export type HelperClientState = "stopped" | "starting" | "ready" | "unavailable" | "closed";

interface PendingRequest {
  request: NativeRequest;
  resolve: (result: NativeResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveJob {
  generation: string;
  helperInstanceId: string;
  registerRequestId: string;
}

function defaultSpawnHelper(executablePath: string, env?: NodeJS.ProcessEnv): HelperChildProcess {
  return spawn(executablePath, [], {
    shell: false,
    windowsHide: true,
    stdio: "pipe",
    env,
  }) as ChildProcessWithoutNullStreams;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);
}

export class ClipboardWriteFence {
  private blockedValue = false;

  get isBlocked(): boolean {
    return this.blockedValue;
  }

  blockUntilHelperExit(): void {
    this.blockedValue = true;
  }

  confirmHelperExit(): void {
    this.blockedValue = false;
  }

  assertWriteAllowed(): void {
    if (this.blockedValue) throw new Error("helper_side_effect_unresolved");
  }
}

export class NativeHelperClient {
  private readonly spawnHelper: NonNullable<NativeHelperClientOptions["spawnHelper"]>;
  private readonly createRequestId: () => string;
  private readonly onCurrentResult?: (result: NativeResult) => void;
  private readonly onUnavailable?: (error: Error) => void;
  private readonly onProcessExit?: () => void;
  private child: HelperChildProcess | null = null;
  private childExited = true;
  private unavailableNotified = false;
  private readonly childExitWaiters = new Set<(didExit: boolean) => void>();
  private stateValue: HelperClientState = "stopped";
  private readyValue: HelperReady | null = null;
  private inputBuffer = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingRequest>();
  private readonly usedRequestIds = new Set<string>();
  private readonly usedPanelGenerations = new Set<string>();
  private readonly activeJobs = new Map<string, ActiveJob>();
  private currentPanelGenerationValue: string | null = null;
  private helperAcceptedGeneration: string | null = null;
  private readyResolve: ((ready: HelperReady) => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: NativeHelperClientOptions) {
    this.spawnHelper = options.spawnHelper ?? defaultSpawnHelper;
    this.createRequestId = options.createRequestId ?? randomUUID;
    this.onCurrentResult = options.onCurrentResult;
    this.onUnavailable = options.onUnavailable;
    this.onProcessExit = options.onProcessExit;
  }

  get state(): HelperClientState {
    return this.stateValue;
  }

  get hasExited(): boolean {
    return this.childExited;
  }

  get currentPanelGeneration(): string | null {
    return this.currentPanelGenerationValue;
  }

  get acceptedHelperGeneration(): string | null {
    return this.helperAcceptedGeneration;
  }

  get pendingRequestCount(): number {
    return this.pending.size;
  }

  get activeJobCount(): number {
    return this.activeJobs.size;
  }

  /** Records a panel-opening intent before any ACK can arrive for the prior generation. */
  beginPanelGeneration(generation: string): void {
    if (!isId(generation)) throw new Error("generation_invalid");
    if (this.usedPanelGenerations.has(generation)) throw new Error("generation_reused");
    this.usedPanelGenerations.add(generation);
    this.currentPanelGenerationValue = generation;
  }

  start(executablePath: string, env?: NodeJS.ProcessEnv): Promise<HelperReady> {
    if (this.stateValue !== "stopped") return Promise.reject(new Error("helper_client_already_started"));
    if (process.platform !== "win32" || !isAbsolute(executablePath)) {
      return Promise.reject(new Error("helper_path_or_platform_invalid"));
    }

    this.stateValue = "starting";
    let child: HelperChildProcess;
    try {
      child = this.spawnHelper(executablePath, env);
    } catch {
      this.fail(new Error("helper_spawn_failed"));
      return Promise.reject(new Error("helper_spawn_failed"));
    }
    this.child = child;
    this.childExited = false;
    this.unavailableNotified = false;

    const readyPromise = new Promise<HelperReady>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.readyTimer = setTimeout(
      () => this.fail(new Error("helper_ready_timeout")),
      this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    );

    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stdin.on("error", () => this.fail(new Error("helper_stdin_failed")));
    child.once("error", () => this.fail(new Error("helper_process_error")));
    child.once("exit", () => {
      this.markChildExited();
      if (this.stateValue !== "closed" && this.stateValue !== "unavailable") {
        this.fail(new Error("helper_process_exited"));
      }
      try {
        this.onProcessExit?.();
      } catch {
        // Exit observers must not escape a child-process event callback.
      }
    });
    return readyPromise;
  }

  /**
   * Sends one helper request. Request IDs are generated here and never reused by this client.
   * An old generation can never be sent again after a newer one has been admitted.
   */
  request(
    command: NativeRequestCommand,
    generation: string,
    deadline: NativeRequestDeadline = {},
  ): Promise<NativeResult> {
    if (this.stateValue !== "ready" || !this.child || !this.readyValue) {
      return Promise.reject(new Error("helper_unavailable"));
    }
    if (!isId(generation)) return Promise.reject(new Error("generation_invalid"));
    if (this.currentPanelGenerationValue !== generation) {
      return Promise.reject(new Error("stale_generation"));
    }
    if (command.kind === "cancel" && !isId(command.jobId)) {
      return Promise.reject(new Error("cancel_job_id_required"));
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      this.fail(new Error("helper_output_backpressure"));
      return Promise.reject(new Error("helper_output_backpressure"));
    }

    const requestId = this.createRequestId();
    if (!isId(requestId) || this.usedRequestIds.has(requestId)) {
      this.fail(new Error("request_id_reuse"));
      return Promise.reject(new Error("request_id_reuse"));
    }
    this.usedRequestIds.add(requestId);
    const request = {
      ...command,
      v: 1,
      requestId,
      generation,
      helperInstanceId: this.readyValue.helperInstanceId,
    } as NativeRequest;
    if (!isNativeRequest(request)) return Promise.reject(new Error("native_request_invalid"));

    const encoded = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > MAX_FRAME_BYTES) {
      return Promise.reject(new Error("native_request_frame_too_large"));
    }

    return new Promise<NativeResult>((resolve, reject) => {
      const timeoutMs = deadline.deadlineAt === undefined
        ? deadline.timeoutMs ?? DEFAULT_DEADLINE_MS[request.kind]
        : Math.floor(deadline.deadlineAt - performance.now());
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        reject(new Error("helper_request_deadline_expired"));
        return;
      }
      const timer = setTimeout(() => this.fail(new Error("helper_request_timeout")), timeoutMs);
      this.pending.set(requestId, { request, resolve, reject, timer });
      try {
        this.child?.stdin.write(encoded, (error) => {
          if (error) this.fail(new Error("helper_stdin_failed"));
        });
        if ((this.child?.stdin.writableLength ?? 0) > MAX_BUFFER_BYTES) {
          this.fail(new Error("helper_output_backpressure"));
        }
      } catch {
        this.fail(new Error("helper_stdin_failed"));
      }
    });
  }

  close(): void {
    if (this.stateValue === "closed") return;
    this.stateValue = "closed";
    this.clearReadyTimer();
    const error = new Error("helper_client_closed");
    this.rejectOutstanding(error);
    if (!this.childExited) this.child?.kill("SIGTERM");
  }

  /** Stops the child and confirms exit before a supervisor may start a replacement. */
  async terminateAndWait(timeoutMs = 300): Promise<boolean> {
    const child = this.child;
    if (!child || this.childExited) {
      this.close();
      return true;
    }
    const exitResult = this.waitForChildExit(timeoutMs);
    this.close();
    return exitResult;
  }

  private onStdout(chunk: Buffer | string): void {
    if (this.stateValue !== "starting" && this.stateValue !== "ready") return;
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    if (this.inputBuffer.byteLength + next.byteLength > MAX_BUFFER_BYTES) {
      this.fail(new Error("helper_output_buffer_exceeded"));
      return;
    }
    this.inputBuffer = Buffer.concat([this.inputBuffer, next]);

    let newline = this.inputBuffer.indexOf(0x0a);
    while (newline !== -1) {
      const line = this.inputBuffer.subarray(0, newline);
      this.inputBuffer = this.inputBuffer.subarray(newline + 1);
      if (line.byteLength === 0 || line.byteLength > MAX_FRAME_BYTES) {
        this.fail(new Error("helper_frame_invalid"));
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
      } catch {
        this.fail(new Error("helper_frame_invalid"));
        return;
      }
      this.handleResult(value);
      if (this.stateValue !== "starting" && this.stateValue !== "ready") return;
      newline = this.inputBuffer.indexOf(0x0a);
    }
    if (this.inputBuffer.byteLength > MAX_FRAME_BYTES) this.fail(new Error("helper_frame_too_large"));
  }

  private handleResult(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.fail(new Error("helper_result_invalid"));
      return;
    }
    const candidate = value as Record<string, unknown>;
    if (!isId(candidate.requestId) || !isId(candidate.generation) || !isId(candidate.helperInstanceId)) {
      this.fail(new Error("helper_result_invalid"));
      return;
    }
    const expected: Pick<NativeEnvelope, "requestId" | "generation" | "helperInstanceId"> = {
      requestId: candidate.requestId,
      generation: candidate.generation,
      helperInstanceId: candidate.helperInstanceId,
    };
    if (!isNativeResult(value, expected)) {
      this.fail(new Error("helper_result_invalid"));
      return;
    }

    if (this.stateValue === "starting") {
      this.acceptStartupResult(value);
      return;
    }
    if (value.helperInstanceId !== this.readyValue?.helperInstanceId || value.status === "ready") {
      this.fail(new Error("helper_instance_changed"));
      return;
    }

    const pending = this.pending.get(value.requestId);
    if (pending) {
      const expectedEnvelope = pending.request;
      if (
        value.generation !== expectedEnvelope.generation ||
        value.helperInstanceId !== expectedEnvelope.helperInstanceId ||
        ("jobId" in expectedEnvelope && "jobId" in value && value.jobId !== expectedEnvelope.jobId)
      ) {
        this.fail(new Error("helper_result_correlation_invalid"));
        return;
      }
      if (
        (value.status === "cancelled" || value.status === "too_late") &&
        (pending.request.kind !== "cancel" ||
          !("jobId" in pending.request) ||
          !pending.request.jobId ||
          value.jobId !== pending.request.jobId)
      ) {
        this.fail(new Error("helper_cancel_correlation_invalid"));
        return;
      }
      this.pending.delete(value.requestId);
      clearTimeout(pending.timer);
      this.admitGeneration(value);
      if (pending.request.kind === "register_content" && value.status === "content_registered") {
        this.activeJobs.set(value.jobId, {
          generation: value.generation,
          helperInstanceId: value.helperInstanceId,
          registerRequestId: value.requestId,
        });
      }
      if (this.currentPanelGenerationValue === value.generation && !this.notifyCurrentResult(value)) {
        pending.reject(new Error("helper_observer_failed"));
        return;
      }
      pending.resolve(value);
      return;
    }

    if (value.status !== "job_finished") return;
    const job = this.activeJobs.get(value.jobId);
    if (
      !job ||
      value.requestId !== job.registerRequestId ||
      value.generation !== job.generation ||
      value.helperInstanceId !== job.helperInstanceId
    ) return;
    this.activeJobs.delete(value.jobId);
    if (this.currentPanelGenerationValue === value.generation) this.notifyCurrentResult(value);
  }

  private acceptStartupResult(value: NativeResult): void {
    if (value.status !== "ready" || value.requestId !== "startup" || value.generation !== "startup") {
      this.fail(new Error("helper_ready_invalid"));
      return;
    }
    const childPid = this.child?.pid;
    if (typeof childPid !== "number" || !Number.isInteger(childPid) || value.helperPid !== childPid) {
      this.fail(new Error("helper_ready_identity_mismatch"));
      return;
    }
    let hostAccepted = false;
    try {
      hostAccepted = this.options.acceptReady(value, childPid);
    } catch {
      // A bridge callback is part of startup authorization. Convert its failure
      // to a rejected READY promise instead of throwing through stdout's event.
      hostAccepted = false;
    }
    if (!hostAccepted) {
      this.fail(new Error("helper_ready_identity_mismatch"));
      return;
    }
    this.readyValue = value;
    this.stateValue = "ready";
    this.clearReadyTimer();
    this.readyResolve?.(value);
    this.readyResolve = null;
    this.readyReject = null;
  }

  private admitGeneration(result: NativeResult): void {
    if (result.status === "busy" && result.reasonCode === "generation_transition_pending") return;
    if (result.generation === this.currentPanelGenerationValue) this.helperAcceptedGeneration = result.generation;
  }

  private notifyCurrentResult(result: NativeResult): boolean {
    try {
      this.onCurrentResult?.(result);
      return true;
    } catch {
      this.fail(new Error("helper_observer_failed"));
      return false;
    }
  }

  private fail(error: Error): void {
    if (this.stateValue === "unavailable" || this.stateValue === "closed") return;
    this.stateValue = "unavailable";
    this.clearReadyTimer();
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    this.rejectOutstanding(error);
    if (!this.childExited) this.child?.kill("SIGTERM");
    if (!this.unavailableNotified) {
      this.unavailableNotified = true;
      try {
        this.onUnavailable?.(error);
      } catch {
        // Supervisory notification must not escape a child-process event callback.
      }
    }
  }

  private waitForChildExit(timeoutMs: number): Promise<boolean> {
    if (!this.child || this.childExited) return Promise.resolve(true);
    const boundedTimeout = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (didExit: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.childExitWaiters.delete(finish);
        resolve(didExit);
      };
      this.childExitWaiters.add(finish);
      timer = setTimeout(() => finish(false), boundedTimeout);
      if (this.childExited) finish(true);
    });
  }

  private markChildExited(): void {
    if (this.childExited) return;
    this.childExited = true;
    for (const waiter of this.childExitWaiters) waiter(true);
    this.childExitWaiters.clear();
  }

  private rejectOutstanding(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.activeJobs.clear();
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }
}

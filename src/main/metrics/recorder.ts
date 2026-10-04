import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

export type MetricFlow = "wake" | "selection";
export type MetricOutcome = "ok" | "not_found" | "no_input" | "failed";
export type MetricStage =
  | "request_started"
  | "previous_window_capture_started"
  | "previous_window_captured"
  | "panel_shown"
  | "panel_actionable"
  | "panel_actionable_timeout"
  | "selection_received"
  | "clipboard_written"
  | "copy_ipc_acknowledged"
  | "panel_hidden"
  | "target_recaptured"
  | "paste_helper_spawned"
  | "send_input_acknowledged"
  | "paste_helper_failed"
  | "target_display_observed"
  | "request_finished";

export interface MetricRecord {
  requestId: string;
  flow: MetricFlow;
  stage: MetricStage;
  elapsedMs: number;
  stageDurationMs: number;
  outcome?: MetricOutcome;
}

export interface MetricsRecorderOptions {
  enabled?: boolean;
  outputPath?: string;
  now?: () => number;
  createRequestId?: () => string;
  maxRecords?: number;
}

interface ActiveRequest {
  flow: MetricFlow;
  startedAt: number;
  lastAt: number;
}

const DEFAULT_MAX_RECORDS = 4096;

/** Metadata-only, bounded timings. No clipboard data or window details are accepted. */
export class MetricsRecorder {
  private readonly enabled: boolean;
  private readonly outputPath?: string;
  private readonly now: () => number;
  private readonly createRequestId: () => string;
  private readonly maxRecords: number;
  private readonly active = new Map<string, ActiveRequest>();
  private readonly records: MetricRecord[] = [];
  private readonly pendingWrites: MetricRecord[] = [];
  private writeScheduled = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: MetricsRecorderOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.outputPath = options.outputPath;
    this.now = options.now ?? (() => performance.now());
    this.createRequestId = options.createRequestId ?? randomUUID;
    this.maxRecords = Math.max(32, options.maxRecords ?? DEFAULT_MAX_RECORDS);
  }

  begin(flow: MetricFlow): string | null {
    if (!this.enabled || this.active.size >= this.maxRecords) return null;
    const requestId = this.createRequestId();
    if (this.active.has(requestId)) return null;
    const now = this.now();
    this.active.set(requestId, { flow, startedAt: now, lastAt: now });
    this.push({ requestId, flow, stage: "request_started", elapsedMs: 0, stageDurationMs: 0 });
    return requestId;
  }

  mark(requestId: string | null, stage: MetricStage, outcome?: MetricOutcome): boolean {
    if (!this.enabled || !requestId) return false;
    const active = this.active.get(requestId);
    if (!active) return false;
    const now = this.now();
    this.push({
      requestId,
      flow: active.flow,
      stage,
      elapsedMs: Math.max(0, now - active.startedAt),
      stageDurationMs: Math.max(0, now - active.lastAt),
      ...(outcome ? { outcome } : {}),
    });
    active.lastAt = now;
    return true;
  }

  finish(requestId: string | null, outcome: MetricOutcome): boolean {
    if (!this.mark(requestId, "request_finished", outcome) || !requestId) return false;
    this.active.delete(requestId);
    return true;
  }

  isActive(requestId: string): boolean {
    return this.enabled && this.active.has(requestId);
  }

  snapshot(): readonly MetricRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  async flush(): Promise<void> {
    if (!this.outputPath || this.pendingWrites.length === 0) {
      await this.writeChain;
      return;
    }
    const batch = this.pendingWrites.splice(0, this.pendingWrites.length);
    const jsonLines = `${batch.map((record) => JSON.stringify(record)).join("\n")}\n`;
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.outputPath!), { recursive: true });
      await appendFile(this.outputPath!, jsonLines, "utf8");
    });
    await this.writeChain;
  }

  private push(record: MetricRecord): void {
    if (this.records.length === this.maxRecords) this.records.shift();
    this.records.push(record);
    if (this.outputPath && this.pendingWrites.length < this.maxRecords) {
      this.pendingWrites.push(record);
      if (!this.writeScheduled) {
        this.writeScheduled = true;
        setImmediate(() => {
          this.writeScheduled = false;
          void this.flush().catch(() => undefined);
        });
      }
    }
  }
}

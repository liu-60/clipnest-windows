import type { UtilityProcess } from "electron";
import { join } from "node:path";

const IMAGE_RESPONSE_CHUNK_BYTES = 1024 * 1024;

export const IMAGE_LIMITS = Object.freeze({
  sourceBytes: 20 * 1024 * 1024,
  decodedPixels: 16_000_000,
  decodedCacheBytes: 32 * 1024 * 1024,
  workerPeakBytes: 256 * 1024 * 1024,
  contentPrepareTimeoutMs: 3_000,
});

export type ImageFormat = "png" | "jpeg";
export interface ImageDecodeInput {
  readonly jobId: string;
  readonly format: ImageFormat;
  readonly encodedBytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}
export type ImageDecoder = (input: ImageDecodeInput, signal: AbortSignal) => Promise<DecodedImage>;
export interface ImageDecodeWorker {
  decode(input: ImageDecodeInput, signal: AbortSignal): Promise<DecodedImage>;
  dispose(): Promise<void>;
}
export interface ImageWorkerEndpoint {
  onMessage(listener: (message: unknown) => void): () => void;
  postMessage(message: { type: "decoded"; requestId: string; image: DecodedImage;
    stageTimings?: { decodeMs: number } } |
    { type: "decoded_chunk"; requestId: string; seq: number; pixels: Uint8Array } |
    { type: "decoded_end"; requestId: string; width: number; height: number; chunkCount: number;
      byteLength: number; stageTimings?: { decodeMs: number; chunkSendMs: number } } |
    { type: "failed"; requestId: string; reason: string }): void;
}

interface ActiveImageJob {
  id: string;
  controller: AbortController;
  image: DecodedImage | null;
  nextChunkSeq: number;
  awaitingAck: number | null;
  collectTimings: boolean;
  decodeStartedAt: number;
  chunkSendStartedAt: number;
}

/** Shared worker protocol is testable with a decoder injected by the fixture. */
export function installImageWorkerRuntime(endpoint: ImageWorkerEndpoint, decoder: ImageDecoder): () => void {
  let active: ActiveImageJob | null = null;
  let disposed = false;
  let removeListener: () => void = () => {};
  removeListener = endpoint.onMessage((raw) => {
    if (!isRecord(raw) || disposed) return;
    if (raw.type === "decoded_chunk_ack") {
      const job = active;
      if (!job) return;
      if (raw.requestId !== job.id || !Number.isSafeInteger(raw.seq) || raw.seq !== job.awaitingAck) {
        failJob(job, "image_worker_protocol_invalid");
        return;
      }
      job.awaitingAck = null;
      try { sendNextChunk(job); }
      catch { failJob(job, "image_worker_send_failed"); }
      return;
    }
    if (raw.type !== "decode" || typeof raw.requestId !== "string") return;
    const input = raw.input;
    if (!isDecodeInput(input)) {
      endpoint.postMessage({ type: "failed", requestId: raw.requestId, reason: "image_request_invalid" });
      return;
    }
    if (active) {
      endpoint.postMessage({ type: "failed", requestId: raw.requestId, reason: "image_worker_busy" });
      return;
    }
    const collectTimings = process.env?.T04_WORKER_STAGE_TIMING === "1";
    const job: ActiveImageJob = { id: raw.requestId, controller: new AbortController(),
      image: null, nextChunkSeq: 0, awaitingAck: null, collectTimings,
      decodeStartedAt: collectTimings ? performance.now() : 0, chunkSendStartedAt: 0 };
    active = job;
    void Promise.resolve().then(() => decoder(input, job.controller.signal)).then((image) => {
      if (disposed || active !== job || job.controller.signal.aborted) return;
      if (!isDecodedImage(image) || image.width !== input.width || image.height !== input.height ||
          image.pixels.byteLength !== input.width * input.height * 4) {
        failJob(job, "image_decoded_invalid");
        return;
      }
      if (image.pixels.byteLength <= IMAGE_LIMITS.decodedCacheBytes) {
        endpoint.postMessage({
          type: "decoded", requestId: job.id, image,
          ...(job.collectTimings ? { stageTimings: { decodeMs: roundTiming(performance.now() - job.decodeStartedAt) } } : {}),
        });
        if (active === job) active = null;
        return;
      }
      job.image = image;
      job.chunkSendStartedAt = job.collectTimings ? performance.now() : 0;
      sendNextChunk(job);
    }).catch((error: unknown) => {
      if (!disposed && active === job) failJob(job, errorReason(error));
    });
  });
  return () => { disposed = true; active?.controller.abort(); removeListener(); };

  function sendNextChunk(job: ActiveImageJob): void {
    if (active !== job || !job.image) return;
    const byteLength = job.image.pixels.byteLength;
    const chunkCount = Math.ceil(byteLength / IMAGE_RESPONSE_CHUNK_BYTES);
    if (job.nextChunkSeq >= chunkCount) {
      endpoint.postMessage({
        type: "decoded_end", requestId: job.id, width: job.image.width, height: job.image.height,
        chunkCount, byteLength,
        ...(job.collectTimings ? { stageTimings: {
          decodeMs: roundTiming(job.chunkSendStartedAt - job.decodeStartedAt),
          chunkSendMs: roundTiming(performance.now() - job.chunkSendStartedAt),
        } } : {}),
      });
      active = null;
      return;
    }
    const seq = job.nextChunkSeq++;
    const offset = seq * IMAGE_RESPONSE_CHUNK_BYTES;
    // Buffer.slice() is a view and can retain/clone the full frame's backing
    // store. Copy into an exactly sized chunk so IPC remains genuinely bounded.
    const pixels = Uint8Array.from(job.image.pixels.subarray(offset,
      Math.min(offset + IMAGE_RESPONSE_CHUNK_BYTES, byteLength)));
    job.awaitingAck = seq;
    endpoint.postMessage({ type: "decoded_chunk", requestId: job.id, seq, pixels });
  }

  function failJob(job: ActiveImageJob, reason: string): void {
    if (active !== job) return;
    active = null;
    job.controller.abort();
    endpoint.postMessage({ type: "failed", requestId: job.id, reason });
  }
}

/** Explicit failing fixture retained for tests of unavailable decoder handling. */
export const decodeImageAdapterPendingT06: ImageDecoder = async () => {
  throw new Error("image_decoder_pending_t06");
};

export function createUtilityProcessImageWorker(): ImageDecodeWorker {
  return new UtilityImageWorker();
}

class UtilityImageWorker implements ImageDecodeWorker {
  private child: UtilityProcess | null = null;
  private retiringChild: UtilityProcess | null = null;
  private pending: { id: string; width: number; height: number; signal: AbortSignal; abort: () => void;
    expectedBytes: number; nextChunkSeq: number; receivedBytes: number; pixels: Buffer | null;
    resolve: (image: DecodedImage) => void; reject: (error: Error) => void } | null = null;
  private disposed = false;

  decode(input: ImageDecodeInput, signal: AbortSignal): Promise<DecodedImage> {
    if (this.disposed) return Promise.reject(new Error("image_worker_closed"));
    if (this.pending) return Promise.reject(new Error("image_worker_busy"));
    if (this.retiringChild) return Promise.reject(new Error("image_worker_terminating"));
    if (!isDecodeInput(input)) return Promise.reject(new Error("image_request_invalid"));
    if (signal.aborted) return Promise.reject(new Error("image_decode_cancelled"));
    try { this.ensureChild(); } catch { return Promise.reject(new Error("image_worker_start_failed")); }
    return new Promise((resolve, reject) => {
      const abort = () => {
        const error = abortError(signal);
        const child = this.child;
        // Cancellation can race a decoded response. Quarantine every killed
        // child until exit, and reject immediately even when kill fails.
        if (child) this.retiringChild = child;
        try { child?.kill(); } catch { /* Retire the worker and fail closed. */ }
        this.finish(error);
      };
      this.pending = { id: input.jobId, width: input.width, height: input.height, signal, abort,
        expectedBytes: input.width * input.height * 4, nextChunkSeq: 0, receivedBytes: 0, pixels: null,
        resolve, reject };
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted) abort();
        else this.child?.postMessage({ type: "decode", requestId: input.jobId, input });
      }
      catch { this.retire(new Error("image_worker_send_failed")); }
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      if (!child.kill() && child.pid === undefined) resolve();
    });
  }

  private ensureChild(): void {
    if (this.retiringChild) throw new Error("image_worker_terminating");
    if (this.child) return;
    const { utilityProcess } = require("electron") as typeof import("electron");
    const child = utilityProcess.fork(join(__dirname, "image-worker.js"), [], {
      serviceName: "ClipNest Image Decoder", stdio: "ignore",
    });
    this.child = child;
    child.on("message", (raw: unknown) => this.onMessage(raw));
    child.on("exit", () => {
      if (this.child === child) this.child = null;
      if (this.retiringChild === child) this.retiringChild = null;
      const pending = this.pending;
      if (pending) this.finish(new Error(pending.signal.aborted ? "image_decode_cancelled" : "image_worker_exited"));
    });
  }

  private onMessage(raw: unknown): void {
    if (!this.pending) return;
    if (!isRecord(raw) || typeof raw.requestId !== "string") {
      this.retire(new Error("image_worker_response_invalid"));
      return;
    }
    // A late response from a completed request must not poison the worker's
    // next active request. Matching request IDs still receive strict checks.
    if (raw.requestId !== this.pending.id) return;
    if (raw.type === "failed" && typeof raw.reason === "string" && /^image_[a-z0-9_]+$/.test(raw.reason)) {
      if (raw.reason === "image_worker_protocol_invalid") this.retire(new Error(raw.reason));
      else this.finish(new Error(raw.reason));
    }
    else if (raw.type === "decoded") this.onDecodedMessage(raw);
    else if (raw.type === "decoded_chunk") this.onDecodedChunk(raw);
    else if (raw.type === "decoded_end") this.onDecodedEnd(raw);
    else this.retire(new Error("image_worker_response_invalid"));
  }

  private onDecodedMessage(raw: Record<string, unknown>): void {
    const pending = this.pending;
    if (!pending || !isDecodedImage(raw.image) || raw.image.width !== pending.width ||
        raw.image.height !== pending.height || raw.image.pixels.byteLength !== pending.expectedBytes ||
        raw.image.pixels.byteLength > IMAGE_LIMITS.decodedCacheBytes) {
      this.retire(new Error("image_worker_response_invalid"));
      return;
    }
    this.finish(undefined, raw.image);
  }

  private onDecodedChunk(raw: Record<string, unknown>): void {
    const pending = this.pending;
    const chunk = raw.pixels;
    if (!pending || pending.expectedBytes <= IMAGE_LIMITS.decodedCacheBytes ||
        !Number.isSafeInteger(raw.seq) || raw.seq !== pending.nextChunkSeq ||
        !(chunk instanceof Uint8Array) || chunk.byteLength === 0 || chunk.byteLength > IMAGE_RESPONSE_CHUNK_BYTES ||
        chunk.byteLength !== Math.min(IMAGE_RESPONSE_CHUNK_BYTES, pending.expectedBytes - pending.receivedBytes) ||
        pending.receivedBytes + chunk.byteLength > pending.expectedBytes) {
      this.retire(new Error("image_worker_response_invalid"));
      return;
    }
    if (!pending.pixels) pending.pixels = Buffer.allocUnsafe(pending.expectedBytes);
    Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(pending.pixels, pending.receivedBytes);
    pending.receivedBytes += chunk.byteLength;
    pending.nextChunkSeq++;
    try { this.child?.postMessage({ type: "decoded_chunk_ack", requestId: pending.id, seq: raw.seq as number }); }
    catch { this.retire(new Error("image_worker_send_failed")); }
  }

  private onDecodedEnd(raw: Record<string, unknown>): void {
    const pending = this.pending;
    if (!pending || pending.expectedBytes <= IMAGE_LIMITS.decodedCacheBytes ||
        raw.width !== pending.width || raw.height !== pending.height || raw.byteLength !== pending.expectedBytes ||
        raw.chunkCount !== pending.nextChunkSeq || pending.receivedBytes !== pending.expectedBytes || !pending.pixels) {
      this.retire(new Error("image_worker_response_invalid"));
      return;
    }
    this.finish(undefined, { width: pending.width, height: pending.height, pixels: pending.pixels });
  }

  private finish(error?: Error, image?: DecodedImage): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.signal.removeEventListener("abort", pending.abort);
    if (error) pending.reject(error);
    else if (image) pending.resolve(image);
    else pending.reject(new Error("image_worker_response_invalid"));
  }

  private retire(error: Error): void {
    const child = this.child;
    if (child) this.retiringChild = child;
    this.finish(error);
    try { child?.kill(); } catch { /* Retire the process even if termination reports an error. */ }
  }
}

function installProductionWorkerEntry(): void {
  if (require.main !== module) return;
  const { decodeProductionImage } = require("./image-decoder") as typeof import("./image-decoder");
  const { parentPort } = process;
  installImageWorkerRuntime({
    onMessage(listener) {
      const handler = (event: Electron.MessageEvent) => listener(event.data);
      parentPort.on("message", handler);
      return () => parentPort.off("message", handler);
    },
    postMessage(message) {
      parentPort.postMessage(message);
    },
  }, decodeProductionImage);
}

function isDecodeInput(value: unknown): value is ImageDecodeInput {
  if (!isRecord(value) || typeof value.jobId !== "string" ||
      (value.format !== "png" && value.format !== "jpeg") ||
      !(value.encodedBytes instanceof Uint8Array) || value.encodedBytes.byteLength === 0 ||
      value.encodedBytes.byteLength > IMAGE_LIMITS.sourceBytes ||
      typeof value.width !== "number" || !Number.isInteger(value.width) || value.width <= 0 ||
      typeof value.height !== "number" || !Number.isInteger(value.height) || value.height <= 0) return false;
  const pixels = value.width * value.height;
  return Number.isSafeInteger(pixels) && pixels <= IMAGE_LIMITS.decodedPixels &&
    value.encodedBytes.byteLength + pixels * 4 <= IMAGE_LIMITS.workerPeakBytes;
}

function isDecodedImage(value: unknown): value is DecodedImage {
  return isRecord(value) && typeof value.width === "number" && typeof value.height === "number" &&
    value.pixels instanceof Uint8Array;
}
function errorReason(error: unknown): string {
  return error instanceof Error && /^image_[a-z0-9_]+$/.test(error.message) ? error.message : "image_decode_failed";
}
function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error && /^image_[a-z0-9_]+$/.test(reason.message)
    ? reason
    : new Error("image_decode_cancelled");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function roundTiming(value: number): number { return Math.round(value * 100) / 100; }

installProductionWorkerEntry();

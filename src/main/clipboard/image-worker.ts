import type { UtilityProcess } from "electron";
import { join } from "node:path";

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
  postMessage(message: { type: "decoded"; requestId: string; image: DecodedImage } |
    { type: "failed"; requestId: string; reason: string }): void;
}

/** Shared worker protocol is testable with a decoder injected by the fixture. */
export function installImageWorkerRuntime(endpoint: ImageWorkerEndpoint, decoder: ImageDecoder): () => void {
  let active: { id: string; controller: AbortController } | null = null;
  let disposed = false;
  let removeListener: () => void = () => {};
  removeListener = endpoint.onMessage((raw) => {
    if (!isRecord(raw) || disposed || raw.type !== "decode" || typeof raw.requestId !== "string") return;
    const input = raw.input;
    if (!isDecodeInput(input)) {
      endpoint.postMessage({ type: "failed", requestId: raw.requestId, reason: "image_request_invalid" });
      return;
    }
    if (active) {
      endpoint.postMessage({ type: "failed", requestId: raw.requestId, reason: "image_worker_busy" });
      return;
    }
    const job = { id: raw.requestId, controller: new AbortController() };
    active = job;
    void Promise.resolve().then(() => decoder(input, job.controller.signal)).then((image) => {
      if (disposed || active !== job || job.controller.signal.aborted) return;
      if (!isDecodedImage(image) || image.width !== input.width || image.height !== input.height ||
          image.pixels.byteLength !== input.width * input.height * 4) {
        endpoint.postMessage({ type: "failed", requestId: job.id, reason: "image_decoded_invalid" });
      } else endpoint.postMessage({ type: "decoded", requestId: job.id, image });
    }).catch((error: unknown) => {
      if (!disposed && active === job) endpoint.postMessage({
        type: "failed", requestId: job.id, reason: errorReason(error),
      });
    }).finally(() => { if (active === job) active = null; });
  });
  return () => { disposed = true; active?.controller.abort(); removeListener(); };
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
  private pending: { id: string; signal: AbortSignal; abort: () => void;
    resolve: (image: DecodedImage) => void; reject: (error: Error) => void } | null = null;
  private disposed = false;

  decode(input: ImageDecodeInput, signal: AbortSignal): Promise<DecodedImage> {
    if (this.disposed) return Promise.reject(new Error("image_worker_closed"));
    if (this.pending) return Promise.reject(new Error("image_worker_busy"));
    if (this.retiringChild) return Promise.reject(new Error("image_worker_terminating"));
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
      this.pending = { id: input.jobId, signal, abort, resolve, reject };
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted) abort();
        else this.child?.postMessage({ type: "decode", requestId: input.jobId, input });
      }
      catch { this.finish(new Error("image_worker_send_failed")); }
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
    if (!isRecord(raw) || typeof raw.requestId !== "string" || !this.pending || raw.requestId !== this.pending.id) return;
    if (raw.type === "failed" && typeof raw.reason === "string") this.finish(new Error(raw.reason));
    else if (raw.type === "decoded" && isDecodedImage(raw.image)) this.finish(undefined, raw.image);
    else this.finish(new Error("image_worker_response_invalid"));
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
    postMessage(message) { parentPort.postMessage(message); },
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

installProductionWorkerEntry();

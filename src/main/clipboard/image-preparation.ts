import { performance } from "node:perf_hooks";
import {
  IMAGE_LIMITS, createUtilityProcessImageWorker,
  type DecodedImage, type ImageDecodeInput, type ImageDecodeWorker, type ImageFormat,
} from "./image-worker";
export { IMAGE_LIMITS } from "./image-worker";

export interface ImagePreparationInput {
  readonly itemRef: string; readonly itemVersion: string; readonly format: ImageFormat;
  readonly encodedBytes: Uint8Array; readonly width: number; readonly height: number;
}
export type ImagePreparationPhase = "preparing" | "ready" | "failed" | "cancelled";
export interface ImagePreparationUpdate {
  readonly phase: ImagePreparationPhase; readonly itemRef: string; readonly itemVersion: string;
  readonly cacheHit?: boolean; readonly reason?: string;
}
export interface ImagePreparationOptions {
  readonly signal?: AbortSignal; readonly isCurrent?: () => boolean; readonly deadlineAt?: number;
  readonly onUpdate?: (update: ImagePreparationUpdate) => void;
}
export interface ImagePreparationResult { readonly image: DecodedImage; readonly cacheHit: boolean; readonly cached: boolean; }
export interface ImageCacheStats { readonly entries: number; readonly bytes: number; readonly limitBytes: number; readonly workerBusy: boolean; }

export class ImagePreparationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ImagePreparationError"; }
}

export interface ImageSourceInfo { readonly format: ImageFormat; readonly width: number; readonly height: number; }

/** Validates that a retained data URL and its decoded bytes describe the same supported image. */
export function inspectImageSource(dataUrl: string, encodedBytes: Uint8Array): ImageSourceInfo {
  if (!(encodedBytes instanceof Uint8Array) || encodedBytes.byteLength === 0) throw new ImagePreparationError("image_source_invalid");
  if (encodedBytes.byteLength > IMAGE_LIMITS.sourceBytes) throw new ImagePreparationError("image_source_too_large");
  const prefix = typeof dataUrl === "string" ? /^data:image\/([^;,]+);base64,/.exec(dataUrl) : null;
  if (!prefix) throw new ImagePreparationError("image_source_invalid");
  if (prefix[1] !== "png" && prefix[1] !== "jpeg") throw new ImagePreparationError("image_format_unsupported");
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new ImagePreparationError("image_source_invalid");
  const base64 = match[2];
  if (base64.length > 4 * Math.ceil(IMAGE_LIMITS.sourceBytes / 3)) throw new ImagePreparationError("image_source_too_large");
  if (base64.length % 4 !== 0) throw new ImagePreparationError("image_source_invalid");
  const decoded = Buffer.from(base64, "base64");
  if (decoded.toString("base64") !== base64) throw new ImagePreparationError("image_source_invalid");
  const source = Buffer.from(encodedBytes.buffer, encodedBytes.byteOffset, encodedBytes.byteLength);
  if (decoded.byteLength > IMAGE_LIMITS.sourceBytes) throw new ImagePreparationError("image_source_too_large");
  if (!decoded.equals(source)) throw new ImagePreparationError("image_source_mismatch");

  const format: ImageFormat = match[1] === "png" ? "png" : "jpeg";
  const dimensions = format === "png" ? pngDimensions(decoded) : jpegDimensions(decoded);
  if (!dimensions) throw new ImagePreparationError("image_source_invalid");
  if (dimensions.width * dimensions.height > IMAGE_LIMITS.decodedPixels) {
    throw new ImagePreparationError("image_dimensions_too_large");
  }
  return { format, ...dimensions };
}

type CacheEntry = { readonly itemRef: string; readonly image: DecodedImage; readonly bytes: number };
type ActiveJob = { readonly itemRef: string; readonly controller: AbortController };

export class ImagePreparationService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly workerFactory: () => ImageDecodeWorker;
  private worker: ImageDecodeWorker | null = null;
  private active: ActiveJob | null = null;
  private workerRetirement: Promise<void> | null = null;
  private cachedBytes = 0;
  private nextJobId = 0;
  private disposed = false;

  constructor(options: { workerFactory?: () => ImageDecodeWorker } = {}) {
    this.workerFactory = options.workerFactory ?? createUtilityProcessImageWorker;
  }

  async prepare(input: ImagePreparationInput, options: ImagePreparationOptions = {}): Promise<ImagePreparationResult> {
    if (this.disposed) throw new ImagePreparationError("image_service_closed");
    validateInput(input);
    throwIfAborted(options.signal);

    const key = cacheKey(input.itemRef, input.itemVersion);
    const cached = this.readCache(key);
    if (cached) {
      this.emit(options.onUpdate, { phase: "ready", itemRef: input.itemRef, itemVersion: input.itemVersion, cacheHit: true });
      return { image: cached.image, cacheHit: true, cached: true };
    }
    if (this.active) throw new ImagePreparationError("image_worker_busy");

    const startedAt = performance.now();
    const deadlineAt = options.deadlineAt ?? startedAt + IMAGE_LIMITS.contentPrepareTimeoutMs;
    if (!Number.isFinite(deadlineAt)) throw new ImagePreparationError("image_deadline_invalid");
    let timedOut = false;
    const controller = new AbortController();
    const abort = () => controller.abort(new ImagePreparationError("image_cancelled"));
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort(new ImagePreparationError("image_prepare_timeout"));
    }, Math.max(0, deadlineAt - startedAt));
    const job = { itemRef: input.itemRef, controller };
    this.active = job;
    this.emit(options.onUpdate, { phase: "preparing", itemRef: input.itemRef, itemVersion: input.itemVersion });
    try {
      const retirement = this.workerRetirement;
      if (retirement) {
        await waitForPromiseOrAbort(retirement, controller.signal);
        this.throwIfPreparationExpired(deadlineAt, controller, () => { timedOut = true; });
        if (this.workerRetirement === retirement) this.workerRetirement = null;
      }
      this.throwIfPreparationExpired(deadlineAt, controller, () => { timedOut = true; });

      const request: ImageDecodeInput = {
        jobId: `image-${++this.nextJobId}`, format: input.format,
        encodedBytes: Uint8Array.from(input.encodedBytes), width: input.width, height: input.height,
      };
      this.throwIfPreparationExpired(deadlineAt, controller, () => { timedOut = true; });

      const worker = (this.worker ??= this.workerFactory());
      const decoded = await worker.decode(request, controller.signal);
      this.throwIfPreparationExpired(deadlineAt, controller, () => { timedOut = true; }, worker);
      throwIfAborted(controller.signal);
      if (options.isCurrent && !options.isCurrent()) throw new ImagePreparationError("image_item_stale");
      validateDecodedImage(decoded, input.width, input.height);
      const image: DecodedImage = { width: decoded.width, height: decoded.height, pixels: Uint8Array.from(decoded.pixels) };
      this.throwIfPreparationExpired(deadlineAt, controller, () => { timedOut = true; }, worker);
      const cachedNow = this.writeCache(key, input.itemRef, image);
      // Large images cannot enter the decoded cache. Retire their worker so
      // native/zlib allocations from one uncached decode cannot accumulate
      // across later large-image preparations in the same utility process.
      if (!cachedNow) this.retireWorker(worker);
      this.emit(options.onUpdate, { phase: "ready", itemRef: input.itemRef, itemVersion: input.itemVersion, cacheHit: false });
      return { image, cacheHit: false, cached: cachedNow };
    } catch (error) {
      if (timedOut) this.retireWorker(this.worker);
      const failure = timedOut
        ? new ImagePreparationError("image_prepare_timeout")
        : normalizeError(error, controller.signal.aborted);
      this.emit(options.onUpdate, {
        phase: failure.code === "image_cancelled" ? "cancelled" : "failed",
        itemRef: input.itemRef, itemVersion: input.itemVersion, reason: failure.code,
      });
      throw failure;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      if (this.active === job) this.active = null;
    }
  }

  cancelActive(itemRef?: string): boolean {
    if (!this.active || (itemRef !== undefined && this.active.itemRef !== itemRef)) return false;
    this.active.controller.abort();
    return true;
  }

  invalidateItem(itemRef: string): void {
    for (const [key, entry] of this.cache) if (entry.itemRef === itemRef) this.deleteCacheEntry(key, entry);
    this.cancelActive(itemRef);
  }

  clearCache(): void { this.cache.clear(); this.cachedBytes = 0; }

  getCacheStats(): ImageCacheStats {
    return { entries: this.cache.size, bytes: this.cachedBytes, limitBytes: IMAGE_LIMITS.decodedCacheBytes, workerBusy: this.active !== null };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelActive();
    this.clearCache();
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.dispose();
    if (this.workerRetirement) await this.workerRetirement;
  }

  private readCache(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (entry) { this.cache.delete(key); this.cache.set(key, entry); }
    return entry;
  }

  private writeCache(key: string, itemRef: string, image: DecodedImage): boolean {
    const bytes = image.pixels.byteLength;
    if (bytes > IMAGE_LIMITS.decodedCacheBytes) return false;
    const prior = this.cache.get(key);
    if (prior) this.deleteCacheEntry(key, prior);
    while (this.cachedBytes + bytes > IMAGE_LIMITS.decodedCacheBytes) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      const oldest = oldestKey === undefined ? undefined : this.cache.get(oldestKey);
      if (!oldest || oldestKey === undefined) break;
      this.deleteCacheEntry(oldestKey, oldest);
    }
    this.cache.set(key, { itemRef, image, bytes });
    this.cachedBytes += bytes;
    return true;
  }

  private deleteCacheEntry(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cachedBytes -= entry.bytes;
  }

  private emit(callback: ImagePreparationOptions["onUpdate"], update: ImagePreparationUpdate): void {
    try { callback?.(update); } catch { /* Observers cannot fail image preparation. */ }
  }

  private throwIfPreparationExpired(
    deadlineAt: number,
    controller: AbortController,
    markTimedOut: () => void,
    worker?: ImageDecodeWorker,
  ): void {
    const { signal } = controller;
    if (signal.aborted) {
      if (signal.reason instanceof ImagePreparationError) throw signal.reason;
      throw new ImagePreparationError("image_cancelled");
    }
    if (performance.now() < deadlineAt) return;
    markTimedOut();
    const timeoutError = new ImagePreparationError("image_prepare_timeout");
    // The utility worker kills and quarantines its child on this reason.
    // An already completed but late response is retired below.
    controller.abort(timeoutError);
    if (worker) this.retireWorker(worker);
    throw timeoutError;
  }

  private retireWorker(worker: ImageDecodeWorker | null): void {
    if (!worker || this.worker !== worker) return;
    this.worker = null;
    const previous = this.workerRetirement ?? Promise.resolve();
    const retirement = previous.then(() => worker.dispose());
    this.workerRetirement = retirement;
    // Keep a failed retirement latched so future work cannot start another worker
    // while the previous utility process may still be alive.
    void retirement.catch(() => undefined);
  }
}

function waitForPromiseOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof ImagePreparationError
      ? signal.reason
      : new ImagePreparationError("image_cancelled"));
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason instanceof ImagePreparationError
      ? signal.reason
      : new ImagePreparationError("image_cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

function validateInput(input: ImagePreparationInput): void {
  if (!input || typeof input.itemRef !== "string" || !input.itemRef ||
      typeof input.itemVersion !== "string" || !input.itemVersion) throw new ImagePreparationError("image_item_identity_invalid");
  if (input.format !== "png" && input.format !== "jpeg") throw new ImagePreparationError("image_format_unsupported");
  if (!(input.encodedBytes instanceof Uint8Array) || input.encodedBytes.byteLength === 0) throw new ImagePreparationError("image_source_invalid");
  if (input.encodedBytes.byteLength > IMAGE_LIMITS.sourceBytes) throw new ImagePreparationError("image_source_too_large");
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width <= 0 || input.height <= 0) {
    throw new ImagePreparationError("image_dimensions_invalid");
  }
  const pixels = input.width * input.height;
  if (!Number.isSafeInteger(pixels) || pixels > IMAGE_LIMITS.decodedPixels) throw new ImagePreparationError("image_dimensions_too_large");
  if (input.encodedBytes.byteLength + pixels * 4 > IMAGE_LIMITS.workerPeakBytes) {
    throw new ImagePreparationError("image_worker_capacity_exceeded");
  }
}

function validateDecodedImage(image: DecodedImage, width: number, height: number): void {
  if (!image || image.width !== width || image.height !== height || !(image.pixels instanceof Uint8Array) ||
      image.pixels.byteLength !== width * height * 4) throw new ImagePreparationError("image_decoded_invalid");
}
function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || !signature.every((byte, index) => bytes[index] === byte) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda || marker === 0x00) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      if (segmentLength < 8) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += segmentLength;
  }
  return null;
}
function cacheKey(itemRef: string, itemVersion: string): string { return JSON.stringify([itemRef, itemVersion]); }
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ImagePreparationError("image_cancelled");
}
function normalizeError(error: unknown, aborted: boolean): ImagePreparationError {
  if (aborted) return new ImagePreparationError("image_cancelled");
  if (error instanceof ImagePreparationError) return error;
  return new ImagePreparationError(error instanceof Error && /^image_[a-z0-9_]+$/.test(error.message)
    ? error.message : "image_decode_failed");
}

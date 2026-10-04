import { createHash } from "node:crypto";
import type { ClipboardItem } from "../../shared/types";
import type { NativeRequestCommand } from "../../shared/native-contracts";

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_RAW_CHUNK_BYTES = 32 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;
const BITMAPINFOHEADER_BYTES = 40;
const MAX_DIB_BYTES = MAX_IMAGE_PIXELS * 4 + BITMAPINFOHEADER_BYTES;

export type NativeImageBitmap = Readonly<{
  width: number;
  height: number;
  /** Windows 32bpp BGRA bytes in top-down row order; decoder owns platform interpretation. */
  bgra: Buffer;
}>;

export interface NativeContentProviderOptions {
  lookupCurrentItem: (itemRef: string) => ClipboardItem | undefined;
  isTrustedSender: (senderId: number) => boolean;
  /** Must decode off the Electron main event loop and return Windows 32bpp BGRA. */
  decodeImage: (dataUrl: string, encodedBytes: Buffer) => Promise<NativeImageBitmap>;
}

export interface NativeContentSnapshot {
  readonly itemRef: string;
  readonly itemVersion: string;
  readonly contentType: "text" | "image";
  readonly totalBytes: number;
  readonly totalHash: string;
}

interface StoredSnapshot {
  payload: Buffer;
  inlineBase64?: string;
}

interface RegisteredObject {
  snapshot: NativeContentSnapshot;
  jobId: string;
  objectToken: string;
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function versionFor(item: ClipboardItem): string {
  if (
    !isSafeId(item.id) ||
    !["text", "link", "image"].includes(item.type) ||
    typeof item.content !== "string"
  ) {
    throw new Error("content_item_invalid");
  }
  return sha256(Buffer.from(`clipnest-item-v1\0${item.type}\0${item.content}`, "utf8"));
}

function base64ImageSource(dataUrl: string): {
  bytes: Buffer;
  dimensions: { width: number; height: number };
} {
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length > 4 * Math.ceil(MAX_IMAGE_SOURCE_BYTES / 3)) {
    throw new Error("image_source_invalid");
  }
  const bytes = Buffer.from(match[2], "base64");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_IMAGE_SOURCE_BYTES ||
    bytes.toString("base64") !== match[2]
  ) throw new Error("image_source_invalid");
  const dimensions = match[1] === "png" ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (!dimensions || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    throw new Error("image_dimensions_unsupported");
  }
  return { bytes, dimensions };
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    return null;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      if (segmentLength < 7) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += segmentLength;
  }
  return null;
}

function toTopDownDib(bitmap: NativeImageBitmap): Buffer {
  const { width, height, bgra } = bitmap;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > MAX_IMAGE_PIXELS ||
    bgra.length !== width * height * 4
  ) throw new Error("decoded_image_invalid");

  const pixelBytes = bgra.length;
  const dib = Buffer.allocUnsafe(BITMAPINFOHEADER_BYTES + pixelBytes);
  dib.writeUInt32LE(BITMAPINFOHEADER_BYTES, 0);
  dib.writeInt32LE(width, 4);
  dib.writeInt32LE(-height, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(0, 16); // BI_RGB
  dib.writeUInt32LE(pixelBytes, 20);
  dib.writeInt32LE(0, 24);
  dib.writeInt32LE(0, 28);
  dib.writeUInt32LE(0, 32);
  dib.writeUInt32LE(0, 36);

  // Electron/Skia's Windows N32 pixels are BGRA and premultiplied. Flatten to
  // opaque RGB over white so CF_DIB consumers never depend on alpha handling.
  for (let source = 0, target = BITMAPINFOHEADER_BYTES; source < bgra.length; source += 4, target += 4) {
    const alpha = bgra[source + 3];
    const inverseAlpha = 255 - alpha;
    dib[target] = Math.min(255, bgra[source] + inverseAlpha);
    dib[target + 1] = Math.min(255, bgra[source + 1] + inverseAlpha);
    dib[target + 2] = Math.min(255, bgra[source + 2] + inverseAlpha);
    dib[target + 3] = 0xff;
  }
  return dib;
}

export class NativeContentProvider {
  private readonly payloads = new WeakMap<NativeContentSnapshot, StoredSnapshot>();
  private readonly registered = new Map<string, RegisteredObject>();

  constructor(private readonly options: NativeContentProviderOptions) {}

  async snapshot(senderId: number, itemRef: unknown): Promise<NativeContentSnapshot> {
    if (!Number.isInteger(senderId) || senderId <= 0 || !this.options.isTrustedSender(senderId)) {
      throw new Error("content_sender_rejected");
    }
    if (!isSafeId(itemRef)) throw new Error("content_item_ref_invalid");
    const item = this.options.lookupCurrentItem(itemRef);
    if (!item || item.id !== itemRef || !isSafeId(item.id) || typeof item.content !== "string") {
      throw new Error("content_item_not_found");
    }
    const itemVersion = versionFor(item);

    let payload: Buffer;
    let contentType: NativeContentSnapshot["contentType"];
    if (item.type === "image") {
      const source = base64ImageSource(item.content);
      const decoded = await this.options.decodeImage(item.content, Buffer.from(source.bytes));
      if (decoded.width !== source.dimensions.width || decoded.height !== source.dimensions.height) {
        throw new Error("decoded_image_dimensions_mismatch");
      }
      const current = this.options.lookupCurrentItem(item.id);
      let stillCurrent = false;
      try {
        stillCurrent = current?.id === item.id && versionFor(current) === itemVersion;
      } catch {
        stillCurrent = false;
      }
      if (!stillCurrent) throw new Error("content_snapshot_stale");
      payload = toTopDownDib(decoded);
      contentType = "image";
    } else if (item.type === "text" || item.type === "link") {
      if (item.content.includes("\0")) throw new Error("content_text_invalid");
      payload = Buffer.from(item.content, "utf8");
      if (payload.length > MAX_TEXT_BYTES) throw new Error("content_text_too_large");
      contentType = "text";
    } else {
      throw new Error("content_type_invalid");
    }
    if (payload.length > (contentType === "text" ? MAX_TEXT_BYTES : MAX_DIB_BYTES)) {
      throw new Error("content_payload_too_large");
    }

    const snapshot: NativeContentSnapshot = Object.freeze({
      itemRef: item.id,
      itemVersion,
      contentType,
      totalBytes: payload.length,
      totalHash: sha256(payload),
    });
    this.payloads.set(snapshot, {
      payload: Buffer.from(payload),
      ...(payload.length <= MAX_RAW_CHUNK_BYTES ? { inlineBase64: payload.toString("base64") } : {}),
    });
    return snapshot;
  }

  isCurrent(snapshot: NativeContentSnapshot): boolean {
    const current = this.options.lookupCurrentItem(snapshot.itemRef);
    if (!current || current.id !== snapshot.itemRef) return false;
    try {
      return versionFor(current) === snapshot.itemVersion;
    } catch {
      return false;
    }
  }

  registerCommand(
    snapshot: NativeContentSnapshot,
    jobId: string,
    objectToken: string,
  ): Extract<NativeRequestCommand, { kind: "register_content" }> {
    const stored = this.requireCurrentSnapshot(snapshot);
    if (!isSafeId(jobId) || !isSafeId(objectToken)) throw new Error("content_registration_identity_invalid");
    return {
      kind: "register_content",
      jobId,
      objectToken,
      itemRef: snapshot.itemRef,
      expectedItemVersion: snapshot.itemVersion,
      contentType: snapshot.contentType,
      totalBytes: snapshot.totalBytes,
      totalHash: snapshot.totalHash,
      ...(stored.inlineBase64 !== undefined ? { inlineBase64: stored.inlineBase64 } : {}),
    };
  }

  markRegistered(snapshot: NativeContentSnapshot, jobId: string, objectToken: string): void {
    this.requireCurrentSnapshot(snapshot);
    if (!isSafeId(jobId) || !isSafeId(objectToken)) throw new Error("content_registration_identity_invalid");
    this.registered.set(objectToken, { snapshot, jobId, objectToken });
  }

  createTransfer(snapshot: NativeContentSnapshot, jobId: string, objectToken: string): ContentTransferSession {
    const registration = this.registered.get(objectToken);
    if (!registration || registration.snapshot !== snapshot || registration.jobId !== jobId) {
      throw new Error("content_object_not_registered");
    }
    const stored = this.requireCurrentSnapshot(snapshot);
    return new ContentTransferSession(snapshot, jobId, objectToken, stored.payload, () => this.requireCurrentSnapshot(snapshot));
  }

  prepareCommand(
    snapshot: NativeContentSnapshot,
    jobId: string,
    objectToken: string,
  ): Extract<NativeRequestCommand, { kind: "prepare" }> {
    const registration = this.registered.get(objectToken);
    if (!registration || registration.snapshot !== snapshot || registration.jobId !== jobId) {
      throw new Error("content_object_not_registered");
    }
    this.requireCurrentSnapshot(snapshot);
    return { kind: "prepare", jobId, objectToken, expectedItemVersion: snapshot.itemVersion };
  }

  cancelCommand(jobId: string): Extract<NativeRequestCommand, { kind: "cancel" }> {
    if (!isSafeId(jobId)) throw new Error("content_job_id_invalid");
    return { kind: "cancel", jobId };
  }

  release(snapshot: NativeContentSnapshot, jobId: string, objectToken: string): void {
    const registration = this.registered.get(objectToken);
    if (registration && (registration.snapshot !== snapshot || registration.jobId !== jobId)) return;
    if (!registration && [...this.registered.values()].some((entry) => entry.snapshot === snapshot)) return;
    this.releaseSnapshot(snapshot);
  }

  /** Invalidates the host-side token and returns the helper cancellation command. */
  invalidateRegisteredObject(
    snapshot: NativeContentSnapshot,
    jobId: string,
    objectToken: string,
  ): Extract<NativeRequestCommand, { kind: "cancel" }> {
    this.release(snapshot, jobId, objectToken);
    return this.cancelCommand(jobId);
  }

  private releaseSnapshot(snapshot: NativeContentSnapshot): void {
    const stored = this.payloads.get(snapshot);
    // Transfer sessions share this byte buffer. Zero it before dropping the
    // snapshot so retained sessions cannot keep the content alive in memory.
    stored?.payload.fill(0);
    this.payloads.delete(snapshot);
    for (const [token, registration] of this.registered) {
      if (registration.snapshot === snapshot) this.registered.delete(token);
    }
  }

  private requireCurrentSnapshot(snapshot: NativeContentSnapshot): StoredSnapshot {
    const stored = this.payloads.get(snapshot);
    if (!stored) throw new Error("content_snapshot_unknown");
    if (!this.isCurrent(snapshot)) throw new Error("content_snapshot_stale");
    return stored;
  }
}

export class ContentTransferSession {
  private offset = 0;
  private index = 0;
  private awaitingIndex: number | null = null;

  constructor(
    private readonly snapshot: NativeContentSnapshot,
    private readonly jobId: string,
    private readonly objectToken: string,
    private readonly payload: Buffer,
    private readonly assertCurrent: () => void,
  ) {}

  nextChunk(): Extract<NativeRequestCommand, { kind: "content_chunk" }> | null {
    this.assertCurrent();
    if (this.awaitingIndex !== null) throw new Error("content_chunk_ack_pending");
    if (this.snapshot.totalBytes <= MAX_RAW_CHUNK_BYTES) return null;
    if (this.offset >= this.payload.length) return null;
    const chunk = this.payload.subarray(this.offset, Math.min(this.offset + MAX_RAW_CHUNK_BYTES, this.payload.length));
    if (Buffer.byteLength(JSON.stringify({
      kind: "content_chunk",
      jobId: this.jobId,
      objectToken: this.objectToken,
      index: this.index,
      offset: this.offset,
      base64: chunk.toString("base64"),
      chunkHash: sha256(chunk),
    }), "utf8") > MAX_FRAME_BYTES) throw new Error("content_chunk_frame_too_large");
    this.awaitingIndex = this.index;
    return {
      kind: "content_chunk",
      jobId: this.jobId,
      objectToken: this.objectToken,
      index: this.index,
      offset: this.offset,
      base64: chunk.toString("base64"),
      chunkHash: sha256(chunk),
    };
  }

  acknowledge(index: number, accepted: boolean): void {
    this.assertCurrent();
    if (this.awaitingIndex === null || index !== this.awaitingIndex) throw new Error("content_chunk_ack_mismatch");
    if (!accepted) throw new Error("content_chunk_rejected");
    const length = Math.min(MAX_RAW_CHUNK_BYTES, this.payload.length - this.offset);
    this.offset += length;
    this.index += 1;
    this.awaitingIndex = null;
  }

  finishCommand(): Extract<NativeRequestCommand, { kind: "finish_content" }> | null {
    this.assertCurrent();
    if (this.snapshot.totalBytes <= MAX_RAW_CHUNK_BYTES) return null;
    if (this.awaitingIndex !== null || this.offset !== this.payload.length) {
      throw new Error("content_transfer_incomplete");
    }
    return {
      kind: "finish_content",
      jobId: this.jobId,
      objectToken: this.objectToken,
      totalHash: this.snapshot.totalHash,
    };
  }
}

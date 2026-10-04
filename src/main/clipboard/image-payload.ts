export const MAX_IMAGE_PAYLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PAYLOAD_PIXELS = 16_000_000;

export interface ClipboardImageSource {
  getSize(): { width: number; height: number };
  toPNG(): Buffer;
  toJPEG(quality: number): Buffer;
}

export interface EncodedClipboardImage {
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

export function encodeClipboardImage(source: ClipboardImageSource): EncodedClipboardImage | null {
  const { width, height } = source.getSize();
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > MAX_IMAGE_PAYLOAD_PIXELS
  ) return null;

  let bytes = source.toPNG();
  let mimeType: EncodedClipboardImage["mimeType"] = "image/png";
  if (bytes.byteLength > MAX_IMAGE_PAYLOAD_BYTES) {
    bytes = source.toJPEG(82);
    mimeType = "image/jpeg";
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_PAYLOAD_BYTES) return null;

  return { bytes, mimeType, width, height };
}

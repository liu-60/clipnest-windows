import { decode as decodeJpeg } from "jpeg-js";
import { inflateSync } from "node:zlib";
import type { Metadata } from "pngjs";
import { IMAGE_LIMITS, type DecodedImage, type ImageDecodeInput, type ImageDecoder } from "./image-worker";

type PngMetadata = Omit<Metadata, "colorType" | "palette"> & {
  colorType: number;
  palette?: number[][]; transColor?: number[];
};
interface PngReader { read(length: number, callback: (bytes: Buffer) => void): void; process(): void; }

// These internals are pinned to pngjs 7.0.0. Its public sync reader inflates
// interlaced files without an output limit; reuse its parser/pixel conversion
// with Node's bounded inflater so Adam7 and ordinary PNGs have the same budget.
const PngReader = require("pngjs/lib/sync-reader") as new (bytes: Buffer) => PngReader;
const PngParser = require("pngjs/lib/parser") as new (options: { checkCRC: boolean }, dependencies: {
  read: PngReader["read"]; error(error: Error): void; metadata(metadata: PngMetadata): void;
  palette(palette: number[][]): void; transColor(color: number[]): void;
  simpleTransparency(): void; gamma(value: number): void; inflateData(bytes: Buffer): void;
}) => { start(): void };
const pngCrc = require("pngjs/lib/crc") as { crc32(bytes: Buffer): number };
const pngFilter = require("pngjs/lib/filter-parse-sync") as { process(bytes: Buffer, metadata: PngMetadata): Buffer };
const pngBitmap = require("pngjs/lib/bitmapper") as { dataToBitMap(bytes: Buffer, metadata: PngMetadata): Buffer | Uint16Array };
const normalizePng = require("pngjs/lib/format-normaliser") as
  (pixels: Buffer | Uint16Array, metadata: PngMetadata, skipRescale: boolean) => Buffer;
const pngPaeth = require("pngjs/lib/paeth-predictor") as (left: number, up: number, upperLeft: number) => number;
const pngInterlace = require("pngjs/lib/interlace") as {
  getImagePasses(width: number, height: number): { width: number; height: number }[];
};
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Called only by the utility-process production entry; never decode on the main thread. */
export const decodeProductionImage: ImageDecoder = async (input, signal) => {
  if (signal.aborted) throw new Error("image_decode_cancelled");
  validateInput(input);
  const bytes = Buffer.from(input.encodedBytes.buffer, input.encodedBytes.byteOffset, input.encodedBytes.byteLength);
  try {
    const image = input.format === "png" ? decodePng(bytes, input) : decodeJpegImage(bytes, input);
    if (signal.aborted) throw new Error("image_decode_cancelled");
    if (image.width !== input.width || image.height !== input.height ||
        image.pixels.byteLength !== input.width * input.height * 4) throw new Error("image_decoded_invalid");
    return image;
  } catch (error) {
    if (error instanceof Error && /^image_[a-z0-9_]+$/.test(error.message)) throw error;
    if (error instanceof Error && error.message.includes("maxResolutionInMP")) throw new Error("image_dimensions_too_large");
    if (error instanceof Error && error.message.includes("maxMemoryUsageInMB")) throw new Error("image_worker_capacity_exceeded");
    throw new Error("image_decode_failed");
  }
};

function decodePng(bytes: Buffer, input: ImageDecodeInput): DecodedImage {
  validatePngChunks(bytes, input);
  let metadata: PngMetadata | undefined;
  const compressedParts: Buffer[] = [];
  const reader = new PngReader(bytes);
  const parser = new PngParser({ checkCRC: true }, {
    read: reader.read.bind(reader), error(error) { throw error; },
    metadata(value) { metadata = value; },
    palette(value) { if (metadata) metadata.palette = value; },
    transColor(value) { if (metadata) metadata.transColor = value; },
    simpleTransparency() {}, gamma() {}, inflateData(value) { compressedParts.push(value); },
  });
  parser.start();
  reader.process();
  if (!metadata || compressedParts.length === 0) throw new Error("image_source_invalid");
  const passes = metadata.interlace ? pngInterlace.getImagePasses(metadata.width, metadata.height) : [metadata];
  let inflatedBytes = 0;
  let unfilteredBytes = 0;
  let rowCount = 0;
  for (const pass of passes) {
    const rowBytes = Math.ceil(pass.width * metadata.bpp * metadata.depth / 8);
    unfilteredBytes += rowBytes * pass.height;
    inflatedBytes += (rowBytes + 1) * pass.height;
    rowCount += pass.height;
  }
  const pixels = input.width * input.height;
  // Include IDAT concatenation, inflater output/copy, filter rows/copy, and
  // the larger 16-bit intermediate where applicable, plus runtime headroom.
  const directRgba8 = metadata.depth === 8 && metadata.colorType === 6 && !metadata.interlace && !metadata.transColor;
  const peakBytes = bytes.byteLength * 2 + (directRgba8
    ? inflatedBytes + pixels * 4 + rowCount * 16 + 16 * 1024 * 1024
    : Math.max(
      inflatedBytes * 2,
      inflatedBytes + unfilteredBytes * 2,
      unfilteredBytes + pixels * (metadata.depth === 16 ? 12 : 4),
    ) + rowCount * 128 + 16 * 1024 * 1024);
  if (peakBytes > IMAGE_LIMITS.workerPeakBytes) throw new Error("image_worker_capacity_exceeded");
  const compressed = compressedParts.length === 1 ? compressedParts[0] : Buffer.concat(compressedParts);
  compressedParts.length = 0;
  // zlib's synchronous helper otherwise fills 16 KiB chunks and concatenates
  // them into a second full-size buffer. A single bounded output chunk avoids
  // that transient copy on large images; the extra byte keeps an exact-size
  // stream from exhausting the chunk and allocating another one.
  let inflated: Buffer | null = inflateSync(compressed, {
    maxOutputLength: inflatedBytes,
    chunkSize: Math.max(64 * 1024, inflatedBytes + 1),
  });
  if (inflated.byteLength !== inflatedBytes) throw new Error("image_source_invalid");
  if (directRgba8) {
    const rgba = unfilterRgba8InPlace(inflated, metadata.width, metadata.height);
    inflated = null;
    return { width: metadata.width, height: metadata.height, pixels: rgba };
  }
  const filtered = pngFilter.process(inflated, metadata);
  inflated = null;
  const bitmap = pngBitmap.dataToBitMap(filtered, metadata);
  const rgba = normalizePng(bitmap, metadata, false);
  if (!(rgba instanceof Uint8Array)) throw new Error("image_decoded_invalid");
  return { width: metadata.width, height: metadata.height, pixels: rgba };
}

/**
 * For non-interlaced 8-bit RGBA PNGs, reverse row filters in place and compact
 * away filter bytes after the bounded inflater has produced one output buffer.
 */
function unfilterRgba8InPlace(data: Buffer, width: number, height: number): Buffer {
  const rowBytes = width * 4;
  const sourceStride = rowBytes + 1;
  for (let row = 0; row < height; row++) {
    const sourceOffset = row * sourceStride + 1;
    const destinationOffset = row * rowBytes;
    const filter = data[sourceOffset - 1];
    if (filter === 0) {
      data.copyWithin(destinationOffset, sourceOffset, sourceOffset + rowBytes);
      continue;
    }
    if (filter < 1 || filter > 4) throw new Error("image_source_invalid");
    const previousOffset = destinationOffset - rowBytes;
    for (let index = 0; index < rowBytes; index++) {
      const left = index >= 4 ? data[destinationOffset + index - 4] : 0;
      const up = row > 0 ? data[previousOffset + index] : 0;
      const upperLeft = row > 0 && index >= 4 ? data[previousOffset + index - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else predictor = pngPaeth(left, up, upperLeft);
      data[destinationOffset + index] = (data[sourceOffset + index] + predictor) & 0xff;
    }
  }
  return data.subarray(0, rowBytes * height);
}

function validatePngChunks(bytes: Buffer, input: ImageDecodeInput): void {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(pngSignature)) throw new Error("image_source_invalid");
  let offset = 8;
  let chunkCount = 0;
  let sawData = false;
  let dataEnded = false;
  let paletteEntries = 0;
  let sawTransparency = false;
  let colorType = -1;
  while (offset + 12 <= bytes.length) {
    if (++chunkCount > 4096) throw new Error("image_source_invalid");
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length) throw new Error("image_source_invalid");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) ||
        pngCrc.crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readInt32BE(end - 4)) {
      throw new Error("image_png_crc_invalid");
    }
    if (chunkCount === 1) {
      if (type !== "IHDR" || length !== 13) throw new Error("image_source_invalid");
      validateDimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12), input);
      const depth = bytes[offset + 16];
      colorType = bytes[offset + 17];
      const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[colorType]?.includes(depth)) throw new Error("image_source_invalid");
    } else if (type === "IHDR") throw new Error("image_source_invalid");
    if (type === "PLTE") {
      if (sawData || paletteEntries || length === 0 || length > 768 || length % 3 !== 0 || colorType === 0 || colorType === 4) {
        throw new Error("image_source_invalid");
      }
      paletteEntries = length / 3;
    }
    if (type === "tRNS") {
      if (sawData || sawTransparency || (colorType === 0 ? length !== 2 : colorType === 2 ? length !== 6 :
          colorType === 3 ? length === 0 || length > paletteEntries : true)) throw new Error("image_source_invalid");
      sawTransparency = true;
    }
    if (type === "gAMA" && length !== 4) throw new Error("image_source_invalid");
    if (type === "IDAT") {
      if (dataEnded) throw new Error("image_source_invalid");
      sawData = true;
    } else if (sawData) dataEnded = true;
    if (type === "IEND") {
      if (!sawData || length !== 0 || end !== bytes.length) throw new Error("image_source_invalid");
      return;
    }
    offset = end;
  }
  throw new Error("image_source_invalid");
}

function decodeJpegImage(bytes: Buffer, input: ImageDecodeInput): DecodedImage {
  validateDimensions(...jpegDimensions(bytes), input);
  const image = decodeJpeg(bytes, {
    useTArray: true, formatAsRGBA: true, tolerantDecoding: false,
    maxResolutionInMP: 16, maxMemoryUsageInMB: 256,
  });
  return { width: image.width, height: image.height, pixels: image.data };
}

function jpegDimensions(bytes: Buffer): [number, number] {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("image_source_invalid");
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda || marker === 0x00) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) break;
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  throw new Error("image_source_invalid");
}

function validateInput(input: ImageDecodeInput): void {
  if (!input || !(input.encodedBytes instanceof Uint8Array) || input.encodedBytes.byteLength === 0) throw new Error("image_source_invalid");
  if (input.encodedBytes.byteLength > IMAGE_LIMITS.sourceBytes) throw new Error("image_source_too_large");
  if (input.format !== "png" && input.format !== "jpeg") throw new Error("image_format_unsupported");
  validateDimensions(input.width, input.height, input);
}
function validateDimensions(width: number, height: number, input: ImageDecodeInput): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error("image_dimensions_invalid");
  if (!Number.isSafeInteger(width * height) || width * height > IMAGE_LIMITS.decodedPixels) throw new Error("image_dimensions_too_large");
  if (width !== input.width || height !== input.height) throw new Error("image_dimensions_mismatch");
}

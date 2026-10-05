import type { DecodedImage } from "./image-worker";

/*
 * The fixed-point IDCT constants and row/column stages below are adapted from
 * jpeg-js 0.4.4 (Copyright (c) 2014 Eugene Ware), under its 3-Clause BSD
 * license. The implementation keeps only one MCU row instead of the full
 * coefficient and component planes used by that decoder.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 * 1. Source redistributions retain the above copyright notice, this list of
 *    conditions and the following disclaimer.
 * 2. Binary redistributions reproduce the above copyright notice, this list
 *    of conditions and the following disclaimer in the documentation and/or
 *    other materials provided with the distribution.
 * 3. Neither the name of Eugene Ware nor the names of its contributors may be
 *    used to endorse or promote products derived from this software without
 *    specific prior written permission.
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDER AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

const ZIG_ZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

const COS_1 = 4017;
const SIN_1 = 799;
const COS_3 = 3406;
const SIN_3 = 2276;
const COS_6 = 1567;
const SIN_6 = 3784;
const SQRT_2 = 5793;
const SQRT_1_2 = 2896;

interface HuffmanTable {
  readonly minCode: Int32Array;
  readonly maxCode: Int32Array;
  readonly valueOffset: Int32Array;
  readonly values: Uint8Array;
}

interface Component {
  readonly id: number;
  readonly h: number;
  readonly v: number;
  readonly quantizationId: number;
  quantization: Uint16Array | undefined;
  dcTable: HuffmanTable | undefined;
  acTable: HuffmanTable | undefined;
  predictor: number;
  band: Uint8Array | undefined;
  bandWidth: number;
}

interface Frame {
  readonly width: number;
  readonly height: number;
  readonly components: Component[];
  readonly maxH: number;
  readonly maxV: number;
}

interface ScanComponent {
  readonly component: Component;
}

interface ScanPlan {
  readonly frame: Frame;
  readonly scan: ScanComponent[];
  readonly restartInterval: number;
  readonly entropyOffset: number;
  readonly mcuColumns: number;
  readonly mcuRows: number;
}

/**
 * Decodes only high-memory, 8-bit SOF0 JPEGs with one full interleaved scan.
 * A null result means the existing jpeg-js path must retain its old behavior.
 * Once this function selects a stream, malformed data throws and never falls
 * back to a full-frame decoder.
 */
export function decodeLargeBaselineJpeg(
  bytes: Buffer,
  expectedWidth: number,
  expectedHeight: number,
): DecodedImage | null {
  const plan = parsePlan(bytes, expectedWidth, expectedHeight);
  if (!plan) return null;
  return decodePlan(bytes, plan);
}

function parsePlan(bytes: Buffer, expectedWidth: number, expectedHeight: number): ScanPlan | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("image_source_invalid");
  const quantizationTables: (Uint16Array | undefined)[] = [];
  const dcTables: (HuffmanTable | undefined)[] = [];
  const acTables: (HuffmanTable | undefined)[] = [];
  let frame: Frame | undefined;
  let restartInterval = 0;
  let offset = 2;

  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) throw new Error("image_source_invalid");
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) throw new Error("image_source_invalid");
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0x00 || marker === 0xd8) {
      throw new Error("image_source_invalid");
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) throw new Error("image_source_invalid");
    const segmentLength = bytes.readUInt16BE(offset);
    const payload = offset + 2;
    const end = offset + segmentLength;
    if (segmentLength < 2 || end > bytes.length) throw new Error("image_source_invalid");

    if (marker === 0xc0) {
      if (frame) return null;
      const precision = bytes[payload];
      const height = bytes.readUInt16BE(payload + 1);
      const width = bytes.readUInt16BE(payload + 3);
      const count = bytes[payload + 5];
      if (segmentLength !== 8 + count * 3) throw new Error("image_source_invalid");
      if (precision !== 8 || (count !== 1 && count !== 3)) return null;
      if (width !== expectedWidth || height !== expectedHeight) throw new Error("image_dimensions_mismatch");
      const components: Component[] = [];
      const ids = new Set<number>();
      let maxH = 1;
      let maxV = 1;
      let blocksPerMcu = 0;
      for (let index = 0; index < count; index++) {
        const componentOffset = payload + 6 + index * 3;
        const id = bytes[componentOffset];
        const sampling = bytes[componentOffset + 1];
        const h = sampling >>> 4;
        const v = sampling & 0x0f;
        const quantizationId = bytes[componentOffset + 2];
        if (ids.has(id) || h < 1 || h > 4 || v < 1 || v > 4 || quantizationId > 3) {
          throw new Error("image_source_invalid");
        }
        ids.add(id);
        maxH = Math.max(maxH, h);
        maxV = Math.max(maxV, v);
        blocksPerMcu += h * v;
        components.push({ id, h, v, quantizationId, quantization: undefined,
          dcTable: undefined, acTable: undefined, predictor: 0, band: undefined, bandWidth: 0 });
      }
      if (blocksPerMcu > 10 || (count === 1 && (components[0].h !== 1 || components[0].v !== 1))) return null;
      frame = { width, height, components, maxH, maxV };
    } else if (isSofMarker(marker)) {
      return null;
    } else if (marker === 0xdb) {
      let cursor = payload;
      while (cursor < end) {
        const spec = bytes[cursor++];
        const precision = spec >>> 4;
        const tableId = spec & 0x0f;
        if (tableId > 3 || precision !== 0) return null;
        if (cursor + 64 > end) throw new Error("image_source_invalid");
        const table = new Uint16Array(64);
        for (let index = 0; index < 64; index++) table[ZIG_ZAG[index]] = bytes[cursor++];
        if (table.some((value) => value === 0)) throw new Error("image_source_invalid");
        quantizationTables[tableId] = table;
      }
    } else if (marker === 0xc4) {
      let cursor = payload;
      while (cursor < end) {
        if (cursor + 17 > end) throw new Error("image_source_invalid");
        const spec = bytes[cursor++];
        const tableClass = spec >>> 4;
        const tableId = spec & 0x0f;
        if (tableClass > 1 || tableId > 3) return null;
        const counts = bytes.subarray(cursor, cursor + 16);
        cursor += 16;
        const valueCount = counts.reduce((sum, value) => sum + value, 0);
        if (valueCount === 0 || valueCount > 256 || cursor + valueCount > end) {
          throw new Error("image_source_invalid");
        }
        const values = Uint8Array.from(bytes.subarray(cursor, cursor + valueCount));
        cursor += valueCount;
        const table = buildHuffmanTable(counts, values);
        (tableClass === 0 ? dcTables : acTables)[tableId] = table;
      }
    } else if (marker === 0xdd) {
      if (segmentLength !== 4) throw new Error("image_source_invalid");
      restartInterval = bytes.readUInt16BE(payload);
    } else if (marker === 0xda) {
      if (!frame) throw new Error("image_source_invalid");
      const scanCount = bytes[payload];
      if (segmentLength !== 6 + scanCount * 2) {
        throw new Error("image_source_invalid");
      }
      if (scanCount !== frame.components.length || bytes[payload + 1 + scanCount * 2] !== 0 ||
          bytes[payload + 2 + scanCount * 2] !== 63 || bytes[payload + 3 + scanCount * 2] !== 0) return null;
      const scan: ScanComponent[] = [];
      const seen = new Set<number>();
      for (let index = 0; index < scanCount; index++) {
        const id = bytes[payload + 1 + index * 2];
        const tableSpec = bytes[payload + 2 + index * 2];
        const component = frame.components.find((item) => item.id === id);
        if (!component || seen.has(id)) throw new Error("image_source_invalid");
        seen.add(id);
        component.quantization = quantizationTables[component.quantizationId];
        component.dcTable = dcTables[tableSpec >>> 4];
        component.acTable = acTables[tableSpec & 0x0f];
        if (!component.quantization || !component.dcTable || !component.acTable) {
          throw new Error("image_source_invalid");
        }
        scan.push({ component });
      }
      const mcuColumns = Math.ceil(frame.width / (frame.maxH * 8));
      const mcuRows = Math.ceil(frame.height / (frame.maxV * 8));
      for (const component of frame.components) {
        component.bandWidth = mcuColumns * component.h * 8;
        component.band = new Uint8Array(component.bandWidth * component.v * 8);
      }
      return { frame, scan, restartInterval, entropyOffset: end, mcuColumns, mcuRows };
    }
    offset = end;
  }
  return null;
}

function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function buildHuffmanTable(counts: Uint8Array, values: Uint8Array): HuffmanTable {
  const minCode = new Int32Array(17).fill(-1);
  const maxCode = new Int32Array(17).fill(-1);
  const valueOffset = new Int32Array(17);
  let code = 0;
  let valueIndex = 0;
  for (let length = 1; length <= 16; length++) {
    const count = counts[length - 1];
    if (count > 0 && code + count >= 2 ** length) throw new Error("image_source_invalid");
    if (count > 0) {
      minCode[length] = code;
      maxCode[length] = code + count - 1;
      valueOffset[length] = valueIndex - code;
      valueIndex += count;
    }
    code = (code + count) << 1;
  }
  if (valueIndex !== values.length) throw new Error("image_source_invalid");
  return { minCode, maxCode, valueOffset, values };
}

class EntropyReader {
  private offset: number;
  private current = 0;
  private remaining = 0;

  constructor(private readonly bytes: Buffer, offset: number) { this.offset = offset; }

  readBit(): number {
    if (this.remaining === 0) {
      if (this.offset >= this.bytes.length) throw new Error("image_source_invalid");
      this.current = this.bytes[this.offset++];
      if (this.current === 0xff) {
        if (this.offset >= this.bytes.length || this.bytes[this.offset++] !== 0) {
          throw new Error("image_source_invalid");
        }
      }
      this.remaining = 8;
    }
    return (this.current >>> --this.remaining) & 1;
  }

  readRestart(expected: number): void {
    this.alignWithOnes();
    if (this.bytes[this.offset++] !== 0xff) throw new Error("image_source_invalid");
    while (this.bytes[this.offset] === 0xff) this.offset++;
    if (this.bytes[this.offset++] !== 0xd0 + expected) throw new Error("image_source_invalid");
  }

  requireEndOfImage(): void {
    this.alignWithOnes();
    if (this.bytes[this.offset++] !== 0xff) throw new Error("image_source_invalid");
    while (this.bytes[this.offset] === 0xff) this.offset++;
    if (this.bytes[this.offset++] !== 0xd9) throw new Error("image_source_invalid");
  }

  private alignWithOnes(): void {
    if (this.remaining === 0) return;
    const mask = (1 << this.remaining) - 1;
    if ((this.current & mask) !== mask) throw new Error("image_source_invalid");
    this.remaining = 0;
  }
}

function decodePlan(bytes: Buffer, plan: ScanPlan): DecodedImage {
  const { frame } = plan;
  const pixels = Buffer.allocUnsafe(frame.width * frame.height * 4);
  const coefficients = new Int32Array(64);
  const work = new Int32Array(64);
  const samples = new Uint8Array(64);
  const sampleRows = Array.from({ length: 8 }, (_, row) => samples.subarray(row * 8, row * 8 + 8));
  const reader = new EntropyReader(bytes, plan.entropyOffset);
  const totalMcus = plan.mcuColumns * plan.mcuRows;
  let restartNumber = 0;
  let decodedMcus = 0;

  for (let mcuY = 0; mcuY < plan.mcuRows; mcuY++) {
    for (let mcuX = 0; mcuX < plan.mcuColumns; mcuX++) {
      for (const scanComponent of plan.scan) {
        const component = scanComponent.component;
        for (let blockY = 0; blockY < component.v; blockY++) {
          for (let blockX = 0; blockX < component.h; blockX++) {
            decodeBlock(reader, component, coefficients, work, samples);
            writeBlock(component, mcuX, blockX, blockY, sampleRows);
          }
        }
      }
      decodedMcus++;
      if (plan.restartInterval > 0 && decodedMcus < totalMcus && decodedMcus % plan.restartInterval === 0) {
        reader.readRestart(restartNumber);
        restartNumber = (restartNumber + 1) & 7;
        for (const component of frame.components) component.predictor = 0;
      }
    }
    renderMcuRow(frame, pixels, mcuY);
  }
  reader.requireEndOfImage();
  return { width: frame.width, height: frame.height, pixels };
}

function decodeBlock(
  reader: EntropyReader,
  component: Component,
  coefficients: Int32Array,
  work: Int32Array,
  samples: Uint8Array,
): void {
  const dcTable = component.dcTable;
  const acTable = component.acTable;
  const quantization = component.quantization;
  if (!dcTable || !acTable || !quantization) throw new Error("image_source_invalid");
  coefficients.fill(0);
  const dcCategory = decodeHuffman(reader, dcTable);
  if (dcCategory > 11) throw new Error("image_source_invalid");
  component.predictor += receiveExtended(reader, dcCategory);
  if (component.predictor < -2048 || component.predictor > 2047) throw new Error("image_source_invalid");
  coefficients[0] = component.predictor;

  let coefficient = 1;
  while (coefficient < 64) {
    const symbol = decodeHuffman(reader, acTable);
    const run = symbol >>> 4;
    const size = symbol & 0x0f;
    if (size === 0) {
      if (run === 0) break;
      if (run !== 15 || coefficient + 16 > 64) throw new Error("image_source_invalid");
      coefficient += 16;
      continue;
    }
    if (size > 10) throw new Error("image_source_invalid");
    coefficient += run;
    if (coefficient >= 64) throw new Error("image_source_invalid");
    coefficients[ZIG_ZAG[coefficient++]] = receiveExtended(reader, size);
  }
  inverseDct(coefficients, quantization, work, samples);
}

function decodeHuffman(reader: EntropyReader, table: HuffmanTable): number {
  let code = 0;
  for (let length = 1; length <= 16; length++) {
    code = (code << 1) | reader.readBit();
    const max = table.maxCode[length];
    if (max >= 0 && code <= max) {
      const index = table.valueOffset[length] + code;
      if (index < 0 || index >= table.values.length) throw new Error("image_source_invalid");
      return table.values[index];
    }
  }
  throw new Error("image_source_invalid");
}

function receiveExtended(reader: EntropyReader, length: number): number {
  if (length === 0) return 0;
  let value = 0;
  for (let index = 0; index < length; index++) value = (value << 1) | reader.readBit();
  const threshold = 1 << (length - 1);
  return value >= threshold ? value : value - ((1 << length) - 1);
}

function writeBlock(component: Component, mcuX: number, blockX: number, blockY: number, sampleRows: Uint8Array[]): void {
  const band = component.band;
  if (!band) throw new Error("image_source_invalid");
  const xStart = mcuX * component.h * 8 + blockX * 8;
  const yStart = blockY * 8;
  for (let y = 0; y < 8; y++) {
    const destination = (yStart + y) * component.bandWidth + xStart;
    band.set(sampleRows[y], destination);
  }
}

function renderMcuRow(frame: Frame, pixels: Buffer, mcuY: number): void {
  const { components, width, height, maxH, maxV } = frame;
  const firstY = mcuY * maxV * 8;
  const rowCount = Math.min(maxV * 8, height - firstY);
  const first = components[0];
  const second = components[1];
  const third = components[2];
  if (maxH === 1 && maxV === 1) {
    const firstBand = first.band;
    const secondBand = second?.band;
    const thirdBand = third?.band;
    if (!firstBand || (second && !secondBand) || (third && !thirdBand)) throw new Error("image_source_invalid");
    for (let localY = 0; localY < rowCount; localY++) {
      const y = firstY + localY;
      let firstOffset = localY * first.bandWidth;
      let secondOffset = localY * (second?.bandWidth ?? 0);
      let thirdOffset = localY * (third?.bandWidth ?? 0);
      let output = (y * width) * 4;
      for (let x = 0; x < width; x++) {
        const firstSample = firstBand[firstOffset++];
        let red = firstSample;
        let green = firstSample;
        let blue = firstSample;
        if (secondBand && thirdBand) {
          const cb = secondBand[secondOffset++];
          const cr = thirdBand[thirdOffset++];
          red = clamp8(firstSample + 1.402 * (cr - 128));
          green = clamp8(firstSample - 0.3441363 * (cb - 128) - 0.71413636 * (cr - 128));
          blue = clamp8(firstSample + 1.772 * (cb - 128));
        }
        pixels[output++] = red;
        pixels[output++] = green;
        pixels[output++] = blue;
        pixels[output++] = 255;
      }
    }
    return;
  }
  for (let localY = 0; localY < rowCount; localY++) {
    const y = firstY + localY;
    const firstRow = localY * first.v / maxV | 0;
    const secondRow = second ? (localY * second.v / maxV | 0) : 0;
    const thirdRow = third ? (localY * third.v / maxV | 0) : 0;
    const firstBand = first.band;
    const secondBand = second?.band;
    const thirdBand = third?.band;
    if (!firstBand || (second && !secondBand) || (third && !thirdBand)) throw new Error("image_source_invalid");
    let output = (y * width) * 4;
    for (let x = 0; x < width; x++) {
      const firstSample = firstBand[firstRow * first.bandWidth + (x * first.h / maxH | 0)];
      let red = firstSample;
      let green = firstSample;
      let blue = firstSample;
      if (second && third && secondBand && thirdBand) {
        const cb = secondBand[secondRow * second.bandWidth + (x * second.h / maxH | 0)];
        const cr = thirdBand[thirdRow * third.bandWidth + (x * third.h / maxH | 0)];
        red = clamp8(firstSample + 1.402 * (cr - 128));
        green = clamp8(firstSample - 0.3441363 * (cb - 128) - 0.71413636 * (cr - 128));
        blue = clamp8(firstSample + 1.772 * (cb - 128));
      }
      pixels[output++] = red;
      pixels[output++] = green;
      pixels[output++] = blue;
      pixels[output++] = 255;
    }
  }
}

function clamp8(value: number): number { return value < 0 ? 0 : value > 255 ? 255 : value; }

function inverseDct(
  coefficients: Int32Array,
  quantization: Uint16Array,
  work: Int32Array,
  samples: Uint8Array,
): void {
  for (let index = 0; index < 64; index++) work[index] = coefficients[index] * quantization[index];
  let v0 = 0, v1 = 0, v2 = 0, v3 = 0, v4 = 0, v5 = 0, v6 = 0, v7 = 0, t = 0;

  for (let row = 0; row < 8; row++) {
    const base = row * 8;
    if (work[base + 1] === 0 && work[base + 2] === 0 && work[base + 3] === 0 && work[base + 4] === 0 &&
        work[base + 5] === 0 && work[base + 6] === 0 && work[base + 7] === 0) {
      t = (SQRT_2 * work[base] + 512) >> 10;
      for (let column = 0; column < 8; column++) work[base + column] = t;
      continue;
    }
    v0 = (SQRT_2 * work[base] + 128) >> 8;
    v1 = (SQRT_2 * work[base + 4] + 128) >> 8;
    v2 = work[base + 2]; v3 = work[base + 6];
    v4 = (SQRT_1_2 * (work[base + 1] - work[base + 7]) + 128) >> 8;
    v7 = (SQRT_1_2 * (work[base + 1] + work[base + 7]) + 128) >> 8;
    v5 = work[base + 3] << 4; v6 = work[base + 5] << 4;
    t = (v0 - v1 + 1) >> 1; v0 = (v0 + v1 + 1) >> 1; v1 = t;
    t = (v2 * SIN_6 + v3 * COS_6 + 128) >> 8; v2 = (v2 * COS_6 - v3 * SIN_6 + 128) >> 8; v3 = t;
    t = (v4 - v6 + 1) >> 1; v4 = (v4 + v6 + 1) >> 1; v6 = t;
    t = (v7 + v5 + 1) >> 1; v5 = (v7 - v5 + 1) >> 1; v7 = t;
    t = (v0 - v3 + 1) >> 1; v0 = (v0 + v3 + 1) >> 1; v3 = t;
    t = (v1 - v2 + 1) >> 1; v1 = (v1 + v2 + 1) >> 1; v2 = t;
    t = (v4 * SIN_3 + v7 * COS_3 + 2048) >> 12; v4 = (v4 * COS_3 - v7 * SIN_3 + 2048) >> 12; v7 = t;
    t = (v5 * SIN_1 + v6 * COS_1 + 2048) >> 12; v5 = (v5 * COS_1 - v6 * SIN_1 + 2048) >> 12; v6 = t;
    work[base] = v0 + v7; work[base + 7] = v0 - v7;
    work[base + 1] = v1 + v6; work[base + 6] = v1 - v6;
    work[base + 2] = v2 + v5; work[base + 5] = v2 - v5;
    work[base + 3] = v3 + v4; work[base + 4] = v3 - v4;
  }

  for (let column = 0; column < 8; column++) {
    if (work[8 + column] === 0 && work[16 + column] === 0 && work[24 + column] === 0 &&
        work[32 + column] === 0 && work[40 + column] === 0 && work[48 + column] === 0 &&
        work[56 + column] === 0) {
      t = (SQRT_2 * work[column] + 8192) >> 14;
      for (let row = 0; row < 8; row++) work[row * 8 + column] = t;
      continue;
    }
    v0 = (SQRT_2 * work[column] + 2048) >> 12;
    v1 = (SQRT_2 * work[32 + column] + 2048) >> 12;
    v2 = work[16 + column]; v3 = work[48 + column];
    v4 = (SQRT_1_2 * (work[8 + column] - work[56 + column]) + 2048) >> 12;
    v7 = (SQRT_1_2 * (work[8 + column] + work[56 + column]) + 2048) >> 12;
    v5 = work[24 + column]; v6 = work[40 + column];
    t = (v0 - v1 + 1) >> 1; v0 = (v0 + v1 + 1) >> 1; v1 = t;
    t = (v2 * SIN_6 + v3 * COS_6 + 2048) >> 12; v2 = (v2 * COS_6 - v3 * SIN_6 + 2048) >> 12; v3 = t;
    t = (v4 - v6 + 1) >> 1; v4 = (v4 + v6 + 1) >> 1; v6 = t;
    t = (v7 + v5 + 1) >> 1; v5 = (v7 - v5 + 1) >> 1; v7 = t;
    t = (v0 - v3 + 1) >> 1; v0 = (v0 + v3 + 1) >> 1; v3 = t;
    t = (v1 - v2 + 1) >> 1; v1 = (v1 + v2 + 1) >> 1; v2 = t;
    t = (v4 * SIN_3 + v7 * COS_3 + 2048) >> 12; v4 = (v4 * COS_3 - v7 * SIN_3 + 2048) >> 12; v7 = t;
    t = (v5 * SIN_1 + v6 * COS_1 + 2048) >> 12; v5 = (v5 * COS_1 - v6 * SIN_1 + 2048) >> 12; v6 = t;
    work[column] = v0 + v7; work[56 + column] = v0 - v7;
    work[8 + column] = v1 + v6; work[48 + column] = v1 - v6;
    work[16 + column] = v2 + v5; work[40 + column] = v2 - v5;
    work[24 + column] = v3 + v4; work[32 + column] = v3 - v4;
  }
  for (let index = 0; index < 64; index++) {
    const value = 128 + ((work[index] + 8) >> 4);
    samples[index] = value < 0 ? 0 : value > 255 ? 255 : value;
  }
}

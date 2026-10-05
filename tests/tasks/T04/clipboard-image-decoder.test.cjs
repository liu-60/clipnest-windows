const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { deflateSync } = require("node:zlib");
const jpeg = require("jpeg-js");
const { crc32 } = require("pngjs/lib/crc");
const { decodeProductionImage } = require("../../../dist-electron/main/clipboard/image-decoder.js");
const { decodeLargeBaselineJpeg } = require("../../../dist-electron/main/clipboard/jpeg-baseline-stream.js");
const { IMAGE_LIMITS } = require("../../../dist-electron/main/clipboard/image-worker.js");

function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4, "ascii");
  data.copy(bytes, 8);
  bytes.writeInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4);
  return bytes;
}

function png({ width = 2, height = 1, depth = 8, colorType = 6, interlace = 0,
  raw = Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 128]), extra = [] } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = colorType;
  header[12] = interlace;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    ...extra, chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

function filteredRgbaRows(width, height, pixels) {
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  const previous = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = y % 5;
    const rowOffset = y * rowBytes;
    const rawOffset = y * (rowBytes + 1);
    raw[rawOffset] = filter;
    for (let index = 0; index < rowBytes; index++) {
      const left = index >= 4 ? pixels[rowOffset + index - 4] : 0;
      const up = y > 0 ? previous[index] : 0;
      const upperLeft = y > 0 && index >= 4 ? previous[index - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = testPaeth(left, up, upperLeft);
      raw[rawOffset + 1 + index] = (pixels[rowOffset + index] - predictor) & 0xff;
    }
    pixels.copy(previous, 0, rowOffset, rowOffset + rowBytes);
  }
  return raw;
}

function testPaeth(left, up, upperLeft) {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance ? left
    : upDistance <= upperLeftDistance ? up : upperLeft;
}

function request(format, bytes, width = 2, height = 1) {
  return { jobId: "real-image", format, encodedBytes: Uint8Array.from(bytes), width, height };
}
function jpegSof(width, height, samplingFactors) {
  const componentCount = samplingFactors.length;
  const segmentLength = 8 + componentCount * 3;
  const bytes = Buffer.alloc(4 + segmentLength);
  bytes.set([0xff, 0xd8, 0xff, 0xc0]);
  bytes.writeUInt16BE(segmentLength, 4);
  bytes[6] = 8;
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  bytes[11] = componentCount;
  for (let index = 0; index < componentCount; index++) {
    const offset = 12 + index * 3;
    bytes[offset] = index + 1;
    bytes[offset + 1] = samplingFactors[index];
  }
  return bytes;
}
function jpegSegment(marker, payload) {
  const bytes = Buffer.alloc(payload.length + 4);
  bytes.set([0xff, marker]);
  bytes.writeUInt16BE(payload.length + 2, 2);
  payload.copy(bytes, 4);
  return bytes;
}
function truncatedJpegSegment(marker, payload, missingBytes = 2) {
  const bytes = jpegSegment(marker, payload);
  bytes.writeUInt16BE(bytes.readUInt16BE(2) + missingBytes, 2);
  return bytes;
}
function jpegWithSegments(frame, segments) {
  return Buffer.concat([frame, ...segments, Buffer.from([0xff, 0xd9])]);
}
function jpegWithCommentBytes(encoded, payloadBytes) {
  const scanMarker = Buffer.from([0xff, 0xda]);
  const scanOffset = encoded.indexOf(scanMarker);
  assert.notEqual(scanOffset, -1, "fixture should contain an SOS marker");
  const comments = [];
  let remaining = payloadBytes;
  while (remaining > 0) {
    const length = Math.min(remaining, 65_533);
    comments.push(jpegSegment(0xfe, Buffer.alloc(length)));
    remaining -= length;
  }
  return Buffer.concat([encoded.subarray(0, scanOffset), ...comments, encoded.subarray(scanOffset)]);
}
function jpegWithSegmentsBeforeScan(encoded, segments) {
  const scanMarker = Buffer.from([0xff, 0xda]);
  const scanOffset = encoded.indexOf(scanMarker);
  assert.notEqual(scanOffset, -1, "fixture should contain an SOS marker");
  return Buffer.concat([encoded.subarray(0, scanOffset), ...segments, encoded.subarray(scanOffset)]);
}
function jpegWithSegmentsAfterScan(encoded, segments) {
  const eoiMarker = Buffer.from([0xff, 0xd9]);
  const eoiOffset = encoded.lastIndexOf(eoiMarker);
  assert.notEqual(eoiOffset, -1, "fixture should contain an EOI marker");
  return Buffer.concat([encoded.subarray(0, eoiOffset), ...segments, encoded.subarray(eoiOffset)]);
}
function simpleBaselineJpeg({
  width,
  height,
  sampling,
  restartInterval = 0,
  allOnesDcHuffman = false,
  dcCodeLength = 1,
  dcCodeCounts = null,
  dcSymbols = null,
  dcCodewords = null,
  acCodeLength = 1,
  acCodewords = null,
}) {
  const componentCount = sampling.length;
  const frame = Buffer.alloc(6 + componentCount * 3);
  frame[0] = 8;
  frame.writeUInt16BE(height, 1);
  frame.writeUInt16BE(width, 3);
  frame[5] = componentCount;
  for (let index = 0; index < componentCount; index++) {
    frame[6 + index * 3] = index + 1;
    frame[7 + index * 3] = sampling[index];
    frame[8 + index * 3] = 0;
  }
  const quantization = Buffer.from([0, ...new Array(64).fill(1)]);
  const dcCounts = Buffer.alloc(16);
  if (dcCodeCounts) {
    assert.equal(dcCodeCounts.length, 16);
    Buffer.from(dcCodeCounts).copy(dcCounts);
  } else if (allOnesDcHuffman) {
    dcCounts[0] = 2;
  } else {
    for (let length = 0; length < dcCodeLength; length++) dcCounts[length] = 1;
  }
  const dcSymbolCount = dcCounts.reduce((sum, count) => sum + count, 0);
  const acSymbolCount = acCodeLength;
  const acTableOffset = 17 + dcSymbolCount;
  const huffman = Buffer.alloc(acTableOffset + 17 + acSymbolCount);
  const dcValues = Buffer.alloc(dcSymbolCount);
  const acCounts = Buffer.alloc(16);
  const acValues = Buffer.alloc(acSymbolCount);
  huffman[0] = 0x00;
  if (dcSymbols) {
    assert.equal(dcSymbols.length, dcSymbolCount);
    Buffer.from(dcSymbols).copy(dcValues);
  } else if (allOnesDcHuffman && !dcCodeCounts) {
    dcValues[1] = 1;
  }
  huffman.set(dcCounts, 1);
  huffman.set(dcValues, 17);
  huffman[acTableOffset] = 0x10;
  for (let length = 0; length < acCodeLength; length++) acCounts[length] = 1;
  huffman.set(acCounts, acTableOffset + 1);
  huffman.set(acValues, acTableOffset + 17);
  const segments = [
    jpegSegment(0xdb, quantization),
    jpegSegment(0xc0, frame),
    jpegSegment(0xc4, huffman),
  ];
  if (restartInterval > 0) {
    const interval = Buffer.alloc(2);
    interval.writeUInt16BE(restartInterval);
    segments.push(jpegSegment(0xdd, interval));
  }
  const scan = Buffer.alloc(1 + componentCount * 2 + 3);
  scan[0] = componentCount;
  for (let index = 0; index < componentCount; index++) {
    scan[1 + index * 2] = index + 1;
    scan[2 + index * 2] = 0;
  }
  scan[1 + componentCount * 2] = 0;
  scan[2 + componentCount * 2] = 63;
  scan[3 + componentCount * 2] = 0;
  segments.push(jpegSegment(0xda, scan));

  const maxH = Math.max(...sampling.map((factor) => factor >>> 4));
  const maxV = Math.max(...sampling.map((factor) => factor & 0x0f));
  const mcuColumns = Math.ceil(width / (maxH * 8));
  const mcuRows = Math.ceil(height / (maxV * 8));
  const mcuCount = mcuColumns * mcuRows;
  const blocksPerMcu = sampling.reduce((total, factor) => total + (factor >>> 4) * (factor & 0x0f), 0);
  const totalBlocks = mcuCount * blocksPerMcu;
  if (dcCodewords) assert.equal(dcCodewords.length, totalBlocks);
  if (acCodewords) assert.equal(acCodewords.length, totalBlocks);
  const entropy = [];
  let pendingByte = 0;
  let pendingBits = 0;
  let restart = 0;
  const writeBit = (bit) => {
    pendingByte = (pendingByte << 1) | bit;
    if (++pendingBits === 8) {
      entropy.push(pendingByte);
      if (pendingByte === 0xff) entropy.push(0);
      pendingByte = 0;
      pendingBits = 0;
    }
  };
  const writeCode = (code, length) => {
    for (let bit = length - 1; bit >= 0; bit--) writeBit((code >>> bit) & 1);
  };
  const alignEntropy = () => {
    while (pendingBits !== 0) writeBit(1);
  };
  let codewordIndex = 0;
  for (let mcu = 0; mcu < mcuCount; mcu++) {
    for (const factor of sampling) {
      const blocks = (factor >>> 4) * (factor & 0x0f);
      for (let block = 0; block < blocks; block++) {
        const dcWord = dcCodewords?.[codewordIndex];
        const acWord = acCodewords?.[codewordIndex];
        writeCode(dcWord?.code ?? (allOnesDcHuffman ? 0 : (2 ** dcCodeLength) - 2), dcWord?.length ?? dcCodeLength);
        writeCode(dcWord?.amplitudeBits ?? 0, dcWord?.amplitudeLength ?? 0);
        writeCode(acWord?.code ?? (2 ** acCodeLength) - 2, acWord?.length ?? acCodeLength);
        codewordIndex++;
      }
    }
    if (restartInterval > 0 && (mcu + 1) % restartInterval === 0 && mcu + 1 < mcuCount) {
      alignEntropy();
      entropy.push(0xff, 0xd0 + restart);
      restart = (restart + 1) & 7;
    }
  }
  alignEntropy();
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...segments,
    Buffer.from(entropy),
    Buffer.from([0xff, 0xd9]),
  ]);
}
const decode = (input) => decodeProductionImage(input, new AbortController().signal);

test("production PNG decoder returns exact unpremultiplied RGBA and preserves encoded bytes", async () => {
  const input = request("png", png());
  const before = Uint8Array.from(input.encodedBytes);
  const result = await decode(input);
  assert.deepEqual([result.width, result.height], [2, 1]);
  assert.ok(result.pixels instanceof Uint8Array);
  assert.deepEqual([...result.pixels], [255, 0, 0, 255, 0, 255, 0, 128]);
  assert.deepEqual(input.encodedBytes, before);
});

test("8-bit RGBA PNG in-place path reverses every row filter exactly", async () => {
  const pixels = Buffer.from(Array.from({ length: 2 * 5 * 4 }, (_value, index) => (index * 53 + 17) & 0xff));
  const source = png({ width: 2, height: 5, raw: filteredRgbaRows(2, 5, pixels) });
  const image = await decode(request("png", source, 2, 5));
  assert.deepEqual([...image.pixels], [...pixels]);

  // Build a validly compressed one-row image with an unsupported filter byte.
  const invalidFilter = png({ width: 2, height: 1, raw: Buffer.from([5, ...pixels.subarray(0, 8)]) });
  await assert.rejects(decode(request("png", invalidFilter, 2, 1)), /image_source_invalid/);
});

test("PNG decoder expands RGB and palette transparency, and rescales 16-bit grayscale to RGBA", async () => {
  const rgb = await decode(request("png", png({ colorType: 2, raw: Buffer.from([0, 255, 0, 0, 0, 255, 0]) })));
  assert.deepEqual([...rgb.pixels], [255, 0, 0, 255, 0, 255, 0, 255]);
  const palette = await decode(request("png", png({ colorType: 3, raw: Buffer.from([0, 0, 1]), extra: [
    chunk("PLTE", Buffer.from([255, 0, 0, 0, 255, 0])), chunk("tRNS", Buffer.from([255, 128])),
  ] })));
  assert.deepEqual([...palette.pixels], [255, 0, 0, 255, 0, 255, 0, 128]);
  const grayscale = await decode(request("png", png({ colorType: 0, depth: 16, raw: Buffer.from([0, 0xff, 0xff, 0x80, 0x80]) })));
  assert.deepEqual([...grayscale.pixels], [255, 255, 255, 255, 128, 128, 128, 255]);
});

test("Adam7 PNG decodes using its exact inflated size and rejects compressed excess", async () => {
  const tinyInterlaced = png({ width: 1, height: 1, interlace: 1, raw: Buffer.from([0, 20, 40, 60, 80]) });
  assert.deepEqual([...(await decode(request("png", tinyInterlaced, 1, 1))).pixels], [20, 40, 60, 80]);
  const bomb = png({ width: 1, height: 1, interlace: 1, raw: Buffer.alloc(1024 * 1024) });
  await assert.rejects(decode(request("png", bomb, 1, 1)), /image_decode_failed/);
  const truncatedPixels = png({ raw: Buffer.from([0, 255, 0, 0]) });
  await assert.rejects(decode(request("png", truncatedPixels)), /image_source_invalid/);
});

test("PNG decoder verifies IHDR, IDAT, and ancillary chunk CRCs before decoding", async () => {
  const source = png({ extra: [chunk("tEXt", Buffer.from("author\0ClipNest"))] });
  for (const type of ["IHDR", "tEXt", "IDAT"]) {
    const broken = Buffer.from(source);
    const offset = broken.indexOf(type, 8, "ascii");
    broken[offset + 4] ^= 1;
    await assert.rejects(decode(request("png", broken)), /image_png_crc_invalid/);
  }
  await assert.rejects(decode(request("png", source.subarray(0, source.length - 4))), /image_source_invalid/);
  const falseDimensions = png({ width: 3 });
  await assert.rejects(decode(request("png", falseDimensions)), /image_dimensions_mismatch/);
});

test("real JPEG decoder produces strict opaque RGBA and rejects damaged data", async () => {
  const pixels = Buffer.from([240, 40, 20, 255, 240, 40, 20, 255]);
  const encoded = jpeg.encode({ width: 2, height: 1, data: pixels }, 100).data;
  const input = request("jpeg", encoded);
  const before = Uint8Array.from(input.encodedBytes);
  const result = await decode(input);
  assert.deepEqual([result.width, result.height, result.pixels.length], [2, 1, 8]);
  for (let index = 0; index < 8; index++) {
    if (index % 4 === 3) assert.equal(result.pixels[index], 255);
    else assert.ok(Math.abs(result.pixels[index] - pixels[index]) <= 2);
  }
  assert.deepEqual(input.encodedBytes, before);
  await assert.rejects(decode(request("jpeg", encoded.subarray(0, encoded.length / 2))), /image_source_invalid/);
  await assert.rejects(decode(request("jpeg", encoded, 1, 1)), /image_dimensions_mismatch/);
});

test("streamed baseline JPEG matches jpeg-js across odd MCU edges and stuffed entropy bytes", () => {
  const width = 37;
  const height = 29;
  const sourcePixels = Buffer.allocUnsafe(width * height * 4);
  let state = 0x31a6c29d;
  for (let offset = 0; offset < sourcePixels.length; offset += 4) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    sourcePixels[offset] = state & 0xff;
    sourcePixels[offset + 1] = (state >>> 8) & 0xff;
    sourcePixels[offset + 2] = (state >>> 16) & 0xff;
    sourcePixels[offset + 3] = 0xff;
  }
  const encoded = Buffer.from(jpeg.encode({ width, height, data: sourcePixels }, 91).data);
  const before = Buffer.from(encoded);
  const sos = encoded.indexOf(Buffer.from([0xff, 0xda]));
  const scanStart = sos + 2 + encoded.readUInt16BE(sos + 2);
  assert.notEqual(encoded.indexOf(Buffer.from([0xff, 0x00]), scanStart), -1, "fixture must exercise FF00 stuffing");
  const streamed = decodeLargeBaselineJpeg(encoded, width, height);
  const reference = jpeg.decode(encoded, { useTArray: true, formatAsRGBA: true });
  assert.ok(streamed);
  assert.deepEqual(streamed.pixels, Buffer.from(reference.data));
  assert.ok(streamed.pixels.every((_value, index) => index % 4 !== 3 || streamed.pixels[index] === 255));
  assert.deepEqual(encoded, before, "the decoder must not mutate the source buffer");
});

test("streamed baseline JPEG handles grayscale, 4:2:0 MCU edges, and the complete RST0–RST7 cycle", () => {
  const grayscale = simpleBaselineJpeg({ width: 72, height: 8, sampling: [0x11], restartInterval: 1 });
  const image = decodeLargeBaselineJpeg(grayscale, 72, 8);
  assert.ok(image);
  assert.deepEqual([...image.pixels.subarray(0, 8)], [128, 128, 128, 255, 128, 128, 128, 255]);
  assert.deepEqual([...image.pixels.subarray(-4)], [128, 128, 128, 255]);

  const y420 = simpleBaselineJpeg({ width: 17, height: 19, sampling: [0x22, 0x11, 0x11] });
  const color = decodeLargeBaselineJpeg(y420, 17, 19);
  assert.ok(color);
  assert.equal(color.pixels.byteLength, 17 * 19 * 4);
  for (let offset = 0; offset < color.pixels.length; offset += 4) {
    assert.deepEqual([...color.pixels.subarray(offset, offset + 4)], [128, 128, 128, 255]);
  }
  assert.equal(decodeLargeBaselineJpeg(
    simpleBaselineJpeg({ width: 16, height: 16, sampling: [0x22] }), 16, 16), null,
    "non-1x1 single-component sampling must retain the legacy path",
  );

  const wrongRestart = Buffer.from(grayscale);
  const marker = wrongRestart.indexOf(Buffer.from([0xff, 0xd0]));
  assert.notEqual(marker, -1);
  wrongRestart[marker + 1] = 0xd2;
  assert.throws(() => decodeLargeBaselineJpeg(wrongRestart, 72, 8), /image_source_invalid/);

  const invalidRestartPadding = Buffer.from(grayscale);
  invalidRestartPadding[marker - 1] &= 0xfe;
  assert.throws(() => decodeLargeBaselineJpeg(invalidRestartPadding, 72, 8), /image_source_invalid/);
});

test("production and streamed baseline JPEG accept APP and COM marker segments after the scan", async () => {
  const encoded = simpleBaselineJpeg({ width: 19, height: 17, sampling: [0x22, 0x11, 0x11] });
  const expected = decodeLargeBaselineJpeg(encoded, 19, 17);
  assert.ok(expected);
  const marked = jpegWithSegmentsAfterScan(encoded, [
    Buffer.from([0xff, 0xff, 0xff]),
    jpegSegment(0xe1, Buffer.from([0x45, 0x78, 0xff, 0xd9, 0x69, 0x66, 0x00])),
    Buffer.from([0xff, 0xff]),
    jpegSegment(0xfe, Buffer.from("comment after the completed scan", "ascii")),
    Buffer.from([0xff, 0xff, 0xff]),
  ]);

  const decoded = decodeLargeBaselineJpeg(marked, 19, 17);
  const reference = jpeg.decode(marked, { useTArray: true, formatAsRGBA: true });
  assert.ok(decoded);
  assert.deepEqual(decoded.pixels, expected.pixels);
  assert.deepEqual(decoded.pixels, Buffer.from(reference.data));
  const production = await decode(request("jpeg", marked, 19, 17));
  assert.deepEqual(Buffer.from(production.pixels), Buffer.from(reference.data));
});

test("production high-memory JPEG streaming handles post-scan metadata and COM limits", async () => {
  const width = 4000;
  const height = 4000;
  const encoded = simpleBaselineJpeg({ width, height, sampling: [0x22, 0x11, 0x11] });
  const commentsForBytes = (payloadBytes) => {
    const segments = [];
    while (payloadBytes > 0) {
      const length = Math.min(65_533, payloadBytes);
      segments.push(jpegSegment(0xfe, Buffer.alloc(length)));
      payloadBytes -= length;
    }
    return segments;
  };
  const comments = commentsForBytes(1024 * 1024);
  const marked = jpegWithSegmentsAfterScan(encoded, [
    Buffer.from([0xff, 0xff]),
    jpegSegment(0xe1, Buffer.from([0x45, 0x78, 0xff, 0xd9, 0x69, 0x66, 0x00])),
    ...comments,
    Buffer.from([0xff, 0xff, 0xff]),
  ]);
  assert.ok(marked.byteLength <= IMAGE_LIMITS.sourceBytes);
  assert.equal(width * height, IMAGE_LIMITS.decodedPixels);
  assert.ok(marked.byteLength + width * height * 4 <= IMAGE_LIMITS.workerPeakBytes);
  const stages = [];
  const image = await decodeProductionImage(request("jpeg", marked, width, height),
    new AbortController().signal, (stage) => stages.push(stage));

  assert.deepEqual([image.width, image.height, image.pixels.byteLength], [width, height, width * height * 4]);
  const preflightStage = stages.indexOf("jpegPreflightParseMs");
  const streamPlanStage = stages.indexOf("jpegStreamPlanParseMs");
  const decodeStage = stages.indexOf("jpegHuffmanIdctWriteMs");
  assert.ok(preflightStage >= 0 && streamPlanStage >= 0,
    "the production high-memory route must select the streamed baseline decoder");
  assert.ok(decodeStage >= 0 && preflightStage < streamPlanStage && streamPlanStage < decodeStage,
    "the production streamed decoder must finish Huffman/IDCT band writing");
  let mismatch = false;
  for (let offset = 0; offset < image.pixels.length; offset += 4) {
    if (image.pixels[offset] !== 128 || image.pixels[offset + 1] !== 128 ||
        image.pixels[offset + 2] !== 128 || image.pixels[offset + 3] !== 255) {
      mismatch = true;
      break;
    }
  }
  assert.equal(mismatch, false, "the complete synthetic 16MP image must decode to opaque neutral gray");

  const overLimit = jpegWithSegmentsAfterScan(encoded, [
    jpegSegment(0xe1, Buffer.from([0x45, 0x78, 0xff, 0xd9])),
    ...commentsForBytes(1024 * 1024 + 1),
  ]);
  assert.ok(overLimit.byteLength <= IMAGE_LIMITS.sourceBytes);
  const rejectedStages = [];
  await assert.rejects(decodeProductionImage(request("jpeg", overLimit, width, height),
    new AbortController().signal, (stage) => rejectedStages.push(stage)), /image_worker_capacity_exceeded/);
  assert.equal(rejectedStages.includes("jpegStreamPlanParseMs"), false,
    "post-scan COM over the preflight limit must fail before streaming decode starts");
});

test("streamed baseline JPEG rejects an extra scan and malformed post-scan segments", () => {
  const encoded = simpleBaselineJpeg({ width: 8, height: 8, sampling: [0x11] });
  const extraScan = jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 63, 0]));
  const truncatedApp = Buffer.from([0xff, 0xe1, 0x00, 0x08, 0x01]);
  const shortComment = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
  const truncatedMarker = Buffer.concat([encoded.subarray(0, encoded.length - 2), Buffer.from([0xff])]);
  for (const malformed of [extraScan, truncatedApp, shortComment, Buffer.from([0x00])]) {
    const bytes = jpegWithSegmentsAfterScan(encoded, [malformed]);
    assert.throws(() => decodeLargeBaselineJpeg(bytes, 8, 8), /image_source_invalid/);
  }
  assert.throws(() => decodeLargeBaselineJpeg(truncatedMarker, 8, 8), /image_source_invalid/);
});

test("production JPEG preflight enforces COM and marker limits after the scan", async () => {
  const encoded = simpleBaselineJpeg({ width: 8, height: 8, sampling: [0x11] });
  const commentSegments = (payloadBytes) => {
    const segments = [];
    while (payloadBytes > 0) {
      const length = Math.min(payloadBytes, 65_533);
      segments.push(jpegSegment(0xfe, Buffer.alloc(length)));
      payloadBytes -= length;
    }
    return segments;
  };
  const oneMiB = 1024 * 1024;
  const commentAtLimit = jpegWithSegmentsAfterScan(encoded, commentSegments(oneMiB));
  const commentImage = await decode(request("jpeg", commentAtLimit, 8, 8));
  assert.deepEqual([...commentImage.pixels.subarray(0, 4)], [128, 128, 128, 255]);
  const commentOverLimit = jpegWithSegmentsAfterScan(encoded, commentSegments(oneMiB + 1));
  await assert.rejects(decode(request("jpeg", commentOverLimit, 8, 8)), /image_worker_capacity_exceeded/);

  const emptyApp2 = jpegSegment(0xe2, Buffer.alloc(0));
  const atMarkerLimit = jpegWithSegmentsAfterScan(encoded, Array(4092).fill(emptyApp2));
  const markerImage = await decode(request("jpeg", atMarkerLimit, 8, 8));
  assert.deepEqual([...markerImage.pixels.subarray(0, 4)], [128, 128, 128, 255]);
  const overMarkerLimit = jpegWithSegmentsAfterScan(encoded, Array(4093).fill(emptyApp2));
  await assert.rejects(decode(request("jpeg", overMarkerLimit, 8, 8)), /image_worker_capacity_exceeded/);
});

test("streamed JPEG Huffman prefix lookup covers canonical 1–4-bit codes and suffix expansion", () => {
  for (let codeLength = 1; codeLength <= 4; codeLength++) {
    const encoded = simpleBaselineJpeg({
      width: 8,
      height: 8,
      sampling: [0x11],
      dcCodeLength: codeLength,
      acCodeLength: codeLength,
    });
    const image = decodeLargeBaselineJpeg(encoded, 8, 8);
    assert.ok(image, `canonical ${codeLength}-bit Huffman fixture should select the stream decoder`);
    for (let offset = 0; offset < image.pixels.length; offset += 4) {
      assert.deepEqual([...image.pixels.subarray(offset, offset + 4)], [128, 128, 128, 255]);
    }
  }
});

test("streamed JPEG Huffman prefix lookup covers all 16 four-bit prefixes", () => {
  const dcSymbols = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1, 2, 3];
  const dcCodewords = [
    { code: 0, length: 4 }, // Prime the entropy reader before checking each prefix.
    ...Array.from({ length: 15 }, (_value, code) => {
      const category = dcSymbols[code];
      const repeatedSymbol = code >= 12;
      const amplitudeBits = category === 0 ? 0 : repeatedSymbol
        ? (1 << (category - 1)) - 1
        : 1 << (category - 1);
      return { code, length: 4, amplitudeBits, amplitudeLength: category };
    }),
    { code: 0b11110, length: 5, amplitudeBits: 0b011, amplitudeLength: 3 },
  ];
  const acCodewords = [
    { code: 0b11110, length: 5 },
    ...Array.from({ length: 16 }, () => ({ code: 0b1110, length: 4 })),
  ];
  const dcCodeCounts = Array.from({ length: 16 }, (_value, index) => index === 3 ? 15 : index === 4 ? 1 : 0);
  const encoded = simpleBaselineJpeg({
    width: 136,
    height: 8,
    sampling: [0x11],
    dcCodeCounts,
    dcSymbols,
    dcCodewords,
    acCodeLength: 5,
    acCodewords,
  });
  const image = decodeLargeBaselineJpeg(encoded, 136, 8);
  assert.ok(image, "the all-prefix fixture should select the streaming baseline decoder");
  const reference = jpeg.decode(encoded, { useTArray: true, formatAsRGBA: true });
  assert.deepEqual(Buffer.from(image.pixels), Buffer.from(reference.data));
  assert.ok(new Set(Array.from(reference.data).filter((_value, index) => index % 4 === 0)).size > 8,
    "distinct DC categories must produce distinct grayscale blocks");
});

test("streamed JPEG Huffman decoder falls back for long codes and fewer than four buffered bits", () => {
  for (const [dcCodeLength, acCodeLength] of [[5, 6], [6, 2], [6, 3]]) {
    const encoded = simpleBaselineJpeg({
      width: 8,
      height: 8,
      sampling: [0x11],
      dcCodeLength,
      acCodeLength,
    });
    const image = decodeLargeBaselineJpeg(encoded, 8, 8);
    assert.ok(image, `fallback fixture (${dcCodeLength}, ${acCodeLength}) should select the stream decoder`);
    for (let offset = 0; offset < image.pixels.length; offset += 4) {
      assert.deepEqual([...image.pixels.subarray(offset, offset + 4)], [128, 128, 128, 255]);
    }
  }
});

test("streamed JPEG selection is conservative and selected malformed streams fail closed", () => {
  const progressiveHeader = Buffer.from(jpegSof(16, 16, [0x11, 0x11, 0x11]));
  progressiveHeader[3] = 0xc2;
  assert.equal(decodeLargeBaselineJpeg(progressiveHeader, 16, 16), null);

  const valid = simpleBaselineJpeg({ width: 16, height: 8, sampling: [0x11] });
  const allOnesCode = simpleBaselineJpeg({ width: 16, height: 8, sampling: [0x11], allOnesDcHuffman: true });
  assert.throws(() => decodeLargeBaselineJpeg(allOnesCode, 16, 8), /image_source_invalid/);
  assert.throws(() => decodeLargeBaselineJpeg(valid.subarray(0, valid.length - 2), 16, 8), /image_source_invalid/);
  assert.throws(() => decodeLargeBaselineJpeg(valid, 8, 16), /image_dimensions_mismatch/);

  const invalidEndPadding = Buffer.from(valid);
  invalidEndPadding[invalidEndPadding.length - 3] &= 0xfe;
  assert.throws(() => decodeLargeBaselineJpeg(invalidEndPadding, 16, 8), /image_source_invalid/);
});

test("encoded source, actual pixel dimensions, and PNG working-set limits are enforced", async () => {
  await assert.rejects(decode(request("png", Buffer.alloc(IMAGE_LIMITS.sourceBytes + 1))), /image_source_too_large/);
  // Claimed small dimensions cannot hide an oversized real IHDR/SOF.
  await assert.rejects(decode(request("png", png({ width: 5000, height: 4000 }))), /image_dimensions_too_large/);
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0x0f, 0xa0, 0x13, 0x88, 1, 1, 0x11, 0]);
  await assert.rejects(decode(request("jpeg", jpegHeader)), /image_dimensions_too_large/);
  // A valid 16 MP 16-bit header would require excessive intermediate buffers.
  await assert.rejects(decode(request("png", png({ width: 4000, height: 4000, depth: 16 }), 4000, 4000)), /image_worker_capacity_exceeded/);
  // Filter bookkeeping for millions of narrow rows must also fit the budget.
  await assert.rejects(decode(request("png", png({ width: 1, height: 16_000_000 }), 1, 16_000_000)), /image_worker_capacity_exceeded/);
});

test("JPEG SOF sampling and coefficient blocks are checked before full decode allocation", async () => {
  for (const samplingFactors of [[0x11, 0x11, 0x11], [0x22, 0x11, 0x11]]) {
    await assert.rejects(
      decode(request("jpeg", jpegSof(4000, 4000, samplingFactors), 4000, 4000)),
      /image_worker_capacity_exceeded/,
    );
  }
  await assert.rejects(
    decode(request("jpeg", jpegSof(32, 32, [0x00, 0x11, 0x11]), 32, 32)),
    /image_source_invalid/,
  );
});

test("JPEG metadata allocations are bounded before decode", async () => {
  const frame = jpegSof(32, 32, [0x11, 0x11, 0x11]);
  const comments = Array.from({ length: 17 }, () => jpegSegment(0xfe, Buffer.alloc(65_533)));
  await assert.rejects(decode(request("jpeg", jpegWithSegments(frame, comments), 32, 32)), /image_worker_capacity_exceeded/);

  const quantizationTable = Buffer.alloc(65);
  const quantizationTables = Array.from({ length: 65 }, () => jpegSegment(0xdb, quantizationTable));
  await assert.rejects(decode(request("jpeg", jpegWithSegments(frame, quantizationTables), 32, 32)), /image_worker_capacity_exceeded/);

  const huffmanTable = Buffer.alloc(18);
  huffmanTable[1] = 1;
  const huffmanTables = Array.from({ length: 65 }, () => jpegSegment(0xc4, huffmanTable));
  await assert.rejects(decode(request("jpeg", jpegWithSegments(frame, huffmanTables), 32, 32)), /image_worker_capacity_exceeded/);

  const repeatedHuffmanTables = Buffer.concat(Array.from({ length: 65 }, () => huffmanTable));
  await assert.rejects(
    decode(request("jpeg", Buffer.concat([frame, truncatedJpegSegment(0xc4, repeatedHuffmanTables)]), 32, 32)),
    /image_source_invalid/,
  );

  const repeatedQuantizationTables = Buffer.concat(Array.from({ length: 65 }, () => quantizationTable));
  await assert.rejects(
    decode(request("jpeg", Buffer.concat([frame, truncatedJpegSegment(0xdb, repeatedQuantizationTables)]), 32, 32)),
    /image_source_invalid/,
  );

  const nearlyFullCommentList = Array.from({ length: 16 }, () => jpegSegment(0xfe, Buffer.alloc(65_533)));
  const truncatedComment = truncatedJpegSegment(0xfe, Buffer.alloc(1024), 2048);
  await assert.rejects(
    decode(request("jpeg", Buffer.concat([frame, ...nearlyFullCommentList, truncatedComment]), 32, 32)),
    /image_source_invalid/,
  );

  const oversizedHuffmanSymbols = Buffer.alloc(17 + 257);
  oversizedHuffmanSymbols[1] = 255;
  oversizedHuffmanSymbols[2] = 2;
  await assert.rejects(
    decode(request("jpeg", jpegWithSegments(frame, [jpegSegment(0xc4, oversizedHuffmanSymbols)]), 32, 32)),
    /image_source_invalid/,
  );

  const emptyAppSegment = jpegSegment(0xe2, Buffer.alloc(0));
  const maximumSegments = Array.from({ length: 4095 }, () => emptyAppSegment);
  await assert.rejects(
    decode(request("jpeg", jpegWithSegments(frame, maximumSegments), 32, 32)),
    /image_decode_failed/,
  );
  const excessiveSegments = Array.from({ length: 4096 }, () => emptyAppSegment);
  await assert.rejects(decode(request("jpeg", jpegWithSegments(frame, excessiveSegments), 32, 32)), /image_worker_capacity_exceeded/);

  await assert.rejects(decode(request("jpeg", jpegSof(32, 32, [0x11, 0x11]), 32, 32)), /image_format_unsupported/);
});

test("JPEG COM comment limit accepts exactly one MiB and rejects the next byte", async () => {
  const base = simpleBaselineJpeg({ width: 8, height: 8, sampling: [0x11] });
  const exactLimit = jpegWithCommentBytes(base, 1024 * 1024);
  const image = await decode(request("jpeg", exactLimit, 8, 8));
  assert.deepEqual([image.width, image.height], [8, 8]);
  for (let offset = 0; offset < image.pixels.length; offset += 4) {
    assert.deepEqual([...image.pixels.subarray(offset, offset + 4)], [128, 128, 128, 255]);
  }

  const overLimit = jpegWithCommentBytes(base, 1024 * 1024 + 1);
  await assert.rejects(decode(request("jpeg", overLimit, 8, 8)), /image_worker_capacity_exceeded/);
});

test("JPEG quantization and Huffman table limits accept 64 definitions and reject 65", async () => {
  const base = simpleBaselineJpeg({ width: 8, height: 8, sampling: [0x11] });
  const quantization = jpegSegment(0xdb, Buffer.from([0, ...new Array(64).fill(1)]));
  const huffmanPayload = Buffer.alloc(18);
  huffmanPayload[1] = 1;
  const huffman = jpegSegment(0xc4, huffmanPayload);
  const assertGrayImage = (image) => {
    assert.deepEqual([image.width, image.height], [8, 8]);
    for (let offset = 0; offset < image.pixels.length; offset += 4) {
      assert.deepEqual([...image.pixels.subarray(offset, offset + 4)], [128, 128, 128, 255]);
    }
  };

  const exactQuantizationLimit = jpegWithSegmentsBeforeScan(base,
    Array.from({ length: 63 }, () => quantization));
  assertGrayImage(await decode(request("jpeg", exactQuantizationLimit, 8, 8)));
  const overQuantizationLimit = jpegWithSegmentsBeforeScan(base,
    Array.from({ length: 64 }, () => quantization));
  await assert.rejects(decode(request("jpeg", overQuantizationLimit, 8, 8)), /image_worker_capacity_exceeded/);

  // The base fixture defines one DC and one AC table; extra segments each add one DC definition.
  const exactHuffmanLimit = jpegWithSegmentsBeforeScan(base,
    Array.from({ length: 62 }, () => huffman));
  assertGrayImage(await decode(request("jpeg", exactHuffmanLimit, 8, 8)));
  const overHuffmanLimit = jpegWithSegmentsBeforeScan(base,
    Array.from({ length: 63 }, () => huffman));
  await assert.rejects(decode(request("jpeg", overHuffmanLimit, 8, 8)), /image_worker_capacity_exceeded/);
});

test("JPEG marker segment limit accepts 4096 valid segments and rejects 4097", async () => {
  const base = simpleBaselineJpeg({ width: 8, height: 8, sampling: [0x11] });
  const emptyAppSegment = jpegSegment(0xe2, Buffer.alloc(0));
  // DQT, SOF0, DHT, and SOS make four segments; EOI is terminal and is not counted.
  const exactLimit = jpegWithSegmentsBeforeScan(base,
    Array.from({ length: 4092 }, () => emptyAppSegment));
  const image = await decode(request("jpeg", exactLimit, 8, 8));
  assert.deepEqual([image.width, image.height], [8, 8]);
  for (let offset = 0; offset < image.pixels.length; offset += 4) {
    assert.deepEqual([...image.pixels.subarray(offset, offset + 4)], [128, 128, 128, 255]);
  }

  const overLimit = jpegWithSegmentsBeforeScan(base,
    Array.from({ length: 4093 }, () => emptyAppSegment));
  await assert.rejects(decode(request("jpeg", overLimit, 8, 8)), /image_worker_capacity_exceeded/);
});

test("decoder handles already-aborted requests and invalid format/signature without output", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(decodeProductionImage(request("png", png()), controller.signal), /image_decode_cancelled/);
  await assert.rejects(decode(request("gif", png())), /image_format_unsupported/);
  await assert.rejects(decode(request("png", Buffer.from([1, 2, 3]))), /image_source_invalid/);
  await assert.rejects(decode(request("jpeg", png())), /image_source_invalid/);
});

function loadWorker(electron, productionEntry) {
  const filename = path.resolve(__dirname, "../../../dist-electron/main/clipboard/image-worker.js");
  const module = { exports: {} };
  const localRequire = createRequire(filename);
  const requireMock = (name) => name === "electron" ? electron : localRequire(name);
  requireMock.main = productionEntry ? module : {};
  const wrapped = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname, process) {\n${fs.readFileSync(filename, "utf8")}\n})`, { filename });
  wrapped(module.exports, requireMock, module, filename, path.dirname(filename), { parentPort: electron.parentPort });
  return module.exports;
}

test("compiled utility-process production entry decodes PNG through its real parentPort protocol", async () => {
  const port = new EventEmitter();
  const responses = [];
  port.postMessage = (message) => responses.push(message);
  loadWorker({ parentPort: port }, true);
  const input = request("png", png());
  port.emit("message", { data: { type: "decode", requestId: input.jobId, input } });
  await waitFor(() => responses.length === 1);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].type, "decoded");
  assert.equal(responses[0].requestId, input.jobId);
  assert.deepEqual([...responses[0].image.pixels], [255, 0, 0, 255, 0, 255, 0, 128]);
});

test("image worker rejects requests whose outer request id differs from the input job id", async () => {
  const { installImageWorkerRuntime } = loadWorker({}, false);
  let receive;
  let decodeCalled = false;
  const responses = [];
  const input = { ...request("png", png()), jobId: "input-job" };
  const dispose = installImageWorkerRuntime({
    onMessage(listener) { receive = listener; return () => {}; },
    postMessage(message) { responses.push(message); },
  }, async () => { decodeCalled = true; return { width: 2, height: 1, pixels: Buffer.alloc(8) }; });

  receive({ type: "decode", requestId: "outer-request", input });
  await waitFor(() => responses.length === 1);
  assert.deepEqual(responses[0], { type: "failed", requestId: "outer-request", reason: "image_request_invalid" });
  assert.equal(decodeCalled, false);
  dispose();
});

test("large worker responses wait for one ACK per bounded raw pixel chunk", async () => {
  const { installImageWorkerRuntime } = loadWorker({}, false);
  let receive;
  const messages = [];
  let decoderArgumentCount = null;
  const width = 3000;
  const height = 2800;
  const pixels = Buffer.alloc(width * height * 4, 0x5a);
  const input = { ...request("png", Uint8Array.of(1), width, height), jobId: "runtime-chunked" };
  installImageWorkerRuntime({
    onMessage(listener) { receive = listener; return () => {}; },
    postMessage(message) { messages.push(message); },
  }, async function decoder(...args) {
    decoderArgumentCount = args.length;
    return { width, height, pixels };
  });

  receive({ type: "decode", requestId: input.jobId, input });
  await waitFor(() => messages.length === 1);
  let outputBytes = 0;
  let sequence = 0;
  while (messages.at(-1).type === "decoded_chunk") {
    const message = messages.at(-1);
    assert.equal(message.requestId, input.jobId);
    assert.equal(message.seq, sequence);
    assert.ok(message.pixels.byteLength > 0 && message.pixels.byteLength <= 1024 * 1024);
    assert.equal(message.pixels.buffer.byteLength, message.pixels.byteLength,
      "each IPC chunk must own an exactly sized backing store");
    outputBytes += message.pixels.byteLength;
    const messageCount = messages.length;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(messages.length, messageCount, "the worker must wait for the current chunk ACK");
    receive({ type: "decoded_chunk_ack", requestId: input.jobId, seq: sequence++ });
    await waitFor(() => messages.length > messageCount);
  }
  assert.equal(messages.at(-1).type, "decoded_end");
  assert.equal(messages.at(-1).chunkCount, sequence);
  assert.equal(messages.at(-1).byteLength, pixels.byteLength);
  assert.equal(Object.hasOwn(messages.at(-1), "stageTimings"), false,
    "default worker output has no diagnostic timing fields");
  assert.equal(decoderArgumentCount, 2, "default decoder call keeps its original argument shape");
  assert.equal(outputBytes, pixels.byteLength);
});

function createFakeUtilityWorker() {
  const children = [];
  const { createUtilityProcessImageWorker } = loadWorker({ utilityProcess: { fork() {
    const child = new EventEmitter();
    child.kill = () => { child.killed = true; return true; };
    child.sentMessages = [];
    child.postMessage = (message) => {
      child.sentMessages.push(message);
      if (message.type === "decode") child.request = message;
    };
    children.push(child);
    return child;
  } } }, false);
  return { children, worker: createUtilityProcessImageWorker() };
}

function largeWorkerInput(jobId) {
  return { ...request("png", png()), jobId, width: 2897, height: 2897 };
}

test("utility worker assembles exact large pixel chunks and ACKs after copying each one", async () => {
  const { children, worker } = createFakeUtilityWorker();
  const input = largeWorkerInput("chunked-good");
  const pixels = Buffer.alloc(input.width * input.height * 4);
  for (let offset = 0; offset < pixels.byteLength; offset++) pixels[offset] = offset & 0xff;
  const decoded = worker.decode(input, new AbortController().signal);
  const chunkBytes = 1024 * 1024;
  let seq = 0;
  for (let offset = 0; offset < pixels.byteLength; offset += chunkBytes) {
    const chunk = pixels.subarray(offset, Math.min(offset + chunkBytes, pixels.byteLength));
    children[0].emit("message", { type: "decoded_chunk", requestId: input.jobId, seq, pixels: chunk });
    assert.deepEqual(children[0].sentMessages.at(-1), { type: "decoded_chunk_ack", requestId: input.jobId, seq });
    seq++;
  }
  children[0].emit("message", { type: "decoded_end", requestId: input.jobId, width: input.width,
    height: input.height, chunkCount: seq, byteLength: pixels.byteLength });
  const image = await decoded;
  assert.deepEqual(children[0].sentMessages[0], { type: "decode", requestId: input.jobId, input },
    "default utility request has no diagnostic opt-in field");
  assert.deepEqual([image.width, image.height, image.pixels.byteLength], [input.width, input.height, pixels.byteLength]);
  assert.ok(Buffer.from(image.pixels.buffer, image.pixels.byteOffset, image.pixels.byteLength).equals(pixels));
  const disposed = worker.dispose();
  children[0].emit("exit", 0);
  await disposed;
});

test("utility worker ignores messages delivered by a retired child after a replacement starts", async () => {
  const { children, worker } = createFakeUtilityWorker();
  const firstInput = largeWorkerInput("retired-child-first");
  const controller = new AbortController();
  const first = worker.decode(firstInput, controller.signal);
  children[0].emit("message", { type: "decoded_chunk", requestId: firstInput.jobId, seq: 0,
    pixels: Buffer.alloc(1024 * 1024) });
  controller.abort();
  await assert.rejects(first, /image_decode_cancelled/);
  assert.equal(children[0].killed, true);
  await assert.rejects(worker.decode({ ...firstInput, jobId: "before-old-child-exit" }, new AbortController().signal),
    /image_worker_terminating/);
  children[0].emit("exit", 0);

  const secondInput = { ...request("png", png()), jobId: "replacement-child-second" };
  const second = worker.decode(secondInput, new AbortController().signal);
  children[0].emit("message", { type: "decoded", requestId: secondInput.jobId,
    image: { width: 2, height: 1, pixels: Buffer.alloc(8, 0x22) } });
  children[1].emit("message", { type: "decoded", requestId: secondInput.jobId,
    image: { width: 2, height: 1, pixels: Buffer.alloc(8, 0x33) } });
  const image = await second;
  assert.deepEqual([...image.pixels], Array(8).fill(0x33));

  children[1].emit("exit", 0);
  await worker.dispose();
});

test("utility worker kills and quarantines a malformed chunk stream without waiting for ACK", async () => {
  const { children, worker } = createFakeUtilityWorker();
  const input = largeWorkerInput("chunked-invalid");
  const rejected = worker.decode(input, new AbortController().signal);
  children[0].emit("message", { type: "decoded_chunk", requestId: "wrong-request", seq: 0, pixels: Buffer.alloc(8) });
  assert.equal(children[0].killed, undefined, "a late response for another request must be ignored");
  children[0].emit("message", { type: "decoded_chunk", requestId: input.jobId, seq: 1, pixels: Buffer.alloc(8) });
  await assert.rejects(rejected, /image_worker_response_invalid/);
  assert.equal(children[0].killed, true);
  await assert.rejects(worker.decode({ ...input, jobId: "quarantined" }, new AbortController().signal), /image_worker_terminating/);
  children[0].emit("exit", 0);

  const afterExit = worker.decode({ ...input, jobId: "after-protocol-exit" }, new AbortController().signal);
  const pixels = Buffer.alloc(input.width * input.height * 4);
  const firstChunk = pixels.subarray(0, 1024 * 1024);
  children[1].emit("message", { type: "decoded_chunk", requestId: "after-protocol-exit", seq: 1, pixels: firstChunk });
  await assert.rejects(afterExit, /image_worker_response_invalid/);
  assert.equal(children[1].killed, true);
  children[1].emit("exit", 0);

  const disposed = worker.dispose();
  await disposed;
});

test("utility worker retires after a busy response because the child may retain another active job", async () => {
  const { children, worker } = createFakeUtilityWorker();
  const input = largeWorkerInput("unexpected-busy");
  const rejected = worker.decode(input, new AbortController().signal);
  children[0].emit("message", { type: "failed", requestId: input.jobId, reason: "image_worker_busy" });
  await assert.rejects(rejected, /image_worker_busy/);
  assert.equal(children[0].killed, true);
  await assert.rejects(worker.decode({ ...input, jobId: "busy-quarantined" }, new AbortController().signal),
    /image_worker_terminating/);
  children[0].emit("exit", 0);
  await worker.dispose();
});

test("utility worker enforces the chunk size and end byte/count metadata", async () => {
  {
    const { children, worker } = createFakeUtilityWorker();
    const input = largeWorkerInput("chunk-oversized");
    const rejected = worker.decode(input, new AbortController().signal);
    children[0].emit("message", { type: "decoded_chunk", requestId: input.jobId, seq: 0,
      pixels: Buffer.alloc(1024 * 1024 + 1) });
    await assert.rejects(rejected, /image_worker_response_invalid/);
    assert.equal(children[0].killed, true);
    children[0].emit("exit", 0);
    await worker.dispose();
  }

  for (const badEnd of [
    (input, sequence) => ({ width: input.width, height: input.height, chunkCount: sequence + 1,
      byteLength: input.width * input.height * 4 }),
    (input, sequence) => ({ width: input.width, height: input.height, chunkCount: sequence,
      byteLength: input.width * input.height * 4 - 1 }),
  ]) {
    const { children, worker } = createFakeUtilityWorker();
    const input = largeWorkerInput("chunk-bad-end");
    const expectedBytes = input.width * input.height * 4;
    const pixels = Buffer.alloc(expectedBytes);
    const rejected = worker.decode(input, new AbortController().signal);
    let seq = 0;
    for (let offset = 0; offset < expectedBytes; offset += 1024 * 1024) {
      children[0].emit("message", { type: "decoded_chunk", requestId: input.jobId, seq,
        pixels: pixels.subarray(offset, Math.min(offset + 1024 * 1024, expectedBytes)) });
      seq++;
    }
    children[0].emit("message", { type: "decoded_end", requestId: input.jobId, ...badEnd(input, seq) });
    await assert.rejects(rejected, /image_worker_response_invalid/);
    assert.equal(children[0].killed, true);
    children[0].emit("exit", 0);
    await worker.dispose();
  }
});

test("utility worker rejects chunk streams split into undersized fragments", async () => {
  const { children, worker } = createFakeUtilityWorker();
  const input = largeWorkerInput("chunk-fragmented");
  const rejected = worker.decode(input, new AbortController().signal);
  children[0].emit("message", { type: "decoded_chunk", requestId: input.jobId, seq: 0,
    pixels: Buffer.alloc(1) });
  await assert.rejects(rejected, /image_worker_response_invalid/);
  assert.equal(children[0].killed, true);
  children[0].emit("exit", 0);
  await worker.dispose();
});

test("cancellation while a worker waits for the next chunk kills and quarantines it", async () => {
  const { children, worker } = createFakeUtilityWorker();
  const controller = new AbortController();
  const input = largeWorkerInput("chunked-abort");
  const cancelled = worker.decode(input, controller.signal);
  children[0].emit("message", { type: "decoded_chunk", requestId: input.jobId, seq: 0, pixels: Buffer.alloc(1024 * 1024) });
  assert.equal(children[0].sentMessages.at(-1).type, "decoded_chunk_ack");
  controller.abort();
  await assert.rejects(cancelled, /image_decode_cancelled/);
  assert.equal(children[0].killed, true);
  assert.equal(worker.pending, null);
  await assert.rejects(worker.decode(input, new AbortController().signal), /image_worker_terminating/);
  children[0].emit("exit", 0);
  const disposed = worker.dispose();
  await disposed;
});

test("utility worker rejects decoded responses with mismatched dimensions or pixel lengths", async () => {
  const input = { ...request("png", png()), jobId: "decoded-invalid" };
  for (const [width, height, byteLength] of [[1, 1, 8], [2, 1, 7], [2, 1, 9]]) {
    const { children, worker } = createFakeUtilityWorker();
    const current = { ...input, jobId: `decoded-invalid-${width}-${height}-${byteLength}` };
    const rejected = worker.decode(current, new AbortController().signal);
    children[0].emit("message", { type: "decoded", requestId: current.jobId,
      image: { width, height, pixels: Buffer.alloc(byteLength) } });
    await assert.rejects(rejected, /image_worker_response_invalid/);
    assert.equal(children[0].killed, true);
    children[0].emit("exit", 0);
    await worker.dispose();
  }
});

function waitFor(predicate, timeoutMs = 1_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) { resolve(); return; }
      if (Date.now() - startedAt >= timeoutMs) { reject(new Error("test_wait_timeout")); return; }
      setTimeout(check, 1);
    };
    check();
  });
}

test("all cancellation reasons quarantine the dying utility process and ignore its late response", async () => {
  for (const reason of [undefined, new Error("image_prepare_timeout")]) {
    const children = [];
    const { createUtilityProcessImageWorker } = loadWorker({ utilityProcess: { fork() {
      const child = new EventEmitter();
      child.kill = () => { child.killed = true; return true; };
      child.postMessage = (message) => { child.request = message; };
      children.push(child);
      return child;
    } } }, false);
    const worker = createUtilityProcessImageWorker();
    const controller = new AbortController();
    const input = request("png", png());
    const pending = worker.decode(input, controller.signal);
    controller.abort(reason);
    await assert.rejects(pending, reason ? /image_prepare_timeout/ : /image_decode_cancelled/);
    assert.equal(children[0].killed, true);
    await assert.rejects(worker.decode(input, new AbortController().signal), /image_worker_terminating/);
    children[0].emit("message", { type: "decoded", requestId: input.jobId, image: { width: 2, height: 1, pixels: new Uint8Array(8) } });
    children[0].emit("exit", 0);
    const next = worker.decode({ ...input, jobId: "after-exit" }, new AbortController().signal);
    assert.equal(children.length, 2);
    children[1].emit("message", { type: "decoded", requestId: "after-exit", image: { width: 2, height: 1, pixels: new Uint8Array(8) } });
    await next;
    const disposed = worker.dispose();
    children[1].emit("exit", 0);
    await disposed;
  }
});

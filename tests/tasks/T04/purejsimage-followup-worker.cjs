'use strict';

const { createHash } = require('node:crypto');
const { deflateSync } = require('node:zlib');
const { pathToFileURL } = require('node:url');

const WIDTH = 4000;
const HEIGHT = 4000;
const PIXEL_COUNT = WIDTH * HEIGHT;
const SOURCE_LIMIT_BYTES = 20 * 1024 * 1024;
const DECODED_BYTES = PIXEL_COUNT * 4;
const MAX_COMPRESSED_BYTES = DECODED_BYTES + 64 * 1024;
const SAMPLE_POINTS = [
  [0, 0], [1, 1], [16, 16], [511, 511], [1024, 1024],
  [1999, 1999], [2000, 2000], [3001, 2377], [3999, 3999],
];

let modulesPromise;
let heldPixels = null;
let heldCompressedPixels = null;

function getModules(packageDist) {
  if (!modulesPromise) {
    modulesPromise = Promise.all([
      import(pathToFileURL(packageDist + '\\codec-entries\\jpeg.js').href),
      import(pathToFileURL(packageDist + '\\source.js').href),
      import(pathToFileURL(packageDist + '\\limits.js').href),
    ]).then(([jpegModule, sourceModule, limitsModule]) => ({
      jpegCodec: jpegModule.jpegCodec,
      MemorySource: sourceModule.MemorySource,
      resolveLimits: limitsModule.resolveLimits,
    }));
  }
  return modulesPromise;
}

function limits(resolveLimits) {
  return resolveLimits({
    maxWidth: WIDTH,
    maxHeight: HEIGHT,
    maxPixels: PIXEL_COUNT,
    maxInputBytes: SOURCE_LIMIT_BYTES,
    maxDecodedBytes: DECODED_BYTES,
  });
}

function post(message) {
  process.parentPort.postMessage(message);
}

function messageData(eventOrMessage) {
  return eventOrMessage && eventOrMessage.data !== undefined ? eventOrMessage.data : eventOrMessage;
}

async function decodeAndReturn(message) {
  const request = message.input;
  const input = request && request.encodedBytes;
  if (!request || request.format !== 'jpeg' || request.width !== WIDTH || request.height !== HEIGHT ||
      !(input instanceof Uint8Array) || input.byteLength === 0 || input.byteLength > SOURCE_LIMIT_BYTES) {
    throw new Error('fixture_source_size_invalid');
  }
  const { jpegCodec, MemorySource, resolveLimits } = await getModules(message.packageDist);
  const inputSha256 = createHash('sha256').update(input).digest('hex');
  const decodeStarted = performance.now();
  const decoder = await jpegCodec.createDecoder(
    new MemorySource(input),
    limits(resolveLimits),
    { tolerantDecoding: false },
  );
  if (!decoder || decoder.width !== WIDTH || decoder.height !== HEIGHT) {
    throw new Error('decoder_dimensions_invalid');
  }
  if (decoder.capabilities.progressive) throw new Error('fixture_unexpected_progressive_jpeg');

  const pixels = Buffer.allocUnsafe(DECODED_BYTES);
  let nextY = 0;
  let blockCount = 0;
  let minStride = Number.POSITIVE_INFINITY;
  let maxBlockDataBytes = 0;
  for await (const block of decoder.decode()) {
    if (block.format !== 'rgb8' || block.x !== 0 || block.width !== WIDTH || block.y !== nextY ||
        !Number.isInteger(block.height) || block.height < 1 || block.y + block.height > HEIGHT) {
      throw new Error('decoder_block_geometry_invalid');
    }
    const rowBytes = WIDTH * 3;
    const requiredBytes = block.stride * (block.height - 1) + rowBytes;
    if (block.stride < rowBytes || block.data.byteLength < requiredBytes ||
        block.data.byteOffset + requiredBytes > block.data.buffer.byteLength) {
      throw new Error('decoder_block_buffer_invalid');
    }
    minStride = Math.min(minStride, block.stride);
    maxBlockDataBytes = Math.max(maxBlockDataBytes, block.data.byteLength);
    for (let localY = 0; localY < block.height; localY++) {
      const sourceOffset = localY * block.stride;
      const outputOffset = ((block.y + localY) * WIDTH) * 4;
      for (let x = 0; x < WIDTH; x++) {
        const from = sourceOffset + x * 3;
        const to = outputOffset + x * 4;
        pixels[to] = block.data[from];
        pixels[to + 1] = block.data[from + 1];
        pixels[to + 2] = block.data[from + 2];
        pixels[to + 3] = 255;
      }
    }
    nextY += block.height;
    blockCount++;
    block.release?.();
  }
  if (nextY !== HEIGHT || pixels.byteLength !== DECODED_BYTES) throw new Error('decoded_output_incomplete');
  for (const [x, y] of SAMPLE_POINTS) {
    if (pixels[(y * WIDTH + x) * 4 + 3] !== 255) throw new Error('decoded_alpha_not_opaque');
  }
  const decodeMs = performance.now() - decodeStarted;
  const rgbaSha256 = createHash('sha256').update(pixels).digest('hex');
  const samples = SAMPLE_POINTS.map(([x, y]) => {
    const offset = (y * WIDTH + x) * 4;
    return { x, y, rgba: Array.from(pixels.subarray(offset, offset + 4)) };
  });

  const deflateStarted = performance.now();
  const compressedPixels = deflateSync(pixels, {
    level: 1,
    maxOutputLength: MAX_COMPRESSED_BYTES,
    chunkSize: Math.min(MAX_COMPRESSED_BYTES, 8 * 1024 * 1024),
  });
  const deflateMs = performance.now() - deflateStarted;
  if (compressedPixels.byteLength === 0 || compressedPixels.byteLength > MAX_COMPRESSED_BYTES) {
    throw new Error('compressed_output_size_invalid');
  }
  const compressedSha256 = createHash('sha256').update(compressedPixels).digest('hex');
  heldPixels = pixels;
  heldCompressedPixels = compressedPixels;
  post({
    type: 'decoded_compressed',
    requestId: message.requestId,
    width: WIDTH,
    height: HEIGHT,
    uncompressedBytes: DECODED_BYTES,
    inputBytes: input.byteLength,
    inputSha256,
    decoderProgressive: false,
    decodedRows: nextY,
    blockCount,
    minBlockStride: minStride,
    maxBlockDataBytes,
    rgbaSha256,
    compressedSha256,
    compressedPixels,
    decodeMs: Math.round(decodeMs * 100) / 100,
    deflateMs: Math.round(deflateMs * 100) / 100,
    pixelSamples: samples,
    retainedUntilRelease: true,
  });
}

process.parentPort.on('message', (eventOrMessage) => {
  const message = messageData(eventOrMessage);
  if (!message || typeof message !== 'object') return;
  if (message.type === 'decode') {
    void decodeAndReturn(message).catch((error) => post({
      type: 'failed',
      requestId: message.requestId,
      error: String(error && error.message || error),
      stack: String(error && error.stack || '').split('\n').slice(0, 5).join('\n'),
    }));
  }
});

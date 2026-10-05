const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { app } = require('electron');
const asarPath = process.env.CLIPNEST_ASAR_PATH;
assert.ok(asarPath && asarPath.endsWith('app.asar'), 'CLIPNEST_ASAR_PATH must identify the built app.asar');
const packagedRequire = createRequire(path.join(asarPath, 'package.json'));
const { PNG } = packagedRequire('pngjs');
const jpeg = packagedRequire('jpeg-js');
const { createUtilityProcessImageWorker } = packagedRequire('./dist-electron/main/clipboard/image-worker.js');
const worker = createUtilityProcessImageWorker();
const watchdog = setTimeout(() => app.exit(1), 45000);
app.whenReady().then(async () => {
  const width = 3000;
  const height = 3000;
  const pixels = Buffer.alloc(width * height * 4);
  pixels.set([12, 34, 56, 255], 0);
  const encoded = PNG.sync.write({ width, height, data: pixels });
  assert.ok(encoded.byteLength < 20 * 1024 * 1024, 'synthetic encoded PNG stays within the source limit');
  const startedAt = process.hrtime.bigint();
  const resultPromise = worker.decode({
    jobId: 'packaged-large-png',
    format: 'png',
    encodedBytes: Uint8Array.from(encoded),
    width,
    height,
  }, new AbortController().signal);
  const child = worker.child;
  assert.ok(child, 'utilityProcess child started');
  const responseTypes = [];
  child.on('message', (raw) => { if (raw && typeof raw.type === 'string') responseTypes.push(raw.type); });
  const result = await resultPromise;
  assert.deepEqual([result.width, result.height, result.pixels.byteLength], [width, height, pixels.byteLength]);
  assert.ok(Buffer.from(result.pixels.buffer, result.pixels.byteOffset, result.pixels.byteLength).equals(pixels), 'every decoded pixel matches the expected RGBA buffer');
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.ok(responseTypes.includes('decoded_chunk'), `expected raw pixel chunks, got ${responseTypes.join(',')}`);
  assert.ok(responseTypes.includes('decoded_end'), `expected validated chunk terminator, got ${responseTypes.join(',')}`);
  const pngResponseTypes = responseTypes.slice();
  responseTypes.length = 0;

  const jpegWidth = 640;
  const jpegHeight = 360;
  const jpegPixels = Buffer.alloc(jpegWidth * jpegHeight * 4);
  for (let y = 0; y < jpegHeight; y++) {
    for (let x = 0; x < jpegWidth; x++) {
      const offset = (y * jpegWidth + x) * 4;
      jpegPixels[offset] = (x * 3 + y) & 0xff;
      jpegPixels[offset + 1] = (x + y * 2) & 0xff;
      jpegPixels[offset + 2] = (x * 2 + y * 5) & 0xff;
      jpegPixels[offset + 3] = 255;
    }
  }
  const encodedJpeg = Buffer.from(jpeg.encode({ width: jpegWidth, height: jpegHeight, data: jpegPixels }, 90).data);
  const frameOffset = encodedJpeg.indexOf(Buffer.from([0xff, 0xc0]));
  assert.notEqual(frameOffset, -1, 'synthetic JPEG uses baseline SOF0');
  assert.equal(encodedJpeg[frameOffset + 9], 3, 'synthetic JPEG has three components');
  assert.deepEqual([encodedJpeg[frameOffset + 11], encodedJpeg[frameOffset + 14], encodedJpeg[frameOffset + 17]],
    [0x11, 0x11, 0x11], 'synthetic SOF0 JPEG uses supported 4:4:4 sampling');
  const jpegOracle = jpeg.decode(encodedJpeg, { useTArray: true, formatAsRGBA: true, tolerantDecoding: false });
  assert.deepEqual([jpegOracle.width, jpegOracle.height], [jpegWidth, jpegHeight]);
  const jpegStartedAt = process.hrtime.bigint();
  const jpegResult = await worker.decode({
    jobId: 'packaged-sof0-jpeg', format: 'jpeg', encodedBytes: Uint8Array.from(encodedJpeg),
    width: jpegWidth, height: jpegHeight,
  }, new AbortController().signal);
  assert.deepEqual([jpegResult.width, jpegResult.height, jpegResult.pixels.byteLength],
    [jpegWidth, jpegHeight, jpegOracle.data.byteLength]);
  assert.ok(Buffer.from(jpegResult.pixels.buffer, jpegResult.pixels.byteOffset, jpegResult.pixels.byteLength)
    .equals(Buffer.from(jpegOracle.data.buffer, jpegOracle.data.byteOffset, jpegOracle.data.byteLength)),
  'every packaged SOF0 JPEG output pixel matches the pinned jpeg-js oracle');
  assert.ok(responseTypes.includes('decoded'), `expected small JPEG response, got ${responseTypes.join(',')}`);
  const jpegElapsedMs = Number(process.hrtime.bigint() - jpegStartedAt) / 1e6;
  await worker.dispose();
  clearTimeout(watchdog);
  console.log(JSON.stringify({
    result: 'PASS',
    packageVersion: packagedRequire('./package.json').version,
    packagePath: asarPath,
    workerLoadedFromAsar: true,
    jpegDecoderLoadedFromAsar: packagedRequire.resolve('jpeg-js'),
    pngUtilityProcessResponseTypes: pngResponseTypes,
    dimensions: `${width}x${height}`,
    pngEncodedBytes: encoded.byteLength,
    decodedBytes: result.pixels.byteLength,
    decodedCacheThresholdBytes: 32 * 1024 * 1024,
    allPixelsExact: true,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    chunkedIpcObserved: true,
    jpeg: {
      format: 'SOF0 baseline 4:4:4',
      dimensions: `${jpegWidth}x${jpegHeight}`,
      encodedBytes: encodedJpeg.byteLength,
      decodedBytes: jpegResult.pixels.byteLength,
      exactPinnedJpegJsOracle: true,
      utilityProcessResponseTypes: responseTypes,
      elapsedMs: Number(jpegElapsedMs.toFixed(2)),
    },
    clipboardContentRead: false,
    clipboardWritten: false,
    inputSent: false,
  }));
  app.exit(0);
}).catch(async (error) => {
  console.error(error);
  await worker.dispose();
  clearTimeout(watchdog);
  app.exit(1);
});



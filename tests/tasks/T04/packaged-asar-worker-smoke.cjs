const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { app } = require('electron');
const asarPath = process.env.CLIPNEST_ASAR_PATH;
assert.ok(asarPath && asarPath.endsWith('app.asar'), 'CLIPNEST_ASAR_PATH must identify the built app.asar');
const packagedRequire = createRequire(path.join(asarPath, 'package.json'));
const { PNG } = packagedRequire('pngjs');
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
  await worker.dispose();
  clearTimeout(watchdog);
  console.log(JSON.stringify({
    result: 'PASS',
    packageVersion: packagedRequire('./package.json').version,
    packagePath: asarPath,
    workerLoadedFromAsar: true,
    utilityProcessResponseTypes: responseTypes,
    dimensions: `${width}x${height}`,
    pngEncodedBytes: encoded.byteLength,
    decodedBytes: result.pixels.byteLength,
    decodedCacheThresholdBytes: 32 * 1024 * 1024,
    allPixelsExact: true,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    chunkedIpcObserved: true,
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



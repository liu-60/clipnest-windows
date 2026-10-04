// Real Electron utility-process verification; creates no window and does not
// read or write the user's clipboard. Run after pnpm build:main.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require("electron"), [__filename], {
    cwd: path.resolve(__dirname, "../../.."), env, stdio: "inherit", timeout: 15_000,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} else {
  const { app } = require("electron");
  const { PNG } = require("pngjs");
  const jpeg = require("jpeg-js");
  const { createUtilityProcessImageWorker } = require("../../../dist-electron/main/clipboard/image-worker.js");
  const worker = createUtilityProcessImageWorker();
  const watchdog = setTimeout(() => {
    process.stderr.write("image-worker Electron verification timed out\n");
    app.exit(1);
  }, 30_000);
  app.whenReady().then(async () => {
    const pixels = Buffer.from([240, 40, 20, 255, 240, 40, 20, 255]);
    const png = PNG.sync.write({ width: 2, height: 1, data: pixels });
    const request = (jobId, format, bytes) => ({ jobId, format, encodedBytes: Uint8Array.from(bytes), width: 2, height: 1 });
    const result = await worker.decode(request("electron-png", "png", png), new AbortController().signal);
    assert.deepEqual([...result.pixels], [...pixels]);
    const encodedJpeg = jpeg.encode({ width: 2, height: 1, data: pixels }, 100).data;
    const jpegResult = await worker.decode(request("electron-jpeg", "jpeg", encodedJpeg), new AbortController().signal);
    assert.deepEqual([jpegResult.width, jpegResult.height, jpegResult.pixels.length], [2, 1, 8]);
    for (let index = 0; index < pixels.length; index++) assert.ok(Math.abs(jpegResult.pixels[index] - pixels[index]) <= 2);
    const largeWidth = 3000;
    const largeHeight = 3000;
    const largePixels = Buffer.alloc(largeWidth * largeHeight * 4);
    const largePng = PNG.sync.write({ width: largeWidth, height: largeHeight, data: largePixels });
    const largeResult = await worker.decode({
      jobId: "electron-large-png",
      format: "png",
      encodedBytes: Uint8Array.from(largePng),
      width: largeWidth,
      height: largeHeight,
    }, new AbortController().signal);
    assert.deepEqual([largeResult.width, largeResult.height, largeResult.pixels.length], [largeWidth, largeHeight, largePixels.length]);
    assert.equal(largeResult.pixels[0], 0);
    assert.equal(largeResult.pixels[largeResult.pixels.length - 1], 0);
    const corrupt = Uint8Array.from(png);
    corrupt[16] ^= 1;
    await assert.rejects(worker.decode(request("electron-crc", "png", corrupt), new AbortController().signal), /image_png_crc_invalid/);
    const controller = new AbortController();
    const cancelled = worker.decode(request("electron-cancelled", "png", png), controller.signal);
    controller.abort(new Error("image_prepare_timeout"));
    await assert.rejects(cancelled, /image_prepare_timeout/);
    await assert.rejects(worker.decode(request("electron-while-dying", "png", png), new AbortController().signal), /image_worker_terminating/);
    await worker.dispose();
    clearTimeout(watchdog);
    process.stdout.write("PASS: real Electron utility process PNG, JPEG, CRC failure, cancellation, retirement\n");
    app.exit(0);
  }).catch(async (error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    await worker.dispose();
    clearTimeout(watchdog);
    app.exit(1);
  });
}

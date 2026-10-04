const assert = require("node:assert/strict");
const test = require("node:test");
const { performance } = require("node:perf_hooks");
const {
  IMAGE_LIMITS,
  ImagePreparationError,
  ImagePreparationService,
  inspectImageSource,
} = require("../../../dist-electron/main/clipboard/image-preparation.js");
const {
  decodeImageAdapterPendingT06,
  installImageWorkerRuntime,
} = require("../../../dist-electron/main/clipboard/image-worker.js");

function input(itemRef, { width = 1024, height = 1024, itemVersion = "v1" } = {}) {
  return {
    itemRef,
    itemVersion,
    format: "png",
    encodedBytes: Uint8Array.of(1, 2, 3),
    width,
    height,
  };
}

function fakeService(options = {}) {
  const calls = [];
  const service = new ImagePreparationService({
    workerFactory: () => ({
      decode: (request, signal) => {
        calls.push(request.jobId);
        return Promise.resolve().then(() => options.decode
          ? options.decode(request, signal)
          : {
            width: request.width,
            height: request.height,
            pixels: new Uint8Array(request.width * request.height * 4),
          });
      },
      dispose: async () => {},
    }),
  });
  return { service, calls };
}

function pngFixture(width = 640, height = 480) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpegFixture(width = 640, height = 480) {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x01, 0x02,
    0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff,
    width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00,
  ]);
}

function dataUrl(format, bytes) {
  return `data:image/${format};base64,${bytes.toString("base64")}`;
}

test("decoded cache is a 32 MiB LRU and a cache hit skips the worker", async () => {
  const { service, calls } = fakeService();
  try {
    for (let index = 0; index < 8; index += 1) await service.prepare(input(`item-${index}`));
    assert.equal(service.getCacheStats().bytes, IMAGE_LIMITS.decodedCacheBytes);

    const hit = await service.prepare(input("item-0"));
    assert.equal(hit.cacheHit, true);
    assert.equal(calls.length, 8);

    await service.prepare(input("item-8"));
    assert.equal(service.getCacheStats().bytes, IMAGE_LIMITS.decodedCacheBytes);
    await service.prepare(input("item-1"));
    assert.equal(calls.length, 10);
    assert.equal(service.getCacheStats().entries, 8);
  } finally {
    await service.dispose();
  }
});

test("uncached large images retire their worker before the next preparation", async () => {
  let created = 0;
  const disposed = [];
  const service = new ImagePreparationService({
    workerFactory: () => {
      const workerId = ++created;
      return {
        decode: (request) => {
          if (workerId > 1) assert.equal(disposed[0], true, "large-image worker is disposed before its replacement decodes");
          return Promise.resolve({
            width: request.width,
            height: request.height,
            pixels: new Uint8Array(request.width * request.height * 4),
          });
        },
        dispose: async () => { disposed[workerId - 1] = true; },
      };
    },
  });
  try {
    const result = await service.prepare(input("large", { width: 3_000_000, height: 3 }));
    assert.equal(result.cached, false);
    assert.equal(result.image.pixels.byteLength, 36_000_000);
    const next = await service.prepare(input("small", { width: 1024, height: 1024 }));
    assert.equal(next.cached, true);
    assert.equal(created, 2);
    assert.deepEqual(service.getCacheStats(), {
      entries: 1,
      bytes: 4 * 1024 * 1024,
      limitBytes: 32 * 1024 * 1024,
      workerBusy: false,
    });
  } finally {
    await service.dispose();
  }
  assert.deepEqual(disposed, [true, true]);
});

test("one active decode is allowed; cancellation clears the lane after the worker settles", async () => {
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const { service } = fakeService({
    decode: (request, signal) => new Promise((resolve, reject) => {
      startedResolve();
      signal.addEventListener("abort", () => reject(new Error("image_decode_cancelled")), { once: true });
    }),
  });
  const controller = new AbortController();
  const preparing = service.prepare(input("slow"), { signal: controller.signal });
  try {
    await started;
    await assert.rejects(service.prepare(input("second")), /image_worker_busy/);
    assert.equal(service.cancelActive("slow"), true);
    await assert.rejects(preparing, /image_cancelled/);
    assert.equal(service.getCacheStats().workerBusy, false);
    assert.equal(service.cancelActive("slow"), false);
  } finally {
    await service.dispose();
  }
});

test("content preparation deadline aborts and retires its worker before the next decode", async () => {
  let created = 0;
  let decodeCalls = 0;
  let firstSignal;
  let allowFirstRetirement;
  let firstRetirementStarted;
  const firstRetirementStartedPromise = new Promise((resolve) => { firstRetirementStarted = resolve; });
  const firstRetirement = new Promise((resolve) => { allowFirstRetirement = resolve; });
  const disposed = [];
  const service = new ImagePreparationService({
    workerFactory: () => {
      const workerId = ++created;
      return {
        decode: (request, signal) => {
          decodeCalls += 1;
          if (workerId === 1) {
            firstSignal = signal;
            return new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          }
          assert.equal(disposed[0], true, "a timed-out worker is disposed before a replacement starts");
          return Promise.resolve({
            width: request.width,
            height: request.height,
            pixels: new Uint8Array(request.width * request.height * 4),
          });
        },
        dispose: async () => {
          if (workerId === 1) {
            firstRetirementStarted();
            await firstRetirement;
          }
          disposed[workerId - 1] = true;
        },
      };
    },
  });
  const updates = [];
  try {
    await assert.rejects(
      service.prepare(input("timeout"), { onUpdate: (update) => updates.push(update) }),
      (error) => error instanceof ImagePreparationError && error.code === "image_prepare_timeout",
    );
    assert.equal(IMAGE_LIMITS.contentPrepareTimeoutMs, 3_000);
    assert.equal(firstSignal.aborted, true, "the absolute deadline aborts the worker signal");
    assert.deepEqual(updates.map((update) => update.phase), ["preparing", "failed"]);
    assert.equal(updates[1].reason, "image_prepare_timeout");
    assert.equal(service.getCacheStats().workerBusy, false);
    assert.equal(service.getCacheStats().entries, 0, "a timed-out decode never enters the cache");

    await firstRetirementStartedPromise;
    const replacement = service.prepare(input("after-timeout"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(created, 1, "a replacement is not spawned before process retirement completes");
    allowFirstRetirement();
    const result = await replacement;
    assert.equal(result.cacheHit, false);
    assert.equal(created, 2, "the timed-out worker object is not reused");
    assert.equal(disposed[0], true);

    await assert.rejects(
      service.prepare(input("expired-selection"), { deadlineAt: -1 }),
      (error) => error instanceof ImagePreparationError && error.code === "image_prepare_timeout",
    );
    assert.equal(decodeCalls, 2, "an already-expired absolute selection deadline never starts another decode");
  } finally {
    allowFirstRetirement();
    await service.dispose();
  }
});

test("waiting for a never-resolving worker retirement is deadline-bounded and stays fail-closed", async () => {
  let created = 0;
  const service = new ImagePreparationService({
    workerFactory: () => {
      created += 1;
      return {
        decode: (_request, signal) => new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
        dispose: () => new Promise(() => {}),
      };
    },
  });

  const firstDeadlineAt = performance.now() + 25;
  await assert.rejects(
    service.prepare(input("retirement-first"), { deadlineAt: firstDeadlineAt }),
    (error) => error instanceof ImagePreparationError && error.code === "image_prepare_timeout",
  );
  assert.equal(created, 1);

  for (const itemRef of ["retirement-wait", "retirement-still-latched"]) {
    const startedAt = performance.now();
    await assert.rejects(
      service.prepare(input(itemRef), { deadlineAt: startedAt + 25 }),
      (error) => error instanceof ImagePreparationError && error.code === "image_prepare_timeout",
    );
    assert.ok(performance.now() - startedAt < 500, "waiting for retirement ends at the current request deadline");
    assert.equal(created, 1, "no worker starts until the old worker confirms retirement");
  }
  assert.equal(service.getCacheStats().entries, 0);
});

test("source size and stale item checks fail before caching", async () => {
  const { service, calls } = fakeService();
  const oversized = input("oversized");
  oversized.encodedBytes = new Uint8Array(IMAGE_LIMITS.sourceBytes + 1);
  try {
    await assert.rejects(
      service.prepare(oversized),
      (error) => error instanceof ImagePreparationError && error.code === "image_source_too_large",
    );
    await assert.rejects(service.prepare(input("stale"), { isCurrent: () => false }), /image_item_stale/);
    assert.equal(service.getCacheStats().entries, 0);
    assert.equal(calls.length, 1);
  } finally {
    await service.dispose();
  }
});

test("missing decoder adapter fails closed and preserves its encoded source", async () => {
  const service = new ImagePreparationService({
    workerFactory: () => ({
      decode: (request, signal) => decodeImageAdapterPendingT06(request, signal),
      dispose: async () => {},
    }),
  });
  const source = Uint8Array.of(137, 80, 78, 71);
  try {
    await assert.rejects(
      service.prepare({ ...input("pending"), encodedBytes: source }),
      /image_decoder_pending_t06/,
    );
    assert.deepEqual([...source], [137, 80, 78, 71]);
    assert.equal(service.getCacheStats().entries, 0);
  } finally {
    await service.dispose();
  }
});

test("utility worker message runtime injects a decoder and rejects a second active request", async () => {
  let deliver;
  const responses = [];
  let resolveDecode;
  let startDecode;
  const started = new Promise((resolve) => { startDecode = resolve; });
  const stop = installImageWorkerRuntime({
    onMessage(listener) {
      deliver = listener;
      return () => { deliver = undefined; };
    },
    postMessage(response) { responses.push(response); },
  }, async (request) => {
    startDecode();
    return new Promise((resolve) => { resolveDecode = resolve; });
  });
  const request = (jobId) => ({
    type: "decode",
    requestId: jobId,
    input: { jobId, format: "png", encodedBytes: Uint8Array.of(1), width: 1, height: 1 },
  });
  try {
    deliver(request("first"));
    deliver(request("second"));
    await started;
    assert.deepEqual(responses, [{ type: "failed", requestId: "second", reason: "image_worker_busy" }]);
    resolveDecode({ width: 1, height: 1, pixels: Uint8Array.of(1, 2, 3, 4) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(responses[1].type, "decoded");
    assert.equal(responses[1].requestId, "first");
  } finally {
    stop();
  }
});

test("inspectImageSource reads PNG IHDR and JPEG SOF dimensions", () => {
  const png = pngFixture();
  const jpeg = jpegFixture(1280, 720);
  assert.deepEqual(inspectImageSource(dataUrl("png", png), png), {
    format: "png", width: 640, height: 480,
  });
  assert.deepEqual(inspectImageSource(dataUrl("jpeg", jpeg), jpeg), {
    format: "jpeg", width: 1280, height: 720,
  });
});

test("inspectImageSource rejects malformed headers, noncanonical base64, and byte mismatch", () => {
  const png = pngFixture();
  const brokenHeader = Buffer.from(png);
  brokenHeader[0] = 0;
  assert.throws(() => inspectImageSource(dataUrl("png", brokenHeader), brokenHeader), /image_source_invalid/);
  assert.throws(() => inspectImageSource("data:image/png;base64,AA===", Uint8Array.of(0)), /image_source_invalid/);
  assert.throws(() => inspectImageSource(dataUrl("png", png), Uint8Array.of(1)), /image_source_mismatch/);
  assert.throws(() => inspectImageSource("data:image/gif;base64,AQ==", Uint8Array.of(1)), /image_format_unsupported/);
  const jpegWithoutFrame = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]);
  assert.throws(() => inspectImageSource(dataUrl("jpeg", jpegWithoutFrame), jpegWithoutFrame), /image_source_invalid/);
});

test("inspectImageSource enforces encoded-byte and decoded-pixel limits", () => {
  const tooLargeSource = new Uint8Array(IMAGE_LIMITS.sourceBytes + 1);
  assert.throws(
    () => inspectImageSource("data:image/png;base64,AQ==", tooLargeSource),
    /image_source_too_large/,
  );
  const tooManyPixels = pngFixture(5000, 4000);
  assert.throws(
    () => inspectImageSource(dataUrl("png", tooManyPixels), tooManyPixels),
    /image_dimensions_too_large/,
  );
});

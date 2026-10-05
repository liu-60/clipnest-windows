// Exercises the production ImagePreparationService with one synthetic 16 MP
// JPEG and real Electron utility processes. No window, clipboard, or input.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../../..");
const STAGE_PROFILE_MODE = process.env.T04_IMAGE_STAGE_PROFILE ?? "";
const STAGE_TIMING_ENABLED = STAGE_PROFILE_MODE === "1" || STAGE_PROFILE_MODE === "block-breakdown";
const EVIDENCE_PATH = path.join(ROOT, "docs", "evidence", "T04", STAGE_PROFILE_MODE === "block-breakdown"
  ? "image-preparation-16mp-block-breakdown.json"
  : STAGE_TIMING_ENABLED
    ? "image-preparation-16mp-stage-profile.json"
    : "image-preparation-16mp-service-integration.json");
const WIDTH = 4000;
const HEIGHT = 4000;
const PIXELS = WIDTH * HEIGHT;
const SOURCE_LIMIT_BYTES = 20 * 1024 * 1024;
const EXPECTED_FIXTURE_SHA256 = "5f5178ce761193b569130af082740669cd16071de9ea733aa8968f4f8e9dc6a3";

if (!process.versions.electron) runLauncher();
else runElectronProbe();

function runLauncher() {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clipnest-t04-i04-service-"));
  let childEvidence;
  let failure;
  try {
    assertTemporaryRoot(profileRoot);
    const userDataPath = path.join(profileRoot, "user-data");
    const sessionDataPath = path.join(profileRoot, "session-data");
    fs.mkdirSync(userDataPath);
    fs.mkdirSync(sessionDataPath);

    const fixture = buildSyntheticJpeg();
    const fixturePath = path.join(profileRoot, "synthetic-4000x4000-20mib.jpg");
    fs.writeFileSync(fixturePath, fixture.bytes);
    const fixtureMetadata = {
      width: WIDTH,
      height: HEIGHT,
      pixelCount: PIXELS,
      encodedBytes: fixture.bytes.byteLength,
      sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
      jpegEncoder: "pinned jpeg-js 0.4.4",
      jpegQuality: fixture.quality,
      jpegImageBytesBeforeApp2Padding: fixture.imageBytesBeforePadding,
      jpegApp2PaddingBytes: fixture.app2PaddingBytes,
      samplingFactors: fixture.samplingFactors,
      content: "deterministic high-entropy synthetic baseline JPEG with APP2 padding; no user data",
    };
    assert.equal(fixtureMetadata.encodedBytes, SOURCE_LIMIT_BYTES);
    assert.equal(fixtureMetadata.sha256, EXPECTED_FIXTURE_SHA256,
      "fixture must be byte-identical to the already measured 16 MP 4:4:4 sample");
    const fixtureMetadataPath = path.join(profileRoot, "fixture-metadata.json");
    fs.writeFileSync(fixtureMetadataPath, `${JSON.stringify(fixtureMetadata, null, 2)}\n`);

    const userData = { ...process.env };
    delete userData.ELECTRON_RUN_AS_NODE;
    Object.assign(userData, {
      T04_PROFILE_ROOT: profileRoot,
      T04_USER_DATA_PATH: userDataPath,
      T04_SESSION_DATA_PATH: sessionDataPath,
      T04_FIXTURE_PATH: fixturePath,
      T04_FIXTURE_METADATA_PATH: fixtureMetadataPath,
      ...(STAGE_TIMING_ENABLED ? { T04_IMAGE_STAGE_PROFILE: STAGE_PROFILE_MODE } : {}),
    });
    // The fixture generator runs in this outer Node process so its 64 MB
    // source pixel allocation is outside the Electron service memory samples.
    fixture.bytes = null;
    if (global.gc) global.gc();

    const electronBinary = resolveElectronBinary();
    userData.T04_ELECTRON_BINARY_SOURCE = electronBinary.source;
    const result = spawnSync(electronBinary.path, [
      `--user-data-dir=${userDataPath}`,
      __filename,
    ], {
      cwd: ROOT,
      env: userData,
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (result.error) throw new Error(`${result.error}; electron stderr=${result.stderr || ""}; stdout=${result.stdout || ""}`);
    if (result.status !== 0) {
      throw new Error(`electron_probe_exit_${result.status}: ${result.stderr || result.stdout}`);
    }
    const jsonLine = result.stdout.split(/\r?\n/).reverse().find((line) => line.startsWith("T04_I04_RESULT "));
    if (!jsonLine) throw new Error(`electron_probe_result_missing: ${result.stderr || result.stdout}`);
    childEvidence = JSON.parse(jsonLine.slice("T04_I04_RESULT ".length));
    if (result.stderr.trim()) childEvidence.environment.electronStderr = result.stderr.trim();
  } catch (error) {
    failure = error;
  } finally {
    assertTemporaryRoot(profileRoot);
    fs.rmSync(profileRoot, { recursive: true, force: true });
    if (fs.existsSync(profileRoot)) failure ??= new Error("temporary_profile_cleanup_failed");
  }
  if (failure) {
    process.stderr.write(`${failure.stack ?? failure}\n`);
    process.exitCode = 1;
    return;
  }
  if (fs.existsSync(EVIDENCE_PATH)) {
    process.stderr.write(`evidence_output_exists:${path.relative(ROOT, EVIDENCE_PATH)}\n`);
    process.exitCode = 1;
    return;
  }
  childEvidence.profileIsolation = {
    isolated: true,
    root: "unique validated child of the operating-system temporary directory",
    userDataAndSessionDataInsideRoot: true,
    fixtureInsideRoot: true,
    cleanupVerified: !fs.existsSync(profileRoot),
    fixtureGeneratorOutsideElectronMemorySample: true,
  };
  childEvidence.cleanup.temporaryProfileRemoved = !fs.existsSync(profileRoot);
  if (!childEvidence.cleanup.temporaryProfileRemoved) {
    process.stderr.write("temporary_profile_cleanup_unverified\n");
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(childEvidence, null, 2)}\n`, "utf8");
  process.stdout.write(`Saved ${path.relative(ROOT, EVIDENCE_PATH)}; result=${childEvidence.result}; largePrepareMs=${childEvidence.largeImage.elapsedMs}; workerPeakMiB=${round(childEvidence.memoryAttribution.largeUtilityPeakWorkingSetBytes / 1024 / 1024)}\n`);
}

function runElectronProbe() {
  const { app, BrowserWindow } = require("electron");
  const { PNG } = require("pngjs");
  const { ImagePreparationService, IMAGE_LIMITS } = require("../../../dist-electron/main/clipboard/image-preparation.js");
  const { createUtilityProcessImageWorker } = require("../../../dist-electron/main/clipboard/image-worker.js");
  const { performance } = require("node:perf_hooks");

  const profileRoot = process.env.T04_PROFILE_ROOT;
  const userDataPath = process.env.T04_USER_DATA_PATH;
  const sessionDataPath = process.env.T04_SESSION_DATA_PATH;
  if (!profileRoot || !userDataPath || !sessionDataPath) throw new Error("isolated_profile_required");
  assertTemporaryRoot(profileRoot);
  assertInside(profileRoot, userDataPath);
  assertInside(profileRoot, sessionDataPath);
  app.setPath("userData", userDataPath);
  app.setPath("sessionData", sessionDataPath);

  const workers = [];
  const diagnosticTimingValues = {};
  let service;
  let sampler;
  let phase = "initialization";
  const watchdog = setTimeout(() => {
    process.stderr.write(`T04 I04 Electron probe timed out during ${phase}\n`);
    app.exit(1);
  }, 90_000);

  app.whenReady().then(async () => {
    assert.equal(process.platform, "win32");
    assert.equal(process.arch, "x64");
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    assert.ok(fs.existsSync(path.join(ROOT, "dist-electron", "main", "clipboard", "image-worker.js")));

    const fixtureMetadata = JSON.parse(fs.readFileSync(process.env.T04_FIXTURE_METADATA_PATH, "utf8"));
    const encodedBytes = fs.readFileSync(process.env.T04_FIXTURE_PATH);
    assert.equal(createHash("sha256").update(encodedBytes).digest("hex"), fixtureMetadata.sha256);
    assert.equal(fixtureMetadata.sha256, EXPECTED_FIXTURE_SHA256);
    assert.equal(fixtureMetadata.encodedBytes, SOURCE_LIMIT_BYTES);
    sampler = createWindowsMemorySampler(50);
    await waitWithin(sampler.ready, 5_000, "Windows memory sampler did not become ready");
    await sampler.addProcess(process.pid);
    sampler.start();
    const mainBefore = await sampler.sample();

    service = new ImagePreparationService({
      workerFactory: () => createObservedWorker(),
    });
    const largeUpdates = [];
    phase = "large-image-service-prepare";
    const largeStartedAt = performance.now();
    const onDiagnosticTiming = STAGE_TIMING_ENABLED
      ? (stage, durationMs) => (diagnosticTimingValues[stage] ??= []).push(durationMs)
      : undefined;
    const largeResult = await service.prepare({
      itemRef: "synthetic-large-jpeg",
      itemVersion: fixtureMetadata.sha256,
      format: "jpeg",
      encodedBytes: encodedBytes,
      width: WIDTH,
      height: HEIGHT,
    }, {
      // The probe isolates service/cache/retirement behavior. This extended
      // diagnostic deadline does not claim the product's 3000 ms user gate.
      deadlineAt: largeStartedAt + 30_000,
      ...(onDiagnosticTiming ? { onDiagnosticTiming } : {}),
      onUpdate: (update) => largeUpdates.push({ ...update }),
    });
    const largeElapsedMs = round(performance.now() - largeStartedAt);
    assert.equal(largeResult.image.width, WIDTH);
    assert.equal(largeResult.image.height, HEIGHT);
    assert.equal(largeResult.image.pixels.byteLength, PIXELS * 4);
    assert.equal(largeResult.cacheHit, false);
    assert.equal(largeResult.cached, false);
    assert.deepEqual(service.getCacheStats(), {
      entries: 0,
      bytes: 0,
      limitBytes: IMAGE_LIMITS.decodedCacheBytes,
      workerBusy: false,
    });
    assert.deepEqual(largeUpdates.map((update) => update.phase), ["preparing", "ready"]);
    const largeWorker = workers[0];
    assert.ok(largeWorker?.pid);
    assert.equal(largeWorker.chunkMessages, 62);
    assert.equal(largeWorker.chunkBytes, PIXELS * 4);
    assert.deepEqual(largeWorker.endMessage, {
      width: WIDTH,
      height: HEIGHT,
      chunkCount: 62,
      byteLength: PIXELS * 4,
    });
    const largeRgbaSha256 = createHash("sha256").update(largeResult.image.pixels).digest("hex");
    const largeStats = service.getCacheStats();
    await waitWithin(largeWorker.exitPromise, 10_000, "large uncached worker must exit before the next image");
    assert.equal(largeWorker.disposeCalls, 1, "the uncached large result retires its real utility process");

    phase = "small-image-after-large-worker-retirement";
    const smallPixels = Buffer.from([12, 34, 56, 255, 78, 90, 123, 255]);
    const smallPng = PNG.sync.write({ width: 2, height: 1, data: smallPixels });
    const smallInput = {
      itemRef: "synthetic-small-png",
      itemVersion: "small-v1",
      format: "png",
      encodedBytes: smallPng,
      width: 2,
      height: 1,
    };
    const smallResult = await service.prepare(smallInput, { deadlineAt: performance.now() + 30_000 });
    const smallWorker = workers[1];
    assert.ok(smallWorker?.pid);
    assert.notEqual(smallWorker.pid, largeWorker.pid);
    assert.ok(largeWorker.exitObservedAtMs <= smallWorker.startedAtMs,
      "the small image starts only after the large worker exit is observed");
    assert.equal(smallResult.cacheHit, false);
    assert.equal(smallResult.cached, true);
    assert.deepEqual([...smallResult.image.pixels], [...smallPixels]);
    const smallStats = service.getCacheStats();
    assert.deepEqual(smallStats, {
      entries: 1,
      bytes: smallPixels.byteLength,
      limitBytes: IMAGE_LIMITS.decodedCacheBytes,
      workerBusy: false,
    });
    const workerCountBeforeCacheHit = workers.length;
    const decodeCountBeforeCacheHit = smallWorker.decodeCalls;
    const cachedResult = await service.prepare(smallInput);
    assert.equal(cachedResult.cacheHit, true);
    assert.equal(cachedResult.cached, true);
    assert.strictEqual(cachedResult.image, smallResult.image);
    assert.equal(workers.length, workerCountBeforeCacheHit);
    assert.equal(smallWorker.decodeCalls, decodeCountBeforeCacheHit);

    phase = "service-dispose-and-worker-exit";
    await service.dispose();
    await waitWithin(smallWorker.exitPromise, 10_000, "service disposal must reap the replacement utility process");
    const finalMainSample = await sampler.sample();
    const memorySamples = [...sampler.samples, finalMainSample];
    const memory = summarizeMemory(memorySamples, process.pid, largeWorker.pid);
    const finalMemory = await sampler.stop();
    const currentSource = collectSourceHashes();
    assert.ok(memory.largeWorkerPeakWorkingSetBytes <= IMAGE_LIMITS.workerPeakBytes,
      "this measured utility-process sample must stay within the configured worker target");
    assert.equal(BrowserWindow.getAllWindows().length, 0);

    const evidence = {
      schemaVersion: 1,
      task: "T04",
      result: "DIAGNOSTIC_PASS_WITH_LIMITATIONS",
      measurementType: "production_ImagePreparationService_real_utilityProcess_16MP_cache_and_retirement",
      measuredAt: new Date().toISOString(),
      ...(STAGE_TIMING_ENABLED ? { diagnosticProfile: {
        optIn: `T04_IMAGE_STAGE_PROFILE=${STAGE_PROFILE_MODE}`,
        timingSource: "optional ImagePreparationService diagnostic sink; utility worker detailed IPC is enabled only for the opted-in decode request; block breakdown samples one of every 128 JPEG blocks and adds timing overhead to that diagnostic run",
        stages: {
          workerColdStartMs: "utilityProcess fork until its production entry installed the decode listener and reported diagnostic_ready",
          serviceInputCopyMs: "ImagePreparationService encoded-byte copy before worker.decode",
          jpegPreflightParseMs: "production JPEG frame/metadata scan, dimension validation, and worker-capacity estimate",
          jpegStreamPlanParseMs: "stream decoder marker/table/scan-plan parse before entropy decoding",
          jpegHuffmanIdctWriteMs: "sum across MCU rows of Huffman/coefficient/IDCT decode plus component-band writes",
          jpegHuffmanDecodeSampledMs: "unscaled subtotal from one of every 128 blocks; includes coefficient clearing and entropy/Huffman decode",
          jpegInverseDctSampledMs: "unscaled subtotal from the same sampled blocks' inverse DCTs",
          jpegBandWriteSampledMs: "unscaled subtotal from the same sampled blocks' component-band row writes",
          jpegBlockSampling: "only every 128th block is timed; sampled subtotals are not extrapolated to the full frame",
          jpegRenderMs: "sum across MCU rows of RGB/RGBA rendering",
          workerDecodeMs: "utility worker request receipt through completed decoder result; includes JPEG stages above",
          workerChunkSendAckMs: "worker 1 MiB raw pixel chunk creation/send through final chunk ACK receipt",
          mainChunkAssemblyMs: "main process allocation and copy of received raw pixel chunks into the full RGBA buffer",
          serviceFinalCopyMs: "ImagePreparationService final decoded-pixel copy after worker.decode resolves",
        },
        reusedFiveSampleEvidence: {
          path: "docs/evidence/T04/image-worker-16000000-pixel-jpeg-20mib-fresh-worker-release-444-5-sample-measurement.json",
          sameFixtureSha256: EXPECTED_FIXTURE_SHA256,
          scope: "existing worker-ready-to-full-response five-sample timing and memory measurements; not rerun by this stage profile",
        },
      } } : {}),
      source: currentSource,
      environment: {
        platform: process.platform,
        architecture: process.arch,
        osVersion: os.release(),
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node,
        electronProcessType: process.type,
        electronBinarySource: process.env.T04_ELECTRON_BINARY_SOURCE,
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        displayOrForegroundAppUsed: false,
        browserWindowCreated: false,
        systemClipboardReadOrWritten: false,
        physicalInputSent: false,
        nativeHelperInvoked: false,
      },
      fixture: fixtureMetadata,
      productionRoute: {
        service: "ImagePreparationService",
        decoderWorker: "createUtilityProcessImageWorker (real Electron utilityProcess)",
        preparationDeadlineMs: 30_000,
        productPreparationTimeoutMs: IMAGE_LIMITS.contentPrepareTimeoutMs,
        deadlineMeaning: "diagnostic-only override used to isolate service/cache/worker lifecycle; not the product 3000 ms deadline gate",
      },
      largeImage: {
        itemRef: "synthetic-large-jpeg",
        elapsedMs: largeElapsedMs,
        productDeadlineWouldHaveExpiredAtObservedDuration: largeElapsedMs > IMAGE_LIMITS.contentPrepareTimeoutMs,
        updatePhases: largeUpdates.map((update) => update.phase),
        resultWidth: largeResult.image.width,
        resultHeight: largeResult.image.height,
        decodedRgbaBytes: largeResult.image.pixels.byteLength,
        decodedRgbaSha256: largeRgbaSha256,
        cacheHit: largeResult.cacheHit,
        cached: largeResult.cached,
        cacheStatsAfterPrepare: largeStats,
        utilityProcessPid: largeWorker.pid,
        utilityProcessDecodeCalls: largeWorker.decodeCalls,
        ...(onDiagnosticTiming ? { diagnosticStageTimings: summarizeDiagnosticTimings(diagnosticTimingValues) } : {}),
        response: {
          decodedChunkMessages: largeWorker.chunkMessages,
          totalChunkBytes: largeWorker.chunkBytes,
          firstSequence: largeWorker.firstSequence,
          lastSequence: largeWorker.lastSequence,
          minChunkBytes: largeWorker.minChunkBytes,
          maxChunkBytes: largeWorker.maxChunkBytes,
          decodedEnd: largeWorker.endMessage,
        },
        retirement: {
          disposeCalls: largeWorker.disposeCalls,
          processExitObserved: largeWorker.exitObservedAtMs !== null,
          exitCode: largeWorker.exitCode,
          exitSignal: largeWorker.exitSignal,
          exitedBeforeSmallImageWorkerStarted: largeWorker.exitObservedAtMs <= smallWorker.startedAtMs,
        },
      },
      smallImageAfterRetirement: {
        decodedRgbaBytes: smallResult.image.pixels.byteLength,
        decodedRgbaSha256: createHash("sha256").update(smallResult.image.pixels).digest("hex"),
        expectedRgbaSha256: createHash("sha256").update(smallPixels).digest("hex"),
        cacheHitOnInitialPrepare: smallResult.cacheHit,
        cachedOnInitialPrepare: smallResult.cached,
        cacheStatsAfterPrepare: smallStats,
        utilityProcessPid: smallWorker.pid,
        replacementWorkerCreated: workers.length === 2 && smallWorker.pid !== largeWorker.pid,
        cacheHitOnRepeat: cachedResult.cacheHit,
        workerFactoryCountUnchangedOnCacheHit: workers.length === workerCountBeforeCacheHit,
        decodeCountUnchangedOnCacheHit: smallWorker.decodeCalls === decodeCountBeforeCacheHit,
        processExitObservedAfterServiceDispose: smallWorker.exitObservedAtMs !== null,
        exitCode: smallWorker.exitCode,
        exitSignal: smallWorker.exitSignal,
      },
      memoryAttribution: {
        sampler: "one Windows PowerShell Get-Process sampler for the Electron main PID and utilityProcess PIDs",
        sampleIntervalMs: 50,
        sampleCount: memorySamples.length,
        mainProcessPid: process.pid,
        mainProcessBaselineWorkingSetBytes: mainBefore.rows[String(process.pid)]?.workingSetBytes ?? null,
        mainProcessPeakWorkingSetBytes: memory.mainPeakWorkingSetBytes,
        mainProcessSampledPeakPrivateBytes: memory.mainSampledPeakPrivateBytes,
        largeUtilityPeakWorkingSetBytes: memory.largeWorkerPeakWorkingSetBytes,
        largeUtilitySampledPeakPrivateBytes: memory.largeWorkerSampledPeakPrivateBytes,
        concurrentMainPlusLargeUtilitySampledPeakWorkingSetBytes: memory.concurrentPeakSumBytes,
        concurrentSamplesUsed: memory.concurrentSampleCount,
        finalMainWorkingSetBytes: finalMainSample.rows[String(process.pid)]?.workingSetBytes ?? null,
        withinConfiguredWorkerTarget: memory.largeWorkerPeakWorkingSetBytes <= IMAGE_LIMITS.workerPeakBytes,
        limitations: [
          "PeakWorkingSet64 is the OS high-water mark observed at 50 ms snapshots; private bytes are sampled current values and shorter peaks may be missed.",
          "Concurrent sum uses same-query 50 ms snapshots of the main process and large utility process; it excludes the PowerShell sampler, fixture generator, other application/system processes, and is not a whole-application hard memory bound.",
          "The main process temporarily owns encoded input, worker IPC assembly, and ImagePreparationService's copied RGBA result; worker RSS does not include those allocations.",
        ],
      },
      profileIsolation: null,
      cleanup: {
        serviceDisposed: true,
        allObservedUtilityProcessesExited: workers.every((worker) => worker.exitObservedAtMs !== null),
        workerExitPids: workers.map((worker) => worker.pid),
        samplerStopped: finalMemory.stopped,
        temporaryProfileRemoved: null,
      },
      probeInvariants: {
        browserWindowCreated: false,
        systemClipboardReadOrWritten: false,
        physicalInputSent: false,
        foregroundApplicationUsed: false,
        helperInvoked: false,
      },
      limitations: [
        "One synthetic 16 MP/20 MiB SOF0 4:4:4 integration sample supplements, but does not replace, the five-sample worker memory evidence or T04 I04 fake boundary cases.",
        `The extended diagnostic deadline does not validate the ${IMAGE_LIMITS.contentPrepareTimeoutMs} ms product deadline; observed service preparation took ${largeElapsedMs} ms, above that threshold in this instrumented run. No cancellation, over-limit input, permission/read failure, clipboard, target application, installed package, or full selection/paste path was exercised.`,
        "A passing probe does not prove a universal 256 MiB RSS ceiling, all JPEG layouts/metadata, 4:2:0 fidelity, or complete T04 acceptance.",
      ],
    };
    await new Promise((resolve) => process.stdout.write(`T04_I04_RESULT ${JSON.stringify(evidence)}\n`, resolve));
    clearTimeout(watchdog);
    app.exit(0);
  }).catch(async (error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    clearTimeout(watchdog);
    try { await service?.dispose(); } catch { /* preserve probe failure */ }
    try { await sampler?.stop(); } catch { /* preserve probe failure */ }
    app.exit(1);
  });

  function createObservedWorker() {
    const realWorker = createUtilityProcessImageWorker();
    const telemetry = {
      pid: null,
      startedAtMs: null,
      exitObservedAtMs: null,
      exitCode: null,
      exitSignal: null,
      exitPromise: null,
      disposeCalls: 0,
      decodeCalls: 0,
      chunkMessages: 0,
      chunkBytes: 0,
      firstSequence: null,
      lastSequence: null,
      minChunkBytes: null,
      maxChunkBytes: null,
      endMessage: null,
    };
    workers.push(telemetry);
    return {
      async decode(input, signal, onDiagnosticTiming) {
        telemetry.decodeCalls++;
        const originalOnMessage = realWorker.onMessage;
        realWorker.onMessage = function observeMessage(raw) {
          if (raw && raw.requestId === input.jobId) {
            if (raw.type === "decoded_chunk") {
              const bytes = raw.pixels?.byteLength ?? 0;
              telemetry.chunkMessages++;
              telemetry.chunkBytes += bytes;
              telemetry.firstSequence ??= raw.seq;
              telemetry.lastSequence = raw.seq;
              telemetry.minChunkBytes = telemetry.minChunkBytes === null ? bytes : Math.min(telemetry.minChunkBytes, bytes);
              telemetry.maxChunkBytes = telemetry.maxChunkBytes === null ? bytes : Math.max(telemetry.maxChunkBytes, bytes);
            } else if (raw.type === "decoded_end") {
              telemetry.endMessage = {
                width: raw.width,
                height: raw.height,
                chunkCount: raw.chunkCount,
                byteLength: raw.byteLength,
              };
            }
          }
          originalOnMessage.call(realWorker, raw);
        };
        const decoded = onDiagnosticTiming
          ? realWorker.decode(input, signal, onDiagnosticTiming)
          : realWorker.decode(input, signal);
        const child = realWorker.child;
        assert.ok(child, "production worker factory must create a real utilityProcess");
        telemetry.exitPromise = new Promise((resolve) => child.once("exit", (code, signalValue) => {
          telemetry.exitObservedAtMs = performance.now();
          telemetry.exitCode = code;
          telemetry.exitSignal = signalValue;
          resolve({ code, signal: signalValue });
        }));
        try {
          await waitForSpawn(child);
          telemetry.pid = child.pid;
          telemetry.startedAtMs = performance.now();
          await sampler.addProcess(child.pid);
          const image = await decoded;
          // Capture the worker's OS high-water mark before ImagePreparationService
          // retires this uncached worker after it receives the decoded buffer.
          sampler.samples.push(await sampler.sample());
          return image;
        } finally {
          realWorker.onMessage = originalOnMessage;
        }
      },
      async dispose() {
        telemetry.disposeCalls++;
        await realWorker.dispose();
      },
    };
  }
}

function summarizeDiagnosticTimings(values) {
  const summaries = {};
  for (const [stage, samples] of Object.entries(values)) {
    summaries[stage] = {
      sampleCount: samples.length,
      totalMs: round(samples.reduce((total, value) => total + value, 0)),
      minMs: round(Math.min(...samples)),
      maxMs: round(Math.max(...samples)),
    };
  }
  return summaries;
}

function createWindowsMemorySampler(intervalMs) {
  const { spawn } = require("node:child_process");
  const script = [
    "$ErrorActionPreference='Stop'",
    "$targets=@{}",
    "[Console]::Out.WriteLine('READY')",
    "while($true){$command=[Console]::In.ReadLine();if($null -eq $command -or $command -eq 'STOP'){break};$parts=$command.Split(',');if($parts[0] -eq 'ADD'){$p=Get-Process -Id ([int]$parts[1]);$targets[$p.Id]=$p;[Console]::Out.WriteLine(('ADDED,{0}' -f $p.Id));continue};if($parts[0] -eq 'SAMPLE'){$tag=$parts[1];foreach($p in @($targets.Values)){try{$p.Refresh();[Console]::Out.WriteLine(('SAMPLE,{0},{1},{2},{3},{4}' -f $tag,$p.Id,$p.WorkingSet64,$p.PrivateMemorySize64,$p.PeakWorkingSet64))}catch{[Console]::Out.WriteLine(('GONE,{0},{1}' -f $tag,$p.Id))}}}}",
    "foreach($p in @($targets.Values)){try{$p.Refresh();[Console]::Out.WriteLine(('FINAL,{0},{1},{2},{3}' -f $p.Id,$p.PeakWorkingSet64,$p.WorkingSet64,$p.PrivateMemorySize64))}catch{[Console]::Out.WriteLine(('FINAL_GONE,{0}' -f $p.Id))}}",
  ].join(";");
  const samplerProcess = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  samplerProcess.stdout.setEncoding("utf8");
  samplerProcess.stderr.setEncoding("utf8");
  let buffered = "";
  let stderr = "";
  let stopped = false;
  let backgroundError = null;
  let ticker = null;
  let sampling = null;
  let nextTag = 0;
  const targets = new Set();
  const addWaiters = new Map();
  const pendingSamples = new Map();
  const finalRows = new Map();
  const samples = [];
  let resolveReady;
  let rejectReady;
  let resolveClosed;
  let rejectClosed;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });

  samplerProcess.stdout.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  });
  samplerProcess.stderr.on("data", (chunk) => { stderr += chunk; });
  samplerProcess.on("error", (error) => { rejectReady(error); rejectClosed(error); });
  samplerProcess.on("close", (code) => {
    if (code === 0) resolveClosed();
    else {
      const error = new Error(`memory_sampler_exit_${code}:${stderr}`);
      rejectReady(error);
      rejectClosed(error);
    }
  });

  return {
    ready,
    samples,
    async addProcess(pid) {
      if (targets.has(String(pid))) return;
      const key = String(pid);
      const waiter = deferred();
      addWaiters.set(key, waiter);
      samplerProcess.stdin.write(`ADD,${key}\n`);
      await waitWithin(waiter.promise, 5_000, `memory sampler could not attach to ${key}`);
      targets.add(key);
    },
    start() {
      if (ticker) return;
      ticker = setInterval(() => {
        if (sampling) return;
        sampling = this.sample().then((sample) => samples.push(sample)).catch((error) => {
          backgroundError = error;
        }).finally(() => { sampling = null; });
      }, intervalMs);
    },
    async sample() {
      const tag = `S${++nextTag}`;
      const expected = new Set(targets);
      const waiter = deferred();
      pendingSamples.set(tag, { expected, rows: {}, waiter, requestedAtMs: require("node:perf_hooks").performance.now() });
      samplerProcess.stdin.write(`SAMPLE,${tag}\n`);
      return waitWithin(waiter.promise, 5_000, `memory sampler snapshot timed out: ${tag}`);
    },
    async stop() {
      if (stopped) return { stopped: true, finalRows: Object.fromEntries(finalRows) };
      stopped = true;
      if (ticker) clearInterval(ticker);
      if (sampling) await sampling;
      if (backgroundError) throw backgroundError;
      if (targets.size) {
        const last = await this.sample();
        samples.push(last);
      }
      samplerProcess.stdin.write("STOP\n");
      await waitWithin(closed, 5_000, "memory sampler did not stop");
      return { stopped: true, finalRows: Object.fromEntries(finalRows) };
    },
  };

  function handleLine(line) {
    if (line === "READY") { resolveReady(); return; }
    const fields = line.split(",");
    if (fields[0] === "ADDED") {
      const waiter = addWaiters.get(fields[1]);
      if (waiter) { addWaiters.delete(fields[1]); waiter.resolve(); }
      return;
    }
    if (fields[0] === "SAMPLE" || fields[0] === "GONE") {
      const tag = fields[1];
      const pid = fields[2];
      const batch = pendingSamples.get(tag);
      if (!batch) return;
      batch.rows[pid] = fields[0] === "GONE" ? null : {
        workingSetBytes: Number(fields[3]),
        privateBytes: Number(fields[4]),
        peakWorkingSetBytes: Number(fields[5]),
      };
      if ([...batch.expected].every((expectedPid) => Object.hasOwn(batch.rows, expectedPid))) {
        pendingSamples.delete(tag);
        batch.waiter.resolve({
          tag,
          requestedAtMs: batch.requestedAtMs,
          completedAtMs: require("node:perf_hooks").performance.now(),
          rows: batch.rows,
        });
      }
      return;
    }
    if (fields[0] === "FINAL" || fields[0] === "FINAL_GONE") {
      finalRows.set(fields[1], fields[0] === "FINAL_GONE" ? null : {
        peakWorkingSetBytes: Number(fields[2]),
        workingSetBytes: Number(fields[3]),
        privateBytes: Number(fields[4]),
      });
    }
  }
}

function buildSyntheticJpeg() {
  const pixels = Buffer.allocUnsafe(PIXELS * 4);
  let state = 0x6d2b79f5;
  for (let offset = 0; offset < pixels.byteLength; offset += 4) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[offset] = state & 0xff;
    pixels[offset + 1] = (state >>> 8) & 0xff;
    pixels[offset + 2] = (state >>> 16) & 0xff;
    pixels[offset + 3] = 0xff;
  }
  const jpeg = require("jpeg-js");
  const qualities = [74];
  let quality = null;
  let imageBytes = null;
  for (const candidate of qualities) {
    const encoded = Buffer.from(jpeg.encode({ width: WIDTH, height: HEIGHT, data: pixels }, candidate).data);
    if (encoded.byteLength < SOURCE_LIMIT_BYTES) {
      quality = candidate;
      imageBytes = encoded;
      break;
    }
  }
  if (!imageBytes) throw new Error("synthetic_jpeg_cannot_fit_source_limit");
  const targetBytes = SOURCE_LIMIT_BYTES - ((SOURCE_LIMIT_BYTES - imageBytes.byteLength) % 4);
  const app2PaddingBytes = targetBytes - imageBytes.byteLength;
  const segments = [];
  let remaining = app2PaddingBytes;
  while (remaining > 0) {
    const segmentBytes = Math.min(65_536, remaining);
    const segment = Buffer.alloc(segmentBytes);
    segment[0] = 0xff;
    segment[1] = 0xe2;
    segment.writeUInt16BE(segmentBytes - 2, 2);
    segments.push(segment);
    remaining -= segmentBytes;
  }
  const bytes = Buffer.concat([imageBytes.subarray(0, 2), ...segments, imageBytes.subarray(2)]);
  return {
    bytes,
    quality,
    imageBytesBeforePadding: imageBytes.byteLength,
    app2PaddingBytes,
    samplingFactors: readJpegSamplingFactors(imageBytes),
  };
}

function readJpegSamplingFactors(bytes) {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) throw new Error("synthetic_jpeg_marker_invalid");
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) throw new Error("synthetic_jpeg_segment_invalid");
    if (marker === 0xc0) {
      const components = bytes[offset + 7];
      return Array.from({ length: components }, (_, index) => {
        const sampling = bytes[offset + 9 + index * 3];
        return { horizontal: sampling >> 4, vertical: sampling & 0x0f };
      });
    }
    offset += segmentLength;
  }
  throw new Error("synthetic_jpeg_sof_missing");
}

function summarizeMemory(samples, mainPid, largePid) {
  const mainKey = String(mainPid);
  const workerKey = String(largePid);
  const mainRows = samples.map((sample) => sample.rows[mainKey]).filter(Boolean);
  const workerRows = samples.map((sample) => sample.rows[workerKey]).filter(Boolean);
  const concurrent = samples.filter((sample) => sample.rows[mainKey] && sample.rows[workerKey]);
  return {
    mainPeakWorkingSetBytes: Math.max(0, ...mainRows.map((row) => row.peakWorkingSetBytes)),
    mainSampledPeakPrivateBytes: Math.max(0, ...mainRows.map((row) => row.privateBytes)),
    largeWorkerPeakWorkingSetBytes: Math.max(0, ...workerRows.map((row) => row.peakWorkingSetBytes)),
    largeWorkerSampledPeakPrivateBytes: Math.max(0, ...workerRows.map((row) => row.privateBytes)),
    concurrentPeakSumBytes: Math.max(0, ...concurrent.map((sample) =>
      sample.rows[mainKey].workingSetBytes + sample.rows[workerKey].workingSetBytes)),
    concurrentSampleCount: concurrent.length,
  };
}

function collectSourceHashes() {
  const files = [
    "src/main/clipboard/image-preparation.ts",
    "src/main/clipboard/image-worker.ts",
    "src/main/clipboard/image-decoder.ts",
    "src/main/clipboard/jpeg-baseline-stream.ts",
    "dist-electron/main/clipboard/image-preparation.js",
    "dist-electron/main/clipboard/image-worker.js",
    "dist-electron/main/clipboard/image-decoder.js",
    "dist-electron/main/clipboard/jpeg-baseline-stream.js",
    "tests/tasks/T04/run-image-preparation-16mp-electron.cjs",
  ];
  return {
    commit: gitValue("rev-parse", "HEAD"),
    branch: gitValue("branch", "--show-current"),
    workingTreeWasDirty: Boolean(gitValue("status", "--porcelain")),
    productionAndBuildFiles: files.map((relative) => {
      const filePath = path.join(ROOT, relative);
      if (!fs.existsSync(filePath)) throw new Error(`source_file_missing:${relative}`);
      return { path: relative, sha256: createHash("sha256").update(fs.readFileSync(filePath)).digest("hex") };
    }),
  };
}

function resolveElectronBinary() {
  if (process.env.T04_ELECTRON_BIN) {
    const binary = path.resolve(process.env.T04_ELECTRON_BIN);
    if (!fs.existsSync(binary)) throw new Error("configured_electron_binary_missing");
    return { path: binary, source: "T04_ELECTRON_BIN override" };
  }
  const indexedPath = require("electron");
  if (fs.existsSync(indexedPath)) return { path: indexedPath, source: "pinned electron package entry" };

  // Some pnpm installs keep the valid extracted runtime one level below the
  // package's expected dist path. Accept it only when --version matches the
  // repository-pinned electron package version.
  const storeRoot = path.join(ROOT, "node_modules", ".pnpm");
  for (const entry of fs.readdirSync(storeRoot).filter((name) => name.startsWith("electron@"))) {
    const packageRoot = path.join(storeRoot, entry, "node_modules", "electron");
    const packageInfoPath = path.join(packageRoot, "package.json");
    if (!fs.existsSync(packageInfoPath)) continue;
    const packageInfo = JSON.parse(fs.readFileSync(packageInfoPath, "utf8"));
    for (const relative of ["dist/electron.exe", "dist/dist/electron.exe"]) {
      const binary = path.join(packageRoot, relative);
      if (!fs.existsSync(binary)) continue;
      const version = spawnSync(binary, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
      if (version.status === 0 && version.stdout.trim() === `v${packageInfo.version}`) {
        return { path: binary, source: `pinned pnpm Electron ${packageInfo.version} runtime; nested dist fallback` };
      }
    }
  }
  throw new Error("pinned_electron_runtime_missing");
}

function gitValue(...args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : "";
}

function assertTemporaryRoot(candidate) {
  const root = path.resolve(os.tmpdir());
  const value = path.resolve(candidate);
  const relative = path.relative(root, value);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("unsafe_t04_temporary_root");
  }
}

function assertInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("unsafe_t04_profile_path");
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function waitWithin(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

function waitForSpawn(child) {
  if (child.pid) return Promise.resolve();
  return waitWithin(new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("exit", (code) => reject(new Error(`utility_process_exited_before_spawn:${code}`)));
  }), 10_000, "utility_process_spawn_timeout");
}

function round(value) { return Math.round(value * 100) / 100; }

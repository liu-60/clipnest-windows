// Measures the production ImagePreparationService with the product's default
// 3000 ms deadline and five fresh Electron utility processes. No window,
// clipboard, helper, or physical input is used.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../../..");
const EVIDENCE_SUFFIX = process.env.T04_DEADLINE_EVIDENCE_SUFFIX ?? "";
if (EVIDENCE_SUFFIX && !/^[a-z0-9-]{1,48}$/.test(EVIDENCE_SUFFIX)) {
  throw new Error("invalid_evidence_suffix");
}
const EVIDENCE_PATH = path.join(ROOT, "docs", "evidence", "T04",
  `image-preparation-16mp-default-deadline${EVIDENCE_SUFFIX ? `-${EVIDENCE_SUFFIX}` : ""}-5-sample.json`);
const WIDTH = 4000;
const HEIGHT = 4000;
const PIXELS = WIDTH * HEIGHT;
const SAMPLE_COUNT = 5;
const SOURCE_LIMIT_BYTES = 20 * 1024 * 1024;
const EXPECTED_FIXTURE_SHA256 = "5f5178ce761193b569130af082740669cd16071de9ea733aa8968f4f8e9dc6a3";
const EXPECTED_RGBA_SHA256 = "f6f1c8619e4adc31a55adc532c5219ab7408bca3cafdcf677d0dde2a0fce83dc";

if (!process.versions.electron) runLauncher();
else runElectronProbe();

function runLauncher() {
  if (fs.existsSync(EVIDENCE_PATH)) throw new Error(`evidence_output_exists:${path.relative(ROOT, EVIDENCE_PATH)}`);
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clipnest-t04-default-deadline-"));
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
      "fixture must match the existing synthetic 16 MP/20 MiB 4:4:4 sample");
    assert.deepEqual(fixtureMetadata.samplingFactors, [
      { horizontal: 1, vertical: 1 },
      { horizontal: 1, vertical: 1 },
      { horizontal: 1, vertical: 1 },
    ]);
    const fixtureMetadataPath = path.join(profileRoot, "fixture-metadata.json");
    fs.writeFileSync(fixtureMetadataPath, `${JSON.stringify(fixtureMetadata, null, 2)}\n`);

    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    delete childEnv.T04_IMAGE_STAGE_PROFILE;
    delete childEnv.T04_WORKER_STAGE_TIMING;
    Object.assign(childEnv, {
      T04_PROFILE_ROOT: profileRoot,
      T04_USER_DATA_PATH: userDataPath,
      T04_SESSION_DATA_PATH: sessionDataPath,
      T04_FIXTURE_PATH: fixturePath,
      T04_FIXTURE_METADATA_PATH: fixtureMetadataPath,
    });
    fixture.bytes = null;
    if (global.gc) global.gc();

    const electronBinary = resolveElectronBinary();
    childEnv.T04_ELECTRON_BINARY_SOURCE = electronBinary.source;
    const result = spawnSync(electronBinary.path, [
      `--user-data-dir=${userDataPath}`,
      __filename,
    ], {
      cwd: ROOT,
      env: childEnv,
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (result.error) throw new Error(`${result.error}; electron stderr=${result.stderr || ""}; stdout=${result.stdout || ""}`);
    if (result.status !== 0) throw new Error(`electron_probe_exit_${result.status}: ${result.stderr || result.stdout}`);
    const jsonLine = result.stdout.split(/\r?\n/).reverse().find((line) => line.startsWith("T04_DEFAULT_DEADLINE_RESULT "));
    if (!jsonLine) throw new Error(`electron_probe_result_missing: ${result.stderr || result.stdout}`);
    childEvidence = JSON.parse(jsonLine.slice("T04_DEFAULT_DEADLINE_RESULT ".length));
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
  childEvidence.profileIsolation = {
    isolated: true,
    root: "unique validated child of the operating-system temporary directory",
    userDataAndSessionDataInsideRoot: true,
    fixtureInsideRoot: true,
    cleanupVerified: !fs.existsSync(profileRoot),
  };
  childEvidence.cleanup.temporaryProfileRemoved = !fs.existsSync(profileRoot);
  if (!childEvidence.cleanup.temporaryProfileRemoved) {
    process.stderr.write("temporary_profile_cleanup_unverified\n");
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(childEvidence, null, 2)}\n`, "utf8");
  process.stdout.write(`Saved ${path.relative(ROOT, EVIDENCE_PATH)}; successes=${childEvidence.summary.successCount}; timeouts=${childEvidence.summary.timeoutCount}; serviceMs=${childEvidence.summary.serviceWallTimeMs.min}/${childEvidence.summary.serviceWallTimeMs.median}/${childEvidence.summary.serviceWallTimeMs.max}\n`);
}

function runElectronProbe() {
  const { app, BrowserWindow } = require("electron");
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

  const services = [];
  const samples = [];
  let activePhase = "electron-ready";
  const watchdog = setTimeout(() => {
    process.stderr.write(`T04 default-deadline probe timed out during ${activePhase}\n`);
    app.exit(1);
  }, 110_000);

  app.whenReady().then(async () => {
    assert.equal(process.platform, "win32");
    assert.equal(process.arch, "x64");
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    assert.equal(process.env.T04_IMAGE_STAGE_PROFILE, undefined);
    assert.equal(process.env.T04_WORKER_STAGE_TIMING, undefined);
    assert.ok(fs.existsSync(path.join(ROOT, "dist-electron", "main", "clipboard", "image-worker.js")));

    const fixtureMetadata = JSON.parse(fs.readFileSync(process.env.T04_FIXTURE_METADATA_PATH, "utf8"));
    const encodedBytes = fs.readFileSync(process.env.T04_FIXTURE_PATH);
    assert.equal(createHash("sha256").update(encodedBytes).digest("hex"), fixtureMetadata.sha256);
    assert.equal(fixtureMetadata.sha256, EXPECTED_FIXTURE_SHA256);
    assert.equal(fixtureMetadata.encodedBytes, SOURCE_LIMIT_BYTES);

    for (let index = 0; index < SAMPLE_COUNT; index++) {
      const previous = samples[index - 1];
      const sample = {
        index: index + 1,
        status: "pending",
        selectionPreparationStartedAtMs: null,
        deadlineAtMs: null,
        serviceSettledAtMs: null,
        serviceWallTimeMs: null,
        deadlineOvershootMs: null,
        errorCode: null,
        outputBytes: null,
        outputRgbaSha256: null,
        workerFactoryCalls: 0,
        workerDecodeCalls: 0,
        diagnosticSinkPassed: false,
        utilityProcessPid: null,
        workerSpawnedAtMs: null,
        workerAbortObserved: false,
        workerAbortObservedAtMs: null,
        workerAbortReasonCode: null,
        workerAbortObservationSource: null,
        workerExitObserved: false,
        workerExitObservedAtMs: null,
        workerExitCode: null,
        workerExitSignal: null,
        workerDisposeCalls: 0,
        serviceDisposeResolvedAtMs: null,
        sampleCompletedAtMs: null,
        serviceDisposeCompleted: false,
        processExitCompletedBeforeNextSample: null,
      };
      const service = new ImagePreparationService({ workerFactory: () => createObservedWorker(sample) });
      services.push(service);

      sample.selectionPreparationStartedAtMs = performance.now();
      sample.deadlineAtMs = sample.selectionPreparationStartedAtMs + IMAGE_LIMITS.contentPrepareTimeoutMs;
      if (previous) {
        assert.equal(previous.workerExitObserved, true, "the prior sample's worker must exit before a new sample starts");
        sample.processExitCompletedBeforeNextSample = previous.workerExitObservedAtMs <= sample.selectionPreparationStartedAtMs;
        assert.equal(sample.processExitCompletedBeforeNextSample, true);
      }

      activePhase = `sample-${sample.index}-prepare`;
      try {
        const result = await service.prepare({
          itemRef: `synthetic-large-jpeg-${sample.index}`,
          itemVersion: fixtureMetadata.sha256,
          format: "jpeg",
          encodedBytes,
          width: WIDTH,
          height: HEIGHT,
        }, { deadlineAt: sample.deadlineAtMs });
        sample.serviceSettledAtMs = performance.now();
        sample.status = "success";
        sample.outputBytes = result.image.pixels.byteLength;
        sample.outputRgbaSha256 = createHash("sha256").update(result.image.pixels).digest("hex");
        assert.equal(result.image.width, WIDTH);
        assert.equal(result.image.height, HEIGHT);
        assert.equal(sample.outputBytes, PIXELS * 4);
        assert.equal(result.cacheHit, false);
        assert.equal(result.cached, false);
        assert.equal(sample.outputRgbaSha256, EXPECTED_RGBA_SHA256,
          "successful 16 MP output must match the established deterministic RGBA hash");
      } catch (error) {
        sample.serviceSettledAtMs = performance.now();
        sample.errorCode = typeof error?.code === "string" ? error.code : error?.message ?? "unknown_error";
        sample.status = sample.errorCode === "image_prepare_timeout" ? "timeout" : "error";
        if (sample.status !== "timeout") throw error;
      }
      sample.serviceWallTimeMs = round(sample.serviceSettledAtMs - sample.selectionPreparationStartedAtMs);
      sample.deadlineOvershootMs = round(Math.max(0,
        sample.serviceSettledAtMs - sample.deadlineAtMs));

      assert.equal(sample.workerFactoryCalls, 1, "each sample must create one new production worker");
      assert.equal(sample.workerDecodeCalls, 1, "each sample must send one production decode request");
      assert.equal(sample.diagnosticSinkPassed, false, "diagnostic timing sink must remain disabled");
      if (sample.status === "timeout") {
        assert.equal(sample.workerAbortObserved, true, "default deadline timeout must abort the worker request");
        assert.equal(sample.workerAbortReasonCode, "image_prepare_timeout");
      } else {
        assert.equal(sample.workerAbortObserved, false, "successful preparation must not abort its worker");
      }

      activePhase = `sample-${sample.index}-worker-exit`;
      await waitWithin(service.dispose(), 15_000, `sample_${sample.index}_service_dispose_timeout`);
      sample.serviceDisposeResolvedAtMs = performance.now();
      sample.serviceDisposeCompleted = true;
      sample.removeWorkerAbortListener?.();
      delete sample.removeWorkerAbortListener;
      if (!sample.workerExitPromise) throw new Error(`sample_${sample.index}_worker_exit_listener_missing`);
      await waitWithin(sample.workerExitPromise, 15_000, `sample_${sample.index}_worker_exit_timeout`);
      sample.workerExitObserved = sample.workerExitObservedAtMs !== null;
      delete sample.workerExitPromise;
      sample.sampleCompletedAtMs = performance.now();
      assert.equal(sample.workerExitObserved, true);
      assert.equal(Number.isInteger(sample.utilityProcessPid), true);
      assert.equal(sample.workerExitObservedAtMs >= (sample.workerAbortObservedAtMs ?? sample.serviceSettledAtMs), true,
        "worker exit must follow timeout abort or successful service settlement");
      samples.push(sample);
    }

    assert.equal(samples.length, SAMPLE_COUNT);
    assert.equal(new Set(samples.map((sample) => sample.utilityProcessPid)).size, SAMPLE_COUNT,
      "all samples must use distinct utility process IDs");
    assert.ok(samples.every((sample) => sample.status === "success" || sample.status === "timeout"));
    assert.ok(samples.every((sample) => sample.workerExitObserved && sample.serviceDisposeCompleted));
    assert.equal(BrowserWindow.getAllWindows().length, 0);

    const successfulSamples = samples.filter((sample) => sample.status === "success");
    const timeoutSamples = samples.filter((sample) => sample.status === "timeout");
    const elapsedTimes = samples.map((sample) => sample.serviceWallTimeMs).sort((a, b) => a - b);
    const source = collectSourceHashes();
    const evidence = {
      schemaVersion: 1,
      task: "T04",
      result: "MEASURED_WITH_LIMITATIONS",
      measurementType: "production_ImagePreparationService_default_3000ms_deadline_five_fresh_utility_process_samples",
      measuredAt: new Date().toISOString(),
      source,
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
        stageTimingProfileEnvPresent: process.env.T04_IMAGE_STAGE_PROFILE === "1",
        workerStageTimingEnvPresent: process.env.T04_WORKER_STAGE_TIMING === "1",
        browserWindowCreated: false,
        systemClipboardReadOrWritten: false,
        physicalInputSent: false,
        nativeHelperInvoked: false,
      },
      fixture: fixtureMetadata,
      productionRoute: {
        service: "ImagePreparationService",
        decoderWorker: "createUtilityProcessImageWorker (real Electron utilityProcess)",
        sampleCount: SAMPLE_COUNT,
        preparationDeadlineMs: IMAGE_LIMITS.contentPrepareTimeoutMs,
        deadlineAt: "performance.now() captured immediately before each service.prepare call plus the configured 3000 ms budget",
        serviceWallTime: "selectionPreparationStartedAtMs until service.prepare fulfills or rejects; excludes worker reaping",
        diagnosticSinkEnabled: false,
        workerStageTimingEnvironmentEnabled: false,
        perSampleIsolation: "new ImagePreparationService and one new utilityProcess per sample; await service.dispose and process exit before the next sample",
      },
      summary: {
        sampleCount: SAMPLE_COUNT,
        successCount: successfulSamples.length,
        timeoutCount: timeoutSamples.length,
        errorCount: 0,
        serviceWallTimeMs: {
          min: elapsedTimes[0],
          median: elapsedTimes[Math.floor(elapsedTimes.length / 2)],
          max: elapsedTimes[elapsedTimes.length - 1],
          values: samples.map((sample) => sample.serviceWallTimeMs),
        },
        allTimedOutSamplesAbortedWorker: timeoutSamples.every((sample) => sample.workerAbortObserved),
        allSampleWorkersExitedBeforeNextSample: samples.slice(1).every((sample) => sample.processExitCompletedBeforeNextSample),
      },
      samples,
      cleanup: {
        serviceDisposeCompletedForAllSamples: samples.every((sample) => sample.serviceDisposeCompleted),
        workerExitObservedForAllSamples: samples.every((sample) => sample.workerExitObserved),
        distinctUtilityProcessPids: [...new Set(samples.map((sample) => sample.utilityProcessPid))],
        temporaryProfileRemoved: null,
      },
      profileIsolation: null,
      probeInvariants: {
        browserWindowCreated: false,
        systemClipboardReadOrWritten: false,
        physicalInputSent: false,
        nativeHelperInvoked: false,
        packageInstalled: false,
      },
      limitations: [
        "Five samples use one deterministic synthetic 16 MP/20 MiB baseline JPEG SOF0 4:4:4 input and do not represent all JPEG layouts or user images.",
        "The measured interval covers production image preparation through success or timeout, but excludes selection UI work, clipboard access, helper calls, target-application behavior, and paste input.",
        "Results are environment-specific timing observations, not a universal 3000 ms guarantee or complete T04 acceptance.",
      ],
    };
    await new Promise((resolve) => process.stdout.write(`T04_DEFAULT_DEADLINE_RESULT ${JSON.stringify(evidence)}\n`, resolve));
    clearTimeout(watchdog);
    app.exit(0);
  }).catch(async (error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    clearTimeout(watchdog);
    await Promise.allSettled(services.map((service) => service.dispose()));
    app.exit(1);
  });

  function createObservedWorker(sample) {
    sample.workerFactoryCalls++;
    const realWorker = createUtilityProcessImageWorker();
    return {
      async decode(input, signal, onDiagnosticTiming) {
        sample.workerDecodeCalls++;
        sample.diagnosticSinkPassed = typeof onDiagnosticTiming === "function";
        const onAbort = () => {
          sample.workerAbortObserved = true;
          sample.workerAbortObservedAtMs = performance.now();
          sample.workerAbortReasonCode = typeof signal.reason?.code === "string"
            ? signal.reason.code : signal.reason?.message ?? null;
          sample.workerAbortObservationSource = "abort_event";
        };
        signal.addEventListener("abort", onAbort, { once: true });
        sample.removeWorkerAbortListener = () => {
          if (signal.aborted && !sample.workerAbortObserved) {
            onAbort();
            sample.workerAbortObservationSource = "aborted_signal_state_at_service_dispose";
          }
          signal.removeEventListener("abort", onAbort);
        };
        const decodePromise = typeof onDiagnosticTiming === "function"
          ? realWorker.decode(input, signal, onDiagnosticTiming)
          : realWorker.decode(input, signal);
        const child = realWorker.child;
        if (!child) throw new Error("production_utility_process_not_created");
        sample.workerExitPromise = new Promise((resolve) => child.once("exit", (code, signalValue) => {
          sample.workerExitObservedAtMs = performance.now();
          sample.workerExitCode = code;
          sample.workerExitSignal = signalValue;
          resolve({ code, signal: signalValue });
        }));
        await waitForSpawn(child);
        sample.utilityProcessPid = child.pid;
        sample.workerSpawnedAtMs = performance.now();
        return await decodePromise;
      },
      async dispose() {
        sample.workerDisposeCalls = (sample.workerDisposeCalls ?? 0) + 1;
        await realWorker.dispose();
      },
    };
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
  const quality = 74;
  const imageBytes = Buffer.from(jpeg.encode({ width: WIDTH, height: HEIGHT, data: pixels }, quality).data);
  if (imageBytes.byteLength >= SOURCE_LIMIT_BYTES) throw new Error("synthetic_jpeg_cannot_fit_source_limit");
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
    "tests/tasks/T04/run-image-preparation-16mp-default-deadline-5-sample.cjs",
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

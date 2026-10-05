// Builds an isolated Windows directory package and verifies post-scan JPEG
// metadata through the worker loaded from that package's app.asar.
// The fixture is synthetic; this runner never opens a window or touches the
// desktop clipboard, native helper, or input APIs.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const REPOSITORY_ROOT = path.resolve(__dirname, "../../..");
const TEMP_PARENT = path.resolve(REPOSITORY_ROOT, "..");
const EVIDENCE_PATH = path.join(REPOSITORY_ROOT,
  "docs/evidence/T04/jpeg-postscan-asar-utilityprocess-integration-asar-only-pass.json");
const WIDTH = 4000;
const HEIGHT = 4000;
const COM_PAYLOAD_BYTES = 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const REQUEST_ID = "postscan-asar-16mp";
const ROOT_PREFIX = "t04-postscan-asar-20261006-";
const BUILDER_TIMEOUT_MS = 120 * 1000;
const ELECTRON_TIMEOUT_MS = 90 * 1000;

if (process.versions.electron) {
  void runPackagedProbe();
} else {
  runBuildAndProbe();
}

function segment(marker, payload) {
  const result = Buffer.alloc(payload.length + 4);
  result[0] = 0xff;
  result[1] = marker;
  result.writeUInt16BE(payload.length + 2, 2);
  payload.copy(result, 4);
  return result;
}

function grayscaleBaselineJpeg(width, height) {
  if (width % 8 !== 0 || height % 8 !== 0) {
    throw new Error("fixture_dimensions_must_align_to_blocks");
  }
  const quantization = Buffer.alloc(65, 1);
  quantization[0] = 0;
  const frame = Buffer.alloc(9);
  frame[0] = 8;
  frame.writeUInt16BE(height, 1);
  frame.writeUInt16BE(width, 3);
  frame[5] = 1;
  frame[6] = 1;
  frame[7] = 0x11;
  frame[8] = 0;
  const huffman = Buffer.alloc(36);
  huffman[0] = 0x00;
  huffman[1] = 1;
  huffman[18] = 0x10;
  huffman[19] = 1;
  const scan = Buffer.from([1, 1, 0, 0, 63, 0]);
  const blockCount = (width / 8) * (height / 8);
  const entropyByteCount = blockCount / 4;
  if (!Number.isInteger(entropyByteCount)) {
    throw new Error("fixture_entropy_alignment_invalid");
  }
  // Each grayscale block encodes DC category 0 and AC EOB as two zero bits.
  const entropy = Buffer.alloc(entropyByteCount);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xdb, quantization),
    segment(0xc0, frame),
    segment(0xc4, huffman),
    segment(0xda, scan),
    entropy,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function appendPostScanMetadata(encoded) {
  const eoi = Buffer.from([0xff, 0xd9]);
  const eoiOffset = encoded.lastIndexOf(eoi);
  assert.notEqual(eoiOffset, -1, "fixture must end with EOI");
  const app1 = segment(0xe1, Buffer.from([0x45, 0x78, 0xff, 0xd9, 0x69, 0x66, 0x00]));
  const comments = [];
  for (let remaining = COM_PAYLOAD_BYTES; remaining > 0;) {
    const length = Math.min(65_533, remaining);
    comments.push(segment(0xfe, Buffer.alloc(length)));
    remaining -= length;
  }
  assert.equal(comments.length, 17);
  return Buffer.concat([
    encoded.subarray(0, eoiOffset),
    Buffer.from([0xff, 0xff]),
    app1,
    ...comments,
    Buffer.from([0xff, 0xff, 0xff]),
    encoded.subarray(eoiOffset),
  ]);
}

function runBuildAndProbe() {
  const evidence = {
    schemaVersion: 1,
    task: "T04",
    check: "current-source-asar-postscan-jpeg-utilityprocess-smoke",
    result: "NOT_RUN",
    checkedDate: chinaLocalDate(),
    source: {},
    environment: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      pnpmVersion: null,
      electronVersion: null,
    },
    package: {},
    build: {},
    smoke: {},
    sideEffects: {
      browserWindowCreated: false,
      systemClipboardReadOrWritten: false,
      nativeHelperRun: false,
      physicalInputSent: false,
      installed: false,
      published: false,
    },
    limitations: [
      "One synthetic 4000x4000 grayscale SOF0 JPEG fixture; this does not establish broad JPEG compatibility or color fidelity.",
      "Direct utilityProcess decode bypasses ImagePreparationService and does not measure its 3000 ms product deadline.",
      "No worker or whole-application RSS is sampled; this smoke does not establish a hard memory bound or complete T04 acceptance.",
      "signAndEditExecutable=false skips WinPackager's normal executable signing/resource-edit path; electron-builder still writes the ASAR integrity resource to the EXE. This smoke does not verify that PE resource, Authenticode signature, installer, or full T04 acceptance.",
    ],
  };

  let tempRoot = null;
  let tempRootCreated = false;
  const ownerToken = randomUUID();
  let asarPath = null;
  let asarSha256 = null;
  let electronResult = null;
  let packageIntegrity = null;
  let probeReport = null;
  let builderCachePath = null;
  let electronDistPath = null;
  const buildSteps = [];
  const stageLog = [];
  const reportStage = (stage) => {
    const entry = { stage, at: new Date().toISOString() };
    stageLog.push(entry);
    process.stdout.write("STAGE " + entry.at + " " + stage + "\n");
  };

  try {
    reportStage("preflight and create unique temporary root");
    assert.equal(process.platform, "win32", "the packaged smoke requires Windows");
    assert.equal(process.arch, "x64", "the packaged smoke requires x64");
    assert.ok(fs.existsSync(path.join(REPOSITORY_ROOT, "package.json")), "repository root must exist");
    assert.ok(fs.existsSync(TEMP_PARENT), "the dedicated temp parent must already exist");
    const canonicalParent = fs.realpathSync(TEMP_PARENT);
    tempRoot = fs.mkdtempSync(path.join(canonicalParent, ROOT_PREFIX));
    tempRootCreated = true;
    const canonicalTempRoot = fs.realpathSync(tempRoot);
    const markerPath = path.join(canonicalTempRoot, ".t04-owned-by-runner.json");
    fs.writeFileSync(markerPath, JSON.stringify({ ownerToken, createdAt: new Date().toISOString() }),
      { flag: "wx" });
    assertFreshTempRoot(tempRoot, canonicalParent);

    const configPath = path.join(canonicalTempRoot, "electron-builder.cjs");
    const outputPath = path.join(canonicalTempRoot, "output");
    builderCachePath = path.join(canonicalTempRoot, "builder-cache");
    const harnessPath = path.join(canonicalTempRoot, "harness");
    const userDataPath = path.join(canonicalTempRoot, "user-data");
    fs.mkdirSync(harnessPath);
    fs.mkdirSync(userDataPath);
    fs.writeFileSync(path.join(harnessPath, "package.json"), JSON.stringify({
      name: "clipnest-t04-postscan-asar-harness",
      private: true,
      main: "main.cjs",
    }, null, 2) + "\n", { flag: "wx" });
    fs.writeFileSync(path.join(harnessPath, "main.cjs"), [
      '"use strict";',
      'const { app } = require("electron");',
      'if (!process.env.CLIPNEST_T04_USER_DATA_DIR || !process.env.CLIPNEST_T04_TEST_SCRIPT) {',
      '  throw new Error("isolated T04 harness environment is required");',
      '}',
      'app.setPath("userData", process.env.CLIPNEST_T04_USER_DATA_DIR);',
      'require(process.env.CLIPNEST_T04_TEST_SCRIPT);',
      "",
    ].join("\n"), { flag: "wx" });

    const packageJson = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));
    electronDistPath = locateElectronDist(packageJson.devDependencies && packageJson.devDependencies.electron);
    const configSource = [
      '"use strict";',
      'const path = require("node:path");',
      "const repository = " + JSON.stringify(REPOSITORY_ROOT) + ";",
      "const output = " + JSON.stringify(outputPath) + ";",
      "const electronDist = " + JSON.stringify(electronDistPath) + ";",
      'const packageJson = require(path.join(repository, "package.json"));',
      "module.exports = {",
      "  ...packageJson.build,",
      "  asar: true,",
      '  asarUnpack: [...(packageJson.build.asarUnpack || []), "**/*.node"],',
      "  directories: { ...packageJson.build.directories, output },",
      "  electronDist,",
      "  npmRebuild: false,",
      "  publish: [],",
      '  win: { ...packageJson.build.win, signAndEditExecutable: false, target: [{ target: "dir", arch: ["x64"] }] },',
      "};",
      "",
    ].join("\n");
    fs.writeFileSync(configPath, configSource, { flag: "wx" });

    evidence.temporaryWorkspace = {
      root: canonicalTempRoot,
      uniqueRoot: true,
      realPathVerified: true,
      ownerMarker: path.basename(markerPath),
      cleanup: "pending",
    };
    evidence.build.configurationPath = configPath;
    evidence.build.outputDirectory = outputPath;
    evidence.build.builderCachePath = builderCachePath;
    evidence.build.configuration = {
      target: "Windows x64 dir",
      asar: true,
      npmRebuild: false,
      signAndEditExecutable: false,
      publish: [],
      nsisTargetConfigured: false,
      packageInstallPerformed: false,
    };

    reportStage("build current main and renderer outputs: pnpm build");
    const build = runCommand("pnpm build", "pnpm", ["build"], {
      cwd: REPOSITORY_ROOT,
      env: cleanElectronEnvironment(),
      timeoutMs: BUILDER_TIMEOUT_MS,
      shell: true,
    });
    buildSteps.push(build);
    evidence.build.sourceBuild = build;
    assert.equal(build.exitCode, 0, "pnpm build failed: " + (build.error || build.stderr));

    const packageArgs = ["exec", "electron-builder", "--win", "dir", "--x64", "--publish", "never",
      "--config", configPath];
    const packageEnv = cleanElectronEnvironment();
    packageEnv.ELECTRON_BUILDER_CACHE = builderCachePath;
    reportStage("package unsigned ASAR-only Windows x64 dir target");
    const packaged = runCommand(
      "pnpm exec electron-builder --win dir --x64 --publish never --config <unique-temp-root>/electron-builder.cjs",
      "pnpm", packageArgs, {
        cwd: REPOSITORY_ROOT,
        env: packageEnv,
        timeoutMs: BUILDER_TIMEOUT_MS,
        shell: true,
      });
    buildSteps.push(packaged);
    evidence.build.package = packaged;
    assert.equal(packaged.exitCode, 0, "electron-builder failed: " + (packaged.error || packaged.stderr));

    asarPath = path.join(outputPath, "win-unpacked", "resources", "app.asar");
    reportStage("verify packaged production entries against current build");
    assert.ok(fs.existsSync(asarPath), "the isolated dir package must contain resources/app.asar");
    assert.ok(fs.statSync(asarPath).isFile(), "app.asar must be a regular file");
    asarSha256 = sha256(fs.readFileSync(asarPath));
    const asar = loadAsarModule();
    packageIntegrity = verifyAsarContents(asar, asarPath, packageJson);
    evidence.package = {
      target: "Windows x64 dir package; no installer target",
      packageVersion: packageIntegrity.packageManifest.version,
      asarPath,
      asarBytes: fs.statSync(asarPath).size,
      asarSha256,
      workerLoadedFromAsar: true,
      byteExactProductionEntries: packageIntegrity.entries,
      dependenciesMatchRepository: packageIntegrity.dependenciesMatch,
      installPerformed: false,
      published: false,
      asarRetainedAfterRun: false,
    };

    const electronPath = path.join(electronDistPath, "electron.exe");
    assert.ok(fs.existsSync(electronPath), "the pinned local Electron executable must exist");
    const electronEnv = cleanElectronEnvironment();
    electronEnv.CLIPNEST_ASAR_PATH = asarPath;
    electronEnv.CLIPNEST_T04_USER_DATA_DIR = userDataPath;
    electronEnv.CLIPNEST_T04_TEMP_ROOT = canonicalTempRoot;
    electronEnv.CLIPNEST_T04_TEST_SCRIPT = __filename;
    electronEnv.CLIPNEST_T04_POSTSCAN_ASAR_RUN = "1";
    reportStage("launch isolated Electron harness and ASAR utilityProcess fixture");
    electronResult = runCommand("Electron isolated ASAR utilityProcess smoke", electronPath, [harnessPath], {
      cwd: REPOSITORY_ROOT,
      env: electronEnv,
      timeoutMs: ELECTRON_TIMEOUT_MS,
      shell: false,
    });
    evidence.smoke.launch = electronResult;
    assert.equal(electronResult.exitCode, 0,
      "packaged Electron smoke failed: " + (electronResult.error || electronResult.stderr));
    probeReport = parseProbeReport(electronResult.stdout);
    assert.equal(probeReport.workerLoadedFromAsar, true);
    assert.deepEqual(probeReport.utilityProcessResponseTypes, { decoded_chunk: 62, decoded_end: 1 });
    assert.deepEqual(probeReport.workerExit, { code: 0, signal: null });
    evidence.smoke.result = probeReport;
    evidence.result = "PASS_SYNTHETIC_CURRENT_ASAR_UTILITY_PROCESS_SMOKE";
  } catch (error) {
    evidence.result = "FAIL_OR_BLOCKED";
    evidence.failure = {
      message: String(error && (error.stack || error.message) || error).slice(0, 12000),
      failedStep: inferFailedStep(buildSteps, electronResult, asarPath),
    };
  } finally {
    reportStage("verify owned temporary root and clean generated package");
    if (tempRootCreated && tempRoot) {
      evidence.temporaryWorkspace = evidence.temporaryWorkspace || { root: tempRoot };
      const cleanup = removeOwnedTempRoot(tempRoot, ownerToken);
      evidence.temporaryWorkspace.cleanup = cleanup;
      if (!cleanup.removed) {
        evidence.package = evidence.package || {};
        evidence.package.asarRetainedAfterRun = Boolean(asarPath && fs.existsSync(asarPath));
        evidence.package.retainedPath = evidence.package.asarRetainedAfterRun ? asarPath : null;
        evidence.limitations.push("The unique temporary package root could not be removed after the exact-path and ownership checks; see temporaryWorkspace.cleanup.");
      }
    } else {
      evidence.temporaryWorkspace = { cleanup: { attempted: false, reason: "temporary root was not created" } };
    }

    evidence.source = gatherSourceIdentity();
    evidence.environment.pnpmVersion = discoverPnpmVersion();
    evidence.environment.electronVersion = process.versions.electron || packageJsonElectronVersion();
    evidence.execution = {
      command: "node tests/tasks/T04/run-image-postscan-asar-electron.cjs",
      packageCommand: "pnpm exec electron-builder --win dir --x64 --publish never --config <unique-temp-root>/electron-builder.cjs",
      pnpmBuildExitCode: evidence.build.sourceBuild ? evidence.build.sourceBuild.exitCode : null,
      packageExitCode: evidence.build.package ? evidence.build.package.exitCode : null,
      electronSmokeExitCode: evidence.smoke.launch ? evidence.smoke.launch.exitCode : null,
      output: evidence.smoke.launch ? evidence.smoke.launch.stdout.trim().slice(-8000) : "",
      errorOutput: evidence.smoke.launch ? evidence.smoke.launch.stderr.trim().slice(-8000) : "",
      stageLog,
    };
    try {
      fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + "\n", { flag: "w" });
      process.stdout.write(evidence.result + ": " + EVIDENCE_PATH + "\n");
      if (evidence.result === "PASS_SYNTHETIC_CURRENT_ASAR_UTILITY_PROCESS_SMOKE") {
        process.stdout.write("ASAR sha256=" + asarSha256 +
          "; 16MP post-scan APP1/1MiB COM; 62 chunks + decoded_end; worker exit code 0.\n");
      } else {
        process.stderr.write("Failure evidence: " + (evidence.failure ? evidence.failure.message : "unknown") + "\n");
      }
    } catch (writeError) {
      process.stderr.write("Could not write evidence " + EVIDENCE_PATH + ": " + (writeError.stack || writeError) + "\n");
      process.exitCode = 1;
    }
  }

  if (evidence.result !== "PASS_SYNTHETIC_CURRENT_ASAR_UTILITY_PROCESS_SMOKE") {
    process.exitCode = 1;
  }
}

async function runPackagedProbe() {
  const { app, BrowserWindow } = require("electron");
  const asarPath = process.env.CLIPNEST_ASAR_PATH;
  const userDataPath = process.env.CLIPNEST_T04_USER_DATA_DIR;
  const tempRoot = process.env.CLIPNEST_T04_TEMP_ROOT;
  const controller = new AbortController();
  let worker = null;
  let child = null;
  let childExit = null;
  let childExitPromise = null;
  let timedOut = false;
  let workerStopped = false;
  let watchdog = null;
  let exitCode = 0;
  let probe = null;

  try {
    await app.whenReady();
    assert.equal(process.env.CLIPNEST_T04_POSTSCAN_ASAR_RUN, "1");
    assert.ok(asarPath && path.isAbsolute(asarPath), "absolute app.asar path is required");
    assert.ok(tempRoot && path.isAbsolute(tempRoot), "absolute isolated temp root is required");
    assert.equal(fs.realpathSync(tempRoot).toLowerCase(), path.resolve(tempRoot).toLowerCase(),
      "temp root must resolve to its exact path");
    assert.equal(fs.realpathSync(asarPath).toLowerCase(), path.resolve(asarPath).toLowerCase(),
      "app.asar must resolve to its exact path");
    assert.equal(path.resolve(app.getPath("userData")).toLowerCase(), path.resolve(userDataPath).toLowerCase(),
      "Electron userData must be isolated inside the unique temp root");
    assert.equal(path.relative(tempRoot, userDataPath).startsWith(".."), false,
      "isolated userData must remain under the unique temp root");
    assert.equal(BrowserWindow.getAllWindows().length, 0, "the isolated harness must create no BrowserWindow");

    const packagedRequire = createRequire(path.join(asarPath, "package.json"));
    const workerModulePath = packagedRequire.resolve("./dist-electron/main/clipboard/image-worker.js");
    assert.ok(workerModulePath.toLowerCase().includes("app.asar"), "the image worker must resolve from app.asar");
    const { createUtilityProcessImageWorker } = packagedRequire("./dist-electron/main/clipboard/image-worker.js");
    const packageVersion = packagedRequire("./package.json").version;
    worker = createUtilityProcessImageWorker();
    const stages = [];
    const encoded = appendPostScanMetadata(grayscaleBaselineJpeg(WIDTH, HEIGHT));
    assert.ok(encoded.length < 20 * 1024 * 1024, "compressed fixture must fit the 20 MiB source limit");
    assert.ok(encoded.length + WIDTH * HEIGHT * 4 <= 256 * 1024 * 1024,
      "worker request envelope must remain within the 256 MiB input-plus-output bound");

    watchdog = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("image_worker_timeout"));
    }, 60_000);
    const startedAt = process.hrtime.bigint();
    const resultPromise = worker.decode({
      jobId: REQUEST_ID,
      format: "jpeg",
      encodedBytes: Uint8Array.from(encoded),
      width: WIDTH,
      height: HEIGHT,
    }, controller.signal, (stage, elapsedMs) => stages.push({ stage, elapsedMs }));
    child = worker.child;
    assert.ok(child, "the ASAR-loaded production worker must start as a real utilityProcess");
    childExitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        childExit = { code, signal: signal || null };
        resolve(childExit);
      });
    });
    const chunks = [];
    let decodedEndCount = 0;
    let decodedEnd = null;
    let decodedChunkFields = null;
    let decodedEndFields = null;
    child.on("message", (message) => {
      if (!message || message.requestId !== REQUEST_ID) return;
      if (message.type === "decoded_chunk") {
        decodedChunkFields = decodedChunkFields || Object.keys(message).sort();
        chunks.push({ seq: message.seq,
          byteLength: message.pixels ? message.pixels.byteLength : 0 });
      }
      if (message.type === "decoded_end") {
        decodedEndCount++;
        decodedEndFields = decodedEndFields || Object.keys(message).sort();
        decodedEnd = {
          width: message.width,
          height: message.height,
          chunkCount: message.chunkCount,
          byteLength: message.byteLength,
        };
      }
    });

    const result = await resultPromise;
    const requestToResponseMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    assert.deepEqual([result.width, result.height, result.pixels.byteLength], [WIDTH, HEIGHT, WIDTH * HEIGHT * 4]);
    let mismatchOffset = -1;
    for (let offset = 0; offset < result.pixels.length; offset += 4) {
      if (result.pixels[offset] !== 128 || result.pixels[offset + 1] !== 128 ||
          result.pixels[offset + 2] !== 128 || result.pixels[offset + 3] !== 255) {
        mismatchOffset = offset;
        break;
      }
    }
    assert.equal(mismatchOffset, -1, "every output pixel must be opaque neutral gray");
    const expectedChunkCount = Math.ceil(result.pixels.byteLength / CHUNK_BYTES);
    assert.equal(expectedChunkCount, 62);
    assert.equal(chunks.length, expectedChunkCount, "the ASAR worker must return 62 bounded chunks");
    assert.deepEqual(chunks.map((chunk) => chunk.seq),
      Array.from({ length: expectedChunkCount }, (_, index) => index),
      "chunk sequence must be complete and ordered");
    assert.ok(chunks.every((chunk) => chunk.byteLength > 0 && chunk.byteLength <= CHUNK_BYTES),
      "each returned chunk must be bounded");
    assert.equal(decodedEndCount, 1, "the ASAR worker must emit exactly one decoded_end");
    assert.deepEqual(decodedEnd, {
      width: WIDTH,
      height: HEIGHT,
      chunkCount: expectedChunkCount,
      byteLength: WIDTH * HEIGHT * 4,
    });
    const stageNames = stages.map((entry) => entry.stage);
    const preflightIndex = stageNames.indexOf("jpegPreflightParseMs");
    const planIndex = stageNames.indexOf("jpegStreamPlanParseMs");
    const decodeIndex = stageNames.indexOf("jpegHuffmanIdctWriteMs");
    assert.ok(preflightIndex >= 0 && preflightIndex < planIndex && planIndex < decodeIndex,
      "ASAR JPEG stage sequence must prove streaming; got " + stageNames.join(","));
    assert.ok(stageNames.includes("workerChunkSendAckMs"), "worker chunk/ACK timing must complete");
    assert.ok(stageNames.includes("mainChunkAssemblyMs"), "main chunk assembly timing must complete");
    assert.equal(BrowserWindow.getAllWindows().length, 0, "the packaged smoke must leave windows closed");

    await stopWorkerWithin(worker, child, childExitPromise, 10_000);
    workerStopped = true;
    assert.deepEqual(childExit, { code: 0, signal: null }, "ASAR utilityProcess must exit normally");
    probe = {
      electronVersion: process.versions.electron,
      packageVersion,
      workerModulePath,
      workerLoadedFromAsar: true,
      fixture: {
        format: "8-bit SOF0 grayscale JPEG",
        dimensions: WIDTH + "x" + HEIGHT,
        pixels: WIDTH * HEIGHT,
        sourceBytes: encoded.length,
        postScanApp1Segments: 1,
        app1PayloadContainsEoiBytes: true,
        comPayloadBytes: COM_PAYLOAD_BYTES,
        comSegmentCount: 17,
        repeatedMarkerFillBytes: true,
      },
      output: { rgbaBytes: result.pixels.byteLength, allPixelsOpaqueNeutralGray: true },
      utilityProcessResponseTypes: { decoded_chunk: chunks.length, decoded_end: decodedEndCount },
      observedMessageFields: {
        decoded_chunk: decodedChunkFields,
        decoded_end: decodedEndFields,
      },
      chunkSequence: {
        first: chunks[0].seq,
        last: chunks[chunks.length - 1].seq,
        count: chunks.length,
        maxChunkBytes: Math.max(...chunks.map((chunk) => chunk.byteLength)),
      },
      decodedEnd,
      stages,
      requestToResponseMs: Number(requestToResponseMs.toFixed(2)),
      workerPid: child.pid,
      workerExit: childExit,
      browserWindowCount: BrowserWindow.getAllWindows().length,
      systemClipboardReadOrWritten: false,
      nativeHelperRun: false,
      physicalInputSent: false,
    };
  } catch (error) {
    process.stderr.write((error.stack || error) + "\n");
    exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    if (worker && !workerStopped) {
      try {
        if (child && childExitPromise) {
          await stopWorkerWithin(worker, child, childExitPromise, 10_000);
        } else {
          await worker.dispose();
        }
      } catch (error) {
        process.stderr.write("worker cleanup failed: " + (error.stack || error) + "\n");
        exitCode = 1;
      }
    }
    if (timedOut) exitCode = 1;
    if (probe) process.stdout.write("T04_POSTSCAN_ASAR_RESULT " + JSON.stringify(probe) + "\n");
    app.exit(exitCode);
  }
}

function verifyAsarContents(asar, archivePath, repositoryPackage) {
  const files = [
    "dist-electron/main/clipboard/image-worker.js",
    "dist-electron/main/clipboard/image-decoder.js",
    "dist-electron/main/clipboard/jpeg-baseline-stream.js",
    "node_modules/jpeg-js/index.js",
  ];
  const entries = files.map((relativePath) => {
    const localBytes = fs.readFileSync(path.join(REPOSITORY_ROOT, ...relativePath.split("/")));
    const packedBytes = asar.extractFile(archivePath, relativePath.replaceAll("/", "\\"));
    assert.ok(localBytes.equals(packedBytes),
      relativePath + " in ASAR must match the current build byte-for-byte");
    return { path: relativePath, bytes: localBytes.length, sha256: sha256(localBytes), exactMatch: true };
  });
  const packageManifest = JSON.parse(asar.extractFile(archivePath, "package.json").toString("utf8"));
  const dependenciesMatch = JSON.stringify(packageManifest.dependencies) ===
    JSON.stringify(repositoryPackage.dependencies);
  assert.ok(dependenciesMatch, "packaged dependencies must match package.json");
  return { entries, dependenciesMatch, packageManifest };
}

function loadAsarModule() {
  try {
    return require(require.resolve("@electron/asar", { paths: [REPOSITORY_ROOT] }));
  } catch {
    const pnpmRoot = path.join(REPOSITORY_ROOT, "node_modules/.pnpm");
    const packageDirectory = fs.readdirSync(pnpmRoot).find((entry) => entry.startsWith("@electron+asar@"));
    assert.ok(packageDirectory, "installed @electron/asar is required; this runner does not install packages");
    return require(path.join(pnpmRoot, packageDirectory, "node_modules/@electron/asar"));
  }
}

function locateElectronDist(version) {
  assert.ok(typeof version === "string" && version.length > 0, "package.json must pin Electron");
  const pnpmRoot = path.join(REPOSITORY_ROOT, "node_modules/.pnpm");
  const prefix = "electron@" + version;
  const candidates = fs.readdirSync(pnpmRoot).filter((entry) => entry.startsWith(prefix));
  for (const candidate of candidates) {
    const distPath = path.join(pnpmRoot, candidate, "node_modules/electron/dist");
    if (fs.existsSync(path.join(distPath, "electron.exe"))) return distPath;
  }
  throw new Error("installed Electron " + version + " distribution was not found under node_modules/.pnpm");
}

function parseProbeReport(stdout) {
  const prefix = "T04_POSTSCAN_ASAR_RESULT ";
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  assert.ok(line, "packaged Electron process must emit its structured result");
  return JSON.parse(line.slice(prefix.length));
}

function runCommand(label, executable, args, options) {
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: 12 * 1024 * 1024,
    windowsHide: true,
    shell: options.shell,
  });
  return {
    label,
    executable,
    args: args.map((arg) => String(arg).replaceAll(REPOSITORY_ROOT, "<repository>")),
    exitCode: result.status,
    signal: result.signal,
    error: result.error ? String(result.error.message || result.error) : null,
    durationMs: Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(2)),
    stdout: (result.stdout || "").slice(-16_000),
    stderr: (result.stderr || "").slice(-16_000),
  };
}

function cleanElectronEnvironment() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_OVERRIDE_DIST_PATH;
  delete env.CLIPNEST_ASAR_PATH;
  delete env.CLIPNEST_T04_USER_DATA_DIR;
  delete env.CLIPNEST_T04_TEMP_ROOT;
  delete env.CLIPNEST_T04_TEST_SCRIPT;
  delete env.CLIPNEST_T04_POSTSCAN_ASAR_RUN;
  return env;
}

function assertFreshTempRoot(root, canonicalParent) {
  const canonicalRoot = fs.realpathSync(root);
  const stat = fs.lstatSync(root);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "new temp root must be a real directory");
  assert.equal(path.dirname(canonicalRoot).toLowerCase(), canonicalParent.toLowerCase(),
    "new temp root must be a direct child of the designated temp parent");
  assert.ok(path.basename(canonicalRoot).startsWith(ROOT_PREFIX), "temp root must use the unique T04 prefix");
}

function removeOwnedTempRoot(root, ownerToken) {
  const outcome = { attempted: true, removed: false, verifiedRealPath: false, reason: null };
  try {
    const canonicalParent = fs.realpathSync(TEMP_PARENT);
    const canonicalRoot = fs.realpathSync(root);
    if (canonicalRoot.toLowerCase() !== path.resolve(root).toLowerCase()) {
      throw new Error("refusing cleanup: temp root realpath differs from its created absolute path");
    }
    if (path.dirname(canonicalRoot).toLowerCase() !== canonicalParent.toLowerCase() ||
        !path.basename(canonicalRoot).startsWith(ROOT_PREFIX)) {
      throw new Error("refusing cleanup: temp root is outside the designated direct-child namespace");
    }
    const markerPath = path.join(canonicalRoot, ".t04-owned-by-runner.json");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (marker.ownerToken !== ownerToken) throw new Error("refusing cleanup: owner marker does not match this run");
    outcome.verifiedRealPath = true;
    fs.rmSync(canonicalRoot, { recursive: true, force: false });
    outcome.removed = !fs.existsSync(canonicalRoot);
    if (!outcome.removed) throw new Error("temp root remains after verified cleanup");
  } catch (error) {
    outcome.reason = String(error && (error.stack || error.message) || error).slice(0, 6000);
  }
  return outcome;
}

async function stopWorkerWithin(worker, child, exitPromise, timeoutMs) {
  try {
    await waitWithin(Promise.all([worker.dispose(), exitPromise]), timeoutMs,
      "utility_process_shutdown_timeout");
  } catch (error) {
    try { child.kill(); } catch { /* bounded fallback */ }
    if (exitPromise) {
      await waitWithin(exitPromise, 2_000, "utility_process_exit_timeout").catch(() => {});
    }
    throw error;
  }
}

function waitWithin(promise, timeoutMs, reason) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function chinaLocalDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return [values.year, values.month, values.day].join("-");
}

function gatherSourceIdentity() {
  const head = runCommand("git rev-parse HEAD", "git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT, env: process.env, timeoutMs: 10_000, shell: false,
  });
  const status = runCommand("git status --porcelain", "git", ["status", "--porcelain"], {
    cwd: REPOSITORY_ROOT, env: process.env, timeoutMs: 10_000, shell: false,
  });
  const branch = runCommand("git branch --show-current", "git", ["branch", "--show-current"], {
    cwd: REPOSITORY_ROOT, env: process.env, timeoutMs: 10_000, shell: false,
  });
  return {
    commit: head.exitCode === 0 ? head.stdout.trim() : null,
    branch: branch.exitCode === 0 ? branch.stdout.trim() || null : null,
    workingTreeWasDirty: status.exitCode !== 0 || status.stdout.trim().length > 0,
    runner: {
      path: path.relative(REPOSITORY_ROOT, __filename).replaceAll("\\", "/"),
      bytes: fs.statSync(__filename).size,
      sha256: sha256(fs.readFileSync(__filename)),
    },
  };
}

function discoverPnpmVersion() {
  const result = runCommand("pnpm --version", "pnpm", ["--version"], {
    cwd: REPOSITORY_ROOT, env: process.env, timeoutMs: 10_000, shell: true,
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

function packageJsonElectronVersion() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));
    return packageJson.devDependencies && packageJson.devDependencies.electron || null;
  } catch {
    return null;
  }
}

function inferFailedStep(buildSteps, electronResult, archivePath) {
  if (buildSteps.length === 0) return "preflight_or_temp_setup";
  if (buildSteps[0].exitCode !== 0) return "pnpm_build";
  if (buildSteps[1] && buildSteps[1].exitCode !== 0) return "electron_builder_dir_package";
  if (!archivePath || !fs.existsSync(archivePath)) return "asar_presence_or_integrity";
  if (!electronResult || electronResult.exitCode !== 0) return "packaged_electron_utility_process_smoke";
  return "result_assertion_or_evidence";
}

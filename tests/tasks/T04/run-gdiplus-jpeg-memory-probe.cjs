// Test-only Windows GDI+ route probe. Generates deterministic JPEGs locally,
// then decodes each in a fresh PowerShell child using a System32-only GDI+ load.
// It does not create a BrowserWindow or touch the system clipboard/input.
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../../..");
const WIDTH = 4000;
const HEIGHT = 4000;
const PIXELS = WIDTH * HEIGHT;
const SOURCE_LIMIT_BYTES = 20 * 1024 * 1024;
const SAMPLE_COUNT = Math.min(5, Math.max(1, Math.trunc(Number(process.env.T04_GDIPLUS_SAMPLE_COUNT) || 5)));
const CHILD_SCRIPT = path.join(__dirname, "gdiplus-jpeg-memory-child.ps1");
const FIXTURE_SCRIPT = path.join(__dirname, "gdiplus-jpeg-fixture.ps1");
const EVIDENCE_PATH = path.join(ROOT, "docs", "evidence", "T04", "gdiplus-jpeg-memory-route-probe.json");
const MAX_WORKING_SET_BYTES = 256 * 1024 * 1024;

runProbe().then((passed) => { process.exitCode = passed ? 0 : 1; }, (error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});

async function runProbe() {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");

  const tempRoot = path.resolve(os.tmpdir());
  const tempDirectory = path.resolve(tempRoot, `clipnest-t04-gdiplus-${process.pid}-${Date.now()}`);
  if (path.dirname(tempDirectory).toLowerCase() !== tempRoot.toLowerCase()
      || !path.basename(tempDirectory).startsWith(`clipnest-t04-gdiplus-${process.pid}-`)) {
    throw new Error("generated_fixture_directory_outside_expected_temp_root");
  }
  fs.mkdirSync(tempDirectory, { recursive: false });

  const rows = [];
  const fixtureRows = [];
  let failure = null;
  try {
    const fixtures = createFixtures(tempDirectory);
    for (const fixture of fixtures) {
      const fixturePath = path.join(tempDirectory, `${fixture.subsampling}.jpg`);
      fs.writeFileSync(fixturePath, fixture.bytes, { flag: "wx" });
      fixtureRows.push({
        subsampling: fixture.subsampling,
        width: WIDTH,
        height: HEIGHT,
        pixelCount: PIXELS,
        encodedBytes: fixture.bytes.byteLength,
        sourceLimitBytes: SOURCE_LIMIT_BYTES,
        sourceLimitHeadroomBytes: SOURCE_LIMIT_BYTES - fixture.bytes.byteLength,
        encoder: fixture.encoder,
        quality: fixture.quality,
        samplingFactors: fixture.samplingFactors,
        jpegSha256: createHash("sha256").update(fixture.bytes).digest("hex"),
        deterministicOracle: "R=32+floor(x*80/width), G=96+floor(y*80/height), B=48+floor((x+y)*80/(width+height)), A=255",
        app2PaddingBytes: fixture.app2PaddingBytes,
      });

      for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex += 1) {
        const run = await runPowerShellChild(fixturePath);
        const sample = {
          subsampling: fixture.subsampling,
          sampleIndex: sampleIndex + 1,
          launchToExitMs: round(run.elapsedMs),
          childPid: run.pid,
          processExitCode: run.exitCode,
          processSignal: run.signal,
          processExitedAndReaped: run.closed,
          timedOut: run.timedOut,
          stdoutJsonParsed: run.childResult !== null,
          stderr: run.stderr.trim() || null,
          child: run.childResult,
        };
        rows.push(sample);
        const valid = run.exitCode === 0 && run.closed && !run.timedOut
          && run.childResult?.result === "PASS"
          && run.childResult?.loaderFlag === "LOAD_LIBRARY_SEARCH_SYSTEM32 (0x00000800)"
          && run.childResult?.decodedPixelCountVerified === PIXELS
          && run.childResult?.gdiplusModulePath?.toLowerCase().endsWith("\\system32\\gdiplus.dll")
          && run.childResult?.peakWorkingSetBytes > 0;
        if (!valid) {
          failure = {
            stage: "isolated_gdiplus_child",
            subsampling: fixture.subsampling,
            sampleIndex: sampleIndex + 1,
            result: run.childResult?.result ?? "NO_STRUCTURED_RESULT",
            failureStage: run.childResult?.failureStage ?? null,
            failure: run.childResult?.failure ?? (run.stderr.trim() || "child failed without diagnostic text"),
          };
          break;
        }
      }
      if (failure) break;
    }
  } catch (error) {
    failure = { stage: "fixture_or_runner", error: `${error.name}:${error.message}` };
  } finally {
    // The directory is generated under the OS temp root and checked above;
    // remove only the two known fixture files and then the empty directory.
    for (const subsampling of ["420", "444"]) {
      const fixturePath = path.resolve(tempDirectory, `${subsampling}.jpg`);
      if (path.dirname(fixturePath).toLowerCase() === tempDirectory.toLowerCase() && fs.existsSync(fixturePath)) {
        fs.unlinkSync(fixturePath);
      }
    }
    if (fs.existsSync(tempDirectory) && fs.readdirSync(tempDirectory).length === 0) fs.rmdirSync(tempDirectory);
  }

  const allPassed = fixtureRows.length === 2 && rows.length === fixtureRows.length * SAMPLE_COUNT
    && rows.every((row) => row.processExitCode === 0 && row.processExitedAndReaped
      && row.child?.result === "PASS" && row.child?.decodedPixelCountVerified === PIXELS);
  const withinTarget = allPassed && rows.every((row) => row.child.peakWorkingSetBytes <= MAX_WORKING_SET_BYTES);
  const uniquePids = new Set(rows.map((row) => row.childPid).filter((pid) => Number.isInteger(pid)));
  const evidence = {
    schemaVersion: 1,
    task: "T04",
    recordType: "test_only_windows_gdiplus_jpeg_memory_route_probe",
    checkedDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date()),
    result: allPassed
      ? (withinTarget ? "FEASIBILITY_PASS_WITH_LIMITATIONS" : "FEASIBLE_BUT_ABOVE_T04_MEMORY_TARGET")
      : "PROBE_FAILED_WITH_LIMITATIONS",
    source: {
      commit: gitValue("rev-parse", "HEAD"),
      branch: gitValue("branch", "--show-current"),
      workingTreeWasDirty: gitValue("status", "--short").length > 0,
      runnerSha256: sha256File(__filename),
        childScriptSha256: sha256File(CHILD_SCRIPT),
        fixtureScriptSha256: sha256File(FIXTURE_SCRIPT),
    },
    environment: {
      platform: process.platform,
      architecture: process.arch,
      osVersion: os.version(),
      nodeVersion: process.versions.node,
      cpuModel: os.cpus()[0]?.model ?? null,
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      browserWindowCreated: false,
      systemClipboardReadOrWritten: false,
      physicalInputSent: false,
      childRuntime: "Windows PowerShell test child process, C# P/Invoke bindings compiled in-memory with Add-Type",
      sampleCountPerSubsampling: SAMPLE_COUNT,
    },
    scope: {
      gdiPlusLoadedBy: "LoadLibraryExW(\"gdiplus.dll\", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32)",
      actualModulePathCheckedWith: "GetModuleFileNameW(handle)",
      requiredModulePath: "Environment.SpecialFolder.System\\gdiplus.dll (System32 on the required x64 host)",
      imageTransport: "attempted CreateStreamOnHGlobal-backed IStream, GdipLoadImageFromStream and full 4000x4000 GdipBitmapLockBits only after the exact System32 module-path check; the check rejected this host's WinSxS resolution first",
      processIsolation: "one new Windows PowerShell test process per attempted decode; parent waits for the child close event before continuing",
      memoryMetrics: "child Process.WorkingSet64 before/after, PeakWorkingSet64, PrivateMemorySize64 and PeakPagedMemorySize64; a path-gate failure sample measures process initialization only, not image decoding",
      independentOracle: "recompute expected smooth RGB gradients in C# from x/y; compare every decoded pixel, all alpha bytes and aggregate/max channel error",
      oracleThresholds: { maxChannelAbsoluteError: 24, meanRgbAbsoluteError: 3.0, alphaMismatchCount: 0 },
      memoryTargetBytes: MAX_WORKING_SET_BYTES,
    },
    fixtures: fixtureRows,
    samples: rows,
    processRecycling: {
      childCount: rows.length,
      uniqueChildPidCount: uniquePids.size,
      everyChildExitedAndWasReaped: rows.length > 0 && rows.every((row) => row.processExitedAndReaped),
      noChildPidWasReusedWithinRun: uniquePids.size === rows.length,
    },
    failure,
    limitations: [
      "This is an isolated decoder feasibility probe; it does not add GDI+ to the production ffi-rs allowlist or integrate an image worker route.",
      "The fixtures are deterministic smooth synthetic images with APP2 padding, not user images; progressive JPEG, EXIF/ICC handling, malformed inputs, other content, packaging/ASAR behavior and cancellation are not covered.",
      "This child process is not Electron utilityProcess. The probe reached a Windows PowerShell test child, but the path gate halted before GDI+ startup, memory-stream use, LockBits, pixel validation, or an image decode; packaged Electron worker compatibility is not measured.",
      "Windows accepted LoadLibraryExW with LOAD_LIBRARY_SEARCH_SYSTEM32, then GetModuleFileNameW reported the actual module under the protected WinSxS component store rather than the required System32 path. The strict check stopped before resolving or invoking any GDI+ export. Recorded child memory is process startup and path-check overhead only.",
      "No decoder peak or full-pixel result was measured; the single child working-set peak is not an image-decode measurement. T04 memory feasibility and acceptance remain unverified.",
      "No system clipboard, target window, physical input, user data or visible app window was used. T04 acceptance, P15, JPEG production-route support and later T05 gates remain open.",
    ],
  };
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    evidencePath: EVIDENCE_PATH,
    result: evidence.result,
    fixtureCount: fixtureRows.length,
    sampleCount: rows.length,
    processRecycle: evidence.processRecycling,
    peakWorkingSetBytes: rows.map((row) => row.child?.peakWorkingSetBytes ?? null),
    decodeAndFullScanMs: rows.map((row) => row.child?.decodeAndFullScanMs ?? null),
    failure,
  })}\n`);
  return allPassed;
}

function createFixtures(tempDirectory) {
  const rgba = Buffer.allocUnsafe(PIXELS * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 4;
      rgba[offset] = expectedR(x);
      rgba[offset + 1] = expectedG(y);
      rgba[offset + 2] = expectedB(x, y);
      rgba[offset + 3] = 0xff;
    }
  }

  const fourTwoZeroBasePath = path.join(tempDirectory, "420-base.jpg");
  const fixtureResult = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File", FIXTURE_SCRIPT,
    "-OutputPath", fourTwoZeroBasePath, "-Width", String(WIDTH), "-Height", String(HEIGHT),
  ], { cwd: ROOT, encoding: "utf8", timeout: 180_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  if (fixtureResult.error) throw fixtureResult.error;
  if (fixtureResult.status !== 0 || !fs.existsSync(fourTwoZeroBasePath)) {
    throw new Error(`synthetic_420_fixture_generation_failed:${fixtureResult.stderr.trim() || fixtureResult.stdout.trim()}`);
  }
  const fourTwoZeroJpeg = fs.readFileSync(fourTwoZeroBasePath);
  fs.unlinkSync(fourTwoZeroBasePath);
  const fourFourFourJpeg = Buffer.from(require("jpeg-js").encode({ width: WIDTH, height: HEIGHT, data: rgba }, 96).data);
  const candidates = [
    { subsampling: "420", encoder: "Windows System.Drawing JPEG encoder", quality: 96, bytes: fourTwoZeroJpeg, expected: [[2, 2], [1, 1], [1, 1]] },
    { subsampling: "444", encoder: "pinned jpeg-js 0.4.4 encoder", quality: 96, bytes: fourFourFourJpeg, expected: [[1, 1], [1, 1], [1, 1]] },
  ];
  const fixtures = candidates.map((candidate) => {
    const samplingFactors = readJpegSamplingFactors(candidate.bytes);
    assert.deepEqual(samplingFactors.map(({ horizontal, vertical }) => [horizontal, vertical]), candidate.expected,
      `${candidate.subsampling} JPEG sampling factors must match the fixture name`);
    const padded = padWithApp2ToLimit(candidate.bytes);
    return { ...candidate, bytes: padded.bytes, samplingFactors, app2PaddingBytes: padded.app2PaddingBytes };
  });
  rgba.fill(0);
  return fixtures;
}

function padWithApp2ToLimit(encoded) {
  if (encoded.length >= SOURCE_LIMIT_BYTES) throw new Error("base_jpeg_reaches_encoded_source_limit");
  const paddingBytes = SOURCE_LIMIT_BYTES - encoded.length;
  const segments = [];
  let remaining = paddingBytes;
  while (remaining > 0) {
    const segmentBytes = Math.min(65_536, remaining);
    if (segmentBytes < 4) throw new Error("jpeg_app2_padding_cannot_encode_trailing_bytes");
    const segment = Buffer.alloc(segmentBytes);
    segment[0] = 0xff;
    segment[1] = 0xe2;
    segment.writeUInt16BE(segmentBytes - 2, 2);
    segments.push(segment);
    remaining -= segmentBytes;
  }
  return {
    bytes: Buffer.concat([encoded.subarray(0, 2), ...segments, encoded.subarray(2)]),
    app2PaddingBytes: paddingBytes,
  };
}

function readJpegSamplingFactors(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("synthetic_jpeg_soi_missing");
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) throw new Error("synthetic_jpeg_marker_invalid");
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) throw new Error("synthetic_jpeg_segment_length_truncated");
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) throw new Error("synthetic_jpeg_segment_invalid");
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      const componentCount = bytes[offset + 7];
      const samplingFactors = [];
      for (let index = 0; index < componentCount; index += 1) {
        const sampling = bytes[offset + 9 + index * 3];
        samplingFactors.push({ horizontal: sampling >> 4, vertical: sampling & 0x0f });
      }
      if (samplingFactors.length !== 3) throw new Error("synthetic_jpeg_component_count_invalid");
      return samplingFactors;
    }
    offset += segmentLength;
  }
  throw new Error("synthetic_jpeg_sof_missing");
}

function expectedR(x) { return 32 + Math.floor((x * 80) / WIDTH); }
function expectedG(y) { return 96 + Math.floor((y * 80) / HEIGHT); }
function expectedB(x, y) { return 48 + Math.floor(((x + y) * 80) / (WIDTH + HEIGHT)); }

function runPowerShellChild(imagePath) {
  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    const child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-File", CHILD_SCRIPT,
      "-ImagePath", imagePath, "-ExpectedWidth", String(WIDTH), "-ExpectedHeight", String(HEIGHT),
    ], { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* closed before deadline */ }
    }, 180_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ pid: child.pid ?? null, exitCode: null, signal: null, closed: false, timedOut,
        elapsedMs: elapsedSince(startedAt), stdout, stderr: `${stderr}${error.stack ?? error}`, childResult: null });
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ pid: child.pid ?? null, exitCode, signal, closed: true, timedOut,
        elapsedMs: elapsedSince(startedAt), stdout, stderr, childResult: lastJson(stdout) });
    });
  });
}

function lastJson(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* inspect the prior line */ }
  }
  return null;
}

function gitValue(...args) {
  try { return spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }).stdout.trim(); }
  catch { return ""; }
}
function sha256File(file) { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function elapsedSince(startedAt) { return Number(process.hrtime.bigint() - startedAt) / 1_000_000; }
function round(value) { return Math.round(value * 100) / 100; }

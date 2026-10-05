'use strict';

// Candidate-only WPF/WIC JPEG probe. It uses synthetic files and fresh hidden
// Windows PowerShell processes; it never opens a window or touches clipboard/input.
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../..');
const WIDTH = 4000;
const HEIGHT = 4000;
const PIXELS = WIDTH * HEIGHT;
const SOURCE_LIMIT_BYTES = 20 * 1024 * 1024;
const WORKER_LIMIT_BYTES = 256 * 1024 * 1024;
const SAMPLE_COUNT = 5;
const CHILD_TIMEOUT_MS = 180_000;
const CHILD_SCRIPT = path.join(__dirname, 'wic-jpeg-memory-child.ps1');
const FIXTURE_SCRIPT = path.join(__dirname, 'gdiplus-jpeg-fixture.ps1');
const PIXEL_ORACLE_SCRIPT = path.join(__dirname, 'purejsimage-independent-pixel-oracle.ps1');
const EVIDENCE_PATH = path.join(ROOT, 'docs', 'evidence', 'T04', 'wic-jpeg-memory-probe.json');
const SAMPLE_POINTS = [
  { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 16, y: 16 }, { x: 511, y: 511 },
  { x: 1024, y: 1024 }, { x: 1999, y: 1999 }, { x: 2000, y: 2000 },
  { x: 3001, y: 2377 }, { x: 3999, y: 3999 },
];
const FIXTURE_SPECS = [
  { key: '420', expectedSampling: [[2, 2], [1, 1], [1, 1]], encoder: 'Windows System.Drawing JPEG encoder', quality: 96 },
  { key: '444', expectedSampling: [[1, 1], [1, 1], [1, 1]], encoder: 'pinned jpeg-js 0.4.4 encoder', quality: 96 },
];

outerRun().then((code) => { process.exitCode = code; }, (error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});

async function outerRun() {
  assert.equal(process.platform, 'win32', 'requires_windows');
  assert.equal(process.arch, 'x64', 'requires_windows_x64');
  assert.ok(fs.existsSync(FIXTURE_SCRIPT), 'existing_420_fixture_generator_missing');
  assert.ok(fs.existsSync(PIXEL_ORACLE_SCRIPT), 'existing_independent_pixel_oracle_missing');

  const tempRoot = path.resolve(os.tmpdir());
  const tempDirectory = path.resolve(tempRoot, `clipnest-t04-wic-jpeg-${process.pid}-${Date.now()}`);
  if (path.dirname(tempDirectory).toLowerCase() !== tempRoot.toLowerCase()
      || !path.basename(tempDirectory).startsWith(`clipnest-t04-wic-jpeg-${process.pid}-`)) {
    throw new Error('generated_fixture_directory_outside_expected_temp_root');
  }
  fs.mkdirSync(tempDirectory, { recursive: false });

  const startingState = repositoryState();
  const fixtureMetadata = [];
  const gdiOracleMetadata = [];
  const samples = [];
  let failure = null;
  let currentStage = 'generate_synthetic_fixtures';
  let cleanupError = null;
  let temporaryDirectoryCleanup = null;
  try {
    const fixtures = createFixtures(tempDirectory);
    for (const fixture of fixtures) {
      const fixturePath = path.join(tempDirectory, `${fixture.key}.jpg`);
      fs.writeFileSync(fixturePath, fixture.bytes, { flag: 'wx' });
      const gdiOracle = runGdiPlusOracle(fixturePath);
      gdiOracleMetadata.push({ fixtureKey: fixture.key, ...gdiOracle });
      const record = {
        fixtureKey: fixture.key,
        path: `${fixture.key}.jpg`,
        width: WIDTH,
        height: HEIGHT,
        pixelCount: PIXELS,
        encodedBytes: fixture.bytes.byteLength,
        exactSourceLimitBytes: SOURCE_LIMIT_BYTES,
        encoder: fixture.encoder,
        quality: fixture.quality,
        samplingFactors: fixture.samplingFactors,
        sha256: sha256(fixture.bytes),
        app2PaddingBytes: fixture.app2PaddingBytes,
        syntheticOracle: 'R=32+floor(x*80/width), G=96+floor(y*80/height), B=48+floor((x+y)*80/(width+height)), A=255',
      };
      fixtureMetadata.push(record);

      for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex += 1) {
        currentStage = `wic_decode_${fixture.key}_sample_${sampleIndex + 1}`;
        const childRun = await runPowerShellChild(fixturePath);
        const child = childRun.childResult;
        const oracleCompare = child ? compareGdiPoints(child.crossCheckPoints, gdiOracle.samples) : null;
        const row = {
          fixtureKey: fixture.key,
          sampleIndex: sampleIndex + 1,
          childPid: childRun.pid,
          launchToExitMs: round(childRun.elapsedMs),
          processExitCode: childRun.exitCode,
          processSignal: childRun.signal,
          processExitedAndReaped: childRun.closed,
          timedOut: childRun.timedOut,
          stdoutJsonParsed: child !== null,
          stderr: childRun.stderr.trim() || null,
          child,
          independentGdiPointComparison: oracleCompare,
        };
        samples.push(row);
        if (childRun.exitCode !== 0 || !childRun.closed || childRun.timedOut || child?.result !== 'PASS'
            || child?.decodedPixelCount !== PIXELS || !oracleCompare?.withinTolerance) {
          failure ??= {
            stage: currentStage,
            result: child?.result ?? 'NO_STRUCTURED_RESULT',
            failureStage: child?.failureStage ?? null,
            failure: child?.failure ?? (childRun.stderr.trim() || 'child failed without diagnostics'),
            gdiPointComparison: oracleCompare,
          };
        }
      }
    }
  } catch (error) {
    failure ??= { stage: currentStage, error: `${error.name}:${error.message}` };
  } finally {
    try {
      temporaryDirectoryCleanup = removeOnlyOwnedTempDirectory(tempDirectory);
    } catch (error) {
      cleanupError = `${error.name}:${error.message}`;
    }
  }

  const allDecoded = fixtureMetadata.length === FIXTURE_SPECS.length
    && samples.length === fixtureMetadata.length * SAMPLE_COUNT
    && samples.every((row) => row.processExitCode === 0 && row.processExitedAndReaped && !row.timedOut
      && row.child?.result === 'PASS' && row.child?.decodedPixelCount === PIXELS
      && row.independentGdiPointComparison?.withinTolerance);
  const withinTarget = allDecoded
    ? samples.every((row) => row.child.peakWorkingSetBytes <= WORKER_LIMIT_BYTES)
    : null;
  const result = !allDecoded
    ? 'WPF_WIC_PROBE_FAILED_WITH_LIMITATIONS'
    : (withinTarget ? 'WPF_WIC_CANDIDATE_WITHIN_BUDGET_NOT_ACCEPTANCE' : 'WPF_WIC_CANDIDATE_EXCEEDS_BUDGET');
  const evidence = {
    schemaVersion: 1,
    task: 'T04',
    recordType: 'candidate_only_wpf_wic_jpeg_memory_probe',
    checkedDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()),
    result,
    source: {
      ...startingState,
      runnerSha256: sha256File(__filename),
      childScriptSha256: sha256File(CHILD_SCRIPT),
      existing420FixtureScriptSha256: sha256File(FIXTURE_SCRIPT),
      existingGdiPixelOracleScriptSha256: sha256File(PIXEL_ORACLE_SCRIPT),
    },
    environment: {
      hostPlatform: process.platform,
      hostArchitecture: process.arch,
      hostNodeVersion: process.version,
      osVersion: os.version(),
      windowsPowerShellVersions: [...new Set(samples.map((row) => row.child?.windowsPowerShellVersion).filter(Boolean))],
      clrFrameworks: [...new Set(samples.map((row) => row.child?.clrFramework).filter(Boolean))],
      childArchitecture: 'x64',
      childApartment: 'STA',
      presentationCoreLoadedInPreflight: true,
      createdBrowserWindow: false,
      createdWpfWindowOrControl: false,
      systemClipboardReadOrWritten: false,
      physicalOrSyntheticInputSent: false,
      installedApplicationRun: false,
      dependenciesInstalledOrChanged: false,
    },
    scope: {
      decoder: 'System.Windows.Media.Imaging.JpegBitmapDecoder via WPF managed imaging / Windows imaging infrastructure',
      pixelConversion: 'FormatConvertedBitmap to PixelFormats.Bgra32 followed by one full-frame caller-owned byte[] CopyPixels call',
      bitmapCacheOption: 'None; the synthetic MemoryStream remains open until CopyPixels completes',
      processIsolation: 'One fresh hidden Windows PowerShell STA child process per sample; each child is awaited and reaped before continuing.',
      memoryMetrics: 'Absolute child PeakWorkingSet64 and PeakPagedMemorySize64, pre/post working set/private bytes, and 25ms sampled child working-set/private bytes. Peak working set includes PowerShell/.NET/WPF process baseline and is not decoder-only memory.',
      targetBytes: WORKER_LIMIT_BYTES,
      processIsNotElectronUtilityProcess: true,
      outputBufferBytes: PIXELS * 4,
      syntheticOnly: true,
      fixtureFilesWrittenOnlyToOwnUniqueTempDirectory: true,
      temporaryDirectoryCleanup,
      cleanupError,
    },
    fixtures: fixtureMetadata,
    independentGdiPlusOracle: {
      script: 'tests/tasks/T04/purejsimage-independent-pixel-oracle.ps1',
      coordinates: SAMPLE_POINTS,
      maxCrossDecoderChannelDifference: 8,
      fixtures: gdiOracleMetadata,
    },
    measurements: {
      freshChildCount: samples.length,
      sampleCountPerFixture: SAMPLE_COUNT,
      peakWorkingSetBytes: samples.map((row) => row.child?.peakWorkingSetBytes ?? null),
      maxPeakWorkingSetBytes: maxNullable(samples.map((row) => row.child?.peakWorkingSetBytes ?? null)),
      sampledPeakPrivateBytes: samples.map((row) => row.child?.sampledPeakPrivateBytes ?? null),
      decodeCopyAndFullScanMs: samples.map((row) => row.child?.decodeCopyAndFullScanMs ?? null),
      allChildProcessesExitedAndWereReaped: samples.length > 0 && samples.every((row) => row.processExitedAndReaped),
      within256MiBForEverySample: withinTarget,
    },
    samples,
    failure,
    limitations: [
      'This is a WPF managed-imaging candidate probe over Windows imaging infrastructure, not a direct IWIC COM implementation or the production Electron utilityProcess.',
      'PowerShell, CLR, WPF, stream data, and codec state are included in child PeakWorkingSet64; the number is not decoder-only memory. WPF documents no memory ceiling for this path.',
      'The probe copies one synthetic 16 MP baseline JPEG into one full 64,000,000-byte BGRA buffer; this does not test the production worker IPC/deflate/parent-inflate path, helper DIB registration, or final clipboard payload.',
      'Only deterministic synthetic 4:2:0 and 4:4:4 JPEGs padded to the 20 MiB compressed-source cap are covered. Progressive JPEG, CMYK, EXIF/ICC/orientation, malformed corpus, cancellation, timeout, packaged loading, and varied content are not covered.',
      'Even if every sample is below 256 MiB and pixel checks pass, this result only justifies further direct-WIC/utilityProcess evaluation; it cannot close the T04 memory gate, P15, production integration, or T04 acceptance.',
      'No BrowserWindow, WPF control/window, user image, system clipboard, physical keyboard, or input was used.',
    ],
    sources: [
      { title: 'Microsoft Learn: WPF Imaging overview', url: 'https://learn.microsoft.com/en-us/dotnet/framework/wpf/graphics-multimedia/imaging-overview', supports: 'The managed WPF imaging component uses the unmanaged imaging infrastructure and exposes JPEG codecs.' },
      { title: 'Microsoft Learn: BitmapCacheOption', url: 'https://learn.microsoft.com/dotnet/api/system.windows.media.imaging.bitmapcacheoption', supports: 'None creates no image memory cache; OnLoad caches the entire image.' },
      { title: 'Microsoft Learn: BitmapSource.CopyPixels', url: 'https://learn.microsoft.com/en-us/dotnet/api/system.windows.media.imaging.bitmapsource.copypixels?view=windowsdesktop-10.0', supports: 'CopyPixels writes a selected rectangle or complete image into a caller-specified destination array/stride.' },
      { title: 'Microsoft Learn: PixelFormats.Bgra32', url: 'https://learn.microsoft.com/en-us/dotnet/api/system.windows.media.pixelformats.bgra32?view=windowsdesktop-10.0', supports: 'Bgra32 is sRGB, 32bpp, with 8-bit blue, green, red, and alpha channels.' },
      { title: 'Microsoft Learn: WIC overview', url: 'https://learn.microsoft.com/windows/win32/wic/-wic-about-windows-imaging-codec', supports: 'Windows imaging infrastructure and built-in codec framework.' },
    ],
    taskStatus: 'T04 remains in_progress; this candidate probe does not establish WIC production feasibility or acceptance.',
  };
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    evidencePath: EVIDENCE_PATH,
    result,
    fixtureCount: fixtureMetadata.length,
    sampleCount: samples.length,
    maxPeakWorkingSetBytes: evidence.measurements.maxPeakWorkingSetBytes,
    within256MiBForEverySample: withinTarget,
    pixelAndGdiPointChecksPassed: allDecoded,
    failure,
    cleanupError,
  })}\n`);
  return allDecoded ? 0 : 1;
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

  const fourTwoZeroBasePath = path.join(tempDirectory, '420-base.jpg');
  const fixtureResult = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-File', FIXTURE_SCRIPT,
    '-OutputPath', fourTwoZeroBasePath, '-Width', String(WIDTH), '-Height', String(HEIGHT),
  ], { cwd: ROOT, encoding: 'utf8', timeout: 180_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  if (fixtureResult.error) throw fixtureResult.error;
  if (fixtureResult.status !== 0 || !fs.existsSync(fourTwoZeroBasePath)) {
    throw new Error(`synthetic_420_fixture_generation_failed:${fixtureResult.stderr.trim() || fixtureResult.stdout.trim()}`);
  }
  const fourTwoZeroJpeg = fs.readFileSync(fourTwoZeroBasePath);
  fs.unlinkSync(fourTwoZeroBasePath);
  const fourFourFourJpeg = Buffer.from(require('jpeg-js').encode({ width: WIDTH, height: HEIGHT, data: rgba }, 96).data);
  rgba.fill(0);

  const rawCandidates = [
    { key: '420', bytes: fourTwoZeroJpeg },
    { key: '444', bytes: fourFourFourJpeg },
  ];
  return rawCandidates.map((candidate) => {
    const spec = FIXTURE_SPECS.find((entry) => entry.key === candidate.key);
    const samplingFactors = readJpegSamplingFactors(candidate.bytes);
    assert.deepEqual(samplingFactors.map(({ horizontal, vertical }) => [horizontal, vertical]), spec.expectedSampling,
      `${candidate.key}_jpeg_sampling_factors_mismatch`);
    const padded = padWithApp2ToLimit(candidate.bytes);
    return {
      key: candidate.key,
      encoder: spec.encoder,
      quality: spec.quality,
      samplingFactors,
      bytes: padded.bytes,
      app2PaddingBytes: padded.app2PaddingBytes,
    };
  });
}

function padWithApp2ToLimit(encoded) {
  if (encoded.length >= SOURCE_LIMIT_BYTES) throw new Error('base_jpeg_reaches_encoded_source_limit');
  const paddingBytes = SOURCE_LIMIT_BYTES - encoded.length;
  const segments = [];
  let remaining = paddingBytes;
  while (remaining > 0) {
    const segmentBytes = Math.min(65_536, remaining);
    if (segmentBytes < 4) throw new Error('jpeg_app2_padding_cannot_encode_trailing_bytes');
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
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('synthetic_jpeg_soi_missing');
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) throw new Error('synthetic_jpeg_marker_invalid');
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) throw new Error('synthetic_jpeg_segment_length_truncated');
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) throw new Error('synthetic_jpeg_segment_invalid');
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      const componentCount = bytes[offset + 7];
      const samplingFactors = [];
      for (let index = 0; index < componentCount; index += 1) {
        const sampling = bytes[offset + 9 + index * 3];
        samplingFactors.push({ horizontal: sampling >> 4, vertical: sampling & 0x0f });
      }
      if (samplingFactors.length !== 3) throw new Error('synthetic_jpeg_component_count_invalid');
      return samplingFactors;
    }
    offset += segmentLength;
  }
  throw new Error('synthetic_jpeg_sof_missing');
}

function runGdiPlusOracle(imagePath) {
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-File', PIXEL_ORACLE_SCRIPT,
    '-ImagePath', imagePath, '-CoordinateJson', JSON.stringify(SAMPLE_POINTS),
  ], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`gdi_plus_pixel_oracle_failed:${result.stderr.trim() || result.stdout.trim()}`);
  const parsed = parseLastJsonLine(result.stdout);
  if (parsed.width !== WIDTH || parsed.height !== HEIGHT || parsed.samples?.length !== SAMPLE_POINTS.length) {
    throw new Error('gdi_plus_pixel_oracle_shape_mismatch');
  }
  return parsed;
}

function compareGdiPoints(wicPoints, gdiPoints) {
  if (!Array.isArray(wicPoints) || !Array.isArray(gdiPoints) || wicPoints.length !== gdiPoints.length) {
    return { withinTolerance: false, reason: 'sample_count_mismatch', maxChannelDifference: null };
  }
  let maxChannelDifference = 0;
  const rows = [];
  for (let index = 0; index < wicPoints.length; index += 1) {
    const left = wicPoints[index];
    const right = gdiPoints[index];
    if (left.x !== right.x || left.y !== right.y || left.rgba?.length !== 4 || right.rgba?.length !== 4) {
      return { withinTolerance: false, reason: `point_shape_mismatch_${index}`, maxChannelDifference: null };
    }
    const channelDifferences = left.rgba.map((value, channel) => Math.abs(value - right.rgba[channel]));
    const pointMax = Math.max(...channelDifferences);
    maxChannelDifference = Math.max(maxChannelDifference, pointMax);
    rows.push({ x: left.x, y: left.y, wicRgba: left.rgba, gdiRgba: right.rgba, channelDifferences, maxChannelDifference: pointMax });
  }
  return { withinTolerance: maxChannelDifference <= 8, maxChannelDifference, points: rows };
}

function runPowerShellChild(imagePath) {
  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-File', CHILD_SCRIPT,
      '-ImagePath', imagePath, '-ExpectedWidth', String(WIDTH), '-ExpectedHeight', String(HEIGHT),
    ], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* closed before deadline */ }
    }, CHILD_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
        pid: Number.isInteger(child.pid) ? child.pid : null,
        exitCode: null,
        signal: null,
        closed: false,
        timedOut,
        childResult: null,
        stdout,
        stderr: `${stderr}${error.message}`,
      });
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      let childResult = null;
      try { childResult = parseLastJsonLine(stdout); } catch { /* recorded in stdoutJsonParsed */ }
      resolve({
        elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
        pid: Number.isInteger(child.pid) ? child.pid : null,
        exitCode,
        signal,
        closed: true,
        timedOut,
        childResult,
        stdout,
        stderr,
      });
    });
  });
}

function parseLastJsonLine(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error('empty_child_stdout');
  return JSON.parse(lines[lines.length - 1]);
}

function removeOnlyOwnedTempDirectory(tempDirectory) {
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(tempDirectory);
  if (path.dirname(resolved).toLowerCase() !== tempRoot.toLowerCase()
      || !path.basename(resolved).startsWith(`clipnest-t04-wic-jpeg-${process.pid}-`)) {
    throw new Error('refusing_to_remove_unowned_temp_directory');
  }
  for (const name of ['420.jpg', '444.jpg', '420-base.jpg']) {
    const filePath = path.resolve(resolved, name);
    if (path.dirname(filePath).toLowerCase() === resolved.toLowerCase() && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  if (fs.existsSync(resolved)) {
    const remainingEntries = fs.readdirSync(resolved);
    if (remainingEntries.length > 0) {
      throw new Error(`unexpected_files_left_in_owned_temp_directory:${remainingEntries.join(',')}`);
    }
    fs.rmdirSync(resolved);
  }
  return { removed: !fs.existsSync(resolved), remainingEntries: [] };
}

function repositoryState() {
  return {
    commit: gitValue('rev-parse', 'HEAD'),
    branch: gitValue('branch', '--show-current'),
    workingTreeWasDirty: gitValue('status', '--short').length > 0,
  };
}

function gitValue(...args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git_${args.join('_')}_failed:${result.stderr.trim()}`);
  return result.stdout.trim();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function expectedR(x) { return 32 + Math.floor((x * 80) / WIDTH); }
function expectedG(y) { return 96 + Math.floor((y * 80) / HEIGHT); }
function expectedB(x, y) { return 48 + Math.floor(((x + y) * 80) / (WIDTH + HEIGHT)); }
function round(value) { return Number(value.toFixed(3)); }
function maxNullable(values) { return values.some(Number.isFinite) ? Math.max(...values.filter(Number.isFinite)) : null; }

'use strict';

// Uninstalled exact-tarball feasibility probe. It uses synthetic JPEGs,
// fresh Electron utilityProcess workers, Windows GDI+ pixel samples, and the
// production-shaped deflate/IPC/parent-inflate response path. No user desktop
// window, clipboard, helper, or input device is used.
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createInflate } = require('node:zlib');

const ROOT = path.resolve(__dirname, '../../..');
const EXPECTED_TARBALL_SHA512 = 'sha512-u/A6tC4FYCRqL61QMAHiTEwKByh17txytXalgAjKhv84lFQfDNVaRc8H816dLqsTpm5MaEz9pd7UzHc0qaaJ8A==';
const EXPECTED_TARBALL_BYTES = 1_358_289;
const DEFAULT_TARBALL = path.join(os.tmpdir(), 'clipnest-purejsimage-audit', 'purejsimage-0.17.0.tgz');
const DEFAULT_ELECTRON_RUNTIME = path.join(ROOT, 'release', 'windows-flat-20261005', 'artifacts', 'win-unpacked');
const EVIDENCE_PATH = path.join(ROOT, 'docs', 'evidence', 'T04', 'purejsimage-16mp-utility-ipc-followup.json');
const WORKER_PATH = path.join(__dirname, 'purejsimage-followup-worker.cjs');
const ORACLE_SCRIPT = path.join(__dirname, 'purejsimage-independent-pixel-oracle.ps1');
const WIDTH = 4000;
const HEIGHT = 4000;
const PIXEL_COUNT = WIDTH * HEIGHT;
const SOURCE_LIMIT_BYTES = 20 * 1024 * 1024;
const DECODED_BYTES = PIXEL_COUNT * 4;
const WORKER_LIMIT_BYTES = 256 * 1024 * 1024;
const DEFLATE_MAX_BYTES = DECODED_BYTES + 64 * 1024;
const SAMPLE_COUNT = 5;
const SAMPLE_INTERVAL_MS = 50;
const PIXEL_TOLERANCE = 8;
const SAMPLE_POINTS = [
  { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 16, y: 16 }, { x: 511, y: 511 },
  { x: 1024, y: 1024 }, { x: 1999, y: 1999 }, { x: 2000, y: 2000 },
  { x: 3001, y: 2377 }, { x: 3999, y: 3999 },
];
const FIXTURE_SPECS = [
  { key: '420', chromaSubsampling: '420', quality: 50, expectedSampling: [{ h: 2, v: 2 }, { h: 1, v: 1 }, { h: 1, v: 1 }] },
  { key: '444', chromaSubsampling: '444', quality: 25, expectedSampling: [{ h: 1, v: 1 }, { h: 1, v: 1 }, { h: 1, v: 1 }] },
];

if (!process.versions.electron) {
  outerRun().then((code) => process.exit(code), (error) => {
    process.stderr.write(String(error.stack || error) + '\n');
    process.exit(1);
  });
} else {
  electronRun().catch((error) => {
    writeFailureEvidence('ELECTRON_PROBE_FAILED', error);
    process.stderr.write(String(error.stack || error) + '\n');
    require('electron').app.exit(1);
  });
}

async function outerRun() {
  const startedAt = new Date().toISOString();
  const tarballPath = path.resolve(process.env.T04_PUREJSIMAGE_TARBALL || DEFAULT_TARBALL);
  const beforeHashes = readDependencyFileHashes();
  const startingState = repositoryState();
  let workDir = null;
  let phase = 'preflight';
  let measuredTarballSha512 = null;
  let packageManifest = null;
  let fixtureMetadata = [];
  let oracleMetadata = [];
  let isolatedRuntime = null;
  try {
    assert.equal(process.platform, 'win32', 'requires_windows');
    assert.equal(process.arch, 'x64', 'requires_windows_x64');
    assert.ok(fs.existsSync(tarballPath), 'exact_candidate_tarball_missing:' + tarballPath);
    const tarball = fs.readFileSync(tarballPath);
    assert.equal(tarball.byteLength, EXPECTED_TARBALL_BYTES, 'candidate_tarball_size_mismatch');
    measuredTarballSha512 = 'sha512-' + createHash('sha512').update(tarball).digest('base64');
    assert.equal(measuredTarballSha512, EXPECTED_TARBALL_SHA512, 'candidate_tarball_sha512_mismatch');
    assertStaticSideEffectAudit();

    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipnest-t04-purejsimage-ipc-'));
    phase = 'extract_exact_tarball';
    const extracted = spawnSync('tar.exe', ['-xzf', tarballPath, '-C', workDir], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    });
    if (extracted.error) throw extracted.error;
    if (extracted.status !== 0) throw new Error('tar_extract_failed:' + extracted.status + ':' + extracted.stderr);
    const packageDir = path.join(workDir, 'package');
    packageManifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    assert.equal(packageManifest.name, 'purejsimage', 'candidate_package_name_mismatch');
    assert.equal(packageManifest.version, '0.17.0', 'candidate_package_version_mismatch');
    const packageDist = path.join(packageDir, 'dist');
    assert.ok(fs.existsSync(path.join(packageDist, 'codec-entries', 'jpeg.js')), 'jpeg_codec_entry_missing');
    assert.ok(fs.existsSync(path.join(packageDist, 'sink.js')), 'candidate_encoder_sink_missing');

    phase = 'generate_deterministic_fixtures';
    fixtureMetadata = await generateFixtures(packageDist, workDir);
    phase = 'independent_windows_gdiplus_oracle';
    oracleMetadata = fixtureMetadata.map((fixture) => runPixelOracle(fixture.filePath, fixture.key));
    for (const fixture of fixtureMetadata) {
      fixture.oracle = oracleMetadata.find((row) => row.fixtureKey === fixture.key).oracle;
    }
    fs.writeFileSync(path.join(workDir, 'fixture-metadata.json'), JSON.stringify(fixtureMetadata, null, 2) + '\n');
    fs.writeFileSync(path.join(workDir, 'oracle-metadata.json'), JSON.stringify(oracleMetadata, null, 2) + '\n');

    const initialEvidence = {
      schemaVersion: 1,
      task: 'T04',
      recordType: 'uninstalled_exact_tarball_jpeg_utility_process_ipc_followup',
      result: 'RUNNING',
      startedAt,
      source: startingState,
      candidate: {
        name: packageManifest.name,
        version: packageManifest.version,
        declaredLicense: packageManifest.license,
        tarballPath: tarballPath,
        tarballBytes: tarball.byteLength,
        expectedRegistryIntegrity: EXPECTED_TARBALL_SHA512,
        measuredTarballIntegrity: measuredTarballSha512,
        candidateNotInstalled: true,
        dependencyApproved: false,
        distributionAndHEVCReview: 'OPEN; this measurement is not a license, patent, dependency, or distribution decision.',
      },
      environment: {
        hostPlatform: process.platform,
        hostArchitecture: process.arch,
        hostNodeVersion: process.version,
        fixturesGeneratorNodeVersion: process.version,
        osVersion: os.version(),
      },
      packageFiles: {
        packageJsonSha256: sha256(fs.readFileSync(path.join(packageDir, 'package.json'))),
        importedEntries: ['dist/codec-entries/jpeg.js', 'dist/source.js', 'dist/limits.js', 'dist/sink.js'],
        optionalHeifAndWasmEntriesImported: false,
      },
      isolation: {
        createdBrowserWindow: false,
        systemClipboardReadOrWritten: false,
        physicalOrSyntheticInputSent: false,
        helperProcessUsed: false,
        onlySyntheticFixtureFilesRead: true,
        existingTempFilesModified: false,
        onlyOwnUniqueTempDirectoryWritten: true,
        staticSideEffectAudit: { checkedFiles: [path.relative(ROOT, __filename), path.relative(ROOT, WORKER_PATH), path.relative(ROOT, ORACLE_SCRIPT)], forbiddenApiMatches: [] },
      },
      independentPixelOracle: {
        implementation: 'Windows System.Drawing / GDI+ decodes each synthetic JPEG in a separate PowerShell process before Electron worker measurements.',
        coordinates: SAMPLE_POINTS,
        maximumAbsoluteRgbChannelDifferenceAccepted: PIXEL_TOLERANCE,
        oracleResults: oracleMetadata,
        interpretation: 'Independent cross-decoder spot checks for lossy JPEG; not exact source-RGB equality.',
      },
      fixtures: fixtureMetadata.map(publicFixture),
      protocol: {
        input: 'synthetic JPEG sent as Uint8Array over utilityProcess IPC',
        output: 'full 64,000,000-byte RGBA in worker, level-1 deflate response, utilityProcess IPC, parent 1 MiB-chunk inflate into exact-size Buffer',
        workerDeflateParameters: { level: 1, maxOutputBytes: DEFLATE_MAX_BYTES, chunkSizeBytes: 8 * 1024 * 1024 },
        parentInflateParameters: { chunkSizeBytes: 1 * 1024 * 1024, exactOutputBytes: DECODED_BYTES },
        requestToFullParentRgbaTiming: 'starts before input IPC; ends after parent inflates, hashes, and validates the complete RGBA output',
      },
      measurements: {
        sampleCountPerFixtureRequired: SAMPLE_COUNT,
        workerPeakTargetBytes: WORKER_LIMIT_BYTES,
        privateMemorySamplingIntervalMs: SAMPLE_INTERVAL_MS,
        parentPeakWorkingSetBytes: null,
        parentSampledPeakPrivateBytes: null,
        fixtures: [],
      },
      dependencyFileIntegrity: { before: beforeHashes, afterMeasurement: null },
      limitations: [
        'Candidate feasibility evidence only; no installation, production decoder integration, ASAR packaging, or T06 dependency acceptance.',
        'Inputs are deterministic baseline SOF0 JPEGs at 16 MP, padded with valid APP2 segments to exactly the 20 MiB compressed-source cap; a separate cap+1 request must fail before decode. Only 4:2:0 and 4:4:4 are represented.',
        'PeakWorkingSet64 is an OS high-water mark for each fresh worker in this environment, not a universal hard cap for all inputs or app states.',
        'Decoder abort behavior, progressive JPEG, EXIF/ICC/orientation, packaged loading, UI, clipboard, and target-visible paste are outside this probe.',
        'A successful result cannot close P15, general JPEG memory acceptance, T04 acceptance, or T05 controlled-live acceptance.',
      ],
    };
    writeEvidence(initialEvidence);

    phase = 'electron_utility_process_measurement';
    isolatedRuntime = createIsolatedRuntime();
    const env = { ...process.env,
      T04_PUREJSIMAGE_FOLLOWUP_WORKDIR: workDir,
      T04_PUREJSIMAGE_FOLLOWUP_FIXTURES: path.join(workDir, 'fixture-metadata.json'),
      T04_PUREJSIMAGE_FOLLOWUP_ORACLES: path.join(workDir, 'oracle-metadata.json'),
      T04_PUREJSIMAGE_FOLLOWUP_PACKAGE_DIR: packageDir,
      T04_PUREJSIMAGE_FOLLOWUP_TARBALL: tarballPath,
      T04_PUREJSIMAGE_FOLLOWUP_TARBALL_SHA512: measuredTarballSha512,
      T04_PUREJSIMAGE_FOLLOWUP_STARTED_AT: startedAt,
      T04_PUREJSIMAGE_FOLLOWUP_STARTING_STATE: JSON.stringify(startingState),
      T04_PUREJSIMAGE_FOLLOWUP_DEP_HASHES: JSON.stringify(beforeHashes),
      T04_PUREJSIMAGE_FOLLOWUP_RUNTIME_DIR: isolatedRuntime,
      T04_PUREJSIMAGE_FOLLOWUP_MEMORY_SAMPLER: path.join(workDir, 'windows-memory-sampler.ps1'),
      NODE_VERSION: process.version,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    fs.writeFileSync(env.T04_PUREJSIMAGE_FOLLOWUP_MEMORY_SAMPLER, MEMORY_SAMPLER_SOURCE, 'utf8');
    const electronResult = spawnSync(path.join(isolatedRuntime, 'ClipNest.exe'), [
      '--user-data-dir=' + path.join(workDir, 'isolated-user-data'), '--disable-gpu', '--no-sandbox',
    ], {
      cwd: isolatedRuntime, env, stdio: 'inherit', windowsHide: true, timeout: 900_000, maxBuffer: 8 * 1024 * 1024,
    });
    if (electronResult.error) throw electronResult.error;
    if (electronResult.status !== 0) throw new Error('electron_probe_exit_' + electronResult.status);
    const afterHashes = readDependencyFileHashes();
    assert.deepEqual(afterHashes, beforeHashes, 'package_manifest_or_lockfile_changed_during_measurement');
    const finalTarballHash = 'sha512-' + createHash('sha512').update(fs.readFileSync(tarballPath)).digest('base64');
    assert.equal(finalTarballHash, measuredTarballSha512, 'source_temp_tarball_changed_during_measurement');
    return 0;
  } catch (error) {
    writeWrapperFailureEvidence({
      phase, error, startedAt, tarballPath, measuredTarballSha512, packageManifest,
      fixtureMetadata, oracleMetadata, startingState, beforeHashes,
    });
    process.stderr.write('PureJsImage follow-up stopped in ' + phase + ': ' + String(error.stack || error) + '\n');
    return 1;
  } finally {
    if (workDir) removeOnlyOwnedTempDirectory(workDir);
    if (isolatedRuntime) removeOnlyOwnedRuntimeDirectory(isolatedRuntime);
  }
}

const MEMORY_SAMPLER_SOURCE = String.raw`param([Parameter(Mandatory = $true)][int]$TargetProcessId, [int]$IntervalMs = 50)
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  try {
    $target = Get-Process -Id $TargetProcessId -ErrorAction Stop
    $target.Refresh()
    [Console]::Out.WriteLine("$($target.PeakWorkingSet64)$([char]9)$($target.PrivateMemorySize64)")
    [Console]::Out.Flush()
    Start-Sleep -Milliseconds $IntervalMs
  } catch { break }
}`;

function createIsolatedRuntime() {
  const source = path.resolve(process.env.T04_ELECTRON_RUNTIME || DEFAULT_ELECTRON_RUNTIME);
  assert.ok(fs.existsSync(path.join(source, 'ClipNest.exe')), 'packaged_electron_runtime_missing:' + source);
  const runtime = fs.mkdtempSync(path.join(__dirname, '.t04-electron-runtime-'));
  try {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.name === 'locales') {
        fs.symlinkSync(path.join(source, entry.name), path.join(runtime, entry.name), 'junction');
      } else if (entry.name === 'resources') {
        const resources = path.join(runtime, 'resources');
        fs.mkdirSync(resources);
        const native = path.join(source, 'resources', 'native');
        if (fs.existsSync(native)) fs.symlinkSync(native, path.join(resources, 'native'), 'junction');
        // Deliberately omit app.asar and app.asar.unpacked. The isolated app below is the only main entry.
      } else if (entry.isFile()) {
        fs.linkSync(path.join(source, entry.name), path.join(runtime, entry.name));
      } else {
        throw new Error('unexpected_runtime_entry:' + entry.name);
      }
    }
    const probeApp = path.join(runtime, 'resources', 'app');
    fs.mkdirSync(probeApp);
    fs.writeFileSync(path.join(probeApp, 'package.json'), JSON.stringify({
      name: 'clipnest-t04-isolated-measurement', version: '1.0.0', main: 'main.cjs',
    }) + '\n', 'utf8');
    fs.writeFileSync(path.join(probeApp, 'main.cjs'),
      "'use strict';\nrequire(" + JSON.stringify(__filename) + ");\n", 'utf8');
    return runtime;
  } catch (error) {
    removeOnlyOwnedRuntimeDirectory(runtime);
    throw error;
  }
}

async function electronRun() {
  const { app, utilityProcess } = require('electron');
  let parentSampler = null;
  try {
    assert.equal(process.platform, 'win32', 'requires_windows');
    assert.equal(process.arch, 'x64', 'requires_windows_x64');
    const workDir = requiredEnvironmentPath('T04_PUREJSIMAGE_FOLLOWUP_WORKDIR');
    const runtimeDir = requiredEnvironmentPath('T04_PUREJSIMAGE_FOLLOWUP_RUNTIME_DIR');
    const fixtures = JSON.parse(fs.readFileSync(requiredEnvironmentPath('T04_PUREJSIMAGE_FOLLOWUP_FIXTURES'), 'utf8'));
    const oracles = JSON.parse(fs.readFileSync(requiredEnvironmentPath('T04_PUREJSIMAGE_FOLLOWUP_ORACLES'), 'utf8'));
    const packageDist = path.join(requiredEnvironmentPath('T04_PUREJSIMAGE_FOLLOWUP_PACKAGE_DIR'), 'dist');
    const evidence = JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8'));
    assert.equal(evidence.result, 'RUNNING', 'evidence_not_in_running_state');
    assert.equal(fixtures.length, FIXTURE_SPECS.length, 'fixture_count_mismatch');

    app.setPath('userData', path.join(workDir, 'isolated-user-data'));
    await app.whenReady();
    assert.equal(path.resolve(app.getAppPath()), path.join(runtimeDir, 'resources', 'app'),
      'isolated_probe_app_path_mismatch');
    assert.equal(fs.existsSync(path.join(runtimeDir, 'resources', 'app.asar')), false,
      'unexpected_application_asar_in_isolated_runtime');
    evidence.environment.electronVersion = process.versions.electron;
    evidence.environment.electronNodeVersion = process.versions.node;
    evidence.isolation.runtime = {
      executable: process.execPath,
      runtimeRoot: runtimeDir,
      appPath: app.getAppPath(),
      appAsarPresent: false,
      userDataPath: app.getPath('userData'),
      mainProcessPid: process.pid,
      createdBrowserWindow: false,
      onlyProbeMainEntryLoaded: true,
    };

    const memorySamplerPath = requiredEnvironmentPath('T04_PUREJSIMAGE_FOLLOWUP_MEMORY_SAMPLER');
    parentSampler = startWindowsMemorySampler(process.pid, SAMPLE_INTERVAL_MS, memorySamplerPath);
    await parentSampler.ready;
    for (const fixture of fixtures) {
      const oracle = oracles.find((row) => row.fixtureKey === fixture.key);
      assert.ok(oracle, 'fixture_oracle_missing:' + fixture.key);
      const fixtureResult = await measureFixture(utilityProcess, packageDist, fixture, oracle.oracle,
        parentSampler, memorySamplerPath);
      const previousIndex = evidence.measurements.fixtures.findIndex((item) => item.fixtureKey === fixture.key);
      if (previousIndex === -1) evidence.measurements.fixtures.push(fixtureResult);
      else evidence.measurements.fixtures[previousIndex] = fixtureResult;
      evidence.measurements.parentPeakWorkingSetBytes = parentSampler.snapshot().peakWorkingSetBytes;
      evidence.measurements.parentSampledPeakPrivateBytes = parentSampler.snapshot().sampledPeakPrivateBytes;
      writeEvidence(evidence);
    }

    const parentMemory = await parentSampler.stop();
    parentSampler = null;
    evidence.measurements.parentPeakWorkingSetBytes = parentMemory.peakWorkingSetBytes;
    evidence.measurements.parentSampledPeakPrivateBytes = parentMemory.sampledPeakPrivateBytes;
    evidence.measurements.parentMemorySamples = parentMemory.sampleCount;
    evidence.measurements.fixtures.forEach((fixture) => {
      fixture.successfulSampleCount = fixture.samples.filter((sample) => sample.outcome === 'success').length;
      fixture.oversizeBoundaryRejected = fixture.boundaryChecks.every((check) => check.actualError === 'fixture_source_size_invalid');
      fixture.withinWorkerPeakTarget = fixture.samples.every((sample) => sample.peakWorkingSetBytes <= WORKER_LIMIT_BYTES);
    });
    evidence.measurements.allSamplesComplete = evidence.measurements.fixtures.length === FIXTURE_SPECS.length &&
      evidence.measurements.fixtures.every((fixture) => fixture.samples.length === SAMPLE_COUNT &&
        fixture.samples.every((sample) => sample.outcome === 'success') && fixture.oversizeBoundaryRejected);
    evidence.measurements.withinWorkerPeakTarget = evidence.measurements.fixtures.every((fixture) => fixture.withinWorkerPeakTarget);
    evidence.measurementCompletedAt = new Date().toISOString();
    evidence.result = evidence.measurements.allSamplesComplete ? 'MEASURED_WITH_LIMITATIONS' : 'INCOMPLETE_MEASUREMENT';
    evidence.dependencyFileIntegrity.afterMeasurement = readDependencyFileHashes();
    evidence.candidate.finalMeasuredTarballIntegrity = 'sha512-' + createHash('sha512')
      .update(fs.readFileSync(requiredEnvironmentPath('T04_PUREJSIMAGE_FOLLOWUP_TARBALL'))).digest('base64');
    assert.deepEqual(evidence.dependencyFileIntegrity.afterMeasurement, evidence.dependencyFileIntegrity.before,
      'package_manifest_or_lockfile_changed_during_measurement');
    assert.equal(evidence.candidate.finalMeasuredTarballIntegrity, evidence.candidate.measuredTarballIntegrity,
      'source_temp_tarball_changed_during_measurement');
    writeEvidence(evidence);
    process.stdout.write(JSON.stringify({
      result: evidence.result,
      fixtureCounts: evidence.measurements.fixtures.map((fixture) => ({
        key: fixture.fixtureKey, samples: fixture.samples.length, p50Ms: fixture.latency.p50Ms,
        p95Ms: fixture.latency.p95Ms, peakWorkingSetBytes: fixture.peakWorkingSetBytes,
      })),
      parentPeakWorkingSetBytes: parentMemory.peakWorkingSetBytes,
    }) + '\n');
    app.exit(evidence.measurements.allSamplesComplete ? 0 : 2);
  } catch (error) {
    if (parentSampler) await parentSampler.stop().catch(() => undefined);
    writeFailureEvidence('ELECTRON_PROBE_FAILED', error);
    process.stderr.write(String(error.stack || error) + '\n');
    app.exit(1);
  }
}

async function measureFixture(utilityProcess, packageDist, fixture, oracle, parentSampler, memorySamplerPath) {
  const encodedBytes = fs.readFileSync(fixture.filePath);
  assert.equal(encodedBytes.byteLength, SOURCE_LIMIT_BYTES, 'fixture_not_at_input_size_limit:' + fixture.key);
  assert.equal(sha256(encodedBytes), fixture.inputSha256, 'fixture_input_hash_changed:' + fixture.key);
  const samples = [];
  for (let index = 0; index < SAMPLE_COUNT; index++) {
    const sample = await measureFreshWorker(utilityProcess, packageDist, fixture, oracle, encodedBytes, index + 1,
      memorySamplerPath);
    samples.push(sample);
    parentSampler.snapshot();
    writeEvidenceProgress(fixture.key, samples, null);
  }
  const boundaryCheck = await rejectOversizeInput(utilityProcess, packageDist, fixture, encodedBytes);
  const timings = samples.map((sample) => sample.requestToFullParentRgbaMs);
  const peakWorkingSetBytes = Math.max(...samples.map((sample) => sample.peakWorkingSetBytes));
  const sampledPeakPrivateBytes = Math.max(...samples.map((sample) => sample.sampledPeakPrivateBytes));
  return {
    fixtureKey: fixture.key,
    chromaSubsampling: fixture.chromaSubsampling,
    inputBytes: encodedBytes.byteLength,
    inputLimitBytes: SOURCE_LIMIT_BYTES,
    inputLimitHeadroomBytes: SOURCE_LIMIT_BYTES - encodedBytes.byteLength,
    inputSha256: fixture.inputSha256,
    samples,
    boundaryChecks: [boundaryCheck],
    peakWorkingSetBytes,
    peakWorkingSetMiB: round(peakWorkingSetBytes / 1024 / 1024),
    sampledPeakPrivateBytes,
    sampledPeakPrivateMiB: round(sampledPeakPrivateBytes / 1024 / 1024),
    latency: {
      p50Ms: percentile(timings, 0.5),
      p95Ms: percentile(timings, 0.95),
      maximumMs: Math.max(...timings),
      samplesCounted: timings.length,
      scope: 'fresh utilityProcess ready through input IPC, JPEG decode, RGBA deflate, response IPC, exact 64MB parent inflate, full RGBA hash and pixel-oracle checks',
    },
  };
}

async function measureFreshWorker(utilityProcess, packageDist, fixture, oracle, encodedBytes, sampleNumber, memorySamplerPath) {
  const requestId = 't04-purejsimage-' + fixture.key + '-' + sampleNumber;
  const workerStartedAt = process.hrtime.bigint();
  const child = utilityProcess.fork(WORKER_PATH, [], {
    serviceName: 'ClipNest T04 PureJsImage JPEG measurement', stdio: 'ignore',
  });
  let sampler = null;
  try {
    await waitForSpawn(child);
    const startupMs = elapsedMs(workerStartedAt);
    assert.ok(child.pid, 'utility_process_pid_unavailable');
    sampler = startWindowsMemorySampler(child.pid, SAMPLE_INTERVAL_MS, memorySamplerPath);
    await sampler.ready;
    const before = sampler.snapshot();
    const startedAt = process.hrtime.bigint();
    const response = await sendDecodeRequest(child, requestId, packageDist, {
      jobId: requestId,
      format: 'jpeg',
      encodedBytes: Uint8Array.from(encodedBytes),
      width: WIDTH,
      height: HEIGHT,
    });
    if (response.type !== 'decoded_compressed') {
      throw new Error('decoder_failed:' + String(response.error || response.reason || response.type));
    }
    assert.equal(response.width, WIDTH, 'worker_width_mismatch');
    assert.equal(response.height, HEIGHT, 'worker_height_mismatch');
    assert.equal(response.uncompressedBytes, DECODED_BYTES, 'worker_rgba_length_mismatch');
    assert.equal(response.inputBytes, encodedBytes.byteLength, 'worker_input_length_mismatch');
    assert.equal(response.inputSha256, fixture.inputSha256, 'worker_input_hash_mismatch');
    assert.equal(response.decoderProgressive, false, 'worker_progressive_flag_mismatch');
    assert.ok(response.compressedPixels instanceof Uint8Array, 'worker_compressed_payload_not_uint8array');
    assert.ok(response.compressedPixels.byteLength > 0 && response.compressedPixels.byteLength <= DEFLATE_MAX_BYTES,
      'worker_compressed_payload_out_of_bounds');
    const compressed = Buffer.from(response.compressedPixels.buffer,
      response.compressedPixels.byteOffset, response.compressedPixels.byteLength);
    assert.equal(sha256(compressed), response.compressedSha256, 'worker_compressed_hash_mismatch');
    const inflateStartedAt = process.hrtime.bigint();
    const pixels = await inflateExactly(compressed, DECODED_BYTES);
    const parentInflateMs = elapsedMs(inflateStartedAt);
    const rgbaSha256 = sha256(pixels);
    assert.equal(rgbaSha256, response.rgbaSha256, 'parent_rgba_hash_mismatch');
    for (let offset = 3; offset < pixels.byteLength; offset += 4) {
      if (pixels[offset] !== 255) throw new Error('parent_rgba_alpha_not_opaque_at_byte_' + offset);
    }
    const pixelChecks = comparePixelSamples(pixels, response.pixelSamples, oracle);
    const requestToFullParentRgbaMs = elapsedMs(startedAt);
    const after = sampler.snapshot();
    const memory = await sampler.stop();
    sampler = null;
    child.kill();
    await waitForExit(child);
    return {
      sampleNumber,
      outcome: 'success',
      pid: child.pid,
      workerStartupMs: round(startupMs),
      workerDecodeMs: response.decodeMs,
      workerDeflateMs: response.deflateMs,
      parentInflateMs: round(parentInflateMs),
      requestToFullParentRgbaMs: round(requestToFullParentRgbaMs),
      inputBytes: encodedBytes.byteLength,
      inputSha256: fixture.inputSha256,
      compressedBytes: compressed.byteLength,
      compressedSha256: response.compressedSha256,
      rgbaBytes: pixels.byteLength,
      rgbaSha256,
      decodedRows: response.decodedRows,
      blockCount: response.blockCount,
      minBlockStride: response.minBlockStride,
      maxBlockDataBytes: response.maxBlockDataBytes,
      pixelOracle: pixelChecks,
      memory: { workingSetBeforeBytes: before.workingSetBytes, privateBeforeBytes: before.privateBytes,
        workingSetAfterBytes: after.workingSetBytes, privateAfterBytes: after.privateBytes,
        peakWorkingSetBytes: memory.peakWorkingSetBytes, sampledPeakPrivateBytes: memory.sampledPeakPrivateBytes,
        sampleIntervalMs: SAMPLE_INTERVAL_MS, sampleCount: memory.sampleCount },
      peakWorkingSetBytes: memory.peakWorkingSetBytes,
      sampledPeakPrivateBytes: memory.sampledPeakPrivateBytes,
    };
  } catch (error) {
    if (sampler) await sampler.stop().catch(() => undefined);
    child.kill();
    await waitForExit(child).catch(() => undefined);
    throw error;
  }
}

async function rejectOversizeInput(utilityProcess, packageDist, fixture, encodedBytes) {
  const requestId = 't04-purejsimage-' + fixture.key + '-limit-plus-one';
  const child = utilityProcess.fork(WORKER_PATH, [], {
    serviceName: 'ClipNest T04 PureJsImage JPEG input-boundary probe', stdio: 'ignore',
  });
  try {
    await waitForSpawn(child);
    const oversized = Buffer.concat([encodedBytes, Buffer.from([0])]);
    assert.equal(oversized.byteLength, SOURCE_LIMIT_BYTES + 1);
    const response = await sendDecodeRequest(child, requestId, packageDist, {
      jobId: requestId, format: 'jpeg', encodedBytes: Uint8Array.from(oversized), width: WIDTH, height: HEIGHT,
    });
    assert.equal(response.type, 'failed', 'oversize_input_was_not_rejected');
    assert.equal(response.error, 'fixture_source_size_invalid', 'oversize_rejection_reason_mismatch');
    return { inputBytes: oversized.byteLength, limitBytes: SOURCE_LIMIT_BYTES,
      expectedError: 'fixture_source_size_invalid', actualError: response.error, decoderStarted: false };
  } finally {
    child.kill();
    await waitForExit(child).catch(() => undefined);
  }
}

function sendDecodeRequest(child, requestId, packageDist, input) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('utility_process_response_timeout:' + requestId)), 180_000);
    const onMessage = (eventOrMessage) => {
      const message = eventOrMessage && eventOrMessage.data !== undefined ? eventOrMessage.data : eventOrMessage;
      if (!message || message.requestId !== requestId) return;
      finish(null, message);
    };
    const onExit = (code) => finish(new Error('utility_process_exited_before_response:' + code));
    const finish = (error, message) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(message);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
    try {
      child.postMessage({ type: 'decode', requestId, packageDist, input });
    } catch (error) {
      finish(error);
    }
  });
}

function inflateExactly(compressed, expectedBytes) {
  return new Promise((resolve, reject) => {
    const inflater = createInflate({ chunkSize: 1024 * 1024 });
    const pixels = Buffer.allocUnsafe(expectedBytes);
    let outputBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      inflater.destroy();
      reject(error);
    };
    inflater.on('data', (chunk) => {
      if (settled) return;
      if (outputBytes + chunk.byteLength > expectedBytes) {
        fail(new Error('inflated_rgba_exceeded_exact_size'));
        return;
      }
      chunk.copy(pixels, outputBytes);
      outputBytes += chunk.byteLength;
    });
    inflater.once('error', fail);
    inflater.once('end', () => {
      if (settled) return;
      settled = true;
      if (outputBytes !== expectedBytes) reject(new Error('inflated_rgba_size_mismatch:' + outputBytes));
      else resolve(pixels);
    });
    inflater.end(compressed);
  });
}

function comparePixelSamples(pixels, workerSamples, oracle) {
  const gdiSamples = new Map(oracle.samples.map((sample) => [sample.x + ':' + sample.y, sample.rgba]));
  const workerMap = new Map(workerSamples.map((sample) => [sample.x + ':' + sample.y, sample.rgba]));
  let maxAbsoluteRgbDifference = 0;
  const samples = SAMPLE_POINTS.map(({ x, y }) => {
    const offset = (y * WIDTH + x) * 4;
    const rgba = Array.from(pixels.subarray(offset, offset + 4));
    const workerRgba = workerMap.get(x + ':' + y);
    const oracleRgba = gdiSamples.get(x + ':' + y);
    assert.deepEqual(rgba, workerRgba, 'worker_parent_sample_mismatch:' + x + ':' + y);
    assert.ok(oracleRgba, 'independent_oracle_sample_missing:' + x + ':' + y);
    const differences = rgba.slice(0, 3).map((channel, index) => Math.abs(channel - oracleRgba[index]));
    maxAbsoluteRgbDifference = Math.max(maxAbsoluteRgbDifference, ...differences);
    return { x, y, rgba, oracleRgba, maximumAbsoluteRgbDifference: Math.max(...differences) };
  });
  assert.ok(maxAbsoluteRgbDifference <= PIXEL_TOLERANCE,
    'independent_oracle_rgb_difference_exceeded:' + maxAbsoluteRgbDifference);
  return { decoder: oracle.decoder, acceptedRgbChannelDifference: PIXEL_TOLERANCE,
    maxAbsoluteRgbDifference, samples };
}

function startWindowsMemorySampler(pid, intervalMs, samplerPath) {
  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', samplerPath, String(pid), String(intervalMs),
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const values = [];
  let partial = '';
  let startupError = null;
  let firstSampleResolve;
  let firstSampleReject;
  const ready = new Promise((resolve, reject) => { firstSampleResolve = resolve; firstSampleReject = reject; });
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    partial += chunk;
    const lines = partial.split(/\r?\n/);
    partial = lines.pop() || '';
    for (const line of lines) {
      const [workingSet, privateBytes] = line.trim().split('\t').map(Number);
      if (!Number.isFinite(workingSet) || !Number.isFinite(privateBytes)) continue;
      values.push({ workingSetBytes: workingSet, privateBytes });
      if (values.length === 1) firstSampleResolve();
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { startupError = (startupError || '') + chunk; });
  child.once('error', (error) => {
    startupError = String(error);
    firstSampleReject(error);
  });
  child.once('close', (code) => {
    if (!values.length) firstSampleReject(new Error('memory_sampler_closed_without_samples:' + code + ':' + startupError));
  });
  const timeout = setTimeout(() => firstSampleReject(new Error('memory_sampler_first_sample_timeout:' + pid)), 15_000);
  const readyWithTimeout = ready.finally(() => clearTimeout(timeout));
  function snapshot() {
    return {
      workingSetBytes: values.length ? values[values.length - 1].workingSetBytes : null,
      privateBytes: values.length ? values[values.length - 1].privateBytes : null,
      peakWorkingSetBytes: values.length ? Math.max(...values.map((sample) => sample.workingSetBytes)) : null,
      sampledPeakPrivateBytes: values.length ? Math.max(...values.map((sample) => sample.privateBytes)) : null,
      sampleCount: values.length,
    };
  }
  return {
    ready: readyWithTimeout,
    snapshot,
    async stop() {
      if (child.exitCode === null) child.kill();
      await Promise.race([closed, timeoutReject(10_000, 'memory_sampler_exit_timeout:' + pid)]);
      const last = snapshot();
      if (!values.length) throw new Error('memory_sampler_no_samples:' + pid);
      return { peakWorkingSetBytes: last.peakWorkingSetBytes,
        sampledPeakPrivateBytes: last.sampledPeakPrivateBytes, workingSetAtStopBytes: last.workingSetBytes,
        privateBytesAtStop: last.privateBytes, sampleCount: last.sampleCount };
    },
  };
}

function requiredEnvironmentPath(name) {
  const value = process.env[name];
  if (!value) throw new Error('missing_environment_path:' + name);
  return path.resolve(value);
}

function writeEvidenceProgress(fixtureKey, samples, boundaryChecks) {
  const evidence = JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8'));
  const current = evidence.measurements.fixtures.find((fixture) => fixture.fixtureKey === fixtureKey);
  if (current) current.samples = samples;
  else evidence.measurements.fixtures.push({ fixtureKey, samples, boundaryChecks: boundaryChecks || [] });
  writeEvidence(evidence);
}

async function generateFixtures(packageDist, workDir) {
  const [{ jpegCodec }, { Uint8ArraySink }] = await Promise.all([
    import(pathToFileURL(path.join(packageDist, 'codec-entries', 'jpeg.js')).href),
    import(pathToFileURL(path.join(packageDist, 'sink.js')).href),
  ]);
  const fixtures = [];
  for (const spec of FIXTURE_SPECS) {
    const sink = new Uint8ArraySink();
    const encoder = await jpegCodec.createEncoder(sink, {
      width: WIDTH,
      height: HEIGHT,
      pixelFormat: 'rgb8',
      options: { quality: spec.quality, progressive: false, chromaSubsampling: spec.chromaSubsampling },
    });
    if (!encoder) throw new Error('candidate_encoder_unavailable:' + spec.key);
    let state = 0x6d2b79f5;
    const sourceHash = createHash('sha256');
    const row = Buffer.allocUnsafe(WIDTH * 3);
    const pointsByRow = new Map();
    for (const [index, point] of SAMPLE_POINTS.entries()) {
      const rowPoints = pointsByRow.get(point.y) || [];
      rowPoints.push({ ...point, index });
      pointsByRow.set(point.y, rowPoints);
    }
    const sourceSamples = Array(SAMPLE_POINTS.length).fill(null);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const offset = x * 3;
        for (let channel = 0; channel < 3; channel++) {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          row[offset + channel] = state & 0xff;
        }
      }
      for (const point of pointsByRow.get(y) || []) {
        const offset = point.x * 3;
        sourceSamples[point.index] = Array.from(row.subarray(offset, offset + 3));
      }
      sourceHash.update(row);
      await encoder.write({ x: 0, y, width: WIDTH, height: 1, stride: row.byteLength, format: 'rgb8', data: row });
    }
    await encoder.finish();
    await sink.close();
    const unpadded = Buffer.from(sink.toUint8Array());
    if (unpadded.byteLength >= SOURCE_LIMIT_BYTES) throw new Error('candidate_fixture_exceeds_source_limit:' + spec.key);
    const padded = padJpegNearSourceLimit(unpadded);
    const sampling = readSamplingFactors(unpadded);
    assert.deepEqual(sampling.components, spec.expectedSampling, 'fixture_sampling_mismatch:' + spec.key);
    if (sampling.marker !== 0xc0) throw new Error('fixture_not_baseline_sof0:' + spec.key);
    const filePath = path.join(workDir, 'synthetic-baseline-16mp-' + spec.key + '-near20mib.jpg');
    fs.writeFileSync(filePath, padded);
    fixtures.push({
      key: spec.key,
      fileName: path.basename(filePath),
      filePath,
      width: WIDTH,
      height: HEIGHT,
      pixelCount: PIXEL_COUNT,
      sourceBytes: padded.byteLength,
      sourceLimitBytes: SOURCE_LIMIT_BYTES,
      sourceLimitHeadroomBytes: SOURCE_LIMIT_BYTES - padded.byteLength,
      sourceBytesBeforeApp2Padding: unpadded.byteLength,
      app2PaddingBytes: padded.byteLength - unpadded.byteLength,
      maximumApp2SegmentBytes: 65_537,
      marker: '0x' + sampling.marker.toString(16),
      samplingFactors: sampling.components,
      chromaSubsampling: spec.chromaSubsampling,
      quality: spec.quality,
      progressive: false,
      sourcePixelGenerator: 'xorshift32 seed 0x6d2b79f5; one update per R/G/B channel; low 8 bits; seed resets per fixture',
      sourceRgbSha256: sourceHash.digest('hex'),
      knownSourcePixels: SAMPLE_POINTS.map((point, index) => ({ x: point.x, y: point.y, rgb: sourceSamples[index] })),
      inputSha256: createHash('sha256').update(padded).digest('hex'),
    });
  }
  return fixtures;
}

function publicFixture(fixture) {
  const { filePath, ...value } = fixture;
  return value;
}

function padJpegNearSourceLimit(image) {
  const targetBytes = SOURCE_LIMIT_BYTES;
  let remaining = targetBytes - image.byteLength;
  if (remaining < 0) throw new Error('invalid_app2_padding_span');
  const segmentSizes = [];
  while (remaining > 65_537) {
    segmentSizes.push(65_536);
    remaining -= 65_536;
  }
  if (remaining > 0 && remaining < 4) {
    const previous = segmentSizes.pop();
    const adjustment = 4 - remaining;
    if (!previous || previous - adjustment < 4) throw new Error('invalid_app2_segment_padding');
    segmentSizes.push(previous - adjustment);
    remaining += adjustment;
  }
  if (remaining > 0) segmentSizes.push(remaining);
  const chunks = [image.subarray(0, 2)];
  for (const segmentBytes of segmentSizes) {
    if (segmentBytes < 4 || segmentBytes > 65_537) throw new Error('invalid_app2_segment_padding');
    const segment = Buffer.alloc(segmentBytes);
    segment[0] = 0xff;
    segment[1] = 0xe2;
    segment.writeUInt16BE(segmentBytes - 2, 2);
    chunks.push(segment);
  }
  chunks.push(image.subarray(2));
  const output = Buffer.concat(chunks, targetBytes);
  if (output.byteLength > SOURCE_LIMIT_BYTES) throw new Error('padded_jpeg_exceeds_source_limit');
  return output;
}

function readSamplingFactors(bytes) {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) throw new Error('jpeg_marker_prefix_missing');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw new Error('jpeg_marker_segment_invalid');
    if (marker === 0xc0) {
      const count = bytes[offset + 7];
      return {
        marker,
        components: Array.from({ length: count }, (_, index) => {
          const sampling = bytes[offset + 9 + index * 3];
          return { h: sampling >>> 4, v: sampling & 0x0f };
        }),
      };
    }
    offset += length;
  }
  throw new Error('baseline_sof0_marker_missing');
}

function runPixelOracle(fixturePath, fixtureKey) {
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', ORACLE_SCRIPT, fixturePath, JSON.stringify(SAMPLE_POINTS),
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 1 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('independent_pixel_oracle_failed:' + result.status + ':' + result.stderr);
  const oracle = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(oracle.width, WIDTH);
  assert.equal(oracle.height, HEIGHT);
  assert.equal(oracle.samples.length, SAMPLE_POINTS.length);
  return { fixtureKey, oracle };
}


function assertStaticSideEffectAudit() {
  const files = [__filename, WORKER_PATH, ORACLE_SCRIPT];
  const patterns = [
    ['BrowserWindow construction', new RegExp('\\b' + 'new' + '\\s+' + 'Browser' + 'Window' + '\\s*\\(')],
    ['Electron clipboard calls', /\bclipboard\s*\.\s*(?:read|write|clear|availableFormats)\s*\(/],
    ['system image clipboard source', /\bnativeImage\s*\.\s*createFrom(?:Clipboard|Bitmap)\s*\(/],
    ['Win32 input APIs', new RegExp('\\b(?:' + 'Send' + 'Input|' + 'keybd' + '_' + 'event|' + 'GetAsync' + 'KeyState' + ')\\b')],
    ['native helper paste protocol', new RegExp('\\b(?:' + 'commit' + '_' + 'write|' + 'paste' + 'Target|' + 'clipnest' + '-helper\\.exe)\\b')],
  ];
  const findings = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const [name, pattern] of patterns) {
      if (pattern.test(content)) findings.push({ file: path.relative(ROOT, file), name });
    }
  }
  assert.deepEqual(findings, [], 'probe_contains_forbidden_desktop_side_effect_code');
}

function writeFailureEvidence(kind, error) {
  let evidence = null;
  if (fs.existsSync(EVIDENCE_PATH)) {
    try { evidence = JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8')); } catch { /* Replace malformed partial output. */ }
  }
  if (!evidence || evidence.result !== 'RUNNING') {
    evidence = {
      schemaVersion: 1,
      task: 'T04',
      recordType: 'uninstalled_exact_tarball_jpeg_utility_process_ipc_followup',
      startedAt: new Date().toISOString(),
      candidate: { name: 'purejsimage', version: '0.17.0', expectedRegistryIntegrity: EXPECTED_TARBALL_SHA512, candidateNotInstalled: true },
      measurements: { fixtures: [] },
    };
  }
  evidence.result = kind;
  evidence.failure = { error: String(error && error.stack || error) };
  evidence.measurementCompletedAt = new Date().toISOString();
  writeEvidence(evidence);
}

function writeWrapperFailureEvidence(data) {
  if (fs.existsSync(EVIDENCE_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8'));
      if (existing && existing.result && existing.result !== 'RUNNING') {
        existing.wrapperFailure = { phase: data.phase, error: String(data.error && data.error.stack || data.error) };
        existing.dependencyFileIntegrity = existing.dependencyFileIntegrity || {};
        existing.dependencyFileIntegrity.afterMeasurement = readDependencyFileHashes();
        existing.measurementCompletedAt = new Date().toISOString();
        writeEvidence(existing);
        return;
      }
      if (existing && existing.result === 'RUNNING') {
        existing.result = data.phase === 'preflight' ? 'PREFLIGHT_FAILED' : 'RUNNER_FAILED';
        existing.failure = { phase: data.phase, error: String(data.error && data.error.stack || data.error) };
        existing.dependencyFileIntegrity = existing.dependencyFileIntegrity || {};
        existing.dependencyFileIntegrity.afterMeasurement = readDependencyFileHashes();
        existing.measurementCompletedAt = new Date().toISOString();
        writeEvidence(existing);
        return;
      }
    } catch { /* Create a structured wrapper failure below if partial evidence cannot be parsed. */ }
  }
  const evidence = {
    schemaVersion: 1,
    task: 'T04',
    recordType: 'uninstalled_exact_tarball_jpeg_utility_process_ipc_followup',
    result: 'PREFLIGHT_FAILED',
    startedAt: data.startedAt,
    source: data.startingState,
    candidate: {
      name: data.packageManifest && data.packageManifest.name || 'purejsimage',
      version: data.packageManifest && data.packageManifest.version || '0.17.0',
      tarballPath: data.tarballPath,
      expectedRegistryIntegrity: EXPECTED_TARBALL_SHA512,
      measuredTarballIntegrity: data.measuredTarballSha512,
      candidateNotInstalled: true,
      packageJsonOrLockfileChanged: false,
    },
    fixtures: data.fixtureMetadata.map(publicFixture),
    independentPixelOracle: { oracleResults: data.oracleMetadata },
    measurements: { fixtures: [] },
    dependencyFileIntegrity: { before: data.beforeHashes, afterMeasurement: readDependencyFileHashes() },
    isolation: { createdBrowserWindow: false, systemClipboardReadOrWritten: false, physicalOrSyntheticInputSent: false },
    limitations: ['Preflight or runner failed before all samples completed; this is not T04 or general JPEG memory acceptance.'],
    failure: { phase: data.phase, error: String(data.error && data.error.stack || data.error) },
    measurementCompletedAt: new Date().toISOString(),
  };
  writeEvidence(evidence);
}

function removeOnlyOwnedTempDirectory(directory) {
  const resolved = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  if (!resolved.startsWith(tempRoot + path.sep) ||
      !path.basename(resolved).startsWith('clipnest-t04-purejsimage-ipc-')) {
    process.stderr.write('Refusing to remove non-owned temporary directory: ' + resolved + '\n');
    return;
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function removeOnlyOwnedRuntimeDirectory(directory) {
  const resolved = path.resolve(directory);
  const taskRoot = path.resolve(__dirname);
  const relative = path.relative(taskRoot, resolved);
  if (!path.basename(resolved).startsWith('.t04-electron-runtime-') || !relative ||
      relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    process.stderr.write('Refusing to remove non-owned Electron runtime directory: ' + resolved + '\n');
    return;
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function readDependencyFileHashes() {
  return Object.fromEntries(['package.json', 'pnpm-lock.yaml'].map((name) => [
    name, sha256(fs.readFileSync(path.join(ROOT, name))),
  ]));
}

function repositoryState() {
  return {
    commit: gitValue('rev-parse', 'HEAD'),
    branch: gitValue('branch', '--show-current'),
    status: gitValue('status', '--short').split(/\r?\n/).filter(Boolean),
  };
}

function gitValue() {
  const result = spawnSync('git', Array.from(arguments), { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : '';
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function writeEvidence(value) { fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}
function round(value) { return Math.round(value * 100) / 100; }
function elapsedMs(startedAt) { return Number(process.hrtime.bigint() - startedAt) / 1_000_000; }
function timeoutReject(milliseconds, message) { return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds)); }
function waitForSpawn(child) {
  if (child.pid) return Promise.resolve();
  return Promise.race([
    new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('exit', (code) => reject(new Error('worker_exited_before_spawn:' + code)));
    }),
    timeoutReject(10_000, 'worker_spawn_timeout'),
  ]);
}
function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    timeoutReject(10_000, 'worker_exit_timeout'),
  ]);
}

const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../..");
const expectedProfileRoot = path.resolve(repositoryRoot, "tests/tasks/T01/runtime-profile");
const reportDirectory = path.join(repositoryRoot, "docs/evidence/T01");
const args = process.argv.slice(2);
let runProfile = null;
let resolvedProfileRoot = null;

function option(name) {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1] ?? null;
}

const reportName = option("--report") ?? "wake-baseline.json";
if (path.basename(reportName) !== reportName || !/^[a-z0-9][a-z0-9._-]*\.json$/i.test(reportName) || reportName.includes("..")) {
  process.stderr.write("--report must be a JSON filename in docs/evidence/T01\n");
  process.exit(2);
}
const reportPath = path.join(reportDirectory, reportName);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function cleanupRunProfile() {
  if (!runProfile || !resolvedProfileRoot || !fs.existsSync(runProfile)) return;
  const resolvedRunProfile = fs.realpathSync.native(runProfile);
  if (normalized(path.dirname(resolvedRunProfile)) !== normalized(resolvedProfileRoot)) {
    process.stderr.write("Refusing to remove a benchmark profile outside its verified root\n");
    return;
  }
  fs.rmSync(runProfile, { recursive: true, force: true });
  runProfile = null;
}

process.once("exit", cleanupRunProfile);

const profileArgument = option("--profile");
if (!profileArgument || path.resolve(repositoryRoot, profileArgument) !== expectedProfileRoot) {
  fail("--profile must be tests/tasks/T01/runtime-profile inside this repository");
}
if (!args.includes("--no-input")) fail("--no-input is mandatory; this benchmark never sends keys");
const injectMissingRendererAck = args.includes("--simulate-no-ack");
const samples = Number(option("--samples") ?? "10");
if (!Number.isInteger(samples) || samples < 1 || samples > 100) {
  fail("--samples must be an integer from 1 to 100");
}

let electronPath;
try {
  electronPath = require("electron");
} catch (error) {
  fail(`Electron dependency is unavailable: ${error.message}`);
}
if (typeof electronPath !== "string" || !fs.existsSync(electronPath)) {
  fail("Electron executable was not found in this checkout");
}

fs.mkdirSync(expectedProfileRoot, { recursive: true });
const normalized = (value) => process.platform === "win32" ? value.toLowerCase() : value;
resolvedProfileRoot = fs.realpathSync.native(expectedProfileRoot);
if (normalized(resolvedProfileRoot) !== normalized(expectedProfileRoot)) {
  fail("The benchmark profile root must not be a symlink or junction");
}

const build = process.platform === "win32"
  ? spawnSync("cmd.exe", ["/d", "/s", "/c", "pnpm build"], { cwd: repositoryRoot, stdio: "inherit" })
  : spawnSync("pnpm", ["build"], { cwd: repositoryRoot, stdio: "inherit" });
if (build.error) fail(`Unable to build the isolated benchmark app: ${build.error.message}`);
if (build.status !== 0) fail(`Benchmark build failed with exit code ${build.status}`);

runProfile = path.join(expectedProfileRoot, `run-${Date.now()}-${randomUUID()}`);
fs.mkdirSync(runProfile, { recursive: true });
const resolvedRunProfile = fs.realpathSync.native(runProfile);
if (normalized(path.dirname(resolvedRunProfile)) !== normalized(resolvedProfileRoot)) {
  fail("The isolated benchmark run escaped its verified profile root");
}

const appEnvironment = { ...process.env };
for (const key of Object.keys(appEnvironment)) {
  if (/(TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY)/i.test(key)) delete appEnvironment[key];
}
delete appEnvironment.ELECTRON_RENDERER_URL;
delete appEnvironment.ELECTRON_RUN_AS_NODE;
delete appEnvironment.NODE_OPTIONS;
appEnvironment.CLIPNEST_BENCHMARK_MODE = "1";
appEnvironment.CLIPNEST_BENCHMARK_SAMPLES = String(samples);
appEnvironment.CLIPNEST_DATA_DIR = runProfile;

const child = spawn(electronPath, [repositoryRoot, "--show", "--no-input", ...(injectMissingRendererAck ? ["--simulate-no-ack"] : [])], {
  cwd: repositoryRoot,
  env: appEnvironment,
  stdio: "inherit",
  windowsHide: false,
});

let timedOut = false;
let launchError = null;
const timeout = setTimeout(() => {
  timedOut = true;
  child.kill();
}, 120_000);

child.once("error", (error) => {
  clearTimeout(timeout);
  launchError = error.message;
});
child.once("close", (exitCode, signal) => {
  clearTimeout(timeout);
  const metricsPath = path.join(runProfile, "metrics.jsonl");
  const events = fs.existsSync(metricsPath) ? fs.readFileSync(metricsPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line)) : [];
  const requests = new Map();
  for (const event of events) {
    if (event.flow !== "wake") continue;
    const request = requests.get(event.requestId) ?? [];
    request.push(event);
    requests.set(event.requestId, request);
  }

  const successful = [];
  const failed = [];
  const captureDurations = [];
  for (const [requestId, timeline] of requests) {
    const actionable = timeline.find((event) => event.stage === "panel_actionable");
    const finished = timeline.find((event) => event.stage === "request_finished");
    const capture = timeline.find((event) => event.stage === "previous_window_captured");
    if (capture) captureDurations.push(capture.stageDurationMs);
    if (actionable && finished?.outcome === "ok") successful.push({ requestId, elapsedMs: actionable.elapsedMs });
    else failed.push({ requestId, outcome: finished?.outcome ?? "missing_ack" });
  }
  const unobservedFailedSamples = Math.max(0, samples - requests.size);
  const failedSampleCount = Math.max(failed.length, samples - successful.length);

  const percentile = (values, quantile) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return Number(sorted[Math.ceil(quantile * sorted.length) - 1].toFixed(3));
  };
  const report = {
    task: "T01",
    result: !timedOut && !launchError && exitCode === 0 && requests.size === samples && successful.length === samples
      ? "PASS_COMPONENT_BASELINE"
      : "FAIL_COMPONENT_BASELINE",
    measurement: "warm main show request to renderer readiness acknowledgement (component baseline)",
    trigger: "in-process isolated benchmark cycle; not a physical hotkey measurement",
    requestedSamples: samples,
    sampleCount: requests.size,
    successfulSamples: successful.length,
    failedSamples: failedSampleCount,
    unobservedFailedSamples,
    failures: [
      ...failed,
      ...Array.from({ length: unobservedFailedSamples }, (_, index) => ({ requestId: null, outcome: `unobserved_${index + 1}` })),
    ],
    process: { exitCode, signal, timedOut, launchError },
    injectedMissingRendererAck: injectMissingRendererAck,
    wakeToActionableMs: {
      p50: percentile(successful.map((sample) => sample.elapsedMs), 0.5),
      p95: percentile(successful.map((sample) => sample.elapsedMs), 0.95),
      samples: successful.map((sample) => sample.elapsedMs),
    },
    previousWindowCaptureMs: {
      p50: percentile(captureDurations, 0.5),
      p95: percentile(captureDurations, 0.95),
      samples: captureDurations,
    },
    safety: {
      noInput: true,
      keyboardInputSent: false,
      systemClipboardRead: false,
      systemClipboardWritten: false,
      benchmarkWindowForegroundActivated: false,
      benchmarkWindowVisuallyShown: false,
      globalHotkeyRegistered: false,
      cloudSyncStarted: false,
      autoUpdaterStarted: false,
      startupConfigurationChanged: false,
      targetApplicationDisplayObserved: false,
      knownSecretEnvironmentVariablesForwarded: false,
    },
    environment: {
      platform: process.platform,
      release: os.release(),
      node: process.version,
      electron: JSON.parse(fs.readFileSync(path.join(repositoryRoot, "node_modules/electron/package.json"), "utf8")).version,
      profile: "tests/tasks/T01/runtime-profile/<isolated-run>",
    },
    note: "The invisible, inactive benchmark window avoids stealing focus. Wake timing excludes process start and physical hotkey dispatch; clipboard access, SendInput ACK, and target application display are not measured. This is a component baseline, not end-to-end P95.",
  };

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  cleanupRunProfile();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.result !== "PASS_COMPONENT_BASELINE") process.exitCode = 1;
});

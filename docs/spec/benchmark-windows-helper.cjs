// Read-only diagnostics: never invokes paste, focus, clipboard, or input APIs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const sourcePath = process.argv[2];
const outputPath = process.argv[3];
if (!sourcePath || !outputPath || process.platform !== 'win32') {
  throw new Error('Usage on Windows: node benchmark-windows-helper.cjs MAIN_JS OUTPUT_JSON');
}
const source = fs.readFileSync(sourcePath, 'utf8');
function script(name) {
  const match = source.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;'));
  if (!match) throw new Error('Missing script: ' + name);
  return match[1];
}
const foreground = script('WINDOWS_FOREGROUND_SCRIPT');
const paste = script('WINDOWS_PASTE_SCRIPT');
const compileEnd = paste.indexOf("\n'@");
if (compileEnd < 0) throw new Error('Cannot safely isolate Add-Type');
// Only compile the class; exclude the invocation following the here-string.
const pasteCompileOnly = paste.slice(0, compileEnd + 3);
if (pasteCompileOnly.includes('$sent =') || pasteCompileOnly.includes('[ClipNestKeyboard]::')) {
  throw new Error('Unsafe benchmark: an executable paste invocation remains');
}
const args = value => ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
  '-EncodedCommand', Buffer.from(value, 'utf16le').toString('base64')];
function totalTime(value, expectWindowHandle = false) {
  const start = performance.now();
  const result = spawnSync('powershell.exe', args(value), {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  // PowerShell emits benign first-use progress as CLIXML on stderr.
  // Numeric output additionally proves that foreground Add-Type succeeded.
  if (result.error || result.status !== 0 || /S="Error"/i.test(result.stderr || '')) throw new Error('Read-only helper failed: ' + (result.error?.message || result.status));
  if (expectWindowHandle && !/^\d+$/.test(result.stdout.trim())) throw new Error('Foreground helper did not return a numeric handle');
  return performance.now() - start;
}
function readinessTime(value) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const checked = "$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n" + value +
      "\nif ($null -eq ('ClipNestKeyboard' -as [type])) { throw 'Class did not compile' }\n[Console]::WriteLine('READY')";
    const child = spawn('powershell.exe', args(checked), { windowsHide: true });
    let stdout = '', stderr = '', readyMs;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Helper timed out')); }, 10000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (readyMs === undefined && stdout.includes('READY')) readyMs = performance.now() - start;
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || readyMs === undefined || stderr.trim()) reject(new Error('Compile-only helper failed: ' + code + '; ' + stderr.slice(0, 100)));
      else resolve({ readyMs, exitMs: performance.now() - start });
    });
  });
}
function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = x => Number(x.toFixed(3));
  return { n: samples.length, minMs: round(sorted[0]), medianMs: round(sorted[Math.floor(sorted.length / 2)]),
    sampleP95Ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1]), maxMs: round(sorted.at(-1)), samplesMs: samples.map(round) };
}
async function residentReadOnly() {
  const foregroundCompile = foreground.slice(0, foreground.indexOf("\n'@") + 3);
  const loop = "$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n" + foregroundCompile + `
if ($null -eq ('ClipNestForeground' -as [type])) { throw 'Class did not compile' }
[Console]::WriteLine('READY')
while ($null -ne ($command = [Console]::ReadLine())) {
  if ($command -eq 'foreground') {
    [Console]::WriteLine([ClipNestForeground]::GetForegroundWindow().ToInt64())
  } elseif ($command -eq 'exit') { break }
}
`;
  const start = performance.now();
  const child = spawn('powershell.exe', args(loop), { windowsHide: true });
  let buffer = '', queued = [], waiter, failure;
  const timer = setTimeout(() => { child.kill(); failure = new Error('Resident helper timed out'); waiter?.reject(failure); }, 10000);
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
      if (waiter) { const pending = waiter; waiter = undefined; pending.resolve(line); }
      else queued.push(line);
    }
  });
  child.on('error', error => { failure = error; waiter?.reject(error); });
  const line = () => failure ? Promise.reject(failure) : queued.length ? Promise.resolve(queued.shift()) :
    new Promise((resolve, reject) => { waiter = { resolve, reject }; });
  try {
    if (await line() !== 'READY') throw new Error('Unexpected resident response');
    const startupMs = performance.now() - start;
    const samples = [];
    for (let i = 0; i < 30; i++) {
      const requestStart = performance.now();
      child.stdin.write('foreground\n');
      if (!/^\d+$/.test(await line())) throw new Error('Invalid read-only response');
      samples.push(performance.now() - requestStart);
    }
    child.stdin.end('exit\n');
    return { startupMs: Number(startupMs.toFixed(3)), roundTrip: summarize(samples), steadyAfterFirst: summarize(samples.slice(1)) };
  } finally { clearTimeout(timer); child.kill(); }
}
(async () => {
  const empty = [], capture = [], pasteReady = [], pasteExit = [];
  for (let i = 0; i < 7; i++) {
    empty.push(totalTime('exit 0'));
    capture.push(totalTime(foreground, true));
    const compile = await readinessTime(pasteCompileOnly);
    pasteReady.push(compile.readyMs); pasteExit.push(compile.exitMs);
  }
  const result = {
    generatedAt: new Date().toISOString(), nodeVersion: process.version, sourcePath,
    sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    safety: 'Read-only GetForegroundWindow and Add-Type compilation. No clipboard access, focus restoration, SendInput, or paste execution.',
    method: 'Seven sequential, interleaved fresh-process samples per variant. Foreground matches installed spawnSync flags and validates numeric output. Compile-only stops on errors, validates class existence, rejects stderr, and measures stdout READY. Small-sample p95 is not production p95.',
    emptyProcessExit: summarize(empty), foregroundFullProcess: summarize(capture),
    pasteClassCompileReadiness: summarize(pasteReady), pasteClassCompileExit: summarize(pasteExit),
    residentForegroundRead: await residentReadOnly(),
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });

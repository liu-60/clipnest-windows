// Read-only verification of the planning package, not an application test.
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const workspaceRoot = path.resolve(root, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'task-manifest.json'), 'utf8'));
const limits = JSON.parse(fs.readFileSync(path.join(root, 'limits.v1.json'), 'utf8'));
JSON.parse(fs.readFileSync(path.join(root, 'versions.snapshot.json'), 'utf8'));
const ids = new Set(manifest.tasks.map(t => t.id));
if (ids.size !== 33 || manifest.tasks.length !== 33) throw new Error('Expected 33 unique tasks');
for (let i = 0; i <= 32; i++) if (!ids.has('T' + String(i).padStart(2, '0'))) throw new Error('Missing task');
const visited = new Set(), active = new Set();
function visit(id) {
  if (active.has(id)) throw new Error('Dependency cycle: ' + id);
  if (visited.has(id)) return;
  active.add(id);
  const task = manifest.tasks.find(t => t.id === id);
  for (const dep of task.dependencies) {
    if (!ids.has(dep)) throw new Error('Unknown dependency: ' + dep);
    visit(dep);
  }
  if (!fs.existsSync(path.join(root, task.card))) throw new Error('Missing card: ' + id);
  const card = fs.readFileSync(path.join(root, task.card), 'utf8').replace(/\r\n/g, '\n');
  const allowedSection = card.split('## 允许修改\n\n')[1]?.split('\n每次<=5个手写生产文件')[0];
  if (!allowedSection) throw new Error('Missing allowed section: ' + id);
  const cardPaths = [...allowedSection.matchAll(/^- `([^`]+)`$/gm)].map(m => m[1]);
  if (JSON.stringify(cardPaths) !== JSON.stringify(task.allowedPaths)) throw new Error('Card/manifest paths differ: ' + id);
  if (!task.allowedPaths.includes('docs/progress.json') || !task.allowedPaths.includes('docs/evidence/' + id + '/**')) throw new Error('Missing evidence permissions: ' + id);
  if (task.status !== 'not_started') throw new Error('Planning must not claim implemented tasks');
  active.delete(id); visited.add(id);
}
for (const id of ids) visit(id);
if (limits.cloud.snapshotMaxRows < limits.cloud.maxLiveEntitiesPerWorkspace) throw new Error('Snapshot cap cannot cover live cap');
if (limits.cloud.operationReceiptRetentionDays < limits.cloud.offlineDeviceLeaseDays) throw new Error('Receipt retention shorter than lease');
if (limits.transport.helperRawChunkBytes * 4 / 3 + 4096 > limits.transport.helperFrameBytes) throw new Error('Chunk does not fit frame');
if (limits.concurrency.pasteJobs !== 1) throw new Error('Paste must be serial');
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
let links = 0;
for (const file of files(root).filter(f => f.endsWith('.md'))) {
  const content = fs.readFileSync(file, 'utf8');
  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split('#')[0];
    if (!target || /^(https?:|app:|codex:)/i.test(target)) continue;
    if (path.isAbsolute(target)) throw new Error('Absolute local link is not allowed: ' + file + ' -> ' + target);
    const resolved = path.resolve(path.dirname(file), target);
    const relativeToWorkspace = path.relative(workspaceRoot, resolved);
    if (relativeToWorkspace === '..' || relativeToWorkspace.startsWith('..' + path.sep) || path.isAbsolute(relativeToWorkspace)) {
      throw new Error('Local link escapes workspace: ' + file + ' -> ' + target);
    }
    if (!fs.existsSync(resolved)) throw new Error('Broken local link: ' + file + ' -> ' + target);
    links++;
  }
}
console.log(JSON.stringify({ result: 'PASS', scope: 'planning-integrity-only', taskCards: ids.size,
  dependencyGraph: 'acyclic', cardManifestPaths: 'consistent', localLinksChecked: links, jsonFiles: 3,
  implementationProgress: 'tracked in docs/progress.json' }, null, 2));

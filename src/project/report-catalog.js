import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { writeMarkdownReport } from '../assessment/report-format.js';

export const catalogDirectory = () => path.join(process.env.SLOPPY_HOME ?? path.join(os.homedir(), '.sloppy'), 'projects');
export const projectId = root => crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24);
const manifestPattern = /^([a-f0-9]{24})(?:-([a-f0-9]{32}))?\.json$/;
const readerGraceMs = 5 * 60 * 1000;

export function registerReport(root, reportFile, directory = catalogDirectory()) {
  root = path.resolve(root);
  reportFile = path.resolve(reportFile);
  directory = path.resolve(directory);
  fs.mkdirSync(directory, { recursive: true });
  const { stat, json, report } = captureReport(reportFile);
  if (report.root !== root) throw new Error('Report root does not match its catalog entry.');
  const id = projectId(root);
  const generation = crypto.randomBytes(16).toString('hex');
  const bundle = path.join(directory, 'reports', id, generation);
  const target = path.join(directory, `${id}-${generation}.json`);
  const temporary = `${target}.tmp`;
  try {
    fs.mkdirSync(bundle, { recursive: true, mode: 0o700 });
    const backupReportFile = path.join(bundle, 'report.json');
    fs.writeFileSync(backupReportFile, json, { mode: 0o600 });
    writeMarkdownReport(report, bundle);
    fs.chmodSync(path.join(bundle, 'report.md'), 0o600);
    fs.utimesSync(backupReportFile, stat.atime, stat.mtime);
    fs.utimesSync(path.join(bundle, 'report.md'), stat.atime, stat.mtime);
    fs.writeFileSync(temporary, JSON.stringify({ root, reportFile, backupReportFile, snapshotSavedAtMs: stat.mtimeMs }) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(bundle, { recursive: true, force: true });
    throw error;
  } finally { fs.rmSync(temporary, { force: true }); }
  pruneSnapshots(directory, id);
}

function captureReport(file) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = fs.statSync(file);
    const json = fs.readFileSync(file, 'utf8');
    const stat = fs.statSync(file);
    if (before.mtimeMs !== stat.mtimeMs || before.size !== stat.size) continue;
    return { stat, json, report: JSON.parse(json) };
  }
  throw new Error('Report changed during snapshot capture; rerun the assessment.');
}

function readSnapshots(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).flatMap(name => {
    const match = manifestPattern.exec(name);
    if (!match) return [];
    const manifest = path.join(directory, name);
    try {
      const entry = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (!path.isAbsolute(entry.root) || !path.isAbsolute(entry.reportFile) || projectId(entry.root) !== match[1]) return [];
      if (entry.backupReportFile !== undefined && !path.isAbsolute(entry.backupReportFile)) return [];
      const file = entry.backupReportFile ?? entry.reportFile;
      const savedAt = Number.isFinite(entry.snapshotSavedAtMs) ? entry.snapshotSavedAtMs : fs.existsSync(file) ? fs.statSync(file).mtimeMs : -Infinity;
      return [{ ...entry, id: match[1], manifest, generation: match[2], savedAt, publishedAt: fs.statSync(manifest).mtimeMs }];
    } catch { return []; }
  }).sort((a, b) => b.savedAt - a.savedAt || b.publishedAt - a.publishedAt || b.manifest.localeCompare(a.manifest));
}

export function catalogEntries(directory = catalogDirectory()) {
  const newest = new Map();
  for (const entry of readSnapshots(directory)) if (!newest.has(entry.id)) newest.set(entry.id, entry);
  return [...newest.values()];
}

function pruneSnapshots(directory, id) {
  const snapshots = readSnapshots(directory).filter(entry => entry.id === id);
  const cutoff = Date.now() - readerGraceMs;
  const graceAnchor = snapshots.find(entry => entry.publishedAt < cutoff);
  for (const entry of snapshots.slice(1)) {
    const bundle = entry.generation ? path.join(directory, 'reports', id, entry.generation) : null;
    try {
      if (entry === graceAnchor || entry.publishedAt >= cutoff) continue;
      if (bundle && entry.backupReportFile !== path.join(bundle, 'report.json')) continue;
      fs.rmSync(entry.manifest, { force: true });
      if (bundle) fs.rmSync(bundle, { recursive: true, force: true });
    } catch { /* An overlapping publisher may already have pruned this old generation. */ }
  }
}

const ignoredDirectories = new Set([
  'node_modules', 'venv', '__pycache__', 'dist', 'build', 'coverage',
  'Library', 'Applications', 'Music', 'Pictures', 'Movies',
  '.next', '.cache', '.ruff_cache', '.pytest_cache', '.pnpm-store',
]);
const agentDirectories = new Set(['.codex', '.claude']);

// Discovery imports saved reports once; later checks register their own custom output paths.
export async function discoverReports(root, directory = catalogDirectory()) {
  const queue = [path.resolve(root)];
  let unreadableDirectories = 0;
  while (queue.length) {
    const batch = queue.splice(-32);
    const results = await Promise.all(batch.map(current => scanDirectory(current, queue, directory)));
    unreadableDirectories += results.reduce((sum, result) => sum + result, 0);
  }
  return { unreadableDirectories };
}

async function scanDirectory(current, queue, directory) {
  if (path.resolve(current) === path.resolve(directory)) return 0;
  let entries;
  try { entries = await fs.promises.readdir(current, { withFileTypes: true }); }
  catch (error) { return error.code === 'ENOENT' ? 0 : 1; }
  for (const entry of entries) await discoverEntry(current, entry, queue, directory);
  return 0;
}

async function discoverEntry(current, entry, queue, directory) {
  const location = path.join(current, entry.name);
  if (entry.name === '.git') return discoverGitReports(location, queue, directory);
  if (entry.isFile() && entry.name === 'report.json') return importReport(location, directory);
  if (!entry.isDirectory() || ignoredDirectories.has(entry.name) || entry.name.startsWith('.venv')) return;
  if (agentDirectories.has(entry.name)) {
    const worktrees = path.join(location, 'worktrees');
    if (fs.existsSync(worktrees)) queue.push(worktrees);
    return;
  }
  if (!entry.name.startsWith('.') || entry.name === '.sloppy') queue.push(location);
}

async function discoverGitReports(location, queue, directory) {
  try {
    const stat = await fs.promises.lstat(location);
    if (stat.isFile()) {
      const pointer = await fs.promises.readFile(location, 'utf8');
      const match = /^gitdir: (.+)\s*$/m.exec(pointer);
      if (match) await importReport(path.resolve(path.dirname(location), match[1].trim(), 'sloppy/report.json'), directory);
      return;
    }
    if (!stat.isDirectory()) return;
    await importReport(path.join(location, 'sloppy/report.json'), directory);
    if (fs.existsSync(path.join(location, 'worktrees'))) queue.push(path.join(location, 'worktrees'));
  } catch { /* Unreadable Git metadata is not a saved assessment. */ }
}

async function importReport(file, directory) {
  try {
    if ((await fs.promises.stat(file)).size > 64 * 1024 * 1024) return;
    const report = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    if (report.version === 1 && path.isAbsolute(report.root) && report.summary && Array.isArray(report.checks) && Array.isArray(report.findings)) {
      registerReport(report.root, file, directory);
    }
  } catch { /* Other tools also write report.json; import only readable Sloppy reports. */ }
}

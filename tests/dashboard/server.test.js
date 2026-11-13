import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { catalogEntries, discoverReports, registerReport, projectId } from '../../src/project/report-catalog.js';
import { dashboardHandler } from '../../src/dashboard/server.js';
import { readReport } from '../../src/dashboard/report-data.js';
import { buildReport, writeReport, writeMarkdownReport } from '../../src/assessment/reports.js';
import { finding } from '../../src/domain/findings.js';
import { projectsSchema, detailsSchema } from '../../dashboard/src/report-contract.ts';

async function fixture(context, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sloppy-dashboard-'));
  const directory = path.join(root, 'catalog');
  const assets = path.join(root, 'assets');
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, 'index.html'), '<title>Sloppy</title>');
  const server = http.createServer(dashboardHandler({ directory, scanRoot: root, assets, ...options }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, directory, base };
}

function saveReport(root, directory, { name = 'project', issues = [], checks = [{ name: 'structure', status: 'completed' }], mode = 'deep' } = {}) {
  const project = path.join(root, name);
  fs.mkdirSync(project, { recursive: true });
  const report = buildReport(project, { config: { project: { typescript: true } }, files: ['src/main.ts'], checks, findings: issues, mode });
  const output = path.join(project, '.sloppy');
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report));
  writeMarkdownReport(report, output);
  registerReport(project, path.join(output, 'report.json'), directory);
  return { project, id: projectId(project), file: path.join(output, 'report.json') };
}

const issue = (index, level = 'major') => finding(level === 'info' ? 'maintainability/duplicate-body' : 'python/nested-loop', {
  file: `src/file-${index}.ts`, line: index + 1, column: 1, level, message: `Review candidate ${index}`, guidance: 'Verify the evidence before editing.',
});

test('dashboard shows actual gate outcomes and keeps incomplete and missing reports visible', async context => {
  const { root, directory, base } = await fixture(context);
  saveReport(root, directory, { name: 'advisory', issues: [issue(0)] });
  saveReport(root, directory, { name: 'incomplete', checks: [{ name: 'typescript-types', status: 'failed', detail: 'Compiler unavailable' }] });
  const missing = saveReport(root, directory, { name: 'missing' });
  fs.rmSync(catalogEntries(directory).find(entry => entry.id === missing.id).manifest);
  fs.writeFileSync(path.join(directory, `${missing.id}.json`), JSON.stringify({ root: missing.project, reportFile: missing.file }));
  fs.rmSync(missing.file);
  const result = await (await fetch(`${base}/api/projects`)).json();
  assert.equal(typeof result.discovering, 'boolean');
  assert.deepEqual(result.projects.map(project => project.status), ['passed', 'incomplete', 'unavailable']);
  assert.equal(result.projects[0].summary.blockers, 0);
  assert.equal(result.projects[0].summary.findings, 1);
  assert.equal(result.projects[0].summary.levels.major, 1);
  assert.equal(result.projects[2].summary, null);
  assert.match(result.projects[2].error, /missing/);
});

test('registered reports load while discovery runs in the background', async context => {
  const { root, directory, base } = await fixture(context, { discover: () => new Promise(() => {}) });
  saveReport(root, directory);
  const response = await fetch(`${base}/api/projects`, { signal: AbortSignal.timeout(2000) });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.projects.length, 1);
  assert.equal(result.discovering, true);
});

test('overlapping registrations publish coherent bundles and keep the newest saved report', async context => {
  const { root, directory, base } = await fixture(context, { discover: () => new Promise(() => {}) });
  const project = path.join(root, 'overlap');
  fs.mkdirSync(project);
  const oldFile = path.join(root, 'old/report.json');
  const newFile = path.join(root, 'new/report.json');
  const reportFor = rule => buildReport(project, { config: { project: {} }, files: ['src/main.ts'], checks: [], findings: [finding(rule, { file: 'src/main.ts', line: 1, column: 1, message: rule, guidance: 'Review the evidence.' })], mode: 'deep' });
  const older = reportFor('eslint/older-rule');
  const newer = reportFor('eslint/newer-rule');
  for (const [file, report, time] of [[oldFile, older, 1], [newFile, newer, 2]]) {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(report));
    fs.writeFileSync(path.join(path.dirname(file), 'report.md'), 'Unrelated live Markdown');
    fs.utimesSync(file, time, time);
  }
  const originalWrite = fs.writeFileSync;
  let interleaved = false;
  fs.writeFileSync = (file, data, ...args) => {
    if (!interleaved && String(file).endsWith('.json.tmp') && JSON.parse(String(data)).reportFile === oldFile) {
      interleaved = true;
      registerReport(project, newFile, directory);
    }
    return originalWrite(file, data, ...args);
  };
  try { registerReport(project, oldFile, directory); }
  finally { fs.writeFileSync = originalWrite; }
  const entry = catalogEntries(directory).find(candidate => candidate.id === projectId(project));
  assert.equal(entry.reportFile, newFile);
  fs.writeFileSync(newFile, JSON.stringify(older));
  const json = await (await fetch(`${base}/api/projects/${entry.id}/report.json`)).json();
  const markdown = await (await fetch(`${base}/api/projects/${entry.id}/report.md`)).text();
  assert.equal(json.findings[0].ruleId, 'eslint/newer-rule');
  assert.match(markdown, /eslint\/newer-rule/);
  assert.doesNotMatch(markdown, /older-rule|Unrelated live Markdown/);
});

test('a failed manifest publication leaves the previous retained bundle intact', async context => {
  const { root, directory, base } = await fixture(context, { discover: () => new Promise(() => {}) });
  const { project, file, id } = saveReport(root, directory);
  const original = fs.readFileSync(file, 'utf8');
  const previous = catalogEntries(directory).find(entry => entry.id === id);
  const changed = JSON.parse(original); changed.summary.files = 2;
  fs.writeFileSync(file, JSON.stringify(changed));
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (path.dirname(String(target)) === directory && String(target).endsWith('.json')) throw new Error('Publication interrupted');
    return rename(source, target);
  };
  try { assert.throws(() => registerReport(project, file, directory), /Publication interrupted/); }
  finally { fs.renameSync = rename; }
  assert.equal(catalogEntries(directory).find(entry => entry.id === id).backupReportFile, previous.backupReportFile);
  assert.equal(await (await fetch(`${base}/api/projects/${id}/report.json`)).text(), original);
});

test('superseding an old winner preserves it for an already-started reader', async context => {
  const { root, directory } = await fixture(context, { discover: () => new Promise(() => {}) });
  const { project, file, id } = saveReport(root, directory);
  const previous = catalogEntries(directory).find(entry => entry.id === id);
  const oldPublication = Date.now() / 1000 - 600;
  fs.utimesSync(previous.manifest, oldPublication, oldPublication);
  const pendingRead = readReport(previous);
  const changed = JSON.parse(fs.readFileSync(file, 'utf8')); changed.summary.files = 2;
  fs.writeFileSync(file, JSON.stringify(changed));
  const newerTime = previous.snapshotSavedAtMs / 1000 + 1;
  fs.utimesSync(file, newerTime, newerTime);
  registerReport(project, file, directory);
  assert.equal((await pendingRead).report.summary.files, 1);
  assert.equal(fs.existsSync(previous.backupReportFile), true);
});

test('temporary assessment output remains available after its folder is removed', async context => {
  const { root, directory, base } = await fixture(context);
  const { id, file } = saveReport(root, directory, { name: 'temporary-project', issues: [issue(0)] });
  const original = fs.readFileSync(file, 'utf8');
  const originalMarkdown = fs.readFileSync(path.join(path.dirname(file), 'report.md'), 'utf8');
  const savedTime = fs.statSync(file).mtimeMs;
  fs.rmSync(path.dirname(file), { recursive: true });
  const response = await fetch(`${base}/api/projects/${id}`);
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.name, 'temporary-project');
  assert.equal(detail.summary.findings, 1);
  assert.equal(detail.status, 'passed');
  assert.ok(Math.abs(new Date(detail.savedAt).getTime() - savedTime) < 2);
  assert.equal(await (await fetch(`${base}/api/projects/${id}/report.json`)).text(), original);
  assert.equal(await (await fetch(`${base}/api/projects/${id}/report.md`)).text(), originalMarkdown);
});

test('report details filter and paginate surfaced findings while preserving complete totals', async context => {
  const { root, directory, base } = await fixture(context);
  const issues = Array.from({ length: 121 }, (_, index) => issue(index, index === 120 ? 'info' : 'major'));
  const { id } = saveReport(root, directory, { issues, mode: 'default' });
  const first = await (await fetch(`${base}/api/projects/${id}`)).json();
  assert.equal(first.summary.findings, 121);
  assert.equal(first.summary.hidden, 1);
  assert.equal(first.summary.groups.review.total, 121);
  assert.equal(first.summary.groups.review.blockers, 0);
  assert.equal(first.total, 120);
  assert.equal(first.findings.length, 50);
  assert.equal(first.findings[0].blocksGate, false);
  assert.equal(first.pages, 3);
  const last = await (await fetch(`${base}/api/projects/${id}?page=3`)).json();
  assert.equal(last.findings.length, 20);
  const search = await (await fetch(`${base}/api/projects/${id}?q=file-19.ts&level=major`)).json();
  assert.equal(search.total, 1);
  assert.equal(search.findings[0].file, 'src/file-19.ts');
  assert.equal(search.findings[0].id, first.findings.find(item => item.file === 'src/file-19.ts').id);
  assert.equal((await fetch(`${base}/api/projects/${id}?level=fake`)).status, 400);
  assert.equal((await fetch(`${base}/api/projects/${id}?page=1.5`)).status, 400);
  const sorted = await (await fetch(`${base}/api/projects/${id}?sort=file&direction=desc`)).json();
  assert.equal(sorted.findings[0].file, 'src/file-119.ts');
  const sortedNext = await (await fetch(`${base}/api/projects/${id}?sort=file&direction=desc&page=2`)).json();
  assert.equal(sortedNext.findings[0].file, 'src/file-69.ts');
  assert.equal((await fetch(`${base}/api/projects/${id}?sort=unknown`)).status, 400);
  assert.equal((await fetch(`${base}/api/projects/${id}/report.md`)).status, 200);
  assert.equal((await fetch(`${base}/api/projects/${'a'.repeat(24)}`)).status, 404);
});

test('discovery imports standard, custom and linked-worktree reports, choosing the latest per root', async context => {
  const { root, directory } = await fixture(context);
  const standard = saveReport(root, directory);
  const custom = path.join(standard.project, 'custom-output');
  fs.mkdirSync(custom);
  fs.copyFileSync(standard.file, path.join(custom, 'report.json'));
  const originalTime = fs.statSync(standard.file).mtimeMs / 1000;
  fs.utimesSync(standard.file, originalTime + 1, originalTime + 1);
  fs.utimesSync(path.join(custom, 'report.json'), originalTime + 2, originalTime + 2);
  fs.mkdirSync(path.join(root, 'node_modules/ignored'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/ignored/report.json'), fs.readFileSync(standard.file));
  const linked = saveReport(root, directory, { name: 'linked' });
  const gitMetadata = path.join(root, 'metadata');
  fs.mkdirSync(path.join(gitMetadata, 'sloppy'), { recursive: true });
  fs.renameSync(linked.file, path.join(gitMetadata, 'sloppy/report.json'));
  fs.writeFileSync(path.join(linked.project, '.git'), `gitdir: ../metadata\n`);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ version: 1, results: [] }));
  await discoverReports(root, directory);
  const entries = catalogEntries(directory);
  assert.equal(entries.length, 2);
  assert.equal(entries.find(entry => entry.id === standard.id).reportFile, path.join(custom, 'report.json'));
  assert.equal(entries.find(entry => entry.id === linked.id).reportFile, path.join(gitMetadata, 'sloppy/report.json'));
});

test('HTTP access rejects other origins, rebinding hosts, mutation and filesystem traversal', async context => {
  const { base } = await fixture(context);
  assert.equal((await fetch(`${base}/api/projects`, { headers: { Origin: 'https://other.example' } })).status, 403);
  const rebindingStatus = await new Promise(resolve => {
    http.get(`${base}/api/projects`, { headers: { Host: 'other.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
  });
  assert.equal(rebindingStatus, 403);
  assert.equal((await fetch(`${base}/api/projects`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/api/projects/../../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e%2fpackage.json`)).status, 404);
  assert.equal((await fetch(base)).status, 200);
  const malformedStatus = await new Promise((resolve, reject) => {
    const target = new URL(base);
    http.get({ hostname: target.hostname, port: target.port, path: '//[' }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(malformedStatus, 400);
  assert.equal((await fetch(`${base}/api/projects`)).status, 200);
});

test('legacy and malformed Git metadata stay isolated through the HTTP and frontend schemas', async context => {
  const { root, directory, base } = await fixture(context);
  saveReport(root, directory, { name: 'good' });
  const legacy = saveReport(root, directory, { name: 'legacy' });
  const malformed = saveReport(root, directory, { name: 'malformed' });
  const legacyReport = JSON.parse(fs.readFileSync(legacy.file, 'utf8'));
  legacyReport.revision = { commit: 'abc' };
  legacyReport.summary.levels.obsolete = 'old metadata';
  fs.writeFileSync(legacy.file, JSON.stringify(legacyReport));
  registerReport(legacy.project, legacy.file, directory);
  const malformedReport = JSON.parse(fs.readFileSync(malformed.file, 'utf8'));
  malformedReport.revision = { commit: 123, dirty: false };
  fs.writeFileSync(malformed.file, JSON.stringify(malformedReport));
  registerReport(malformed.project, malformed.file, directory);
  const data = await (await fetch(`${base}/api/projects`)).json();
  assert.equal(projectsSchema.safeParse(data).success, true);
  assert.deepEqual(data.projects.map(project => project.status), ['passed', 'passed', 'unavailable']);
  assert.equal(data.projects.find(project => project.id === legacy.id).revision.dirty, null);
  const detail = await (await fetch(`${base}/api/projects/${legacy.id}`)).json();
  assert.equal(detailsSchema.safeParse(detail).success, true);
});

test('retained Markdown and dashboard agree on pre-classification version-one findings', async context => {
  const { root, directory, base } = await fixture(context, { discover: () => new Promise(() => {}) });
  const { project, file, id } = saveReport(root, directory, { issues: [finding('eslint/legacy-error', { file: 'src/main.ts', line: 4, column: 1, severity: 'error', message: 'Legacy error', guidance: 'Inspect the diagnostic.' })] });
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete report.findings[0].level; delete report.findings[0].kind; delete report.findings[0].confidence;
  delete report.findings[0].blocksGate; delete report.findings[0].ownership;
  delete report.summary.levels; delete report.summary.groups;
  delete report.summary.levelConfidence; delete report.summary.sourceGroups;
  delete report.hotspots; delete report.staleBaseline;
  const raw = JSON.stringify(report); fs.writeFileSync(file, raw);
  registerReport(project, file, directory);
  const detail = await (await fetch(`${base}/api/projects/${id}`)).json();
  assert.equal(detailsSchema.safeParse(detail).success, true);
  assert.equal(detail.findings[0].level, 'major');
  assert.equal(detail.findings[0].blocksGate, true);
  const markdown = await (await fetch(`${base}/api/projects/${id}/report.md`)).text();
  assert.match(markdown, /## Major\n\n- `eslint\/legacy-error` \[diagnostic\] \[blocking\]/);
  assert.match(markdown, /Unknown/);
  assert.doesNotMatch(markdown, /## Major\n\nNone/);
  assert.equal(await (await fetch(`${base}/api/projects/${id}/report.json`)).text(), raw);
});

test('legacy reports keep unavailable category analytics distinct from zero findings', async context => {
  const { root, directory, base } = await fixture(context);
  const { file, id } = saveReport(root, directory, { issues: [issue(0)] });
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete report.summary.groups;
  fs.writeFileSync(file, JSON.stringify(report));
  registerReport(root + '/project', file, directory);
  const detail = await (await fetch(`${base}/api/projects/${id}`)).json();
  assert.equal(detail.summary.groups, null);
  assert.equal(detail.summary.findings, 1);
  assert.equal(detail.summary.blockers, 0);
  report.summary.groups = [{ total: 1, gateErrors: 0 }];
  fs.writeFileSync(file, JSON.stringify(report));
  registerReport(root + '/project', file, directory);
  const invalidGroups = await (await fetch(`${base}/api/projects/${id}`)).json();
  assert.equal(invalidGroups.summary.groups, null);
});

test('report publication registers custom output without changing deterministic report content', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sloppy-publication-'));
  const previous = process.env.SLOPPY_HOME;
  process.env.SLOPPY_HOME = path.join(root, 'storage');
  context.after(() => {
    if (previous === undefined) delete process.env.SLOPPY_HOME;
    else process.env.SLOPPY_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const report = buildReport(root, { config: { project: {} }, files: ['main.js'], checks: [], findings: [] });
  const original = JSON.stringify(report);
  const output = path.join(root, 'custom-output');
  writeReport(report, output);
  assert.equal(JSON.stringify(report), original);
  assert.deepEqual(catalogEntries().map(entry => entry.reportFile), [path.join(output, 'report.json')]);
});

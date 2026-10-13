import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finding } from '../../src/domain/findings.js';
import { buildReport, formatReportSummary, formatReportTags, writeReport } from '../../src/assessment/reports.js';

function fixture(context, findings = [], options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sloppy-report-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = buildReport(root, {
    config: { project: {}, exclude: ['generated/**'] },
    files: ['src/main.ts', 'tests/main.test.ts', 'scripts/build.js'],
    checks: [{ name: 'structure', status: 'completed' }], findings,
    ...options,
  });
  const output = path.join(root, 'report');
  return { root, report, output };
}

function issue(ruleId, level, file = 'src/main.ts') {
  return finding(ruleId, { level, file, line: 1, column: 1, message: ruleId, guidance: 'Inspect the evidence.' });
}

test('reports lead with severity totals and tag categories without changing JSON', context => {
  const { report, output } = fixture(context, [
    issue('python/fat-activity', 'critical'),
    issue('python/dependency-cve', 'critical', '../dependency'),
    issue('eslint/no-debugger', 'major'),
    issue('python/nested-loop', 'major'),
    issue('typescript/TS2322', 'major', '../external.ts'),
    issue('structure/file', 'minor', 'tests/main.test.ts'),
    issue('eslint/directive', 'minor', 'generated/client.ts'),
    issue('maintainability/duplicate-body', 'info', 'scripts/build.js'),
  ]);
  assert.equal(formatReportSummary(report), 'FAIL: 8 findings; 2 critical, 3 major, 2 minor, 1 info.');
  assert.equal(report.summary.gateErrors, 4);
  assert.equal(formatReportTags(report), 'Tags: [diagnostic] 1, [policy] 2, [review] 2, [dependency] 1, [outside-scope] 2; [blocking] 4, [advisory] 4.');
  const before = JSON.stringify(report);
  writeReport(report, output);
  const markdown = fs.readFileSync(path.join(output, 'report.md'), 'utf8');
  assert.match(markdown, /^# Sloppy report\n\nFAIL: 8 findings; 2 critical, 3 major, 2 minor, 1 info\./);
  const headings = ['## Critical', '## Major', '## Minor', '## Info', '## Categories'];
  for (const [index, heading] of headings.entries()) {
    assert.ok(markdown.includes(heading), heading);
    if (index) assert.ok(markdown.indexOf(headings[index - 1]) < markdown.indexOf(heading));
  }
  assert.match(markdown, /`python\/fat-activity` \[policy\] \[blocking\]/);
  assert.match(markdown, /`python\/nested-loop` \[review\] \[advisory\]/);
  assert.match(markdown, /`python\/dependency-cve` \[dependency\] \[blocking\]/);
  assert.match(markdown, /`typescript\/TS2322` \[diagnostic\] \[blocking\] \[outside-scope\]/);
  assert.match(markdown, /`eslint\/directive` \[diagnostic\] \[advisory\] \[outside-scope\]/);
  assert.match(markdown, /\| \[review\] \| 0 \| 1 \| 0 \| 1 \|/);
  assert.match(markdown, /\| \[outside-scope\] \| 0 \| 1 \| 1 \| 0 \|/);
  assert.match(markdown, /\| Tests and fixtures \| 1 \| 0 \| 0 \| 1 \| 0 \|/);
  assert.equal(markdown.match(/`python\/nested-loop`/g).length, 1);
  assert.doesNotMatch(markdown, /## Gate blockers|## Review leads|\| Blockers \|/);
  assert.equal(JSON.stringify(report), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8')), report);
});

test('major advisory findings count in severity totals without failing the gate', context => {
  const { report, output } = fixture(context, [issue('python/nested-loop', 'major')]);
  assert.equal(formatReportSummary(report), 'PASS: 1 finding; 0 critical, 1 major, 0 minor, 0 info.');
  assert.equal(report.passed, true);
  assert.equal(report.summary.gateErrors, 0);
  assert.equal(formatReportTags(report), 'Tags: [review] 1; [blocking] 0, [advisory] 1.');
  writeReport(report, output);
  const markdown = fs.readFileSync(path.join(output, 'report.md'), 'utf8');
  assert.match(markdown, /## Critical\n\nNone\./);
  assert.match(markdown, /\[review\] \[advisory\]/);
  assert.match(markdown, /## Info\n\nNone\./);
});

test('baseline findings stay out of active severity totals and retain their evidence', context => {
  const existing = issue('python/fat-activity', 'critical');
  const { root, output } = fixture(context);
  fs.writeFileSync(path.join(root, 'baseline.json'), JSON.stringify({ version: 1, fingerprints: [existing.fingerprint] }));
  const report = buildReport(root, {
    config: { project: {}, baseline: 'baseline.json' }, files: ['src/main.ts'],
    checks: [], findings: [existing, issue('python/nested-loop', 'major')],
  });
  assert.equal(formatReportSummary(report), 'PASS: 1 finding; 0 critical, 1 major, 0 minor, 0 info.');
  assert.equal(report.summary.baseline, 1);
  writeReport(report, output);
  const markdown = fs.readFileSync(path.join(output, 'report.md'), 'utf8');
  assert.match(markdown, /1 baseline finding/);
  assert.doesNotMatch(markdown, /`python\/fat-activity`/);
  assert.equal(report.findings.find(item => item.ruleId === 'python/fat-activity').baseline, true);
});

test('incomplete assessments keep partial counts and failed checks visible', context => {
  const { report, output } = fixture(context, [], { checks: [{ name: 'lint', status: 'failed', detail: 'Missing tool' }] });
  assert.equal(formatReportSummary(report), 'INCOMPLETE: 0 findings; 0 critical, 0 major, 0 minor, 0 info.');
  assert.equal(formatReportTags(report), 'Tags: [blocking] 0, [advisory] 0.');
  writeReport(report, output);
  const markdown = fs.readFileSync(path.join(output, 'report.md'), 'utf8');
  assert.match(markdown, /Counts may be partial/);
  assert.match(markdown, /Failed: lint/);
  assert.equal(report.complete, false);
  assert.equal(report.passed, false);
});

test('critical review findings appear once and keep their blocking tag', context => {
  const { report, output } = fixture(context, [issue('python/nested-loop', 'critical')]);
  assert.equal(report.passed, false);
  assert.equal(report.summary.gateErrors, 1);
  writeReport(report, output);
  const markdown = fs.readFileSync(path.join(output, 'report.md'), 'utf8');
  assert.match(markdown, /## Critical\n\n- `python\/nested-loop` \[review\] \[blocking\]/);
  assert.equal(markdown.match(/`python\/nested-loop`/g).length, 1);
});

test('rule groups preserve outside-scope tags and indicate truncated lists', context => {
  const findings = [issue('eslint/no-debugger', 'major'), issue('eslint/no-debugger', 'major', '../external.ts'),
    ...Array.from({ length: 5 }, (_, index) => issue(`structure/metric-${index}`, 'major'))];
  const { report, output } = fixture(context, findings);
  writeReport(report, output);
  const markdown = fs.readFileSync(path.join(output, 'report.md'), 'utf8');
  assert.match(markdown, /`eslint\/no-debugger` \[diagnostic\] \[blocking\]: 1 finding/);
  assert.match(markdown, /`eslint\/no-debugger` \[diagnostic\] \[blocking\] \[outside-scope\]: 1 finding/);
  assert.match(markdown, /1 more rule group in report.json/);
});

test('large severity totals are readable and the example matches the renderer', context => {
  const { report, output } = fixture(context);
  report.summary.levels = { info: 0, minor: 161, major: 961, critical: 0 };
  report.passed = false;
  assert.equal(formatReportSummary(report), 'FAIL: 1,122 findings; 0 critical, 961 major, 161 minor, 0 info.');
  const example = JSON.parse(fs.readFileSync(new URL('../../examples/agent-report.json', import.meta.url), 'utf8'));
  writeReport(example, output);
  const markdown = fs.readFileSync(path.join(output, 'report.md'), 'utf8').trimEnd();
  assert.equal(markdown, fs.readFileSync(new URL('../../examples/agent-report.md', import.meta.url), 'utf8').trimEnd());
});

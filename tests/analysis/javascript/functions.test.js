import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { codeHealth, unreachableModules } from "../../../src/analysis/javascript/functions.js";
import { defaults, load, CONFIG } from "../../../src/project/policies.js";
import { lintTypescript } from '../../../src/analysis/javascript/lint-source.js';
import { pythonLint } from '../../../src/analysis/python/lint.js';
import { analyzePython } from "../../../src/analysis/python/source.js";
import { analyzeTypescript } from "../../../src/analysis/javascript/source-files.js";
import { buildReport, writeReport } from "../../../src/assessment/reports.js";
import { check } from "../../../src/assessment/assess-project.js";

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries(files)) fs.writeFileSync(path.join(root, file), contents);
  return { root, config: defaults(root) };
}

test('lint catches unused bindings, unreachable code and redundant error handling', async t => {
  const { root, config } = fixture(t, { 'sample.ts': 'export function work(flag: boolean) { const unused = 2; try { if (flag) return 1; else if (flag) return 2; return 3; console.log(4); } catch (error) { throw error; } }' });
  config.checks.typescriptTypes = false;
  const issues = await lintTypescript(root, ['sample.ts'], config);
  for (const rule of ['@typescript-eslint/no-unused-vars', 'no-unreachable', 'no-dupe-else-if', 'no-useless-catch']) assert.ok(issues.some(f => f.ruleId === `eslint/${rule}`), rule);
});

test('wrapper candidates avoid receiver calls, argument changes and async boundaries', () => {
  const text = 'function a(x: number) { return work(x); } function b(x: number) { return service.work(x); } async function c(x: number) { return work(x); } function d(x: number) { return work(x + 1); } values.map(x => work(x)); function isValue(x: unknown): x is string { return check(x); }';
  const issues = codeHealth(ts.createSourceFile('sample.ts', text, ts.ScriptTarget.Latest, true), 'sample.ts');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'warning');
  assert.equal(issues[0].autoFix, false);
});

test('duplicate bodies ignore formatting but preserve values and short idioms', () => {
  const body = 'const result = value + 1; if (result > 10) { return result * 2; } const next = result + 2; const final = next * 3; return final + value;';
  const text = `function one(value: number) { ${body} } function two(value: number) { ${body.replaceAll(';', ';\n')} } function three(value: number) { ${body.replace('> 10', '> 11')} }`;
  const issues = codeHealth(ts.createSourceFile('sample.ts', text, ts.ScriptTarget.Latest, true), 'sample.ts');
  assert.equal(issues.filter(f => f.ruleId === 'maintainability/duplicate-body').length, 1);
});

test('module candidates follow type imports and protected entry points, never guessed roots', t => {
  const { root, config } = fixture(t, { 'entry.ts': "import type { Data } from './types'; export const value: Data = 1;", 'types.ts': 'export type Data = number;', 'route.ts': 'export const GET = () => 1;', 'orphan.ts': 'export const orphan = 1;' });
  const files = ['entry.ts', 'types.ts', 'route.ts', 'orphan.ts'];
  assert.equal(analyzeTypescript(root, files, config).filter(f => f.ruleId.startsWith('dead-code/')).length, 0);
  config.deadCode = { entryPoints: ['entry.ts'], protected: ['route.ts'] };
  const candidates = analyzeTypescript(root, files, config).filter(f => f.ruleId.startsWith('dead-code/'));
  assert.deepEqual(candidates.map(f => f.file), ['orphan.ts']);
  assert.equal(candidates[0].severity, 'warning');
  const report = buildReport(root, { config, files, checks: [{ name: 'structure', status: 'passed' }], findings: candidates });
  writeReport(report, path.join(root, 'report'));
  const plan = JSON.parse(fs.readFileSync(path.join(root, 'report/repair-plan.json')));
  assert.equal(plan.tasks[0].findings[0].evidence.confidence, 'review-candidate');
  assert.equal(plan.tasks[0].findings[0].autoFix, false);
  assert.throws(() => unreachableModules(new Map([['entry.ts', []]]), { deadCode: { entryPoints: ['typo.ts'], protected: [] } }), /matches no selected/);
});

test('old configs remain valid and malformed dead-code policies fail', t => {
  const { root, config } = fixture(t, {});
  delete config.deadCode;
  fs.writeFileSync(path.join(root, CONFIG), JSON.stringify(config));
  assert.doesNotThrow(() => load(root));
  config.deadCode = { entryPoints: 'entry.ts', protected: [] };
  fs.writeFileSync(path.join(root, CONFIG), JSON.stringify(config));
  assert.throws(() => load(root), /deadCode.entryPoints/);
});

test('Python unreachable checks respect block boundaries and finally cleanup', t => {
  const { root, config } = fixture(t, { 'sample.py': 'def work(flag):\n    if flag:\n        return 1\n    try:\n        return 2\n        print("dead")\n    finally:\n        print("cleanup")\n\ndef other():\n    for x in range(3):\n        continue\n        print(x)\n    print("reachable")\n' });
  const issues = analyzePython(root, ['sample.py'], config).filter(f => f.ruleId === 'dead-code/unreachable-statement');
  assert.deepEqual(issues.map(f => f.line), [6, 13]);
  assert.ok(issues.every(f => f.evidence.confidence === 'syntax-proven' && f.severity === 'error'));
});

test('Python lint already detects unused imports and local variables', t => {
  const { root, config } = fixture(t, { 'sample.py': 'import math\n\ndef work() -> int:\n    unused = 2\n    return 1\n' });
  const issues = pythonLint(root, ['sample.py'], config);
  assert.ok(issues.some(f => f.ruleId === 'ruff/F401'));
  assert.ok(issues.some(f => f.ruleId === 'ruff/F841'));
});

test('JavaScript-only projects are detected, linted and structurally assessed', async t => {
  const { root, config } = fixture(t, { 'example.js': 'export function work(flag) { const unused = 1; if (flag) return 1; else if (flag) return 2; return 3; console.log("dead"); }' });
  assert.equal(config.project.javascript, true);
  assert.equal(config.checks.javascriptLint, true);
  config.limits.complexity = [1, 2];
  fs.writeFileSync(path.join(root, CONFIG), JSON.stringify(config));
  const report = await check(root, path.join(root, '.sloppy'));
  assert.equal(report.summary.files, 1);
  assert.equal(report.complete, true);
  assert.equal(report.passed, false);
  assert.equal(report.checks.find(c => c.name === 'javascript-lint').status, 'completed');
  for (const rule of ['eslint/no-unreachable', 'eslint/no-dupe-else-if', 'eslint/@typescript-eslint/no-unused-vars', 'structure/complexity']) assert.ok(report.findings.some(f => f.ruleId === rule), rule);
  assert.equal(report.checks.find(c => c.name === 'typescript-types').status, 'skipped');
});

test('file naming accepts E2E and stacked framework suffixes without accepting arbitrary dots', context => {
  const files = ['work.e2e.ts', 'vite.server.config.ts', 'work.client.test.ts', 'work.unknown.ts'];
  const { root, config } = fixture(context, Object.fromEntries(files.map(file => [file, 'export const value = 1;'])));
  const findings = analyzeTypescript(root, files, config).filter(item => item.ruleId === 'naming/file');
  assert.deepEqual(findings.map(item => item.file), ['work.unknown.ts']);
});

test('erased import cycles remain advisory while runtime cycles still block', context => {
  const { root, config } = fixture(context, {
    'composition.ts': 'import { adapter } from "./adapter"; export type Contract = number; export const result = adapter;',
    'adapter.ts': 'import type { Contract } from "./composition"; export const adapter: Contract = 1;',
    'runtime.ts': 'import { result } from "./other"; export const value = result;',
    'other.ts': 'import { value } from "./runtime"; export const result = value;',
  });
  const graph = { edges: [], unresolved: [] };
  const findings = analyzeTypescript(root, ['composition.ts', 'adapter.ts', 'runtime.ts', 'other.ts'], config, graph);
  const typeCycle = findings.find(item => item.ruleId === 'architecture/type-import-cycle');
  assert.ok(typeCycle);
  assert.equal(typeCycle.kind, 'review');
  assert.equal(typeCycle.blocksGate, false);
  assert.ok(findings.find(item => item.ruleId === 'architecture/circular-import').blocksGate);
  assert.ok(graph.edges.some(edge => edge.source === 'adapter.ts' && edge.typeOnly));
});

test('mixed value imports and CommonJS cycles still block while erased exports remain advisory', context => {
  const { root, config } = fixture(context, {
    'mixed.ts': 'import { type Contract, adapter } from "./value"; export const result: Contract = adapter;',
    'value.ts': 'import { result } from "./mixed"; export type Contract = number; export const adapter = result;',
    'contract.ts': 'export type { Contract } from "./types"; export const result = 1;',
    'types.ts': 'import { result } from "./contract"; export type Contract = typeof result;',
    'first.cjs': 'const result = require("./second.cjs"); exports.result = result;',
    'second.cjs': 'const result = require("./first.cjs"); exports.result = result;',
  });
  const findings = analyzeTypescript(root, ['mixed.ts', 'value.ts', 'contract.ts', 'types.ts', 'first.cjs', 'second.cjs'], config);
  assert.equal(findings.filter(item => item.ruleId === 'architecture/circular-import' && item.blocksGate).length, 2);
  assert.equal(findings.filter(item => item.ruleId === 'architecture/type-import-cycle' && !item.blocksGate).length, 1);
});

test('reports distinguish source work from tests and tooling without dropping their blockers', context => {
  const { root, config } = fixture(context, { 'source.ts': 'export const value = 1;' });
  const item = (file, ruleId) => ({ file, ruleId, line: 1, column: 1, severity: 'error', level: 'major', kind: 'policy', confidence: 'high', blocksGate: true, fingerprint: `${file}:${ruleId}` });
  const report = buildReport(root, { config, files: ['source.ts', 'tests/owner.test.ts', '.agents/skills/tool/script.py'], checks: [], findings: [
    item('source.ts', 'structure/function'), item('tests/owner.test.ts', 'structure/function'),
    item('tests/owner.test.ts', 'structure/complexity'), item('.agents/skills/tool/script.py', 'structure/function'),
  ] });
  assert.equal(report.summary.gateErrors, 4);
  assert.equal(report.summary.sourceGroups.test.gateErrors, 2);
  assert.equal(report.summary.sourceGroups.tooling.files, 1);
  assert.equal(report.hotspots[0].file, 'source.ts');
  writeReport(report, path.join(root, 'report'));
  const plan = JSON.parse(fs.readFileSync(path.join(root, 'report/repair-plan.json')));
  assert.deepEqual(plan.tasks.map(task => task.sourceRole), ['source', 'test', 'tooling']);
  assert.match(fs.readFileSync(path.join(root, 'report/report.md'), 'utf8'), /Tests and fixtures/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { codeHealth, unreachableModules } from '../src/code-health.js';
import { defaults, load, CONFIG } from '../src/config.js';
import { lintTypescript, pythonLint } from '../src/engines.js';
import { analyzePython } from '../src/python.js';
import { analyzeTypescript } from '../src/typescript.js';
import { buildReport, writeReport } from '../src/report.js';

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
  const report = buildReport(root, config, files, [{ name: 'structure', status: 'passed' }], candidates);
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

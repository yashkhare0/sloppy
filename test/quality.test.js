import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defaults, load, CONFIG } from '../src/config.js';
import { analyzeTypescript } from '../src/typescript.js';
import { analyzePython } from '../src/python.js';
import { check } from '../src/check.js';
import { installHook } from '../src/hook.js';
import { run } from '../src/process.js';

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  }
  const config = defaults(root);
  return { root, config, save: () => fs.writeFileSync(path.join(root, CONFIG), JSON.stringify(config)) };
}
test('detects Next.js and shadcn without editing project manifests', t => {
  const { config } = fixture(t, { 'package.json': '{"dependencies":{"next":"16","react":"19"}}', 'components.json': '{}', 'app/page.tsx': 'export default function Page() { return <p>Hello</p>; }' });
  assert.equal(config.project.next, true);
  assert.equal(config.project.react, true);
  assert.equal(config.project.shadcn, true);
});
test('function metrics exclude nested function complexity but inspect both functions', t => {
  const { root, config } = fixture(t, { 'example.ts': 'function outer() {\n function inner() { if (true) { if (true) { return 1; } } }\n return inner();\n}' });
  config.limits.complexity = [1, 2];
  const findings = analyzeTypescript(root, ['example.ts'], config);
  assert.equal(findings.filter(f => f.ruleId === 'structure/complexity').length, 1);
  assert.equal(findings.find(f => f.ruleId === 'structure/complexity').symbol, 'inner');
});
test('metrics ignore comments and blank lines and report editable limits', t => {
  const { root, config } = fixture(t, { 'small.ts': '// comment\n\n// another\nexport const x = 1;\nexport const y = 2;\nexport const z = 3;' });
  config.limits.file = [1, 2];
  const issue = analyzeTypescript(root, ['small.ts'], config).find(f => f.ruleId === 'structure/file');
  assert.deepEqual(issue.evidence, { measured: 3, warning: 1, error: 2, unit: 'code lines' });
});
test('resolves local cycles and configured import boundaries', t => {
  const { root, config } = fixture(t, { 'src/shared/a.ts': "import { b } from '../features/b'; export const a = b;", 'src/features/b.ts': "import { a } from '../shared/a'; export const b = a;" });
  const findings = analyzeTypescript(root, ['src/shared/a.ts', 'src/features/b.ts'], config);
  assert.ok(findings.some(f => f.ruleId === 'architecture/import-boundary'));
  assert.ok(findings.some(f => f.ruleId === 'architecture/circular-import'));
});
test('Python parser counts functions and handles syntax errors', t => {
  const { root, config } = fixture(t, { 'example.py': 'def work(a, b, c, d, e, f, g):\n    """Documentation"""\n    return a\n', 'broken.py': 'def nope(:\n pass' });
  const findings = analyzePython(root, ['example.py', 'broken.py'], config);
  assert.ok(findings.some(f => f.ruleId === 'structure/parameters' && f.evidence.measured === 7));
  assert.ok(findings.some(f => f.ruleId === 'python/syntax'));
});
test('missing tools produce an incomplete report, never a pass', async t => {
  const { root, config, save } = fixture(t, { 'example.py': 'def work() -> int:\n    return 1\n' });
  config.python.ruffExecutable = 'nonexistent-quality-tool-xyz'; config.checks.pythonTypes = false;
  save();
  const report = await check(root, path.join(root, 'report'));
  assert.equal(report.complete, false); assert.equal(report.passed, false);
  assert.equal(report.checks.find(c => c.name === 'python-lint').status, 'failed');
  assert.ok(fs.existsSync(path.join(root, 'report/report.json')));
});
test('empty projects cannot pass', async t => {
  const { root, save } = fixture(t, {}); save();
  const report = await check(root, path.join(root, 'report'));
  assert.equal(report.passed, false); assert.equal(report.complete, false);
});
test('invalid thresholds and misspelled config keys fail explicitly', t => {
  const { root, config, save } = fixture(t, {});
  config.limits.file = [500, 300]; save();
  assert.throws(() => load(root), /Invalid limit/);
  config.limits.file = [300, 500]; config.limts = {}; save();
  assert.throws(() => load(root), /Unknown configuration key/);
});
test('baseline suppresses only recorded instances and retains their evidence', async t => {
  const { root, config, save } = fixture(t, { 'example.ts': 'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n' });
  config.checks.typescriptLint = false; config.checks.typescriptTypes = false; config.limits.file = [1, 2]; save();
  const first = await check(root, path.join(root, 'report'));
  fs.writeFileSync(path.join(root, 'baseline.json'), JSON.stringify({ version: 1, fingerprints: first.findings.map(f => f.fingerprint) }));
  config.baseline = 'baseline.json'; save();
  const second = await check(root, path.join(root, 'report'));
  assert.equal(second.passed, true); assert.equal(second.findings[0].baseline, true);
  fs.appendFileSync(path.join(root, 'example.ts'), 'export const z2 = 4;\n');
  const changed = await check(root, path.join(root, 'report'));
  assert.equal(changed.passed, false);
});
test('hook preserves existing hooks and install is idempotent', t => {
  const { root } = fixture(t, {});
  assert.equal(run('git', ['init', '--quiet'], root).status, 0);
  const hook = installHook(root);
  assert.equal(installHook(root), hook);
  fs.writeFileSync(hook, '#!/bin/sh\necho custom\n');
  assert.throws(() => installHook(root), /Existing hook preserved/);
  assert.match(fs.readFileSync(hook, 'utf8'), /echo custom/);
});
test('full TypeScript lint and type checking pass clean code and detect unsafe code', async t => {
  const { root, config, save } = fixture(t, {
    'tsconfig.json': '{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true,"exactOptionalPropertyTypes":true,"target":"ES2022","module":"ESNext","moduleResolution":"Bundler"},"include":["*.ts"]}',
    'example.ts': 'export function increment(value: number): number { return value + 1; }\n',
  });
  save();
  const clean = await check(root, path.join(root, 'report'));
  assert.equal(clean.passed, true, JSON.stringify(clean));
  fs.writeFileSync(path.join(root, 'example.ts'), 'export function unsafe(value: any) { return value.nope(); }\n');
  const bad = await check(root, path.join(root, 'report'));
  assert.equal(bad.passed, false);
  assert.ok(bad.findings.some(f => f.ruleId === 'eslint/@typescript-eslint/no-explicit-any'));
  assert.ok(bad.findings.some(f => f.ruleId === 'eslint/@typescript-eslint/no-unsafe-call'));
  assert.equal(config.project.typescript, true);
});
test('full Python Ruff and Pyright detect type and naming violations', async t => {
  const { root, config, save } = fixture(t, { 'example.py': 'def increment(value: int) -> int:\n    return value + 1\n' });
  save();
  const clean = await check(root, path.join(root, 'report'));
  assert.equal(clean.passed, true, JSON.stringify(clean));
  fs.writeFileSync(path.join(root, 'example.py'), 'def BadName(value: int) -> str:\n    return value + 1\n');
  const bad = await check(root, path.join(root, 'report'));
  assert.equal(bad.passed, false);
  assert.ok(bad.findings.some(f => f.ruleId === 'ruff/N802'));
  assert.ok(bad.findings.some(f => f.ruleId.startsWith('pyright/')));
  assert.equal(config.project.python, true);
});
test('Next.js JSX parses and structural accessibility findings are precise', t => {
  const { root, config } = fixture(t, { 'package.json': '{"dependencies":{"next":"16","react":"19"}}', 'app/page.tsx': 'export default function Page() { return <><img src="x" /><button>Save</button></>; }' });
  const findings = analyzeTypescript(root, ['app/page.tsx'], config);
  assert.ok(findings.some(f => f.ruleId === 'accessibility/image-alt'));
  assert.ok(findings.some(f => f.ruleId === 'react/button-type'));
  assert.equal(findings.some(f => f.ruleId.startsWith('typescript/syntax')), false);
});
test('Python boundaries and cycles resolve relative and src imports', t => {
  const { root, config } = fixture(t, { 'src/shared/a.py': 'from features.b import value\n', 'src/features/b.py': 'from shared.a import value\n' });
  const findings = analyzePython(root, ['src/shared/a.py', 'src/features/b.py'], config);
  assert.ok(findings.some(f => f.ruleId === 'architecture/import-boundary'));
  assert.ok(findings.some(f => f.ruleId === 'architecture/circular-import'));
});
test('configuration failures still produce an agent report', async t => {
  const { root } = fixture(t, { [CONFIG]: '{broken' });
  const report = await check(root, path.join(root, 'report'));
  assert.equal(report.complete, false);
  assert.equal(report.checks[0].name, 'configuration');
  assert.ok(fs.existsSync(path.join(root, 'report/report.md')));
});
test('Next.js client graph catches server-only imports through local helpers', t => {
  const { root, config } = fixture(t, {
    'package.json': '{"dependencies":{"next":"16"}}',
    'src/app/page.tsx': '"use client"; import { load } from "../load"; export default function Page() { return load(); }',
    'src/load.ts': 'import "server-only"; export function load() { return null; }',
  });
  const issues = analyzeTypescript(root, ['src/app/page.tsx', 'src/load.ts'], config);
  assert.deepEqual(issues.find(f => f.ruleId === 'next/client-server-boundary').evidence.chain, ['src/app/page.tsx', 'src/load.ts']);
});
test('uncovered TypeScript sources cannot receive a passing type assessment', async t => {
  const { root, config, save } = fixture(t, {
    'tsconfig.json': '{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true,"exactOptionalPropertyTypes":true},"include":["covered.ts"]}',
    'covered.ts': 'export const value = 1;', 'uncovered.ts': 'export const other = 1;',
  });
  config.checks.typescriptLint = false; save();
  const report = await check(root, path.join(root, 'report'));
  assert.equal(report.complete, false);
  assert.match(report.checks.find(c => c.name === 'typescript-types').detail, /uncovered.ts/);
});
test('reports are stable for identical source and configuration', async t => {
  const { root, save } = fixture(t, { 'example.py': 'def increment(value: int) -> int:\n    return value + 1\n' }); save();
  const first = await check(root, path.join(root, 'report'));
  const second = await check(root, path.join(root, 'report'));
  assert.deepEqual(first, second);
});
test('scoped naming overrides and suppression reasons are enforced', async t => {
  const { root, config, save } = fixture(t, {
    'ExternalThing.ts': '// eslint-disable-next-line @typescript-eslint/no-explicit-any\nexport const external: any = 1;\n',
  });
  config.checks.typescriptTypes = false;
  config.overrides.push({ files: ['ExternalThing.ts'], reason: 'Keep the published external filename.', limits: {}, naming: { files: false } }); save();
  const report = await check(root, path.join(root, 'report'));
  assert.equal(report.findings.some(f => f.ruleId === 'naming/file'), false);
  assert.ok(report.findings.some(f => f.ruleId === 'eslint/quality/suppression-reason'));
});
test('Next.js client boundary does not mistake erased type imports for runtime imports', t => {
  const { root, config } = fixture(t, {
    'package.json': '{"dependencies":{"next":"16"}}',
    'page.tsx': '"use client"; import type { Props } from "./data.server"; export function Page(props: Props) { return props.name; }',
    'data.server.ts': 'export type Props = { name: string };',
  });
  const findings = analyzeTypescript(root, ['page.tsx', 'data.server.ts'], config);
  assert.equal(findings.some(f => f.ruleId === 'next/client-server-boundary'), false);
});
test('regular expression contents cannot be mistaken for source comments', t => {
  const { root, config } = fixture(t, { 'example.ts': 'export const regex = /[/*]/;\nexport const second = 2;\nexport const third = 3;\n' });
  config.limits.file = [1, 2];
  const issue = analyzeTypescript(root, ['example.ts'], config).find(f => f.ruleId === 'structure/file');
  assert.equal(issue.evidence.measured, 3);
});
test('Python docstrings do not hide executable statements on the same line', t => {
  const { root, config } = fixture(t, { 'example.py': 'def work() -> int:\n    """Documentation"""; return 1\n' });
  config.limits.file = [1, 3];
  const issue = analyzePython(root, ['example.py'], config).find(f => f.ruleId === 'structure/file');
  assert.equal(issue.evidence.measured, 2);
});

test('external audit configs leave repositories unchanged and emit repair evidence', async t => {
  const { root, config } = fixture(t, { 'bad_name.py': 'def missing_type(value):\n    return value\n' });
  config.checks.pythonTypes = false;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-audit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const external = path.join(directory, 'config.json');
  fs.writeFileSync(external, JSON.stringify(config));
  const report = await check(root, path.join(directory, 'report'), external);
  assert.equal(report.configFile, external);
  assert.equal(fs.existsSync(path.join(root, CONFIG)), false);
  const plan = JSON.parse(fs.readFileSync(path.join(directory, 'report', 'repair-plan.json')));
  assert.ok(plan.tasks[0].sourceSha256);
  assert.ok(plan.tasks[0].findings[0].sourceExcerpt.length);
});

test('monorepo initialization detects frameworks and referenced TS configurations', t => {
  const { config } = fixture(t, {
    'tsconfig.json': '{"files":[],"references":[{"path":"./frontend/tsconfig.app.json"}]}',
    'frontend/tsconfig.app.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
    'frontend/package.json': '{"dependencies":{"react":"19","next":"16"}}',
    'frontend/src/page.tsx': 'export default function Page() { return <p>Hello</p>; }',
    'convex/_generated/api.ts': 'const broken = ;',
    '.output/server/server.ts': 'const broken = ;',
  });
  assert.equal(config.project.react, true);
  assert.equal(config.project.next, true);
  assert.ok(config.typescript.projects.includes('frontend/tsconfig.app.json'));
  assert.equal(config.typescript.projects.length, 2);
});

test('dependency evidence resolves aliases relative to each nested tsconfig', t => {
  const { root, config } = fixture(t, {
    'frontend/tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}},"include":["src"]}',
    'frontend/src/main.ts': 'import { value } from "@/value"; export const result = value;',
    'frontend/src/value.ts': 'export const value = 1;',
  });
  const graph = { edges: [], unresolved: [] };
  analyzeTypescript(root, ['frontend/src/main.ts', 'frontend/src/value.ts'], config, graph);
  assert.equal(graph.edges[0].target, 'frontend/src/value.ts');
  assert.equal(graph.edges[0].evidence.line, 1);
  assert.equal(graph.unresolved.length, 0);
});

test('incomplete lint coverage remains failed while preserving compiler diagnostics', async t => {
  const { root, save } = fixture(t, {
    'tsconfig.json': '{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true,"exactOptionalPropertyTypes":true},"include":["src"]}',
    'src/value.ts': 'export const value: number = "wrong";',
    'scripts/outside.ts': 'export const outside = 1;',
  });
  save();
  const report = await check(root, path.join(root, '.sloppy'));
  assert.equal(report.complete, false);
  assert.equal(report.checks.find(c => c.name === 'typescript-lint').status, 'failed');
  assert.ok(report.findings.some(f => f.ruleId === 'typescript/TS2322'));
});

test('lint compiler prerequisites are configuration failures with valid file-level locations', async t => {
  const { root, save } = fixture(t, {
    'tsconfig.json': '{"compilerOptions":{"strict":false},"include":["src"]}',
    'src/value.ts': 'export const value = 1;',
  });
  save();
  const report = await check(root, path.join(root, '.sloppy'));
  assert.equal(report.complete, false);
  assert.ok(report.findings.some(f => f.ruleId === 'eslint/configuration' && f.line === 1));
  assert.ok(report.findings.every(f => f.line > 0 && f.column > 0));
});

test('referenced monorepo projects are assessed independently without unused root programs', async t => {
  const { root, save } = fixture(t, {
    'tsconfig.json': '{"files":[],"references":[{"path":"./frontend"},{"path":"./server"}]}',
    'frontend/tsconfig.json': '{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true,"exactOptionalPropertyTypes":true},"include":["src"]}',
    'server/tsconfig.json': '{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true,"exactOptionalPropertyTypes":true},"include":["src"]}',
    'frontend/src/index.ts': 'export const frontend = 1;',
    'server/src/index.ts': 'export const server = 2;',
  });
  save();
  const report = await check(root, path.join(root, 'report'));
  assert.equal(report.complete, true);
  assert.equal(report.passed, true);
});

test('imported excluded sources retain diagnostics without becoming agent repair tasks', async t => {
  const { root, save } = fixture(t, {
    'tsconfig.json': '{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true,"exactOptionalPropertyTypes":true},"include":["src"]}',
    'src/index.ts': 'export { value } from "./bad.generated";',
    'src/bad.generated.ts': 'export const value: number = "wrong";',
  });
  save();
  const output = path.join(root, 'report');
  const report = await check(root, output);
  assert.ok(report.findings.some(f => f.file === 'src/bad.generated.ts' && f.ownership === 'excluded'));
  const plan = JSON.parse(fs.readFileSync(path.join(output, 'repair-plan.json')));
  assert.ok(plan.tasks.every(task => task.file !== 'src/bad.generated.ts'));
  assert.ok(plan.externalDiagnostics.length > 0);
});

test('project defaults do not share mutable rules or exclusions across assessments', t => {
  const { root } = fixture(t, { 'value.py': 'value = 1\n' });
  const first = defaults(root);
  first.exclude.push('private/**');
  first.limits.function[0] = 1;
  const second = defaults(root);
  assert.equal(second.exclude.includes('private/**'), false);
  assert.deepEqual(second.limits.function, [40, 80]);
});

test('Fumadocs generated directories are excluded only in declaring packages', t => {
  const { config } = fixture(t, {
    'apps/docs/package.json': '{"dependencies":{"fumadocs-mdx":"14"}}',
    'apps/docs/.source/server.ts': 'export const generated = 1;',
    'apps/other/.source/manual.ts': 'export const maintained = 1;',
  });
  assert.ok(config.exclude.includes('apps/docs/.source/**'));
  assert.equal(config.exclude.includes('apps/other/.source/**'), false);
});

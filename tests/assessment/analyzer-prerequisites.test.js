import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaults, load, CONFIG } from '../../src/project/policies.js';
import { check } from '../../src/assessment/assess-project.js';
import { pythonTypes } from '../../src/analysis/python/type-checking.js';
import { run } from '../../src/runtime/processes.js';

function fixture(t, sources) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sloppy-prerequisite-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(sources)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  const config = defaults(root);
  config.checks.pythonLint = false;
  config.checks.pythonUnusedCode = false;
  return { root, config, save: () => fs.writeFileSync(path.join(root, CONFIG), JSON.stringify(config)) };
}

const tsconfig = JSON.stringify({ compilerOptions: {
  strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
  module: 'ESNext', moduleResolution: 'Bundler',
}, include: ['src'] });
const cli = path.resolve('src/cli/main.js');

for (const extension of ['ts', 'js']) {
  test(`${extension} unused lint suppressions fail with exit 1, not incomplete`, t => {
    const { root, save } = fixture(t, {
      'tsconfig.json': tsconfig,
      [`src/request.${extension}`]: '// eslint-disable-next-line no-debugger -- Retained to reproduce an unused lint suppression.\nexport const request = 1;\n',
    });
    save();
    const output = path.join(root, 'report');
    const result = run(process.execPath, [cli, 'check', '--root', root, '--out', output], root);
    const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json')));
    assert.equal(result.status, 1, result.stderr);
    assert.equal(report.complete, true);
    const issue = report.findings.find(item => item.message.startsWith('Unused eslint-disable directive'));
    assert.equal(issue.ruleId, 'eslint/directive');
    assert.equal(issue.autoFix, true);
    assert.doesNotMatch(issue.guidance, /syntax|TypeScript project/);
  });

  test(`${extension} fatal lint parsing still produces an incomplete assessment`, async t => {
    const { root, save } = fixture(t, {
      'tsconfig.json': tsconfig,
      [`src/request.${extension}`]: 'export const request = ;\n',
    });
    save();
    const report = await check(root, path.join(root, 'report'));
    assert.equal(report.complete, false);
    assert.ok(report.findings.some(item => item.ruleId === 'eslint/parse'));
  });
}

test('generated .gen.ts clients are excluded by default but can be selected explicitly', async t => {
  const { root, config, save } = fixture(t, {
    'tsconfig.json': tsconfig,
    'src/request.ts': 'export const request = 1;\n',
    'src/types.gen.ts': '// eslint-disable-next-line no-debugger -- Generated client retains an unused suppression.\nexport const response = 1;\n',
  });
  save();
  const report = await check(root, path.join(root, 'report'));
  assert.equal(report.passed, true);
  assert.equal(report.summary.files, 1);
  assert.ok(report.findings.every(item => item.file !== 'src/types.gen.ts'));
  config.exclude = config.exclude.filter(pattern => pattern !== '**/*.gen.*');
  save();
  const selected = await check(root, path.join(root, 'report'));
  assert.equal(selected.complete, true);
  assert.equal(selected.passed, false);
  assert.ok(selected.findings.some(item => item.file === 'src/types.gen.ts' && item.ruleId === 'eslint/directive'));
});

test('missing TypeScript imports are setup failures without cascading typed lint findings', async t => {
  const { root, save } = fixture(t, {
    'tsconfig.json': tsconfig,
    'src/request.ts': 'import { request } from "./client";\nexport const response: string = request();\n',
  });
  save();
  const output = path.join(root, 'report');
  const missing = await check(root, output);
  assert.equal(missing.complete, false);
  assert.ok(missing.findings.some(item => item.ruleId === 'typescript/TS2307'));
  assert.ok(missing.findings.every(item => !item.ruleId.includes('no-unsafe')));
  assert.match(missing.checks.find(item => item.name === 'typescript-types').detail, /import.*resol|resol.*import/i);
  fs.writeFileSync(path.join(root, 'src/client.ts'), 'export function request(): string { return "ready"; }\n');
  const resolved = await check(root, output);
  assert.equal(resolved.complete, true);
  assert.equal(resolved.passed, true, JSON.stringify(resolved.findings));
});

test('missing imports in one TypeScript project do not discard another project findings', async t => {
  const { root, config, save } = fixture(t, {
    'apps/client/tsconfig.json': tsconfig,
    'apps/client/src/request.ts': 'import { request } from "./client";\nexport const response = request();\n',
    'apps/server/tsconfig.json': tsconfig,
    'apps/server/src/handler.ts': 'export function handle(value: any) { return value.request(); }\n',
  });
  config.typescript.projects = ['apps/client/tsconfig.json', 'apps/server/tsconfig.json'];
  save();
  const report = await check(root, path.join(root, 'report'));
  assert.equal(report.complete, false);
  assert.ok(report.findings.some(item => item.file === 'apps/client/src/request.ts' && item.ruleId === 'typescript/TS2307'));
  assert.ok(report.findings.some(item => item.file === 'apps/server/src/handler.ts' && item.ruleId === 'eslint/@typescript-eslint/no-unsafe-call'));
  assert.ok(report.findings.every(item => item.file !== 'apps/client/src/request.ts' || !item.ruleId.includes('no-unsafe')));
});

test('Python source roots are discovered from nested project manifests', t => {
  const { root, config, save } = fixture(t, {
    'pyproject.toml': '',
    'apps/backend/pyproject.toml': '',
    'apps/backend/src/main.py': 'value = 1\n',
    'packages/client/pyproject.toml': '',
    'packages/client/src/workspace_client/__init__.py': 'value = 1\n',
  });
  assert.deepEqual(config.python.extraPaths, ['apps/backend/src', 'packages/client/src', 'src']);
  save();
  assert.deepEqual(load(root).python.extraPaths, config.python.extraPaths);
  config.python.extraPaths = ['../outside'];
  save();
  assert.throws(() => load(root), /extraPaths.*inside/);
  config.python.extraPaths = 'src';
  save();
  assert.throws(() => load(root), /extraPaths/);
});

test('Python workspace roots resolve imports and missing imports remain actionable setup failures', async t => {
  const { root, config, save } = fixture(t, {
    'apps/backend/pyproject.toml': '',
    'apps/backend/src/main.py': 'from workspace_client import request\nresponse: str = request()\n',
    'packages/client/pyproject.toml': '',
    'packages/client/src/workspace_client/__init__.py': 'def request() -> str:\n    return "ready"\n',
  });
  save();
  const output = path.join(root, 'report');
  const resolved = await check(root, output);
  assert.equal(resolved.passed, true, JSON.stringify(resolved.findings));
  fs.writeFileSync(path.join(root, 'apps/backend/src/main.py'), 'from missing_sloppy_dependency import request\nresponse: str = request()\n');
  const missing = await check(root, output);
  assert.equal(missing.complete, false);
  assert.equal(missing.checks.find(item => item.name === 'python-types').status, 'failed');
  assert.ok(missing.findings.some(item => item.ruleId === 'pyright/reportMissingImports'));
  assert.ok(missing.findings.every(item => !item.ruleId.startsWith('pyright/reportUnknown')));
  assert.match(missing.findings.find(item => item.ruleId === 'pyright/reportMissingImports').guidance, /python\.executable.*python\.extraPaths/);
  assert.ok(fs.readdirSync(root).every(file => !file.startsWith('.sloppy-pyright-')));
  assert.equal(config.python.typeCheckingMode, 'strict');
});

test('inherited Pyright execution environments are preserved', t => {
  const { root, config } = fixture(t, {
    'pyrightconfig.json': JSON.stringify({ executionEnvironments: [{ root: 'apps/backend', extraPaths: ['vendor'] }] }),
    'apps/backend/main.py': 'from workspace_client import request\nresponse: str = request()\n',
    'vendor/workspace_client/__init__.py': 'def request() -> str:\n    return "ready"\n',
  });
  assert.equal(config.python.extraPaths, null);
  assert.deepEqual(pythonTypes(root, ['apps/backend/main.py'], config), []);
});

test('legacy Python configurations discover workspace roots without rewriting configuration', async t => {
  const { root, config, save } = fixture(t, {
    'apps/backend/pyproject.toml': '',
    'apps/backend/src/main.py': 'from workspace_client import request\nresponse: str = request()\n',
    'packages/client/pyproject.toml': '',
    'packages/client/src/workspace_client/__init__.py': 'def request() -> str:\n    return "ready"\n',
  });
  delete config.python.extraPaths;
  save();
  const original = fs.readFileSync(path.join(root, CONFIG), 'utf8');
  const report = await check(root, path.join(root, 'report'));
  assert.equal(report.passed, true, JSON.stringify(report.findings));
  assert.equal(fs.readFileSync(path.join(root, CONFIG), 'utf8'), original);
});

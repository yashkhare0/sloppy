import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseVultureOutput } from '../../../src/analysis/python/unused-code.js';
import { CONFIG, defaults, load } from '../../../src/project/policies.js';
import { analyzePython } from '../../../src/analysis/python/source.js';

test('Vulture maps path aliases to selected Python files only', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sloppy-vulture-path-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const actualRoot = path.join(directory, 'actual');
  const aliasRoot = path.join(directory, 'alias');
  fs.mkdirSync(actualRoot);
  fs.writeFileSync(path.join(actualRoot, 'selected.py'), 'def selected(): pass\n');
  fs.writeFileSync(path.join(actualRoot, 'other.py'), 'def other(): pass\n');
  try { fs.symlinkSync(actualRoot, aliasRoot, 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('directory symlinks are unavailable');
    throw error;
  }

  const config = defaults(aliasRoot);
  const line = file => `${path.join(actualRoot, file)}:1: unused function '${path.basename(file, '.py')}' (60% confidence)\n`;
  const findings = parseVultureOutput(aliasRoot, ['selected.py'], line('selected.py'), config, {});
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'selected.py');
  assert.throws(() => parseVultureOutput(aliasRoot, ['selected.py'], line('other.py'), config, {}),
    /outside the selected Python sources/);
});

test('Vulture attribute writes remain review candidates without claiming library properties are dead', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sloppy-vulture-attribute-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'owner.py'), 'flow.redirect_uri = "https://example.test"\n');
  const config = defaults(root);
  const findings = parseVultureOutput(root, ['owner.py'], "owner.py:1: unused attribute 'redirect_uri' (60% confidence)\n", config, {});
  assert.equal(findings.length, 1);
  assert.equal(findings[0].blocksGate, false);
  assert.match(findings[0].guidance, /property setters/);
  assert.equal(findings[0].evidence.candidateKind, 'attribute-write');
});

test('client ownership boundaries are configurable without hiding clients in other modules', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sloppy-client-boundary-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = ['providers/adapter.py', 'features/action.py', 'services/client.py'];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'def request() -> None:\n    BureauClient()\n');
  }
  const config = defaults(root);
  config.python.clientBoundaries = ['providers/**'];
  const findings = analyzePython(root, files, config).filter(item => item.ruleId === 'python/inline-client');
  assert.deepEqual(findings.map(item => item.file), ['features/action.py', 'services/client.py']);
});

test('legacy Python client policies keep service boundaries and validate explicit glob lists', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sloppy-client-config-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = defaults(root);
  delete config.python.clientBoundaries;
  const save = () => fs.writeFileSync(path.join(root, CONFIG), JSON.stringify(config));
  save();
  const original = fs.readFileSync(path.join(root, CONFIG), 'utf8');
  assert.deepEqual(load(root).python.clientBoundaries, ['**/services/**']);
  assert.equal(fs.readFileSync(path.join(root, CONFIG), 'utf8'), original);
  config.python.clientBoundaries = ['providers/**', '**/services/**'];
  save();
  assert.deepEqual(load(root).python.clientBoundaries, config.python.clientBoundaries);
  config.python.clientBoundaries = 'providers/**';
  save();
  assert.throws(() => load(root), /clientBoundaries/);
  config.python.clientBoundaries = [''];
  save();
  assert.throws(() => load(root), /clientBoundaries/);
});

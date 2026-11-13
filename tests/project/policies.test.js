import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG, defaults, load } from '../../src/project/policies.js';

test('disabled legacy Electron flags load without editing the configuration or accepting unsupported enabled coverage', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sloppy-legacy-config-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = defaults(root);
  const file = path.join(root, CONFIG);
  config.project.electron = false;
  const saved = JSON.stringify(config);
  fs.writeFileSync(file, saved);
  assert.equal(load(root).project.electron, undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
  config.project.electron = true;
  fs.writeFileSync(file, JSON.stringify(config));
  assert.throws(() => load(root), /project.electron/);
});

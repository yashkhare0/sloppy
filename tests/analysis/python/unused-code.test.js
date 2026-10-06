import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseVultureOutput } from '../../../src/analysis/python/unused-code.js';
import { defaults } from '../../../src/project/policies.js';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import { metric } from '../../src/domain/findings.js';

test('thresholds are inclusive: warning starts at 8 and error starts at 12', () => {
  const location = { file: 'example.ts', line: 1, column: 1, symbol: 'work' };
  const limits = { complexity: [8, 12] };
  assert.equal(metric('complexity', 7, limits, location), null);
  assert.equal(metric('complexity', 8, limits, location).severity, 'warning');
  assert.equal(metric('complexity', 11, limits, location).severity, 'warning');
  assert.equal(metric('complexity', 12, limits, location).severity, 'error');
  assert.equal(metric('complexity', 13, limits, location).severity, 'error');
});


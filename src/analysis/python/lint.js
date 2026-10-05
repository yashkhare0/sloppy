import path from 'node:path';
import { run } from '../../runtime/processes.js';
import { fileNaming } from '../../project/policies.js';
import { finding } from '../../domain/findings.js';

export function pythonLint(root, files, config) {
  const issues = [];
  for (const identifiers of [true, false]) {
    const selected = files.filter(file => fileNaming(file, config).identifiers === identifiers);
    if (!selected.length) continue;
    const select = config.python.ruffSelect.filter(rule => identifiers || rule !== 'N');
    for (let start = 0; start < selected.length; start += 64) {
      const result = run(config.python.ruffExecutable, ['check', '--isolated', '--output-format', 'json', '--select', select.join(','), '--', ...selected.slice(start, start + 64)], root);
      if (![0, 1].includes(result.status)) throw new Error(result.stderr || 'Ruff failed');
      issues.push(...JSON.parse(result.stdout));
    }
  }
  return issues.map(m => finding(`ruff/${m.code}`, { file: path.relative(root, m.filename).replaceAll('\\', '/'), line: m.location.row, column: m.location.column, message: m.message, guidance: m.fix?.message || `Correct ${m.code}; see ${m.url}.`, ...{ autoFix: m.fix?.applicability === 'safe', evidence: { endLine: m.end_location.row, endColumn: m.end_location.column, documentation: m.url, fix: m.fix } } }));
}

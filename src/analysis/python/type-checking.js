import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { run } from '../../runtime/processes.js';
import { finding } from '../../domain/findings.js';
const require = createRequire(import.meta.url);

export function pythonTypes(root, files, config) {
  const directory = fs.mkdtempSync(path.join(root, '.sloppy-pyright-'));
  try {
    const existing = path.join(root, 'pyrightconfig.json');
    const project = {
      ...(fs.existsSync(existing) ? { extends: existing } : {}),
      include: files.map(f => path.relative(directory, path.join(root, f)).replaceAll('\\', '/')), exclude: [], ignore: [],
      typeCheckingMode: config.python.typeCheckingMode,
      executionEnvironments: [{ root, extraPaths: [path.join(root, 'src')] }],
      ...(fs.existsSync(path.join(root, '.venv')) ? { venvPath: root, venv: '.venv' } : {}),
    };
    const configPath = path.join(directory, 'pyrightconfig.json');
    fs.writeFileSync(configPath, JSON.stringify(project));
    const result = run(process.execPath, [require.resolve('pyright/index.js'), '--outputjson', '--project', configPath, '--pythonpath', config.python.executable], root);
    if (![0, 1].includes(result.status)) throw new Error(result.stderr || result.stdout || 'Pyright failed');
    const report = JSON.parse(result.stdout);
    if (report.summary.filesAnalyzed < files.length) throw new Error(`Pyright analyzed ${report.summary.filesAnalyzed} files; expected at least ${files.length}. ${result.stderr}`);
    return report.generalDiagnostics.map(d => finding(`pyright/${d.rule ?? 'type-error'}`, { file: path.relative(root, d.file).replaceAll('\\', '/'), line: d.range.start.line + 1, column: d.range.start.character + 1, message: d.message, guidance: 'Fix the type contract or validate and narrow external data before use.', ...{ severity: d.severity === 'error' ? 'error' : 'warning', evidence: { endLine: d.range.end.line + 1, endColumn: d.range.end.character + 1 } } }));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

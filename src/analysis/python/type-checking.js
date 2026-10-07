import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { run } from '../../runtime/processes.js';
import { finding } from '../../domain/findings.js';
import { discover } from '../../project/policies.js';
import { pythonSourcePaths } from '../../project/python-policies.js';
const require = createRequire(import.meta.url);

export function pythonTypes(root, files, config) {
  const directory = fs.mkdtempSync(path.join(root, '.sloppy-pyright-'));
  try {
    const configPath = path.join(directory, 'pyrightconfig.json');
    fs.writeFileSync(configPath, JSON.stringify(pythonProject(root, directory, files, config)));
    const result = run(process.execPath, [require.resolve('pyright/index.js'), '--outputjson', '--project', configPath, '--pythonpath', config.python.executable], root);
    if (![0, 1].includes(result.status)) throw new Error(result.stderr || result.stdout || 'Pyright failed');
    const report = JSON.parse(result.stdout);
    if (report.summary.filesAnalyzed < files.length) throw new Error(`Pyright analyzed ${report.summary.filesAnalyzed} files; expected at least ${files.length}. ${result.stderr}`);
    const unresolved = report.generalDiagnostics.filter(diagnostic => ['reportMissingImports', 'reportMissingModuleSource'].includes(diagnostic.rule));
    if (unresolved.length) {
      const error = new Error(`${unresolved.length} Python imports could not be resolved. Install the project's dependencies and configure python.executable and python.extraPaths; remaining type diagnostics are withheld until import resolution is restored.`);
      error.findings = unresolved.map(diagnostic => pythonFinding(root, diagnostic, 'Resolve this import using the project environment in python.executable and workspace source roots in python.extraPaths; do not suppress cascading unknown-type diagnostics.'));
      throw error;
    }
    return report.generalDiagnostics.map(diagnostic => pythonFinding(root, diagnostic, 'Fix the type contract or validate and narrow external data before use.'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function pythonProject(root, directory, files, config) {
  const existing = path.join(root, 'pyrightconfig.json');
  const inherits = fs.existsSync(existing);
  const extraPaths = config.python.extraPaths ?? (inherits ? null : pythonSourcePaths(discover(root, config.exclude)));
  return {
    ...(inherits ? { extends: existing } : { executionEnvironments: [{ root }] }),
    include: files.map(file => path.relative(directory, path.join(root, file)).replaceAll('\\', '/')),
    exclude: [], ignore: [], typeCheckingMode: config.python.typeCheckingMode,
    ...(extraPaths !== null ? { extraPaths: extraPaths.map(value => path.resolve(root, value)) } : {}),
    ...(fs.existsSync(path.join(root, '.venv')) ? { venvPath: root, venv: '.venv' } : {}),
  };
}

function pythonFinding(root, diagnostic, guidance) {
  return finding(`pyright/${diagnostic.rule ?? 'type-error'}`, {
    file: path.relative(root, diagnostic.file).replaceAll('\\', '/'),
    line: diagnostic.range.start.line + 1, column: diagnostic.range.start.character + 1,
    message: diagnostic.message, guidance, severity: diagnostic.severity === 'error' ? 'error' : 'warning',
    evidence: { endLine: diagnostic.range.end.line + 1, endColumn: diagnostic.range.end.character + 1 },
  });
}

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from "../../runtime/processes.js";
import { fileLimits, fileNaming, matches } from "../../project/policies.js";
import { cycles } from "../../domain/import-cycles.js";
import { finding, metric } from "../../domain/findings.js";

export function analyzePython(root, files, config) {
  const script = fileURLToPath(new URL("./parser/parse.py", import.meta.url));
  const sourceRoot = path.resolve(path.dirname(script), '../../..');
  const configuredExecutable = config.python.executable;
  const executable = /[\\/]/.test(configuredExecutable) && !path.isAbsolute(configuredExecutable)
    ? path.resolve(root, configuredExecutable)
    : configuredExecutable;
  const result = run(executable, ['-m', 'analysis.python.parser.parse'], sourceRoot, JSON.stringify({
    root, files,
    maxActivityLines: config.python.maxActivityLines,
    maxInlinePromptLines: config.python.maxInlinePromptLines,
  }));
  if (result.status !== 0) throw new Error(result.stderr || 'Python AST parser failed');
  const data = JSON.parse(result.stdout), findings = [], graph = new Map();
  for (const file of files) {
    const item = data[file];
    if (item.error) {
      findings.push(finding('python/syntax', { file: file, line: item.line, column: 1, message: item.error, guidance: 'Fix Python syntax before evaluating this file.' })); continue;
    }
    inspectParsedSource(file, item, config, findings);
    const edges = resolvePythonImports(root, file, item.imports, config, findings);
    graph.set(file, edges);
  }
  findings.push(...cycles(graph));
  return findings;
}

function resolvePythonImports(root, file, imports, config, findings) {
    const edges = [];
    for (const entry of imports) {
      const bases = entry.level ? [path.resolve(root, path.dirname(file), ...Array(entry.level - 1).fill('..'))] : [root, path.join(root, 'src')];
      const modules = [entry.module, ...(entry.names ?? []).filter(n => n !== '*').map(n => entry.module ? `${entry.module}.${n}` : n)];
      for (const module of modules) {
        const candidates = bases.flatMap(base => {
          const name = path.join(base, module.replaceAll('.', path.sep));
          return [`${name}.py`, path.join(name, '__init__.py')];
        });
        const resolved = candidates.find(candidate => fs.existsSync(candidate));
        if (!resolved) continue;
        const target = path.relative(root, resolved).replaceAll('\\', '/');
        if (target.startsWith('../')) continue;
        edges.push(target);
        inspectImportBoundary({ file, target, module, entry, config, findings });
      }
    }
  return edges;
}

function inspectParsedSource(file, item, config, findings) {
    for (const issue of item.codeHealth ?? []) findings.push(finding(issue.rule, { file: file, line: issue.line, column: issue.column, message: issue.message, guidance: issue.guidance, ...{ severity: issue.severity, evidence: issue.evidence } }));
    inspectTargetedIssues(file, item.targeted ?? [], config, findings);
    for (const suppression of item.suppressions) findings.push(finding('python/suppression-reason', { file: file, line: suppression.line, column: suppression.column, message: 'Suppression lacks a justification after --', guidance: 'Specify the rule being suppressed and append -- followed by a meaningful reason of at least 10 characters.' }));
    for (const value of item.metrics) {
      const issue = metric(value.kind, value.value, fileLimits(file, config), { file, line: value.line, column: value.column, symbol: value.symbol });
      if (issue) findings.push(issue);
    }
    if (fileNaming(file, config).files && !/^[a-z_][a-z0-9_]*\.py$/.test(path.basename(file))) findings.push(finding('naming/file', { file: file, line: 1, column: 1, message: 'Python module name must be snake_case', guidance: 'Rename the module and update its imports.' }));
}

function inspectTargetedIssues(file, issues, config, findings) {
  for (const issue of issues) {
    if (issue.rule === 'python/inline-client' && matches(file, config.python.clientBoundaries ?? ['**/services/**'])) continue;
    findings.push(finding(issue.rule, {
      file, line: issue.line, column: issue.column, symbol: issue.symbol,
      message: issue.message, guidance: issue.guidance,
      level: config.python.severities[issue.rule], evidence: issue.evidence,
    }));
  }
}

function inspectImportBoundary(context) {
  const { file, target, module, entry, config, findings } = context;
        for (const boundary of config.boundaries) if (matches(file, boundary.from) && matches(target, boundary.disallow)) findings.push(finding('architecture/import-boundary', { file: file, line: entry.line, column: 1, message: `Import '${module}' crosses a configured boundary`, guidance: boundary.reason || 'Correct the dependency direction.', ...{ evidence: { target, specifier: module } } }));
}

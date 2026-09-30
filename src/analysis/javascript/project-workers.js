import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { run } from '../../runtime/processes.js';

export function isolatedTypescript(engine, root, files, config, onProgress) {
  const worker = fileURLToPath(new URL("./worker.js", import.meta.url));
  if (engine === 'typescript-lint' && !config.checks.typescriptTypes) {
    const result = run(process.execPath, ['--max-old-space-size=8192', worker], root, JSON.stringify({ engine, root, files, config }));
    const output = workerResult(result);
    if (output.error) { const error = new Error(output.error); error.findings = output.findings; throw error; }
    return output.findings;
  }
  const { groups, uncovered } = groupTypescriptSources(root, files, config);
  const findings = [], failures = [];
  for (const [project, selected] of groups) {
    try {
      const scoped = { ...config, typescript: { ...config.typescript, projects: [project] } };
      const result = run(process.execPath, ['--max-old-space-size=8192', worker], root, JSON.stringify({ engine, root, files: selected, config: scoped }));
      const output = workerResult(result);
      findings.push(...output.findings);
      if (output.error) failures.push(`${project}: ${output.error}`);
    } catch (error) { failures.push(`${project}: ${error.message}`); }
    onProgress?.([...new Map(findings.map(f => [`${f.fingerprint}:${f.line}:${f.column}`, f])).values()]);
  }
  const unique = [...new Map(findings.map(f => [`${f.fingerprint}:${f.line}:${f.column}`, f])).values()];
  if (uncovered.length) failures.push(`TypeScript projects do not cover ${uncovered.length} selected files: ${uncovered.slice(0, 20).join(', ')}${uncovered.length > 20 ? ', ...' : ''}`);
  if (failures.length) {
    const error = new Error(failures.join('\n'));
    error.findings = unique;
    throw error;
  }
  return unique;
}

function workerResult(result) {
  if (![0, 2].includes(result.status)) throw new Error(`Engine process failed (${result.status}): ${result.stderr.slice(-2000)}`);
  return JSON.parse(result.stdout);
}

function groupTypescriptSources(root, files, config) {
  const projects = config.typescript.projects.map(project => {
    const absolute = path.resolve(root, project);
    const read = ts.readConfigFile(absolute, ts.sys.readFile);
    if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(absolute), undefined, absolute);
    return { project, directory: path.dirname(absolute), files: new Set(parsed.fileNames.map(f => path.resolve(f).toLowerCase())) };
  }).sort((a, b) => b.directory.length - a.directory.length || a.project.localeCompare(b.project));
  const groups = new Map(), uncovered = [];
  for (const file of files) {
    const project = projects.find(p => p.files.has(path.resolve(root, file).toLowerCase()));
    if (!project) { uncovered.push(file); continue; }
    if (!groups.has(project.project)) groups.set(project.project, []);
    groups.get(project.project).push(file);
  }
  return { groups, uncovered };
}

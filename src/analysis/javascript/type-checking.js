import path from 'node:path';
import ts from 'typescript';
import { finding } from '../../domain/findings.js';

export function typescriptTypes(root, config, files = []) {
  const findings = [], covered = new Set();
  for (const project of config.typescript.projects) {
    const absolute = path.resolve(root, project);
    const read = ts.readConfigFile(absolute, ts.sys.readFile);
    if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(absolute), undefined, absolute);
    if (!parsed.fileNames.length && parsed.projectReferences?.length) continue;
    if (parsed.errors.length) throw new Error(parsed.errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
    findings.push(...requiredCompilerOptions(project, parsed.options, config.typescript.requiredOptions));
    const rootFiles = selectedProjectFiles(root, files, parsed.fileNames);
    const program = ts.createProgram(rootFiles, { ...parsed.options, noEmit: true, incremental: false });
    for (const source of program.getSourceFiles()) covered.add(path.resolve(source.fileName).toLowerCase());
    findings.push(...compilerFindings(program, root, project));
  }
  const uncovered = files.filter(file => !covered.has(path.resolve(root, file).toLowerCase()));
  if (uncovered.length) {
    const error = new Error(`TypeScript projects do not cover ${uncovered.length} selected files: ${uncovered.slice(0, 20).join(', ')}${uncovered.length > 20 ? ', ...' : ''}`);
    error.findings = findings;
    throw error;
  }
  const unresolved = findings.filter(item => ['typescript/TS2307', 'typescript/TS2688', 'typescript/TS2792'].includes(item.ruleId));
  if (unresolved.length) {
    const error = new Error(`${unresolved.length} TypeScript imports or type definitions could not be resolved. Install the project's dependencies and check tsconfig paths/moduleResolution; remaining type diagnostics are withheld until import resolution is restored.`);
    error.findings = unresolved;
    throw error;
  }
  return findings;
}

function requiredCompilerOptions(project, options, required) {
  return required.filter(option => options[option] !== true).map(option => finding('typescript/required-option', { file: project, line: 1, column: 1, message: `TypeScript option ${option} must be true`, guidance: `Enable ${option} in this project's tsconfig or its inherited config.`, evidence: { option, actual: options[option] ?? null, expected: true } }));
}

function selectedProjectFiles(root, files, configured) {
  if (!files.length) return configured;
  const membership = new Set(configured.map(file => path.resolve(file).toLowerCase()));
  const selected = files.map(file => path.resolve(root, file)).filter(file => membership.has(file.toLowerCase()));
  return [...new Set([...selected, ...configured.filter(file => file.endsWith('.d.ts'))])];
}

function compilerFindings(program, root, project) {
  const findings = [];
    for (const d of ts.getPreEmitDiagnostics(program)) {
      const location = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
      findings.push(finding(`typescript/TS${d.code}`, { file: d.file ? path.relative(root, d.file.fileName).replaceAll('\\', '/') : project, line: (location?.line ?? 0) + 1, column: (location?.character ?? 0) + 1, message: ts.flattenDiagnosticMessageText(d.messageText, '\n'), guidance: 'Resolve the compiler error at its source; do not silence it with casts or blanket suppressions.' }));
    }
  return findings;
}

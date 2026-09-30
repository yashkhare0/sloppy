import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import next from '@next/eslint-plugin-next';
import { finding } from './findings.js';
import { run } from './process.js';
import { fileNaming } from './config.js';

const require = createRequire(import.meta.url);
export const versions = {
  cli: require('../package.json').version, node: process.version,
  typescript: ts.version, eslint: ESLint.version,
  pyright: require('pyright/package.json').version,
};
export async function lintTypescript(root, files, config) {
  const typed = config.checks.typescriptTypes;
  const presets = typed ? tseslint.configs.strictTypeChecked : tseslint.configs.strict;
  const rules = {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-non-null-assertion': 'error',
    '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true, 'ts-nocheck': true, 'ts-expect-error': 'allow-with-description', minimumDescriptionLength: 10 }],
    'no-empty': ['error', { allowEmptyCatch: false }],
    'no-debugger': 'error',
    'no-unreachable': 'error',
    'no-dupe-else-if': 'error',
    'no-duplicate-case': 'error',
    'no-constant-condition': ['error', { checkLoops: false }],
    'no-useless-catch': 'error',
    'no-unreachable-loop': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true }],
  };
  if (typed) rules['@typescript-eslint/no-confusing-void-expression'] = ['error', { ignoreArrowShorthand: true }];
  const namingRule = ['error',
    { selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow' },
    { selector: 'variable', format: ['camelCase', 'PascalCase', 'UPPER_CASE'], leadingUnderscore: 'allow' },
    { selector: 'function', format: ['camelCase', 'PascalCase'] },
    { selector: 'typeLike', format: ['PascalCase'] },
    { selector: ['property', 'objectLiteralMethod', 'import'], format: null },
    { selector: 'variable', modifiers: ['destructured'], format: null },
  ];
  if (config.naming.identifiers) rules['@typescript-eslint/naming-convention'] = namingRule;
  const plugins = { quality: { rules: { 'suppression-reason': {
    meta: { type: 'problem', schema: [], messages: { reason: 'Lint suppressions require specific rule IDs and a justification after -- (at least 10 characters).' } },
    create(context) {
      return { Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const match = comment.value.trim().match(/^eslint-disable(?:-next-line|-line)?\s*(.*)$/);
          if (!match) continue;
          const [ids, reason] = match[1].split('--');
          if (!ids.trim() || !reason || reason.trim().length < 10) context.report({ loc: comment.loc, messageId: 'reason' });
        }
      } };
    },
  } } } };
  rules['quality/suppression-reason'] = 'error';
  if (config.project.react) {
    plugins['react-hooks'] = reactHooks;
    Object.assign(rules, reactHooks.configs.recommended.rules);
  }
  if (config.project.next) {
    plugins['@next/next'] = next;
    Object.assign(rules, next.configs.recommended.rules, next.configs['core-web-vitals'].rules);
  }
  const glob = ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'];
  const lint = new ESLint({
    cwd: root, overrideConfigFile: true,
    overrideConfig: [
      { ignores: config.exclude },
      ...presets.map(p => ({ ...p, files: glob })),
      {
        files: glob, plugins,
        languageOptions: { parserOptions: typed ? { project: config.typescript.projects, tsconfigRootDir: root } : { ecmaFeatures: { jsx: true } }, globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', window: 'readonly', document: 'readonly', fetch: 'readonly' } },
        linterOptions: { reportUnusedDisableDirectives: 'error' },
        settings: { next: { rootDir: root } },
        rules: { ...rules, ...config.typescript.eslintRules },
      },
      ...config.overrides.filter(o => o.naming?.identifiers !== undefined).map(o => ({ files: o.files, rules: { '@typescript-eslint/naming-convention': o.naming.identifiers ? namingRule : 'off' } })),
    ],
  });
  const results = await lint.lintFiles(files);
  return results.flatMap(result => result.messages.map(m => finding(`eslint/${m.line === 0 ? 'configuration' : m.ruleId ?? 'parse'}`, { file: path.relative(root, result.filePath).replaceAll('\\', '/'), line: Math.max(1, m.line ?? 1), column: Math.max(1, m.column ?? 1), message: m.message, guidance: m.line === 0 ? 'Resolve the compiler-option prerequisite in the applicable tsconfig; this is a file-level lint configuration failure.' : m.ruleId ? `Correct the violation of ${m.ruleId}. Consult the rule documentation; preserve the public behavior.` : 'Fix syntax or include this file in a configured TypeScript project.', ...{ severity: m.severity === 2 ? 'error' : 'warning', autoFix: Boolean(m.fix), evidence: { ...(m.line === 0 ? { originalRule: m.ruleId, locationKind: 'file-level' } : {}), endLine: m.endLine, endColumn: m.endColumn, ...(m.fix ? { replacement: m.fix } : {}) } } })));
}
export function typescriptTypes(root, config, files = []) {
  const findings = [], covered = new Set();
  for (const project of config.typescript.projects) {
    const absolute = path.resolve(root, project);
    const read = ts.readConfigFile(absolute, ts.sys.readFile);
    if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(absolute), undefined, absolute);
    if (!parsed.fileNames.length && parsed.projectReferences?.length) continue;
    if (parsed.errors.length) throw new Error(parsed.errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
    for (const option of config.typescript.requiredOptions) {
      if (parsed.options[option] !== true) findings.push(finding('typescript/required-option', { file: project, line: 1, column: 1, message: `TypeScript option ${option} must be true`, guidance: `Enable ${option} in this project's tsconfig or its inherited config.`, ...{ evidence: { option, actual: parsed.options[option] ?? null, expected: true } } }));
    }
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
  return findings;
}
function selectedProjectFiles(root, files, configured) {
  if (!files.length) return configured;
  const membership = new Set(configured.map(file => path.resolve(file).toLowerCase()));
  const selected = files.map(file => path.resolve(root, file)).filter(file => membership.has(file.toLowerCase()));
  return [...new Set([...selected, ...configured.filter(file => file.endsWith('.d.ts'))])];
}
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

export function isolatedTypescript(engine, root, files, config, onProgress) {
  const worker = fileURLToPath(new URL('./engine-worker.js', import.meta.url));
  if (engine === 'typescript-lint' && !config.checks.typescriptTypes) {
    const result = run(process.execPath, ['--max-old-space-size=8192', worker], root, JSON.stringify({ engine, root, files, config }));
    if (![0, 2].includes(result.status)) throw new Error(`Engine process failed (${result.status}): ${result.stderr.slice(-2000)}`);
    const output = JSON.parse(result.stdout);
    if (output.error) { const error = new Error(output.error); error.findings = output.findings; throw error; }
    return output.findings;
  }
  const { groups, uncovered } = groupTypescriptSources(root, files, config);
  const findings = [], failures = [];
  for (const [project, selected] of groups) {
    try {
      const scoped = { ...config, typescript: { ...config.typescript, projects: [project] } };
      const result = run(process.execPath, ['--max-old-space-size=8192', worker], root, JSON.stringify({ engine, root, files: selected, config: scoped }));
      if (![0, 2].includes(result.status)) throw new Error(`Engine process failed (${result.status}): ${result.stderr.slice(-2000)}`);
      const output = JSON.parse(result.stdout);
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

export function lintJavascript(root, files, config) {
  return lintTypescript(root, files, { ...config, checks: { ...config.checks, typescriptTypes: false } });
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

function compilerFindings(program, root, project) {
  const findings = [];
    for (const d of ts.getPreEmitDiagnostics(program)) {
      const location = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
      findings.push(finding(`typescript/TS${d.code}`, { file: d.file ? path.relative(root, d.file.fileName).replaceAll('\\', '/') : project, line: (location?.line ?? 0) + 1, column: (location?.character ?? 0) + 1, message: ts.flattenDiagnosticMessageText(d.messageText, '\n'), guidance: 'Resolve the compiler error at its source; do not silence it with casts or blanket suppressions.' }));
    }
  return findings;
}

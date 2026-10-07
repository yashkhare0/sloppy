import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { minimatch } from 'minimatch';
import { run } from "../runtime/processes.js";
import { organizationDefaults, validateOrganization } from './organization.js';
import {
  normalizePythonChecks, pythonConfigurationKeys, pythonDefaults, pythonSourcePaths, validatePythonTools,
} from './python-policies.js';

export const CONFIG = '.sloppy.json';
const limits = {
  file: [300, 500], function: [40, 80], component: [100, 180],
  class: [200, 350], complexity: [8, 12], nesting: [3, 4], parameters: [4, 6],
};
const ignored = ['**/node_modules/**', '**/.git/**', '**/.next/**', '**/.output/**', '**/.nuxt/**', '**/convex/_generated/**', '**/.venv*/**', '**/.claude/worktrees/**', '**/.codex/worktrees/**', '**/.tmp-tests-fs/**', '**/venv/**', '**/__pycache__/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/*.d.ts', '**/*.generated.*', '**/*.gen.*'];
export function detect(root, files = discover(root, ignored)) {
  const packageFiles = files.filter(f => /(^|\/)package\.json$/.test(f));
  const deps = {};
  for (const file of packageFiles) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    Object.assign(deps, pkg.dependencies, pkg.devDependencies);
  }
  return {
    typescript: files.some(f => /\.(?:ts|tsx|mts|cts)$/.test(f)),
    javascript: files.some(f => /\.(?:js|jsx|mjs|cjs)$/.test(f)),
    python: files.some(f => f.endsWith('.py')) || fs.existsSync(path.join(root, 'pyproject.toml')),
    react: Boolean(deps.react || deps.next), next: Boolean(deps.next),
    shadcn: files.some(f => /(^|\/)components\.json$/.test(f)),
  };
}
export function defaults(root) {
  const files = discover(root, ignored);
  const project = detect(root, files);
  const exclude = [...ignored];
  for (const file of files.filter(f => /(^|\/)package\.json$/.test(f))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    if (pkg.dependencies?.['fumadocs-mdx'] || pkg.devDependencies?.['fumadocs-mdx']) {
      const directory = path.posix.dirname(file);
      exclude.push(`${directory === '.' ? '' : directory + '/'}.source/**`);
    }
  }
  const activeConfigs = detectTypescriptProjects(root, files);
  return structuredClone({
    version: 1, project,
    include: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,py}'],
    exclude,
    limits, overrides: [{ files: ['**/*.test.*', '**/*.spec.*', '**/test_*.py', '**/tests/**', '**/test/**'], reason: 'Tests often contain repetitive arrangements and assertions.', limits: { file: [500, 800], function: [80, 160] } }],
    naming: { files: true, identifiers: true },
    boundaries: [
      { from: ['src/shared/**', 'src/lib/**'], disallow: ['src/features/**', 'src/app/**'], reason: 'Shared modules must not depend on application features.' },
    ],
    checks: {
      javascriptLint: project.javascript, typescriptLint: project.typescript,
      typescriptTypes: project.typescript, pythonLint: project.python,
      pythonTypes: project.python, pythonUnusedCode: project.python,
      pythonCoverage: false, pythonDependencyAudit: false,
    },
    typescript: { projects: activeConfigs.length ? activeConfigs : ['tsconfig.json'], requiredOptions: ['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes'], eslintRules: {} },
    python: { ...pythonDefaults(), extraPaths: fs.existsSync(path.join(root, 'pyrightconfig.json')) ? null : pythonSourcePaths(files) },
    baseline: null,
    deadCode: { entryPoints: [], protected: [] },
    organization: organizationDefaults(),
  });
}
export function load(root, configPath = path.join(root, CONFIG)) {
  const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  validateConfigurationShape(c);
  normalizePythonChecks(c);
  validateConfiguration(c, root);
  return c;
}

function validateConfigurationShape(c) {
  const allowed = ['version', 'project', 'include', 'exclude', 'limits', 'overrides', 'naming', 'boundaries', 'checks', 'typescript', 'python', 'baseline', 'deadCode', 'organization'];
  for (const k of Object.keys(c)) if (!allowed.includes(k)) throw new Error(`Unknown configuration key: ${k}`);
  if (c.version !== 1) throw new Error('Unsupported configuration version');
  if (!c.python || typeof c.python !== 'object' || Array.isArray(c.python)) throw new Error('Invalid Python configuration');
  if (!c.checks || typeof c.checks !== 'object' || Array.isArray(c.checks)) throw new Error('Invalid checks configuration');
}

function validateConfiguration(c, root) {
  validateSourcePatterns(c);
  validateLimits(c.limits);
  if (!Array.isArray(c.overrides) || !Array.isArray(c.boundaries)) throw new Error('overrides and boundaries must be arrays');
  validateOverrides(c);
  validateBoundaries(c);
  validatePolicyFlags(c);
  validateTypescriptShape(c);
  if (!['off', 'basic', 'standard', 'strict'].includes(c.python.typeCheckingMode)) throw new Error('Invalid Python type checking mode');
  validateTypescriptProjects(c);
  validatePythonTools(c, root);
  validateEngineKeys(c);
  if (c.baseline !== null && typeof c.baseline !== 'string') throw new Error('baseline must be null or a file path');
  validateDeadCode(c);
  validateOrganization(c.organization);
}

function validateSourcePatterns(c) {
  for (const k of ['include', 'exclude']) if (!Array.isArray(c[k]) || c[k].some(v => typeof v !== 'string')) throw new Error(`${k} must be a list of glob patterns`);
  if (!c.include.length) throw new Error('include cannot be empty');
}
function validateEngineKeys(c) {
  const keys = { typescript: ['projects', 'requiredOptions', 'eslintRules'], python: pythonConfigurationKeys };
  for (const [key, allowed] of Object.entries(keys)) for (const name of Object.keys(c[key])) if (!allowed.includes(name)) throw new Error(`Unknown ${key} key: ${name}`);
}
function validateFlags(value, keys, label, partial = false) {
  if (!value || typeof value !== 'object') throw new Error(`${label} must be an object`);
  for (const [key, flag] of Object.entries(value)) if (!keys.includes(key) || typeof flag !== 'boolean') throw new Error(`Invalid ${label}.${key}`);
  if (!partial && keys.some(k => !(k in value))) throw new Error(`${label} is missing a required flag`);
}
function validateLimits(values, partial = false) {
  if (!values || typeof values !== 'object') throw new Error('limits must be an object');
  for (const [name, value] of Object.entries(values)) {
    if (!(name in limits) || !Array.isArray(value) || value.length !== 2 || value.some(n => !Number.isInteger(n) || n < 1) || value[0] >= value[1]) throw new Error(`Invalid limit ${name}: expected [warning, error]`);
  }
  if (!partial && Object.keys(limits).some(k => !(k in values))) throw new Error('Missing required size limits');
}
export function matches(file, patterns) { return patterns.some(p => minimatch(file, p, { dot: true })); }
export function fileLimits(file, c) {
  return c.overrides.filter(o => matches(file, o.files)).reduce((v, o) => ({ ...v, ...o.limits }), c.limits);
}
export function fileNaming(file, c) {
  return c.overrides.filter(o => matches(file, o.files)).reduce((v, o) => ({ ...v, ...o.naming }), c.naming);
}
export function discover(root, exclude) {
  const repository = run('git', ['rev-parse', '--show-toplevel'], root);
  if (repository.status === 0) {
    const listed = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], root);
    if (listed.status !== 0) throw new Error(listed.stderr || 'Git source discovery failed');
    return [...new Set(listed.stdout.split('\0').filter(Boolean))].filter(file => {
      if (matches(file, exclude)) return false;
      try { return fs.lstatSync(path.join(root, file)).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }).sort();
  }
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).replaceAll('\\', '/');
      if (entry.isSymbolicLink() || matches(relative, exclude) || matches(`${relative}/`, exclude)) continue;
      if (entry.isDirectory()) walk(absolute); else if (entry.isFile()) files.push(relative);
    }
  }
  walk(root);
  return files;
}

function validateOverrides(c) {
  for (const o of c.overrides) {
    if (!Array.isArray(o.files) || o.files.some(f => typeof f !== 'string')) throw new Error('Override files must be glob patterns');
    validateLimits(o.limits, true);
    if (typeof o.reason !== 'string' || o.reason.trim().length < 10) throw new Error('Every override requires a reason of at least 10 characters');
    for (const k of Object.keys(o)) if (!['files', 'limits', 'reason', 'naming'].includes(k)) throw new Error(`Unknown override key: ${k}`);
    if (o.naming) validateFlags(o.naming, ['files', 'identifiers'], 'override.naming', true);
  }
}

function validateBoundaries(c) {
  for (const b of c.boundaries) if (!Array.isArray(b.from) || !Array.isArray(b.disallow) || [...b.from, ...b.disallow].some(f => typeof f !== 'string')) throw new Error('Boundary patterns must be lists of strings');
}

function validatePolicyFlags(c) {
  for (const k of ['typescriptLint', 'typescriptTypes', 'pythonLint', 'pythonTypes', 'pythonUnusedCode', 'pythonCoverage', 'pythonDependencyAudit']) if (typeof c.checks?.[k] !== 'boolean') throw new Error(`checks.${k} must be boolean`);
  for (const k of ['files', 'identifiers']) if (typeof c.naming?.[k] !== 'boolean') throw new Error(`naming.${k} must be boolean`);
  validateFlags(c.naming, ['files', 'identifiers'], 'naming');
  validateFlags(c.checks, ['typescriptLint', 'typescriptTypes', 'pythonLint', 'pythonTypes', 'javascriptLint', 'pythonUnusedCode', 'pythonCoverage', 'pythonDependencyAudit'], 'checks', true);
  if (c.checks.javascriptLint !== undefined && typeof c.checks.javascriptLint !== 'boolean') throw new Error('checks.javascriptLint must be boolean');
  validateProject(c.project);
}
function validateProject(project) {
  const required = ['typescript', 'python', 'react', 'next', 'shadcn'];
  validateFlags(project, [...required, 'javascript'], 'project', true);
  for (const key of required) if (!(key in project)) throw new Error('project is missing a required flag');
}

function validateTypescriptShape(c) {
  if (!Array.isArray(c.typescript?.projects) || !Array.isArray(c.typescript?.requiredOptions) || !c.typescript.eslintRules || typeof c.typescript.eslintRules !== 'object') throw new Error('Invalid typescript configuration');
}

function validateTypescriptProjects(c) {
  for (const field of ['projects', 'requiredOptions']) if (c.typescript[field].some(p => typeof p !== 'string' || !p)) throw new Error(`typescript.${field} must contain nonempty strings`);
  if (c.checks.typescriptTypes && !c.typescript.projects.length) throw new Error('Type checking requires at least one TypeScript project');
}

function validateDeadCode(c) {
  if (c.deadCode !== undefined) {
    if (!c.deadCode || typeof c.deadCode !== 'object' || Object.keys(c.deadCode).some(k => !['entryPoints', 'protected'].includes(k))) throw new Error('Invalid deadCode configuration');
    for (const field of ['entryPoints', 'protected']) if (!Array.isArray(c.deadCode[field]) || c.deadCode[field].some(p => typeof p !== 'string' || !p)) throw new Error(`deadCode.${field} must contain glob patterns`);
  }
}

function detectTypescriptProjects(root, files) {
  const configs = files.filter(f => /(^|\/)tsconfig\.json$/.test(f));
  for (let i = 0; i < configs.length; i++) {
    const absolute = path.resolve(root, configs[i]);
    const parsed = ts.readConfigFile(absolute, ts.sys.readFile);
    for (const reference of parsed.config?.references ?? []) {
      const target = path.resolve(path.dirname(absolute), reference.path);
      const filename = target.endsWith('.json') ? target : path.join(target, 'tsconfig.json');
      const relative = path.relative(root, filename).replaceAll('\\', '/');
      if (!relative.startsWith('../') && files.includes(relative) && !configs.includes(relative)) configs.push(relative);
    }
  }
  const activeConfigs = configs.filter(project => {
    const absolute = path.resolve(root, project);
    const read = ts.readConfigFile(absolute, ts.sys.readFile);
    if (read.error) return true;
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(absolute), undefined, absolute);
    return parsed.fileNames.length > 0 || Boolean(parsed.projectReferences?.length) || parsed.errors.some(e => e.code !== 18003);
  });
  return activeConfigs;
}

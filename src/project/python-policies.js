import path from 'node:path';
import { severityLevels } from '../domain/findings.js';

const severityRules = [
  'python/nested-loop', 'python/raw-dict-return', 'python/inline-client',
  'python/inline-prompt', 'python/fat-activity', 'python/unused-definition',
  'python/coverage', 'python/dependency-cve',
];
const defaultSeverities = {
  'python/nested-loop': 'major', 'python/raw-dict-return': 'major',
  'python/inline-client': 'major', 'python/inline-prompt': 'minor',
  'python/fat-activity': 'critical', 'python/unused-definition': 'major',
  'python/dependency-cve': 'critical',
};

export const pythonConfigurationKeys = [
  'executable', 'ruffExecutable', 'ruffSelect', 'typeCheckingMode',
  'vultureExecutable', 'vultureMinConfidence', 'maxActivityLines',
  'maxInlinePromptLines', 'coverageReport', 'coverageMinimum',
  'dependencyFile', 'uvExecutable', 'pipAuditExecutable', 'severities',
];

export function pythonDefaults() {
  return {
    executable: 'python', ruffExecutable: 'ruff',
    ruffSelect: ['E4', 'E7', 'E9', 'F', 'B', 'I', 'N', 'ASYNC', 'ANN', 'BLE', 'PGH', 'RUF'],
    typeCheckingMode: 'strict', vultureExecutable: 'vulture',
    vultureMinConfidence: 60, maxActivityLines: 30, maxInlinePromptLines: 3,
    coverageReport: null, coverageMinimum: 60, dependencyFile: null,
    uvExecutable: 'uv', pipAuditExecutable: 'pip-audit',
    severities: structuredClone(defaultSeverities),
  };
}

export function normalizePythonChecks(config) {
  config.checks.pythonUnusedCode ??= Boolean(config.project?.python);
  config.checks.pythonCoverage ??= false;
  config.checks.pythonDependencyAudit ??= false;
  config.python.vultureExecutable ??= 'vulture';
  config.python.vultureMinConfidence ??= 60;
  config.python.maxActivityLines ??= 30;
  config.python.maxInlinePromptLines ??= 3;
  config.python.coverageReport ??= null;
  config.python.coverageMinimum ??= 60;
  config.python.dependencyFile ??= null;
  config.python.uvExecutable ??= 'uv';
  config.python.pipAuditExecutable ??= 'pip-audit';
  config.python.severities = { ...defaultSeverities, ...(config.python.severities ?? {}) };
}

export function applyPythonCheckOverrides(config, overrides, root) {
  if (overrides.coverageReport !== undefined) {
    config.python.coverageReport = overrides.coverageReport;
    config.checks.pythonCoverage = true;
  }
  if (overrides.pythonDependencyAudit) config.checks.pythonDependencyAudit = true;
  for (const value of overrides.severities ?? []) {
    const separator = value.lastIndexOf('=');
    if (separator < 1) throw new Error(`Invalid --severity '${value}'; expected RULE=LEVEL`);
    const rule = value.slice(0, separator);
    const level = value.slice(separator + 1);
    if (!severityRules.includes(rule)) throw new Error(`Unknown Python severity rule: ${rule}`);
    if (!severityLevels.includes(level)) throw new Error(`Invalid severity level '${level}'; expected ${severityLevels.join(', ')}`);
    config.python.severities[rule] = level;
  }
  validatePythonTools(config, root);
}

export function validatePythonTools(config, root) {
  validateExecutables(config.python);
  validateRuffRules(config.python.ruffSelect);
  validateThresholds(config.python);
  validatePaths(config.python, root);
  if (config.checks.pythonCoverage && !config.python.coverageReport) {
    throw new Error('checks.pythonCoverage requires python.coverageReport');
  }
  validateSeverities(config.python.severities);
}

function validateExecutables(python) {
  const fields = ['executable', 'ruffExecutable', 'vultureExecutable', 'uvExecutable', 'pipAuditExecutable'];
  for (const field of fields) if (typeof python[field] !== 'string' || !python[field]) throw new Error(`python.${field} is required`);
}

function validateRuffRules(rules) {
  if (!Array.isArray(rules) || !rules.length || rules.some(rule => typeof rule !== 'string')) {
    throw new Error('python.ruffSelect must be a nonempty rule list');
  }
}

function validateThresholds(python) {
  const thresholds = [
    ['vultureMinConfidence', python.vultureMinConfidence, 0, 100],
    ['maxActivityLines', python.maxActivityLines, 1, Number.MAX_SAFE_INTEGER],
    ['maxInlinePromptLines', python.maxInlinePromptLines, 1, Number.MAX_SAFE_INTEGER],
    ['coverageMinimum', python.coverageMinimum, 1, 100],
  ];
  for (const [field, value, minimum, maximum] of thresholds) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`python.${field} must be an integer from ${minimum} to ${maximum}`);
    }
  }
}

function validatePaths(python, root) {
  for (const field of ['coverageReport', 'dependencyFile']) {
    const value = python[field];
    if (value !== null && (typeof value !== 'string' || !value.trim())) {
      throw new Error(`python.${field} must be null or a project-relative file path`);
    }
    if (value !== null) projectPath(root, value, `python.${field}`);
  }
}

function validateSeverities(severities) {
  if (!severities || typeof severities !== 'object' || Array.isArray(severities)) {
    throw new Error('python.severities must be an object');
  }
  for (const [rule, level] of Object.entries(severities)) {
    if (!severityRules.includes(rule)) throw new Error(`Unknown python severity rule: ${rule}`);
    if (!severityLevels.includes(level)) throw new Error(`Invalid python.severities.${rule}: expected ${severityLevels.join(', ')}`);
  }
}

export function projectPath(root, value, label) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) throw new Error(`${label} must be a project-relative path`);
  const absolute = path.resolve(root, value);
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error(`${label} must stay inside the assessed project`);
  return absolute;
}

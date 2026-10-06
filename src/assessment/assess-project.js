import { discover, load, matches } from "../project/policies.js";
import { applyPythonCheckOverrides } from '../project/python-policies.js';
import { analyzeTypescript } from "../analysis/javascript/source-files.js";
import { analyzePython } from "../analysis/python/source.js";
import { isolatedTypescript } from '../analysis/javascript/project-workers.js';
import { lintJavascript } from '../analysis/javascript/lint-source.js';
import { pythonLint } from '../analysis/python/lint.js';
import { pythonTypes } from '../analysis/python/type-checking.js';
import { unusedPython } from '../analysis/python/unused-code.js';
import { pythonCoverage } from '../analysis/python/coverage.js';
import { pythonDependencyAudit } from '../analysis/python/dependency-audit.js';
import { buildReport, gitRevision, writeReport } from "./reports.js";
import { assessOrganization } from '../project/organization.js';

export async function check(root, output, configPath, overrides = {}) {
  const revision = gitRevision(root);
  let config;
  try {
    config = load(root, configPath);
    applyPythonCheckOverrides(config, overrides, root);
  }
  catch (error) {
    const report = buildReport(root, { config: { project: {}, baseline: null }, files: [],
      checks: [{ name: 'configuration', status: 'failed', detail: error.message }], findings: [], revision });
    if (configPath) report.configFile = configPath;
    writeReport(report, output);
    return report;
  }
  const files = discover(root, config.exclude).filter(f => matches(f, config.include));
  const ts = files.filter(f => /\.(?:ts|tsx|mts|cts)$/.test(f));
  const py = files.filter(f => f.endsWith('.py'));
  const js = files.filter(f => /\.(?:js|jsx|mjs|cjs)$/.test(f));
  const findings = [], checks = [];
  const scriptFiles = [...ts, ...js];
  const dependencyGraph = { version: 1, scope: 'JavaScript and TypeScript static imports; excludes external packages', nodes: scriptFiles, edges: [], unresolved: [] };
  function checkpoint(name, partial = []) {
    dependencyGraph.nodes = [...new Set([...scriptFiles, ...dependencyGraph.edges.map(e => e.target)])].sort();
    const report = buildReport(root, { config: { ...config, baseline: null }, files,
      checks: [...checks, { name, status: 'failed', detail: 'Assessment interrupted before this engine completed; rerun required.' }],
      findings: [...findings, ...partial], revision });
    report.dependencyGraph = dependencyGraph;
    if (configPath) report.configFile = configPath;
    writeReport(report, output);
  }
  async function engine(name, enabled, applicable, action) {
    if (!enabled || !applicable) {
      checks.push({ name, status: 'skipped', detail: !enabled ? 'Disabled in configuration' : 'No applicable files' }); return;
    }
    checkpoint(name);
    try {
      const outcome = await action();
      recordEngineResult(name, outcome, checks, findings);
    } catch (error) { if (error.findings) findings.push(...error.findings); checks.push({ name, status: 'failed', detail: error.message }); }
  }
  await engine('organization', Boolean(config.organization), files.length > 0, () => assessOrganization(files, config));
  await engine('typescript-structure', true, scriptFiles.length > 0, () => analyzeTypescript(root, scriptFiles, config, dependencyGraph));
  await engine('python-structure', true, py.length > 0, () => analyzePython(root, py, config));
  await engine('python-unused-code', config.checks.pythonUnusedCode, py.length > 0, () => unusedPython(root, py, config));
  await engine('python-coverage', config.checks.pythonCoverage, py.length > 0, () => pythonCoverage(root, py, config));
  await engine('python-dependency-audit', config.checks.pythonDependencyAudit, py.length > 0 || config.project.python, () => pythonDependencyAudit(root, config));
  await engine('javascript-lint', config.checks.javascriptLint !== false, js.length > 0, () => lintJavascript(root, js, config));
  await engine('typescript-lint', config.checks.typescriptLint, ts.length > 0, () => isolatedTypescript('typescript-lint', root, ts, config, partial => checkpoint('typescript-lint', partial)));
  await engine('typescript-types', config.checks.typescriptTypes, ts.length > 0, () => isolatedTypescript('typescript-types', root, ts, config, partial => checkpoint('typescript-types', partial)));
  await engine('python-lint', config.checks.pythonLint, py.length > 0, () => pythonLint(root, py, config));
  await engine('python-types', config.checks.pythonTypes, py.length > 0, () => pythonTypes(root, py, config));
  if (!files.length) checks.push({ name: 'source-discovery', status: 'failed', detail: 'No matching source files; review include/exclude patterns.' });
  let report;
  try { report = buildReport(root, { config, files, checks, findings, revision }); }
  catch (error) {
    checks.push({ name: 'baseline', status: 'failed', detail: error.message });
    report = buildReport(root, { config: { ...config, baseline: null }, files, checks, findings, revision });
  }
  dependencyGraph.nodes = [...new Set([...scriptFiles, ...dependencyGraph.edges.map(e => e.target)])].sort();
  report.dependencyGraph = dependencyGraph;
  if (configPath) report.configFile = configPath;
  writeReport(report, output);
  return report;
}

function recordEngineResult(name, outcome, checks, findings) {
  const issues = Array.isArray(outcome) ? outcome : outcome.findings;
  if (!Array.isArray(issues)) throw new Error('Assessment engine returned an invalid result');
  findings.push(...issues);
  const parseFailures = issues.filter(f => ['eslint/parse', 'eslint/configuration'].includes(f.ruleId));
  const detail = parseFailures.length
    ? `${parseFailures.length} lint parsing, project coverage or compiler-option prerequisites failed.`
    : outcome.detail;
  checks.push({ name, status: parseFailures.length ? 'failed' : 'completed', findings: issues.length,
    ...(detail ? { detail } : {}) });
}

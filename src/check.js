import { discover, load, matches } from './config.js';
import { analyzeTypescript } from './typescript.js';
import { analyzePython } from './python.js';
import { isolatedTypescript, pythonLint, pythonTypes } from './engines.js';
import { buildReport, writeReport } from './report.js';

export async function check(root, output, configPath) {
  let config;
  try { config = load(root, configPath); }
  catch (error) {
    const report = buildReport(root, { project: {}, baseline: null }, [], [{ name: 'configuration', status: 'failed', detail: error.message }], []);
    if (configPath) report.configFile = configPath;
    writeReport(report, output);
    return report;
  }
  const files = discover(root, config.exclude).filter(f => matches(f, config.include));
  const ts = files.filter(f => /\.(?:ts|tsx|mts|cts)$/.test(f));
  const py = files.filter(f => f.endsWith('.py'));
  const findings = [], checks = [];
  const dependencyGraph = { version: 1, scope: 'TypeScript static imports only; excludes external packages', nodes: ts, edges: [], unresolved: [] };
  function checkpoint(name, partial = []) {
    dependencyGraph.nodes = [...new Set([...ts, ...dependencyGraph.edges.map(e => e.target)])].sort();
    const report = buildReport(root, { ...config, baseline: null }, files,
      [...checks, { name, status: 'failed', detail: 'Assessment interrupted before this engine completed; rerun required.' }], [...findings, ...partial]);
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
      const issues = await action(); findings.push(...issues);
      const parseFailures = issues.filter(f => ['eslint/parse', 'eslint/configuration'].includes(f.ruleId));
      checks.push({ name, status: parseFailures.length ? 'failed' : 'completed', findings: issues.length, ...(parseFailures.length ? { detail: `${parseFailures.length} lint parsing, project coverage or compiler-option prerequisites failed.` } : {}) });
    } catch (error) { if (error.findings) findings.push(...error.findings); checks.push({ name, status: 'failed', detail: error.message }); }
  }
  await engine('typescript-structure', true, ts.length > 0, () => analyzeTypescript(root, ts, config, dependencyGraph));
  await engine('python-structure', true, py.length > 0, () => analyzePython(root, py, config));
  await engine('typescript-lint', config.checks.typescriptLint, ts.length > 0, () => isolatedTypescript('typescript-lint', root, ts, config, partial => checkpoint('typescript-lint', partial)));
  await engine('typescript-types', config.checks.typescriptTypes, ts.length > 0, () => isolatedTypescript('typescript-types', root, ts, config, partial => checkpoint('typescript-types', partial)));
  await engine('python-lint', config.checks.pythonLint, py.length > 0, () => pythonLint(root, py, config));
  await engine('python-types', config.checks.pythonTypes, py.length > 0, () => pythonTypes(root, py, config));
  if (!files.length) checks.push({ name: 'source-discovery', status: 'failed', detail: 'No matching source files; review include/exclude patterns.' });
  let report;
  try { report = buildReport(root, config, files, checks, findings); }
  catch (error) {
    checks.push({ name: 'baseline', status: 'failed', detail: error.message });
    report = buildReport(root, { ...config, baseline: null }, files, checks, findings);
  }
  dependencyGraph.nodes = [...new Set([...ts, ...dependencyGraph.edges.map(e => e.target)])].sort();
  report.dependencyGraph = dependencyGraph;
  if (configPath) report.configFile = configPath;
  writeReport(report, output);
  return report;
}

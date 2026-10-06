import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finding } from '../../domain/findings.js';
import { projectPath } from '../../project/python-policies.js';
import { run } from '../../runtime/processes.js';

export function pythonDependencyAudit(root, config) {
  const dependencyFile = findDependencyFile(root, config.python.dependencyFile);
  const relativeDependencyFile = path.relative(root, dependencyFile).replaceAll('\\', '/');
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sloppy-pip-audit-'));
  try {
    let requirementsFile = dependencyFile;
    if (path.basename(dependencyFile) === 'uv.lock') {
      requirementsFile = path.join(temporaryDirectory, 'requirements.txt');
      const exported = run(config.python.uvExecutable, [
        'export', '--format', 'requirements-txt', '--frozen', '--no-hashes',
        '--all-packages', '--no-emit-workspace', '--no-dev',
        '--output-file', requirementsFile,
      ], path.dirname(dependencyFile));
      if (exported.status !== 0) throw new Error(exported.stderr || 'uv export failed');
    }

    const result = run(config.python.pipAuditExecutable, [
      '--disable-pip', '--no-deps', '--format', 'json', '--progress-spinner', 'off',
      '-r', requirementsFile,
    ], root);
    if (![0, 1].includes(result.status) || !result.stdout.trim()) {
      throw new Error(result.stderr || result.stdout || `pip-audit failed with exit ${result.status}`);
    }
    const findings = parseAuditOutput(relativeDependencyFile, result.stdout, config);
    if (result.status === 1 && findings.length === 0) throw new Error('pip-audit exited with a finding status but reported no vulnerabilities');
    return findings;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseAuditOutput(file, output, config) {
  const dependencies = decodeAuditOutput(output);
  const context = { file, config, seen: new Set() };
  const findings = [];
  for (const dependency of dependencies) {
    validateDependency(dependency);
    findings.push(...dependencyFindings(dependency, context));
  }
  return findings;
}

function decodeAuditOutput(output) {
  let report;
  try { report = JSON.parse(output); }
  catch (error) { throw new Error(`pip-audit returned invalid JSON: ${error.message}`); }
  if (!Array.isArray(report.dependencies)) throw new Error('pip-audit JSON must contain a dependencies array');
  return report.dependencies;
}

function validateDependency(dependency) {
  if (typeof dependency.name !== 'string' || typeof dependency.version !== 'string' || !Array.isArray(dependency.vulns)) {
    throw new Error('pip-audit returned a dependency with an invalid shape');
  }
}

function dependencyFindings(dependency, context) {
  return dependency.vulns.map(vulnerability => vulnerabilityFinding(dependency, vulnerability, context)).filter(Boolean);
}

function vulnerabilityFinding(dependency, vulnerability, { file, config, seen }) {
  if (typeof vulnerability.id !== 'string') throw new Error('pip-audit returned a vulnerability without an id');
  const key = `${dependency.name}@${dependency.version}:${vulnerability.id}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const fixes = stringValues(vulnerability.fix_versions);
  const aliases = stringValues(vulnerability.aliases);
  return finding('python/dependency-cve', {
    file, line: 1, column: 1, symbol: `${dependency.name}==${dependency.version}`,
    message: `${dependency.name}==${dependency.version} has known vulnerability ${vulnerability.id}${fixes.length ? ` (fix: ${fixes.join(', ')})` : ' (no fix version reported)'}`,
    guidance: 'Upgrade the affected dependency to a fixed version and refresh the lockfile; rerun the audit to verify the resolved dependency set.',
    level: config.python.severities['python/dependency-cve'],
    evidence: { advisoryId: vulnerability.id, aliases, fixVersions: fixes, dependency: { name: dependency.name, version: dependency.version } },
  });
}

function stringValues(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function findDependencyFile(root, configured) {
  const candidate = configured
    ? projectPath(root, configured, 'Python dependency file')
    : path.join(root, 'uv.lock');
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw new Error(`Python dependency audit needs a lock or requirements file; configure python.dependencyFile (looked for ${configured ?? 'uv.lock'})`);
  }
  return candidate;
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { matches } from "../project/policies.js";
import { versions } from '../runtime/tool-versions.js';
import { moduleOwners } from '../domain/module-ownership.js';
import { groupLabels, evidenceGroup, counts, countsByLevel, countsByLevelAndConfidence, writeMarkdownReport } from './report-format.js';
export { formatReportSummary, formatReportTags, writeMarkdownReport } from './report-format.js';
import { sourceRole, sourceRoleRank } from '../project/source-scopes.js';
import { registerReport } from '../project/report-catalog.js';

export const REPORT_MODES = Object.freeze(['default', 'critical', 'deep']);

export function validateReportMode(mode) {
  if (!REPORT_MODES.includes(mode)) throw new Error(`Invalid report mode '${mode}'; choose ${REPORT_MODES.join(', ')}`);
  return mode;
}

export function gitRevision(root) {
  const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 });
  if (head.error || head.status !== 0) return null;
  const status = spawnSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=normal', '--', '.'],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  return { commit: head.stdout.trim(), dirty: status.error || status.status !== 0 ? null : Boolean(status.stdout.trim()) };
}

function rankHotspots(findings) {
  const byFile = new Map();
  for (const item of findings) {
    if (item.ownership !== 'project' || item.kind === 'dependency' || item.confidence === 'low') continue;
    if (!byFile.has(item.file)) byFile.set(item.file, []);
    byFile.get(item.file).push(item);
  }
  return [...byFile].map(([file, items]) => ({
    file, sourceRole: sourceRole(file), rules: [...new Set(items.map(item => item.ruleId))].sort(),
    findings: items.length, gateErrors: items.filter(item => item.blocksGate).length,
  })).sort((a, b) => sourceRoleRank[a.sourceRole] - sourceRoleRank[b.sourceRole]
    || Number(b.gateErrors > 0) - Number(a.gateErrors > 0)
    || b.rules.length - a.rules.length || b.gateErrors - a.gateErrors
    || b.findings - a.findings || a.file.localeCompare(b.file)).slice(0, 10);
}

export function buildReport(root, { config, files, checks, findings, revision = null, mode = 'default' }) {
  validateReportMode(mode);
  for (const item of findings) item.ownership = item.file.startsWith('../') || /(^|\/)node_modules\//.test(item.file) ? 'dependency' : matches(item.file, config.exclude ?? []) ? 'excluded' : 'project';
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.ruleId.localeCompare(b.ruleId));
  const staleBaseline = applyBaseline(root, config, findings);
  const active = findings.filter(item => !item.baseline);
  const surfacedActive = active.filter(item => includeFinding(item, mode));
  const surfaced = findings.filter(item => includeFinding(item, mode));
  const { errors, warnings, gateErrors } = counts(active);
  const groups = Object.fromEntries(Object.keys(groupLabels).map(group => [group, counts(active.filter(item => evidenceGroup(item) === group))]));
  const reviewLeads = active.filter(item => item.kind === 'review' && item.ownership === 'project').length;
  const levels = countsByLevel(active);
  const levelConfidence = countsByLevelAndConfidence(active);
  const complete = checks.every(c => c.status !== 'failed') && files.length > 0;
  const sourceGroups = Object.fromEntries(Object.keys(sourceRoleRank).map(role => [role, {
    files: files.filter(file => sourceRole(file) === role).length,
    ...counts(active.filter(item => item.ownership === 'project' && sourceRole(item.file) === role)),
  }]));
  return {
    version: 1, root, project: config.project, configFile: '.sloppy.json', toolVersions: versions,
    mode,
    revision,
    complete, passed: complete && gateErrors === 0,
    repositoryChecks: 'not-run',
    summary: { files: files.length, errors, warnings, gateErrors, reviewLeads, levels, levelConfidence, groups,
      baseline: findings.filter(f => f.baseline).length, baselineConfigured: Boolean(config.baseline), sourceGroups,
      totalFindings: active.length, surfacedFindings: surfacedActive.length, hiddenFindings: active.length - surfacedActive.length },
    hotspots: rankHotspots(surfacedActive),
    checks, findings: surfaced, staleBaseline,
    moduleMap: files.map(file => ({ file, owners: config.organization ? moduleOwners(file, config.organization).map(owner => owner.name) : [] })),
    reviewOnly: [
      'JavaScript receives structural analysis and linting, not TypeScript type checking. Passing static checks does not certify production readiness or runtime correctness.',
      'Whether files within each owner have cohesive responsibilities, clear names, and abstractions that earn their cost.',
      'Whether local, URL, server, and global state have the appropriate ownership.',
      'Whether updates need transactional atomicity or async work can safely run in parallel.',
      'Runtime validation, behavioral correctness, and accessibility beyond static lint coverage.',
      'Vulture unused-definition findings can miss dynamic entry points or public APIs consumed outside the repository. TypeScript module reachability requires explicit entryPoints; framework discovery and external consumers require review.',
      'Change risk is indicated by complexity, nesting, size, and import cycles; static checks cannot establish that code is untouchable or identify AI authorship.',
    ],
  };
}
export function writeReport(report, directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'module-map.json'), JSON.stringify({ version: 1, modules: report.moduleMap, dependencies: report.dependencyGraph ?? null }, null, 2) + '\n');
  const grouped = new Map();
  for (const finding of report.findings.filter(f => !f.baseline && f.ownership === 'project' && f.kind !== 'dependency')) {
    if (!grouped.has(finding.file)) grouped.set(finding.file, []);
    grouped.get(finding.file).push(finding);
  }
  const hotspotRank = new Map(report.hotspots.map((item, index) => [item.file, index]));
  const priorityRank = { gate: 0, review: 1, advisory: 2 };
  const tasks = [...grouped].map(([file, findings]) => {
    const absolute = path.resolve(report.root, file);
    let source = null;
    try { source = fs.readFileSync(absolute, 'utf8'); } catch { /* Compiler diagnostics can point to unavailable files. */ }
    const lines = source?.split(/\r?\n/);
    return { file, sourceRole: sourceRole(file), imports: (report.dependencyGraph?.edges ?? []).filter(e => e.source === file), importedBy: (report.dependencyGraph?.edges ?? []).filter(e => e.target === file),
      priority: findings.some(f => f.blocksGate) ? 'gate' : findings.some(f => f.kind === 'review') ? 'review' : 'advisory',
      sourceSha256: source === null ? null : crypto.createHash('sha256').update(source).digest('hex'),
      findings: findings.map(f => ({ fingerprint: f.fingerprint, ruleId: f.ruleId, severity: f.severity, level: f.level, kind: f.kind, confidence: f.confidence, blocksGate: f.blocksGate, autoFix: f.autoFix, line: f.line, column: f.column, symbol: f.symbol,
        message: f.message, guidance: f.guidance, evidence: f.evidence,
        sourceExcerpt: lines ? lines.slice(Math.max(0, f.line - 2), f.line + 1).map((text, i) => ({ line: Math.max(1, f.line - 1) + i, text })) : [],
      })) };
  }).sort((a, b) => {
    return sourceRoleRank[a.sourceRole] - sourceRoleRank[b.sourceRole]
      || priorityRank[a.priority] - priorityRank[b.priority]
      || (hotspotRank.get(a.file) ?? Infinity) - (hotspotRank.get(b.file) ?? Infinity)
      || a.file.localeCompare(b.file);
  });
  fs.writeFileSync(path.join(directory, 'repair-plan.json'), JSON.stringify({ version: 1, root: report.root,
    ...(report.mode ? { mode: report.mode, surfacedFindings: report.summary.surfacedFindings, hiddenFindings: report.summary.hiddenFindings } : {}),
    complete: report.complete, blockers: report.checks.filter(c => c.status === 'failed'),
    instructions: 'Resolve failed checks first. Compare diagnostics with repository checks; verify review leads before editing. Tasks distinguish source, test/fixture, and tooling paths without changing their gate status. Do not remove defensive guards solely because compiler options omit unchecked-index safety. Check source hashes before changes and rerun the assessment afterward.',
    dependencyFindings: report.findings.filter(f => !f.baseline && f.kind === 'dependency'),
    externalDiagnostics: report.findings.filter(f => !f.baseline && f.ownership !== 'project' && f.kind !== 'dependency'), tasks }, null, 2) + '\n');
  if (report.dependencyGraph) fs.writeFileSync(path.join(directory, 'dependency-graph.json'), JSON.stringify(report.dependencyGraph, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  writeMarkdownReport(report, directory);
  try { registerReport(report.root, path.join(directory, 'report.json')); }
  catch (error) { console.error(`sloppy: Could not register dashboard report: ${error.message}`); }
}

function includeFinding(item, mode) {
  if (mode === 'deep') return true;
  if (mode === 'critical') return item.level === 'critical';
  return item.confidence !== 'low';
}

function applyBaseline(root, config, findings) {
  let staleBaseline = [];
  if (config.baseline) {
    const baseline = JSON.parse(fs.readFileSync(path.resolve(root, config.baseline), 'utf8'));
    if (baseline.version !== 1 || !Array.isArray(baseline.fingerprints) || baseline.fingerprints.some(f => typeof f !== 'string')) throw new Error('Invalid baseline');
    const counts = new Map();
    for (const fingerprint of baseline.fingerprints) counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
    for (const item of findings) if (counts.get(item.fingerprint) > 0) {
      item.baseline = true; counts.set(item.fingerprint, counts.get(item.fingerprint) - 1);
    }
    staleBaseline = [...counts.entries()].filter(([, count]) => count > 0).map(([fingerprint, count]) => ({ fingerprint, count }));
  }
  return staleBaseline;
}

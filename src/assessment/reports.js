import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { matches } from "../project/policies.js";
import { versions } from '../runtime/tool-versions.js';
import { moduleOwners } from '../domain/module-ownership.js';

export function buildReport(root, config, files, checks, findings) {
  for (const item of findings) item.ownership = item.file.startsWith('../') || /(^|\/)node_modules\//.test(item.file) ? 'dependency' : matches(item.file, config.exclude ?? []) ? 'excluded' : 'project';
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.ruleId.localeCompare(b.ruleId));
  const staleBaseline = applyBaseline(root, config, findings);
  const errors = findings.filter(f => f.severity === 'error' && !f.baseline).length;
  const warnings = findings.filter(f => f.severity === 'warning' && !f.baseline).length;
  const complete = checks.every(c => c.status !== 'failed') && files.length > 0;
  return {
    version: 1, root, project: config.project, configFile: '.sloppy.json', toolVersions: versions,
    complete, passed: complete && errors === 0, summary: { files: files.length, errors, warnings, baseline: findings.filter(f => f.baseline).length },
    checks, findings, staleBaseline,
    moduleMap: files.map(file => ({ file, owners: config.organization ? moduleOwners(file, config.organization).map(owner => owner.name) : [] })),
    reviewOnly: [
      'JavaScript receives structural analysis and linting, not TypeScript type checking. Passing static checks does not certify production readiness or runtime correctness.',
      'Whether abstractions earn their complexity and canonical helpers are reused.',
      'Whether local, URL, server, and global state have the appropriate ownership.',
      'Whether updates need transactional atomicity or async work can safely run in parallel.',
      'Runtime validation, behavioral correctness, and accessibility beyond static lint coverage.',
      'Dead-code module candidates require explicit TypeScript entryPoints; unreferenced exports and Python module reachability are not assessed. Framework discovery and external consumers require review.',
      'Change risk is indicated by complexity, nesting, size, and import cycles; static checks cannot establish that code is untouchable or identify AI authorship.',
    ],
  };
}
export function writeReport(report, directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'module-map.json'), JSON.stringify({ version: 1, modules: report.moduleMap, dependencies: report.dependencyGraph ?? null }, null, 2) + '\n');
  const grouped = new Map();
  for (const finding of report.findings.filter(f => !f.baseline && f.ownership === 'project')) {
    if (!grouped.has(finding.file)) grouped.set(finding.file, []);
    grouped.get(finding.file).push(finding);
  }
  const tasks = [...grouped].map(([file, findings]) => {
    const absolute = path.resolve(report.root, file);
    let source = null;
    try { source = fs.readFileSync(absolute, 'utf8'); } catch { /* Compiler diagnostics can point to unavailable files. */ }
    const lines = source?.split(/\r?\n/);
    return { file, imports: (report.dependencyGraph?.edges ?? []).filter(e => e.source === file), importedBy: (report.dependencyGraph?.edges ?? []).filter(e => e.target === file), priority: findings.some(f => f.severity === 'error') ? 'error' : 'warning',
      sourceSha256: source === null ? null : crypto.createHash('sha256').update(source).digest('hex'),
      findings: findings.map(f => ({ fingerprint: f.fingerprint, ruleId: f.ruleId, severity: f.severity, autoFix: f.autoFix, line: f.line, column: f.column, symbol: f.symbol,
        message: f.message, guidance: f.guidance, evidence: f.evidence,
        sourceExcerpt: lines ? lines.slice(Math.max(0, f.line - 2), f.line + 1).map((text, i) => ({ line: Math.max(1, f.line - 1) + i, text })) : [],
      })) };
  }).sort((a, b) => Number(b.priority === 'error') - Number(a.priority === 'error') || a.file.localeCompare(b.file));
  fs.writeFileSync(path.join(directory, 'repair-plan.json'), JSON.stringify({ version: 1, root: report.root,
    complete: report.complete, blockers: report.checks.filter(c => c.status === 'failed'),
    instructions: 'Resolve blockers first. Verify source hashes before editing. Preserve behavior; re-run the assessment after repairs. Findings are static evidence, not proof of runtime bugs.',
    externalDiagnostics: report.findings.filter(f => f.ownership !== 'project'), tasks }, null, 2) + '\n');
  if (report.dependencyGraph) fs.writeFileSync(path.join(directory, 'dependency-graph.json'), JSON.stringify(report.dependencyGraph, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const lines = [
    '# Sloppy report', '',
    `Result: ${report.passed ? 'PASS' : 'FAIL'}; assessment ${report.complete ? 'complete' : 'incomplete'}.`,
    `Files: ${report.summary.files}; new errors: ${report.summary.errors}; warnings: ${report.summary.warnings}; baseline findings: ${report.summary.baseline}.`, '',
    '## Checks', '', ...report.checks.map(c => `- ${c.name}: ${c.status}${c.detail ? ` — ${c.detail.replaceAll('\n', ' ')}` : ''}`), '',
    '## Agent repair instructions', '',
    'Fix tool/configuration failures first. Address new errors before warnings. Preserve behavior and existing architecture. Re-run sloppy check after repairs. A listed auto-fix is a tool-provided candidate, not an instruction to apply it blindly. Baseline findings are existing debt, not verified correctness.', '',
  ];
  for (const f of report.findings) lines.push(
    `### ${f.severity.toUpperCase()} ${f.ruleId}${f.baseline ? ' [baseline]' : ''}`, '',
    `Location: ${f.file}:${f.line}:${f.column}${f.symbol ? ` (${f.symbol})` : ''}`, '',
    f.message, '', `Evidence: ${JSON.stringify(f.evidence)}`, '', `Repair: ${f.guidance}`, '',
  );
  lines.push('## Requires human or agent review', '', ...report.reviewOnly.map(r => `- ${r}`), '');
  if (report.staleBaseline.length) lines.push(`Stale baseline entries: ${report.staleBaseline.reduce((n, e) => n + e.count, 0)}. Regenerate only after reviewing the remaining debt.`, '');
  fs.writeFileSync(path.join(directory, 'report.md'), lines.join('\n'));
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

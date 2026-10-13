import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { matches } from "../project/policies.js";
import { versions } from '../runtime/tool-versions.js';
import { moduleOwners } from '../domain/module-ownership.js';
import { confidenceLevels, severityLevels } from '../domain/findings.js';
import { sourceRole, sourceRoleRank } from '../project/source-scopes.js';

const groupLabels = {
  diagnostic: 'diagnostic',
  policy: 'policy',
  review: 'review',
  dependency: 'dependency',
  outsideScope: 'outside-scope',
};
const displayLevels = [...severityLevels].reverse();

function evidenceGroup(item) {
  if (item.kind === 'dependency') return 'dependency';
  return item.ownership === 'project' ? item.kind : 'outsideScope';
}

function counts(items) {
  return {
    total: items.length,
    gateErrors: items.filter(item => item.blocksGate).length,
    errors: items.filter(item => item.severity === 'error').length,
    warnings: items.filter(item => item.severity === 'warning').length,
  };
}

function countsByLevel(items) {
  return Object.fromEntries(severityLevels.map(level => [level, items.filter(item => item.level === level).length]));
}

function formatSeverityTotals(levels) {
  return displayLevels.map(level => `${levels[level].toLocaleString('en-US')} ${level}`).join(', ');
}

export function formatReportSummary(report) {
  const status = !report.complete ? 'INCOMPLETE' : report.passed ? 'PASS' : 'FAIL';
  const total = Object.values(report.summary.levels).reduce((sum, count) => sum + count, 0);
  return `${status}: ${countLabel(total, 'finding')}; ${formatSeverityTotals(report.summary.levels)}.`;
}

export function formatReportTags(report) {
  const categories = Object.entries(groupLabels).filter(([group]) => report.summary.groups[group].total)
    .map(([group, label]) => `[${label}] ${report.summary.groups[group].total.toLocaleString('en-US')}`);
  const total = Object.values(report.summary.levels).reduce((sum, count) => sum + count, 0);
  return `Tags: ${categories.length ? categories.join(', ') + '; ' : ''}[blocking] ${report.summary.gateErrors.toLocaleString('en-US')}, [advisory] ${(total - report.summary.gateErrors).toLocaleString('en-US')}.`;
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

export function buildReport(root, { config, files, checks, findings, revision = null }) {
  for (const item of findings) item.ownership = item.file.startsWith('../') || /(^|\/)node_modules\//.test(item.file) ? 'dependency' : matches(item.file, config.exclude ?? []) ? 'excluded' : 'project';
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.ruleId.localeCompare(b.ruleId));
  const staleBaseline = applyBaseline(root, config, findings);
  const active = findings.filter(item => !item.baseline);
  const { errors, warnings, gateErrors } = counts(active);
  const groups = Object.fromEntries(Object.keys(groupLabels).map(group => [group, counts(active.filter(item => evidenceGroup(item) === group))]));
  const reviewLeads = active.filter(item => item.kind === 'review' && item.ownership === 'project').length;
  const levels = countsByLevel(active);
  const levelConfidence = Object.fromEntries(severityLevels.map(level => [level,
    Object.fromEntries(confidenceLevels.map(confidence => [confidence,
      active.filter(item => item.level === level && item.confidence === confidence).length]))]));
  const complete = checks.every(c => c.status !== 'failed') && files.length > 0;
  const sourceGroups = Object.fromEntries(Object.keys(sourceRoleRank).map(role => [role, {
    files: files.filter(file => sourceRole(file) === role).length,
    ...counts(active.filter(item => item.ownership === 'project' && sourceRole(item.file) === role)),
  }]));
  return {
    version: 1, root, project: config.project, configFile: '.sloppy.json', toolVersions: versions,
    revision,
    complete, passed: complete && gateErrors === 0,
    repositoryChecks: 'not-run',
    summary: { files: files.length, errors, warnings, gateErrors, reviewLeads, levels, levelConfidence, groups,
      baseline: findings.filter(f => f.baseline).length, baselineConfigured: Boolean(config.baseline), sourceGroups },
    hotspots: rankHotspots(active),
    checks, findings, staleBaseline,
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
    complete: report.complete, blockers: report.checks.filter(c => c.status === 'failed'),
    instructions: 'Resolve failed checks first. Compare diagnostics with repository checks; verify review leads before editing. Tasks distinguish source, test/fixture, and tooling paths without changing their gate status. Do not remove defensive guards solely because compiler options omit unchecked-index safety. Check source hashes before changes and rerun the assessment afterward.',
    dependencyFindings: report.findings.filter(f => !f.baseline && f.kind === 'dependency'),
    externalDiagnostics: report.findings.filter(f => !f.baseline && f.ownership !== 'project' && f.kind !== 'dependency'), tasks }, null, 2) + '\n');
  if (report.dependencyGraph) fs.writeFileSync(path.join(directory, 'dependency-graph.json'), JSON.stringify(report.dependencyGraph, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  writeMarkdownReport(report, directory);
}

function topRules(items, limit = 6) {
  const byRule = new Map();
  for (const item of items) {
    const tags = `[${item.kind}] [${item.blocksGate ? 'blocking' : 'advisory'}]${item.ownership !== 'project' && item.kind !== 'dependency' ? ' [outside-scope]' : ''}`;
    const key = `${item.ruleId} ${tags}`;
    if (!byRule.has(key)) byRule.set(key, { rule: item.ruleId, tags, findings: [] });
    byRule.get(key).findings.push(item);
  }
  const groups = [...byRule.values()].sort((first, second) => second.findings.length - first.findings.length
    || first.rule.localeCompare(second.rule) || first.tags.localeCompare(second.tags));
  return [
    ...groups.slice(0, limit).map(({ rule, tags, findings }) => `- \`${rule}\` ${tags}: ${countLabel(findings.length, 'finding')}, \`${findings[0].file}:${findings[0].line}\`.`),
    ...(groups.length > limit ? [`${countLabel(groups.length - limit, 'more rule group')} in report.json.`] : []),
  ];
}

function countLabel(count, singular) {
  return `${count.toLocaleString('en-US')} ${singular}${count === 1 ? '' : 's'}`;
}

function markdownIntro(report) {
  const baselineNote = !report.complete
    ? 'Counts may be partial until failed checks are rerun.'
    : report.summary.baselineConfigured
      ? 'Unbaselined findings are not necessarily changes in this Git revision.'
      : 'Counts cover all selected sources; no baseline is configured.';
  return [
    '# Sloppy report', '',
    formatReportSummary(report),
    `${countLabel(report.summary.files, 'file')}; ${countLabel(report.summary.baseline, 'baseline finding')}.`,
    report.revision ? `Git ${report.revision.commit.slice(0, 12)}${report.revision.dirty === true ? ' + uncommitted changes' : report.revision.dirty === null ? ' (worktree state unknown)' : ''}.` : 'Git revision unavailable.',
    baselineNote,
    'Severities follow configured rule levels, not confirmed defect risk. Counts include advisory findings. Repository lint, typecheck, and tests were not run.',
    'Tags describe the category and gate status. [review] findings need verification before editing. [blocking] findings fail the gate; [advisory] findings do not.', '',
  ];
}

function markdownCategories(report, active) {
  const presentGroups = Object.entries(groupLabels).filter(([group]) => report.summary.groups[group].total);
  return [
    '## Categories', '',
    ...(presentGroups.length ? ['| Category | Critical | Major | Minor | Info | [blocking] | [advisory] |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...presentGroups.map(([group, label]) => {
        const levels = countsByLevel(active.filter(item => evidenceGroup(item) === group));
        const { total, gateErrors } = report.summary.groups[group];
        return `| [${label}] | ${displayLevels.map(level => levels[level]).join(' | ')} | ${gateErrors} | ${total - gateErrors} |`;
      })] : ['No findings.']), '',
    '## Source scope', '',
    '| Paths | Files | Critical | Major | Minor | Info |', '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries({ source: 'Source', test: 'Tests and fixtures', tooling: 'Scripts and repository tooling' }).map(([role, label]) => {
      const levels = countsByLevel(active.filter(item => item.ownership === 'project' && sourceRole(item.file) === role));
      return `| ${label} | ${report.summary.sourceGroups[role].files} | ${displayLevels.map(level => levels[level]).join(' | ')} |`;
    }), '',
    'Path-based scope labels do not exempt files from checks. Source candidates rank before tests and tooling.', '',
  ];
}

function markdownChecks(checks) {
  const failed = checks.filter(check => check.status === 'failed');
  const skipped = checks.filter(check => check.status === 'skipped');
  const completed = checks.filter(check => check.status === 'completed');
  const lines = [];
  for (const check of failed) lines.push(`- Failed: ${check.name} (${String(check.detail ?? 'no detail').replaceAll('\n', ' ')})`);
  const skippedByReason = new Map();
  for (const check of skipped) {
    const reason = check.detail ?? 'no detail';
    if (!skippedByReason.has(reason)) skippedByReason.set(reason, []);
    skippedByReason.get(reason).push(check.name);
  }
  for (const [reason, names] of skippedByReason) lines.push(`- Skipped (${reason}): ${names.join(', ')}`);
  lines.push(`- Completed (${completed.length}): ${completed.map(check => check.name).join(', ') || 'none'}.`, '',
    'Full findings and guidance: report.json. File-grouped context and dependency advisories: repair-plan.json.', '');
  return lines;
}

export function writeMarkdownReport(report, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const active = report.findings.filter(item => !item.baseline);
  const lines = markdownIntro(report);
  for (const level of displayLevels) {
    const findings = active.filter(item => item.level === level);
    lines.push(`## ${level[0].toUpperCase()}${level.slice(1)}`, '',
      ...(findings.length ? topRules(findings) : ['None.']), '');
  }
  lines.push(...markdownCategories(report, active));
  if (active.length) lines.push('## Severity and confidence', '', '| Severity | High | Medium | Low |', '| --- | ---: | ---: | ---: |',
    ...displayLevels.map(level => `| ${level} | ${confidenceLevels.map(confidence => report.summary.levelConfidence[level][confidence]).join(' | ')} |`),
    '', 'Confidence measures the evidence behind a finding; it does not establish a defect.', '');
  lines.push('## Files to inspect', '',
    ...report.hotspots.slice(0, 5).map(item => `- ${item.file} [${item.sourceRole}]: ${countLabel(item.rules.length, 'rule')}; ${formatSeverityTotals(countsByLevel(active.filter(finding => finding.file === item.file && finding.ownership === 'project' && finding.kind !== 'dependency' && finding.confidence !== 'low')))}.`),
    ...(report.hotspots.length ? [] : ['No high- or medium-confidence project findings.']), '',
    '## Checks', '', ...markdownChecks(report.checks));
  if (report.staleBaseline.length) lines.push(`Stale baseline entries: ${report.staleBaseline.reduce((n, entry) => n + entry.count, 0)}. Review before regenerating.`, '');
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

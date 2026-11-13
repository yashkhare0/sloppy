import fs from 'node:fs';
import path from 'node:path';
import { confidenceLevels, severityLevels, normalizeReportFinding } from '../domain/findings.js';
import { sourceRole } from '../project/source-scopes.js';

export const groupLabels = {
  diagnostic: 'diagnostic',
  policy: 'policy',
  review: 'review',
  dependency: 'dependency',
  outsideScope: 'outside-scope',
};
const displayLevels = [...severityLevels].reverse();
export function evidenceGroup(item) {
  if (item.kind === 'dependency') return 'dependency';
  return item.ownership === 'project' ? item.kind : 'outsideScope';
}

export function counts(items) {
  return {
    total: items.length,
    gateErrors: items.filter(item => item.blocksGate).length,
    errors: items.filter(item => item.severity === 'error').length,
    warnings: items.filter(item => item.severity === 'warning').length,
  };
}

export function countsByLevel(items) {
  return Object.fromEntries(severityLevels.map(level => [level, items.filter(item => item.level === level).length]));
}

export function countsByLevelAndConfidence(items) {
  return Object.fromEntries(severityLevels.map(level => [level,
    Object.fromEntries(confidenceLevels.map(confidence => [confidence,
      items.filter(item => item.level === level && item.confidence === confidence).length]))]));
}

function formatSeverityTotals(levels) {
  if (!levels || !displayLevels.every(level => Number.isSafeInteger(levels[level]))) return 'severity totals unavailable';
  return displayLevels.map(level => `${levels[level].toLocaleString('en-US')} ${level}`).join(', ');
}

function totalFindings(summary) {
  if (!summary.levels || !displayLevels.every(level => Number.isSafeInteger(summary.levels[level]))) return summary.errors + summary.warnings;
  return displayLevels.reduce((sum, level) => sum + summary.levels[level], 0);
}

export function formatReportSummary(report) {
  const status = !report.complete ? 'INCOMPLETE' : report.passed ? 'PASS' : 'FAIL';
  const total = totalFindings(report.summary);
  return `${status}: ${countLabel(total, 'finding')}; ${formatSeverityTotals(report.summary.levels)}.`;
}

export function formatReportTags(report) {
  const categories = Object.entries(groupLabels).filter(([group]) => report.summary.groups[group].total)
    .map(([group, label]) => `[${label}] ${report.summary.groups[group].total.toLocaleString('en-US')}`);
  const total = totalFindings(report.summary);
  return `Tags: ${categories.length ? categories.join(', ') + '; ' : ''}[blocking] ${report.summary.gateErrors.toLocaleString('en-US')}, [advisory] ${(total - report.summary.gateErrors).toLocaleString('en-US')}.`;
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

function markdownRevision(revision) {
  if (!revision || typeof revision.commit !== 'string') return 'Git revision unavailable.';
  const state = revision.dirty === true ? ' + uncommitted changes' : revision.dirty === null || revision.dirty === undefined ? ' (worktree state unknown)' : '';
  return `Git ${revision.commit.slice(0, 12)}${state}.`;
}

function markdownIntro(report) {
  const modeLine = report.mode ? `Mode ${report.mode}: ${countLabel(report.summary.surfacedFindings, 'finding')} surfaced, ${countLabel(report.summary.hiddenFindings, 'finding')} hidden.` : null;
  const baselineNote = !report.complete
    ? 'Counts may be partial until failed checks are rerun.'
    : report.summary.baselineConfigured
      ? 'Unbaselined findings are not necessarily changes in this Git revision.'
      : 'Counts cover all selected sources; no baseline is configured.';
  return [
    '# Sloppy report', '',
    formatReportSummary(report),
    `${countLabel(report.summary.files, 'file')}; ${countLabel(report.summary.baseline, 'baseline finding')}.`,
    ...(modeLine ? [modeLine] : []),
    ...(report.mode && report.summary.hiddenFindings ? ['Use `sloppy check --mode deep` to inspect every finding.'] : []),
    markdownRevision(report.revision),
    baselineNote,
    'Severities follow configured rule levels, not confirmed defect risk. Counts include advisory findings. Repository lint, typecheck, and tests were not run.',
    'Tags describe the category and gate status. [review] findings need verification before editing. [blocking] findings fail the gate; [advisory] findings do not.', '',
  ];
}

function markdownCategories(report, active) {
  const presentGroups = Object.entries(groupLabels)
    .map(([group, label]) => [group, label, counts(active.filter(item => evidenceGroup(item) === group))])
    .filter(([, , summary]) => summary.total);
  return [
    '## Categories', '',
    ...(presentGroups.length ? ['| Category | Critical | Major | Minor | Info | [blocking] | [advisory] |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...presentGroups.map(([group, label, summary]) => {
        const levels = countsByLevel(active.filter(item => evidenceGroup(item) === group));
        const { total, gateErrors } = summary;
        return `| [${label}] | ${displayLevels.map(level => levels[level]).join(' | ')} | ${gateErrors} | ${total - gateErrors} |`;
      })] : ['No findings.']), '',
    '## Source scope', '',
    '| Paths | Files | Critical | Major | Minor | Info |', '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries({ source: 'Source', test: 'Tests and fixtures', tooling: 'Scripts and repository tooling' }).map(([role, label]) => {
      const levels = countsByLevel(active.filter(item => item.ownership === 'project' && sourceRole(item.file) === role));
      return `| ${label} | ${report.summary.sourceGroups?.[role]?.files ?? 'unavailable'} | ${displayLevels.map(level => levels[level]).join(' | ')} |`;
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
    'Findings for the selected mode: report.json. Use deep mode for low-confidence findings. File-grouped context and dependency advisories: repair-plan.json.', '');
  return lines;
}

export function writeMarkdownReport(report, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const active = report.findings.filter(item => !item.baseline).map(normalizeReportFinding);
  const lines = markdownIntro(report);
  for (const level of displayLevels) {
    const findings = active.filter(item => item.level === level);
    lines.push(`## ${level[0].toUpperCase()}${level.slice(1)}`, '',
      ...(findings.length ? topRules(findings) : ['None.']), '');
  }
  lines.push(...markdownCategories(report, active));
  if (active.length) {
    const levelConfidence = countsByLevelAndConfidence(active);
    const unknown = active.some(item => !confidenceLevels.includes(item.confidence));
    lines.push('## Severity and confidence', '', `| Severity | High | Medium | Low |${unknown ? ' Unknown |' : ''}`, `| --- | ---: | ---: | ---: |${unknown ? ' ---: |' : ''}`,
      ...displayLevels.map(level => `| ${level} | ${confidenceLevels.map(confidence => levelConfidence[level][confidence]).join(' | ')} |${unknown ? ` ${active.filter(item => item.level === level && !confidenceLevels.includes(item.confidence)).length} |` : ''}`),
      '', 'Confidence measures the evidence behind a finding; it does not establish a defect.', '');
  }
  lines.push('## Files to inspect', '',
    ...(report.hotspots ?? []).slice(0, 5).map(item => `- ${item.file} [${item.sourceRole}]: ${countLabel(item.rules.length, 'rule')}; ${formatSeverityTotals(countsByLevel(active.filter(finding => finding.file === item.file && finding.ownership === 'project' && finding.kind !== 'dependency' && finding.confidence !== 'low')))}.`),
    ...(report.hotspots?.length ? [] : [report.hotspots ? 'No high- or medium-confidence project findings.' : 'Hotspot ranking unavailable.']), '',
    '## Checks', '', ...markdownChecks(report.checks));
  if (report.staleBaseline?.length) lines.push(`Stale baseline entries: ${report.staleBaseline.reduce((n, entry) => n + entry.count, 0)}. Review before regenerating.`, '');
  fs.writeFileSync(path.join(directory, 'report.md'), lines.join('\n'));
}

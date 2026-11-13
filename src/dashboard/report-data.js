import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeReportFinding } from '../domain/findings.js';

const levels = ['critical', 'major', 'minor', 'info'];
const count = value => Number.isSafeInteger(value) && value >= 0;

export async function readReport(entry) {
  const file = await resolveReportFile(entry);
  const stat = await fs.stat(file);
  if (stat.size > 64 * 1024 * 1024) throw new Error('Report exceeds the 64 MB size limit.');
  const report = JSON.parse(await fs.readFile(file, 'utf8'));
  validateReport(report, entry);
  report.revision = normalizeRevision(report.revision);
  const sourceAvailable = await fs.stat(entry.root).then(source => source.isDirectory()).catch(() => false);
  return { report, savedAt: stat.mtime.toISOString(), sourceAvailable };
}

function normalizeRevision(revision) {
  if (revision === null || revision === undefined) return null;
  if (typeof revision !== 'object' || Array.isArray(revision) || typeof revision.commit !== 'string' || !revision.commit.trim()) throw new Error('Invalid report Git revision.');
  const dirty = revision.dirty === undefined ? null : revision.dirty;
  if (dirty !== null && typeof dirty !== 'boolean') throw new Error('Invalid report worktree state.');
  return { commit: revision.commit, dirty };
}

export async function resolveReportFile(entry) {
  if (entry.snapshotSavedAtMs !== undefined && entry.backupReportFile) return entry.backupReportFile;
  try { await fs.access(entry.reportFile); return entry.reportFile; }
  catch (error) {
    if (error.code !== 'ENOENT' || !entry.backupReportFile) throw error;
    return entry.backupReportFile;
  }
}

function validateReport(report, entry) {
  if (report.version !== 1 || report.root !== entry.root || typeof report.complete !== 'boolean' || typeof report.passed !== 'boolean'
    || !report.summary || !['files', 'errors', 'warnings', 'baseline'].every(key => count(report.summary[key]))
    || !Array.isArray(report.findings) || !Array.isArray(report.checks)) throw new Error('Report format is invalid. Run sloppy check again.');
  if (!report.findings.every(validFinding)
    || !report.checks.every(item => item && typeof item.name === 'string' && typeof item.status === 'string')) {
    throw new Error('Report findings or checks are invalid. Run sloppy check again.');
  }
}

function validFinding(item) {
  return item && typeof item.ruleId === 'string' && typeof item.file === 'string' && typeof item.message === 'string'
    && count(item.line) && typeof item.severity === 'string';
}

function reportGroups(groups) {
  if (!groups || typeof groups !== 'object' || Array.isArray(groups) || Object.keys(groups).length === 0) return null;
  if (!Object.values(groups).every(group => group && count(group.total) && count(group.gateErrors) && group.gateErrors <= group.total)) return null;
  return Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, { total: group.total, blockers: group.gateErrors }]));
}

export function projectSummary(entry, report, savedAt, sourceAvailable) {
  const summary = report.summary;
  return {
    id: entry.id, name: path.basename(entry.root), root: entry.root, savedAt, sourceAvailable,
    status: !report.complete ? 'incomplete' : report.passed ? 'passed' : 'failed',
    languages: Object.entries(report.project ?? {}).filter(([key, enabled]) => enabled && ['python', 'typescript', 'javascript'].includes(key)).map(([key]) => key),
    revision: report.revision ?? null,
    summary: {
      files: summary.files,
      findings: count(summary.totalFindings) ? summary.totalFindings : summary.errors + summary.warnings,
      blockers: count(summary.gateErrors) ? summary.gateErrors : summary.errors,
      baseline: summary.baseline,
      hidden: count(summary.hiddenFindings) ? summary.hiddenFindings : 0,
      levels: summary.levels && levels.every(level => count(summary.levels[level])) ? Object.fromEntries(levels.map(level => [level, summary.levels[level]])) : null,
      groups: reportGroups(summary.groups),
    },
  };
}

export async function listProjects(entries) {
  const projects = await Promise.all(entries.map(async entry => {
    try {
      const { report, savedAt, sourceAvailable } = await readReport(entry);
      return projectSummary(entry, report, savedAt, sourceAvailable);
    } catch (error) {
      return { id: entry.id, name: path.basename(entry.root), root: entry.root, status: 'unavailable',
        savedAt: null, summary: null, languages: [], revision: null, sourceAvailable: false,
        error: error.code === 'ENOENT' ? 'Saved report is missing. Run sloppy check in this project.' : 'Saved report could not be read. Run sloppy check in this project.' };
    }
  }));
  return projects.sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
}

const findingSorts = {
  level: (a, b) => levels.indexOf(a.level) - levels.indexOf(b.level),
  message: (a, b) => a.message.localeCompare(b.message),
  file: (a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }) || a.line - b.line,
  blocksGate: (a, b) => Number(b.blocksGate) - Number(a.blocksGate),
};

export function parseReportQuery(query) {
  const search = (query.get('q') ?? '').slice(0, 500).toLowerCase();
  const level = query.get('level') ?? 'all';
  const page = Number(query.get('page') ?? '1');
  const sort = query.get('sort') ?? 'order';
  const direction = query.get('direction') ?? 'asc';
  if (!['all', ...levels].includes(level) || !Number.isSafeInteger(page) || page < 1
    || !['order', ...Object.keys(findingSorts)].includes(sort) || !['asc', 'desc'].includes(direction)) {
    throw new Error('Invalid findings filter, sort or page.');
  }
  return { search, level, page, sort, direction };
}

export async function projectDetails(entry, { search, level, page, sort, direction }) {
  const { report, savedAt, sourceAvailable } = await readReport(entry);
  const findings = report.findings.filter(item => !item.baseline)
    .map(normalizeReportFinding)
    .map((item, index) => ({
      id: `${typeof item.fingerprint === 'string' ? item.fingerprint : `${item.ruleId}:${item.file}:${item.line}`}:${index}`,
      ruleId: item.ruleId, file: item.file, line: item.line, column: item.column ?? 1,
      message: item.message, guidance: typeof item.guidance === 'string' ? item.guidance : '',
      level: item.level, kind: item.kind, confidence: item.confidence, blocksGate: item.blocksGate,
    }))
    .filter(item => (level === 'all' || item.level === level) && `${item.ruleId} ${item.file} ${item.message}`.toLowerCase().includes(search));
  if (sort !== 'order') findings.sort((a, b) => findingSorts[sort](a, b) * (direction === 'desc' ? -1 : 1));
  const pages = Math.max(1, Math.ceil(findings.length / 50));
  const currentPage = Math.min(page, pages);
  return {
    ...projectSummary(entry, report, savedAt, sourceAvailable), mode: report.mode ?? 'legacy',
    checks: report.checks.map(item => ({ name: item.name, status: item.status, detail: typeof item.detail === 'string' ? item.detail : null })),
    findings: findings.slice((currentPage - 1) * 50, currentPage * 50), total: findings.length, page: currentPage, pages,
  };
}

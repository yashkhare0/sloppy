import crypto from 'node:crypto';

export const severityLevels = Object.freeze(['info', 'minor', 'major', 'critical']);
export const confidenceLevels = Object.freeze(['high', 'medium', 'low']);

const lowConfidenceRules = new Set([
  'python/unused-definition', 'python/inline-prompt',
  'dead-code/unreachable-module-candidate',
  'maintainability/duplicate-body', 'maintainability/pass-through-wrapper',
]);

const policyRules = new Set([
  'architecture/import-boundary', 'architecture/circular-import',
  'typescript/required-option', 'python/coverage', 'python/fat-activity',
  'python/suppression-reason', 'eslint/quality/suppression-reason',
  'naming/file', 'next/client-server-boundary',
  'accessibility/image-alt', 'react/button-type',
]);

function evidenceKind(ruleId) {
  if (ruleId === 'python/dependency-cve') return 'dependency';
  if (policyRules.has(ruleId) || ruleId.startsWith('organization/') || ruleId.startsWith('structure/')) return 'policy';
  if (/^(?:pyright|ruff|eslint)\//.test(ruleId) || /^typescript\/TS\d+$/.test(ruleId)
    || ruleId.startsWith('typescript/syntax-') || ['python/syntax', 'dead-code/unreachable-statement'].includes(ruleId)) return 'diagnostic';
  return 'review';
}

function findingConfidence(ruleId, kind, evidence) {
  if (lowConfidenceRules.has(ruleId) || evidence?.confidence === 'review-candidate') return 'low';
  if (['name-based', 'shape-based'].includes(evidence?.confidence)) return 'medium';
  if (evidence?.confidence === 'syntax-proven') return 'high';
  if (kind === 'review') return 'medium';
  return 'high';
}

export function finding(ruleId, details) {
  const level = details.level ?? (details.severity === 'warning' ? 'minor' : 'major');
  const severity = details.level === undefined
    ? details.severity ?? 'error'
    : ['info', 'minor'].includes(level) ? 'warning' : 'error';
  const kind = evidenceKind(ruleId);
  const item = { ruleId, symbol: null, evidence: {}, autoFix: false, ...details,
    severity, level, kind, confidence: findingConfidence(ruleId, kind, details.evidence),
    blocksGate: severity === 'error' && (kind !== 'review' || level === 'critical') };
  item.fingerprint = crypto.createHash('sha256').update(JSON.stringify([ruleId, item.file, item.symbol, item.message, item.evidence])).digest('hex');
  return item;
}
export function metric(kind, value, limits, location) {
  const [warning, error] = limits[kind];
  if (value < warning) return null;
  const severity = value >= error ? 'error' : 'warning';
  const limit = severity === 'error' ? error : warning;
  return finding(`structure/${kind}`, { ...location,
    message: `${kind[0].toUpperCase()}${kind.slice(1)} ${value} (${severity === 'error' ? 'error' : 'warning'} at ${limit})`,
    guidance: 'Review the responsibility at this threshold; change it only when a smaller unit is clearer.',
    severity, evidence: { measured: value, warning, error, unit: ['complexity', 'nesting', 'parameters'].includes(kind) ? 'count' : 'code lines' } });
}

import crypto from 'node:crypto';

export function finding(ruleId, file, line, column, message, guidance, extra = {}) {
  const item = { ruleId, severity: 'error', file, line, column, symbol: null, message, evidence: {}, guidance, autoFix: false, ...extra };
  item.fingerprint = crypto.createHash('sha256').update(JSON.stringify([ruleId, file, item.symbol, message, item.evidence])).digest('hex');
  return item;
}
export function metric(kind, value, limits, location) {
  const [warning, error] = limits[kind];
  if (value <= warning) return null;
  const severity = value > error ? 'error' : 'warning';
  const limit = severity === 'error' ? error : warning;
  return finding(`structure/${kind}`, location.file, location.line, location.column,
    `${kind} ${value} exceeds ${severity} limit ${limit}`,
    'Reduce complexity while preserving behavior. Extract cohesive responsibilities only when they improve the design; do not split code just to move the same complexity elsewhere.',
    { ...location, severity, evidence: { measured: value, warning, error, unit: ['complexity', 'nesting', 'parameters'].includes(kind) ? 'count' : 'code lines' } });
}

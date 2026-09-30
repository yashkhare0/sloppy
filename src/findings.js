import crypto from 'node:crypto';

export function finding(ruleId, details) {
  const item = { ruleId, severity: 'error', symbol: null, evidence: {}, autoFix: false, ...details };
  item.fingerprint = crypto.createHash('sha256').update(JSON.stringify([ruleId, item.file, item.symbol, item.message, item.evidence])).digest('hex');
  return item;
}
export function metric(kind, value, limits, location) {
  const [warning, error] = limits[kind];
  if (value <= warning) return null;
  const severity = value > error ? 'error' : 'warning';
  const limit = severity === 'error' ? error : warning;
  return finding(`structure/${kind}`, { file: location.file, line: location.line, column: location.column, message: `${kind} ${value} exceeds ${severity} limit ${limit}`, guidance: 'Reduce complexity while preserving behavior. Extract cohesive responsibilities only when they improve the design; do not split code just to move the same complexity elsewhere.', ...{ ...location, severity, evidence: { measured: value, warning, error, unit: ['complexity', 'nesting', 'parameters'].includes(kind) ? 'count' : 'code lines' } } });
}

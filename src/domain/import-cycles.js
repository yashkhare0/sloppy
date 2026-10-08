import { finding } from './findings.js';

export function cycles(graph, ruleId = 'architecture/circular-import') {
  const state = new Map(), stack = [], findings = [], emitted = new Set();
  function visit(file) {
    if (state.get(file) === 2) return;
    if (state.get(file) === 1) {
      const cycle = [...stack.slice(stack.indexOf(file)), file];
      const key = [...new Set(cycle)].sort().join('|');
      if (!emitted.has(key)) findings.push(finding(ruleId, { file: file, line: 1, column: 1,
        message: ruleId === 'architecture/type-import-cycle' ? 'Local dependency cycle includes an erased type-only import' : 'Circular local import dependency',
        guidance: ruleId === 'architecture/type-import-cycle' ? 'Review contract ownership if the type dependency complicates changes; this cycle does not establish a runtime import cycle.' : 'Remove the cycle by placing shared contracts in a module both sides can depend on, or correcting dependency direction.',
        evidence: { cycle } }));
      emitted.add(key); return;
    }
    state.set(file, 1); stack.push(file);
    for (const target of graph.get(file) ?? []) if (graph.has(target)) visit(target);
    stack.pop(); state.set(file, 2);
  }
  for (const file of [...graph.keys()].sort()) visit(file);
  return findings;
}

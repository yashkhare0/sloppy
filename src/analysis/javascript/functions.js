import ts from 'typescript';
import { finding } from "../../domain/findings.js";
import { matches } from "../../project/policies.js";

// Token identity preserves literal values and operators while ignoring formatting.
function tokens(node, source) {
  const result = [];
  function visit(child) {
    const children = child.getChildren(source);
    if (children.length) children.forEach(visit);
    else result.push([child.kind, child.getText(source)]);
  }
  visit(node);
  return result;
}

export function codeHealth(source, file) {
  const findings = [], bodies = new Map();
  function add(rule, node, message, guidance, evidence = {}) {
    const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push(finding(rule, { file: file, line: pos.line + 1, column: pos.character + 1, message: message, guidance: guidance, ...{ severity: 'warning', evidence: { confidence: 'review-candidate', ...evidence } } }));
  }
  function visit(node) {
    const callable = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
    if (callable && node.body) inspectFunction(node);
    ts.forEachChild(node, visit);
  }
  function inspectFunction(node) {
      const sequence = tokens(node.body, source);
      if (sequence.length >= 40) {
        const key = JSON.stringify(sequence), previous = bodies.get(key);
        if (previous) add('maintainability/duplicate-body', node, 'Function body duplicates another body in this file',
          'Compare responsibilities and contracts before consolidating. Similar syntax alone does not justify coupling unrelated behavior.',
          { originalLine: source.getLineAndCharacterOfPosition(previous.getStart(source)).line + 1, tokenCount: sequence.length });
        else bodies.set(key, node);
      }
      if (isPassThrough(node)) {
        add('maintainability/pass-through-wrapper', node, 'Wrapper only forwards its parameters to another function',
          'Check whether this wrapper provides a public contract, framework adapter, or ownership boundary. Inline only if those roles and function identity are unnecessary.');
      }
  }
  visit(source);
  return findings;
}
function returnedExpression(body) {
  if (!ts.isBlock(body)) return body;
  if (body.statements.length !== 1) return null;
  const statement = body.statements[0];
  return ts.isReturnStatement(statement) ? statement.expression : null;
}
function isPassThrough(node) {
  const named = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node.parent);
  if (!named || node.asteriskToken || node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  if (node.type && ts.isTypePredicateNode(node.type)) return false;
  const expression = returnedExpression(node.body);
  if (!expression || !ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) return false;
  return forwardsParameters(node.parameters, expression.arguments);
}
function forwardsParameters(parameters, args) {
  if (!parameters.length || parameters.length !== args.length) return false;
  return parameters.every((p, i) => ts.isIdentifier(p.name) && !p.dotDotDotToken && !p.initializer && ts.isIdentifier(args[i]) && p.name.text === args[i].text);
}

export function unreachableModules(graph, config) {
  const policy = config.deadCode;
  if (!policy?.entryPoints.length) return [];
  const roots = [...graph.keys()].filter(file => matches(file, [...policy.entryPoints, ...policy.protected]));
  for (const pattern of policy.entryPoints) if (![...graph.keys()].some(file => matches(file, [pattern]))) throw new Error(`Dead-code entry point matches no selected TypeScript files: ${pattern}`);
  const reached = new Set(), pending = [...roots];
  while (pending.length) {
    const file = pending.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    pending.push(...(graph.get(file) ?? []));
  }
  return [...graph.keys()].filter(file => !reached.has(file)).sort().map(file => finding('dead-code/unreachable-module-candidate', { file: file, line: 1, column: 1, message: 'Module is not reachable from the configured entry points through resolved imports', guidance: 'Verify framework discovery, package exports, scripts, tests, plugins, and computed dynamic imports before deleting. Add external entry points or protected globs when appropriate.', ...{ severity: 'warning', evidence: { confidence: 'review-candidate', entryPoints: policy.entryPoints, protected: policy.protected, graph: 'resolved TypeScript imports including type-only edges', limitation: 'External consumers, reflection, framework discovery, and computed dynamic imports are not proven absent.' } } }));
}

import { cycles } from '../../domain/import-cycles.js';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { matches, fileLimits, fileNaming } from "../../project/policies.js";
import { finding, metric } from "../../domain/findings.js";
import { codeHealth, suiteBindings, testSuite, unreachableModules } from "./functions.js";

const functionNode = node => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node);
const controls = node => ts.isIfStatement(node) || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isSwitchStatement(node) || ts.isTryStatement(node);
const decisionKinds = new Set(['IfStatement', 'ConditionalExpression', 'CaseClause', 'CatchClause', 'ForStatement', 'ForOfStatement', 'ForInStatement', 'WhileStatement', 'DoStatement'].map(kind => ts.SyntaxKind[kind]));
function erasedImport(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    if (clause.name) return false;
    return allTypeBindings(clause.namedBindings);
  }
  if (ts.isExportDeclaration(node)) return node.isTypeOnly || allTypeBindings(node.exportClause);
  return false;
}
function allTypeBindings(bindings) {
  if (!bindings) return false;
  if (!ts.isNamedImports(bindings) && !ts.isNamedExports(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every(e => e.isTypeOnly);
}
function isClient(source) {
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === 'use client') return true;
  }
  return false;
}
export function codeLines(text, source = ts.createSourceFile('source.tsx', text, ts.ScriptTarget.Latest, true)) {
  const lines = new Set();
  function visit(node) {
    const children = node.getChildren(source);
    if (children.length) { children.forEach(visit); return; }
    if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
    const offset = node.getStart(source);
    const start = source.getLineAndCharacterOfPosition(offset).line;
    text.slice(offset, node.end).split(/\r?\n/).forEach((part, index) => { if (part.trim()) lines.add(start + index); });
  }
  visit(source);
  return lines;
}
function symbolOf(node) {
  return node.name?.getText() ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText() : ts.isPropertyAssignment(node.parent) ? node.parent.name.getText() : '<anonymous>');
}
function complexity(node) {
  let count = 1, nesting = 0;
  function walk(child, depth) {
    if (child !== node && functionNode(child)) return;
    if (decisionKinds.has(child.kind)) count++;
    if (ts.isBinaryExpression(child) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(child.operatorToken.kind)) count++;
    const next = depth + (controls(child) ? 1 : 0);
    nesting = Math.max(nesting, next);
    ts.forEachChild(child, n => walk(n, next));
  }
  walk(node, 0);
  return { complexity: count, nesting };
}
export function analyzeTypescript(root, files, config, dependencyGraph) {
  const findings = [], graph = new Map(), runtimeGraph = new Map(), clients = new Set(), servers = new Set();
  const projects = config.typescript.projects.map(project => {
    const absolute = path.resolve(root, project);
    const read = ts.readConfigFile(absolute, ts.sys.readFile);
    if (read.error) return null;
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(absolute), undefined, absolute);
    return { directory: path.dirname(absolute), options: parsed.options, files: new Set(parsed.fileNames.map(f => path.resolve(f).toLowerCase())) };
  }).filter(Boolean).sort((a, b) => b.directory.length - a.directory.length);
  const shared = { root, config, projects, clients, servers, graph, runtimeGraph, dependencyGraph, findings };
  for (const file of files) analyzeFile(file, shared);
  findings.push(...cycles(runtimeGraph));
  findings.push(...cycles(graph, 'architecture/type-import-cycle').filter(item =>
    item.evidence.cycle.some((file, index, cycle) => index < cycle.length - 1
      && !runtimeGraph.get(file)?.includes(cycle[index + 1]))));
  findings.push(...unreachableModules(graph, config));
  for (const client of clients) inspectClientDependencies(client, shared);

  return findings;
}
function inspectClientDependencies(client, shared) {
  const { servers, runtimeGraph, findings } = shared;
    const visited = new Set();
    const pending = [[client]];
    while (pending.length) {
      const chain = pending.pop(), file = chain.at(-1);
      if (visited.has(file)) continue;
      visited.add(file);
      if (servers.has(file)) findings.push(finding('next/client-server-boundary', { file: client, line: 1, column: 1, message: 'Client module reaches a server-only dependency', guidance: 'Move the server operation behind a server-owned boundary and pass serializable data into the client component.', ...{ evidence: { chain } } }));
      for (const target of runtimeGraph.get(file) ?? []) if (runtimeGraph.has(target)) pending.push([...chain, target]);
    }
}


function inspectJsx(node, context) {
  const { config, source, file, findings } = context;

      if (config.project.react && (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))) {
        const tag = node.tagName.getText();
        const attributes = node.attributes.properties;
        const spread = attributes.some(a => ts.isJsxSpreadAttribute(a));
        const has = name => attributes.some(a => ts.isJsxAttribute(a) && a.name.getText() === name);
        const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
        if (tag === 'img' && !has('alt') && !spread) findings.push(finding('accessibility/image-alt', { file: file, line: pos.line + 1, column: pos.character + 1, message: 'Image has no alt attribute', guidance: 'Provide meaningful alt text, or alt="" for a decorative image.' }));
        if (tag === 'button' && !has('type') && !spread) findings.push(finding('react/button-type', { file: file, line: pos.line + 1, column: pos.character + 1, message: 'Button has no explicit type', guidance: 'Use type="button" unless this button intentionally submits or resets a form.' }));
      }
    }

function collectImports(node, context) {
  const { imports } = context;

      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push({ specifier: node.moduleSpecifier.text, node, erased: erasedImport(node) });
      if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) imports.push({ specifier: node.arguments[0].text, node });
    }

function visit(node, context) {
  const { config, addMetric, span } = context;

      inspectJsx(node, context);
      if (functionNode(node) && node.body) {
        const symbol = symbolOf(node);
        const component = config.project.react && /^[A-Z]/.test(symbol) && !ts.isMethodDeclaration(node);
        addMetric(component ? 'component' : 'function', span(node, testSuite(node, context)), node, symbol);
        const values = { ...complexity(node), parameters: node.parameters.length };
        for (const [kind, value] of Object.entries(values)) addMetric(kind, value, node, symbol);
      }
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) addMetric('class', span(node), node, symbolOf(node));
      collectImports(node, context);
      ts.forEachChild(node, child => visit(child, context));
    }

function resolveImports(context) {
  const { root, file, config, source, options, imports, servers, dependencyGraph } = context;

    const edges = [], runtimeEdges = [];
    for (const { specifier, node, erased } of imports) {
      if (!erased && config.project.next && serverSpecifier(specifier)) servers.add(file);
      const resolved = ts.resolveModuleName(specifier, path.join(root, file), options, ts.sys).resolvedModule;
      if (!resolved) {
        if (dependencyGraph) dependencyGraph.unresolved.push({ file, specifier, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
        continue;
      }
      const target = path.relative(root, resolved.resolvedFileName).replaceAll('\\', '/');
      if (target.startsWith('../') || target.includes('node_modules/')) continue;
      edges.push(target);
      if (!erased) runtimeEdges.push(target);
      const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
      if (dependencyGraph) dependencyGraph.edges.push({ source: file, target, relation: 'imports', proof: 'compiler-resolved', typeOnly: Boolean(erased), evidence: { file, line: pos.line + 1, column: pos.character + 1, specifier } });
      checkImportBoundaries(context, { target, specifier, pos });
    }
      return { edges, runtimeEdges };
    }

function analyzeFile(file, shared) {
  const { root, config, projects, clients, servers, graph, runtimeGraph, dependencyGraph, findings } = shared;

    const absoluteFile = path.resolve(root, file);
    const project = projects.find(p => p.files.has(absoluteFile.toLowerCase())) ?? projects.find(p => absoluteFile.startsWith(p.directory + path.sep));
    const options = project?.options ?? { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext };
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    if (config.project.next && isClient(source)) clients.add(file);
    if (config.project.next && /\.server\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)) servers.add(file);
    const lines = codeLines(text, source), limits = fileLimits(file, config);
    const addMetric = (kind, value, node, symbol) => {
      const position = source.getLineAndCharacterOfPosition(node?.getStart(source) ?? 0);
      const item = metric(kind, value, limits, { file, line: position.line + 1, column: position.character + 1, symbol });
      if (item) findings.push(item);
    };
    const span = (node, excludeNested = false) => {
      const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
      const end = source.getLineAndCharacterOfPosition(node.end).line;
      const nestedLines = new Set();
      function collect(child) {
        if (child !== node && functionNode(child) && child.body) {
          const nestedStart = source.getLineAndCharacterOfPosition(child.body.getStart(source)).line;
          const nestedEnd = source.getLineAndCharacterOfPosition(child.body.end).line;
          for (let line = nestedStart + 1; line < nestedEnd; line++) nestedLines.add(line);
          return;
        }
        ts.forEachChild(child, collect);
      }
      if (excludeNested) collect(node);
      return [...lines].filter(line => line >= start && line <= end && !nestedLines.has(line)).length;
    };
    addMetric('file', lines.size, null, null);
    inspectFileName(file, config, findings);
    const imports = [];
    for (const diagnostic of source.parseDiagnostics) {
      const pos = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      findings.push(finding(`typescript/syntax-${diagnostic.code}`, { file: file, line: pos.line + 1, column: pos.character + 1, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'), guidance: 'Fix syntax before evaluating the structure of this file.' }));
    }




    const context = { root, file, config, source, options, imports, servers, dependencyGraph, findings, addMetric, span, suites: suiteBindings(source) };
    visit(source, context);
    if (!source.parseDiagnostics.length) findings.push(...codeHealth(source, file));
    const { edges, runtimeEdges } = resolveImports(context);
    graph.set(file, edges);
    runtimeGraph.set(file, runtimeEdges);
  }

function checkImportBoundaries(context, location) {
  const { config, file, findings } = context;
  const { target, specifier, pos } = location;
      for (const boundary of config.boundaries) if (matches(file, boundary.from) && matches(target, boundary.disallow)) {
        findings.push(finding('architecture/import-boundary', { file: file, line: pos.line + 1, column: pos.character + 1, message: `Import '${specifier}' crosses a configured boundary`, guidance: boundary.reason || 'Move this dependency behind the configured ownership boundary.', ...{ evidence: { target, specifier } } }));
      }
}

function serverSpecifier(specifier) { return ['server-only', 'next/headers'].includes(specifier) || specifier.startsWith('node:'); }

function inspectFileName(file, config, findings) {
    const name = path.basename(file).replace(/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, '').replace(/(?:\.(?:test|spec|e2e|config|server|client))+$/, '');
    if (fileNaming(file, config).files && !/^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*|\[\[?\.?\.?\.?[A-Za-z][\w]*\]?\]|\([\w-]+\)|_[a-z]+)$/.test(name)) {
      findings.push(finding('naming/file', { file: file, line: 1, column: 1, message: `File name '${name}' is not kebab-case`, guidance: 'Use kebab-case unless this is a framework-mandated file; disable file naming using a scoped override only if necessary.' }));
    }
}

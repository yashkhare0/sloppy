"""Read files through Python's parser; emit deterministic structural diagnostics."""
import ast
import io
import json
import pathlib
import re
import sys
import tokenize
from typing import cast

Metric = dict[str, str | int | None]
Function = ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda
Span = tuple[tuple[int, int], tuple[int, int]]
FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)
CONTROLS = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.Try, ast.Match)
DECISIONS = (ast.If, ast.IfExp, ast.For, ast.AsyncFor, ast.While,
             ast.ExceptHandler, ast.comprehension)


def code_lines(text: str, documentation: list[Span]) -> set[int]:
    lines: set[int] = set()
    ignored = {tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT,
               tokenize.DEDENT, tokenize.ENDMARKER, tokenize.ENCODING}
    for token in tokenize.generate_tokens(io.StringIO(text).readline):
        if token.type == tokenize.STRING and any(start <= token.start <= token.end <= end for start, end in documentation):
            continue
        if token.type not in ignored:
            lines.update(range(token.start[0], token.end[0] + 1))
    return lines


def documentation_spans(tree: ast.Module) -> list[Span]:
    spans: list[Span] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            if ast.get_docstring(node) is not None:
                first = node.body[0]
                spans.append(((first.lineno, first.col_offset),
                              (first.end_lineno or first.lineno, first.end_col_offset or first.col_offset)))
    return spans


def function_complexity(node: Function) -> dict[str, int]:
    complexity = 1
    nesting = 0

    def visit(child: ast.AST, depth: int = 0) -> None:
        nonlocal complexity, nesting
        if child is not node and isinstance(child, (*FUNCTIONS, ast.ClassDef)):
            return
        if isinstance(child, DECISIONS):
            complexity += 1
        if isinstance(child, ast.BoolOp):
            complexity += len(child.values) - 1
        if isinstance(child, ast.match_case) and not isinstance(child.pattern, ast.MatchAs):
            complexity += 1
        depth += isinstance(child, CONTROLS)
        nesting = max(nesting, depth)
        for descendant in ast.iter_child_nodes(child):
            visit(descendant, depth)

    visit(node)
    args = node.args
    positional = args.posonlyargs + args.args
    count = len(positional) + len(args.kwonlyargs) + bool(args.vararg) + bool(args.kwarg)
    if positional and positional[0].arg in ('self', 'cls'):
        count -= 1
    return {'complexity': complexity, 'nesting': nesting, 'parameters': count}


def structure(tree: ast.Module, lines: set[int]) -> list[Metric]:
    result: list[Metric] = [{'kind': 'file', 'value': len(lines), 'line': 1,
                           'column': 1, 'symbol': None}]
    for node in ast.walk(tree):
        if not isinstance(node, (ast.ClassDef, *FUNCTIONS)):
            continue
        location: Metric = {'line': node.lineno, 'column': node.col_offset + 1,
                            'symbol': getattr(node, 'name', '<lambda>')}
        end = node.end_lineno or node.lineno
        size = sum(node.lineno <= line <= end for line in lines)
        kind = 'class' if isinstance(node, ast.ClassDef) else 'function'
        result.append(dict(location, kind=kind, value=size))
        if not isinstance(node, ast.ClassDef):
            for kind, value in function_complexity(node).items():
                result.append(dict(location, kind=kind, value=value))
    return result


def imports(tree: ast.Module) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                result.append({'module': alias.name, 'level': 0, 'line': node.lineno})
        elif isinstance(node, ast.ImportFrom):
            result.append({'module': node.module or '', 'level': node.level,
                           'names': [a.name for a in node.names], 'line': node.lineno})
    return result


def suppressions(text: str) -> list[dict[str, int]]:
    result: list[dict[str, int]] = []
    for token in tokenize.generate_tokens(io.StringIO(text).readline):
        if token.type != tokenize.COMMENT:
            continue
        if re.match(r'#\s*(?:(?:ruff:\s*)?noqa|type:\s*ignore|pyright:\s*ignore)', token.string):
            parts = token.string.split('--', 1)
            if len(parts) != 2 or len(parts[1].strip()) < 10:
                result.append({'line': token.start[0], 'column': token.start[1] + 1})
    return result


def unreachable_statements(statements: list[ast.stmt]) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    terminated = False
    for statement in statements:
        if terminated:
            result.append({'rule': 'dead-code/unreachable-statement', 'line': statement.lineno,
                           'column': statement.col_offset + 1, 'severity': 'error',
                           'message': 'Statement follows an unconditional control-flow exit in the same block',
                           'guidance': 'Remove the unreachable statement or correct the preceding control flow. Preserve cleanup and intended behavior.',
                           'evidence': {'confidence': 'syntax-proven'}})
        terminated = terminated or isinstance(statement, (ast.Return, ast.Raise, ast.Break, ast.Continue))
    return result


def code_health(tree: ast.Module) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    bodies: dict[str, int] = {}
    for node in ast.walk(tree):
        for field in ('body', 'orelse', 'finalbody'):
            statements = getattr(node, field, [])
            if not isinstance(statements, list):
                continue
            # Python AST body/orelse/finalbody lists contain statements by schema.
            result.extend(unreachable_statements(cast(list[ast.stmt], statements)))
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            body = ast.Module(body=node.body, type_ignores=[])
            count = sum(1 for _ in ast.walk(body))
            key = ast.dump(body, include_attributes=False)
            if count >= 25 and key in bodies:
                result.append({'rule': 'maintainability/duplicate-body', 'line': node.lineno,
                               'column': node.col_offset + 1, 'severity': 'warning',
                               'message': 'Function body duplicates another body in this file',
                               'guidance': 'Compare responsibilities and contracts before consolidating; do not couple unrelated behavior just because its syntax matches.',
                               'evidence': {'confidence': 'review-candidate', 'originalLine': bodies[key], 'astNodes': count}})
            else:
                bodies[key] = node.lineno
    return result


def analyze(root: str, file: str) -> dict[str, object]:
    with tokenize.open(pathlib.Path(root, file)) as stream:
        text = stream.read()
    tree = ast.parse(text, filename=file)
    lines = code_lines(text, documentation_spans(tree))
    return {'metrics': structure(tree, lines), 'imports': imports(tree),
            'suppressions': suppressions(text), 'codeHealth': code_health(tree)}


request: dict[str, str | list[str]] = json.load(sys.stdin)
root = request['root']
files = request['files']
if not isinstance(root, str) or not isinstance(files, list):
    raise ValueError('Expected a root string and a list of source paths')
response: dict[str, dict[str, object]] = {}
for file in files:
    try:
        response[file] = analyze(root, file)
    except (SyntaxError, tokenize.TokenError, UnicodeError) as error:
        response[file] = {'error': str(error), 'line': getattr(error, 'lineno', 1) or 1}
json.dump(response, sys.stdout)

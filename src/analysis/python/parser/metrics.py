"""Measure Python source size, branching, nesting, and parameters."""
import ast
import io
import tokenize
from typing import NamedTuple

from analysis.python.parser.protocol import Metric, Span

Function = ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda
SourceNode = ast.ClassDef | Function
FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)
CONTROLS = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.Try, ast.Match)
DECISIONS = (ast.If, ast.IfExp, ast.For, ast.AsyncFor, ast.While,
             ast.ExceptHandler, ast.comprehension)
DOCSTRING_PARENTS = (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)


class FunctionComplexity(NamedTuple):
    complexity: int
    nesting: int
    parameters: int


def code_lines(text: str, documentation: list[Span]) -> set[int]:
    lines: set[int] = set()
    ignored = {tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT,
               tokenize.DEDENT, tokenize.ENDMARKER, tokenize.ENCODING}
    for token in tokenize.generate_tokens(io.StringIO(text).readline):
        if _is_ignored_token(token, ignored, documentation):
            continue
        lines.update(range(token.start[0], token.end[0] + 1))
    return lines


def _is_ignored_token(token: tokenize.TokenInfo, ignored: set[int], documentation: list[Span]) -> bool:
    if token.type in ignored:
        return True
    return token.type == tokenize.STRING and any(
        start <= token.start <= token.end <= end for start, end in documentation
    )


def documentation_spans(tree: ast.Module) -> list[Span]:
    spans: list[Span] = []
    for node in ast.walk(tree):
        if isinstance(node, DOCSTRING_PARENTS) and ast.get_docstring(node) is not None:
            first = node.body[0]
            spans.append(((first.lineno, first.col_offset),
                          (first.end_lineno or first.lineno, first.end_col_offset or first.col_offset)))
    return spans


def function_complexity(node: Function) -> FunctionComplexity:
    complexity = 1
    nesting = 0

    def visit(child: ast.AST, depth: int = 0) -> None:
        nonlocal complexity, nesting
        if child is not node and isinstance(child, (*FUNCTIONS, ast.ClassDef)):
            return
        complexity += decision_count(child)
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
    return FunctionComplexity(complexity, nesting, count)


def decision_count(node: ast.AST) -> int:
    decisions = int(isinstance(node, DECISIONS))
    boolean_branches = len(node.values) - 1 if isinstance(node, ast.BoolOp) else 0
    match_case = isinstance(node, ast.match_case) and not isinstance(node.pattern, ast.MatchAs)
    return decisions + boolean_branches + int(match_case)


def structure(tree: ast.Module, lines: set[int]) -> list[Metric]:
    result = [Metric(kind='file', value=len(lines), line=1, column=1, symbol=None)]
    for node in ast.walk(tree):
        if isinstance(node, (ast.ClassDef, *FUNCTIONS)):
            result.extend(_node_metrics(node, lines))
    return result


def _node_metrics(node: ast.ClassDef | Function, lines: set[int]) -> list[Metric]:
    size = sum(node.lineno <= line <= (node.end_lineno or node.lineno) for line in lines)
    kind = 'class' if isinstance(node, ast.ClassDef) else 'function'
    result = [_metric(kind, size, node)]
    if isinstance(node, ast.ClassDef):
        return result
    measures = function_complexity(node)
    result.extend([
        _metric('complexity', measures.complexity, node),
        _metric('nesting', measures.nesting, node),
        _metric('parameters', measures.parameters, node),
    ])
    return result


def _metric(kind: str, value: int, node: SourceNode) -> Metric:
    symbol = '<lambda>' if isinstance(node, ast.Lambda) else getattr(node, 'name', None)
    return Metric(kind, value, node.lineno, node.col_offset + 1, symbol)

"""Detect unreachable statements and duplicate Python function bodies."""
import ast
from typing import cast

from analysis.python.parser.protocol import CodeHealthIssue, SourceLocation


def unreachable_statements(statements: list[ast.stmt]) -> list[CodeHealthIssue]:
    result: list[CodeHealthIssue] = []
    terminated = False
    for statement in statements:
        if terminated:
            result.append(CodeHealthIssue(
                rule='dead-code/unreachable-statement',
                location=SourceLocation(statement.lineno, statement.col_offset + 1),
                severity='error', symbol=None,
                message='Statement follows an unconditional control-flow exit in the same block',
                guidance='Remove the unreachable statement or correct the preceding control flow. Preserve cleanup and intended behavior.',
                evidence={'confidence': 'syntax-proven'},
            ))
        terminated = terminated or isinstance(statement, (ast.Return, ast.Raise, ast.Break, ast.Continue))
    return result


def code_health(tree: ast.Module) -> list[CodeHealthIssue]:
    result: list[CodeHealthIssue] = []
    bodies: dict[str, int] = {}
    for node in ast.walk(tree):
        result.extend(_unreachable_in_node(node))
        duplicate = _duplicate_body(node, bodies)
        if duplicate:
            result.append(duplicate)
    return result


def _unreachable_in_node(node: ast.AST) -> list[CodeHealthIssue]:
    return [
        *unreachable_statements(_statements(node, 'body')),
        *unreachable_statements(_statements(node, 'orelse')),
        *unreachable_statements(_statements(node, 'finalbody')),
    ]


def _statements(node: ast.AST, field: str) -> list[ast.stmt]:
    value = getattr(node, field, [])
    return cast(list[ast.stmt], value) if isinstance(value, list) else []


def _duplicate_body(node: ast.AST, seen: dict[str, int]) -> CodeHealthIssue | None:
    if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return None
    body = ast.Module(body=node.body, type_ignores=[])
    count = sum(1 for _ in ast.walk(body))
    key = ast.dump(body, include_attributes=False)
    if count < 25 or key not in seen:
        seen[key] = node.lineno
        return None
    return CodeHealthIssue(
        rule='maintainability/duplicate-body',
        location=SourceLocation(node.lineno, node.col_offset + 1),
        severity='warning', symbol=None,
        message='Function body duplicates another body in this file',
        guidance='Compare responsibilities and contracts before consolidating; do not couple unrelated behavior just because its syntax matches.',
        evidence={'confidence': 'review-candidate', 'originalLine': seen[key], 'astNodes': count},
    )

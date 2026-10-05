"""Apply the Python-specific heuristics to parsed source trees."""
import ast

from analysis.python.parser.protocol import (
    HeuristicLimits,
    Issue,
    IssueDescription,
    SourceLocation,
)

Loop = ast.For | ast.AsyncFor | ast.While
LocatedNode = ast.FunctionDef | ast.AsyncFunctionDef | ast.Call | ast.Constant | ast.JoinedStr | Loop
LOOPS = (ast.For, ast.AsyncFor, ast.While)
CLIENT_CONSTRUCTORS = {'Mistral', 'Langfuse', 'Redis', 'StrictRedis',
                      'create_engine', 'create_async_engine'}
CLIENT_SUFFIXES = ('Client', 'Engine', 'Connection', 'Pool')
DOCSTRING_PARENTS = (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)


def decorator_name(node: ast.expr) -> str:
    if isinstance(node, ast.Call):
        node = node.func
    try:
        return ast.unparse(node)
    except (AttributeError, TypeError):
        return ''


def is_raw_dict_annotation(node: ast.expr | None) -> bool:
    if isinstance(node, ast.Subscript):
        node = node.value
    if isinstance(node, ast.Name):
        return node.id in ('dict', 'Dict')
    return isinstance(node, ast.Attribute) and node.attr in ('dict', 'Dict')


def prompt_string_lines(node: ast.Constant | ast.JoinedStr) -> int:
    if isinstance(node, ast.Constant):
        text_lines = str(node.value).count('\n') + 1
    else:
        text_lines = sum(
            str(value.value).count('\n') for value in node.values
            if isinstance(value, ast.Constant)
        ) + 1
    source_lines = (node.end_lineno or node.lineno) - node.lineno + 1
    return min(source_lines, text_lines)


def _embedded_literal_ids(tree: ast.Module) -> set[int]:
    inner = {
        id(value)
        for node in ast.walk(tree)
        if isinstance(node, ast.JoinedStr)
        for value in node.values
    }
    inner.update(
        id(node.format_spec)
        for node in ast.walk(tree)
        if isinstance(node, ast.FormattedValue) and node.format_spec is not None
    )
    return inner


def _docstring_id(node: ast.AST) -> int | None:
    if not isinstance(node, DOCSTRING_PARENTS) or not node.body:
        return None
    expression = node.body[0]
    if not isinstance(expression, ast.Expr) or not isinstance(expression.value, ast.Constant):
        return None
    if not isinstance(expression.value.value, str):
        return None
    return id(expression.value)


def _docstring_ids(tree: ast.Module) -> set[int]:
    return {
        node_id
        for parent in ast.walk(tree)
        if (node_id := _docstring_id(parent)) is not None
    }


def text_literals(tree: ast.Module) -> list[ast.Constant | ast.JoinedStr]:
    excluded = _embedded_literal_ids(tree) | _docstring_ids(tree)
    return [
        node for node in ast.walk(tree)
        if (isinstance(node, ast.JoinedStr)
            or (isinstance(node, ast.Constant) and isinstance(node.value, str)))
        and id(node) not in excluded
    ]


def calls_in_scope(node: ast.AST) -> list[ast.Call]:
    calls: list[ast.Call] = []

    def visit(child: ast.AST) -> None:
        for descendant in ast.iter_child_nodes(child):
            if isinstance(descendant, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                continue
            if isinstance(descendant, ast.Call):
                calls.append(descendant)
            visit(descendant)

    for statement in getattr(node, 'body', []):
        visit(statement)
    return calls


def call_name(node: ast.Call) -> str | None:
    if isinstance(node.func, ast.Name):
        return node.func.id
    if isinstance(node.func, ast.Attribute):
        return node.func.attr
    return None


def nested_loop_nodes(node: ast.AST) -> list[Loop]:
    result: list[Loop] = []

    def visit(parent: ast.AST, depth: int) -> None:
        for child in ast.iter_child_nodes(parent):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                continue
            nested_loop = isinstance(child, LOOPS)
            if nested_loop and depth:
                result.append(child)
            visit(child, depth + nested_loop)

    visit(node, 0)
    return result


def source_location(node: LocatedNode) -> SourceLocation:
    return SourceLocation(node.lineno, node.col_offset + 1)


def issue(node: LocatedNode, description: IssueDescription) -> Issue:
    return Issue(
        description.rule, source_location(node), description.symbol,
        description.message, description.guidance, description.evidence,
    )


def _nested_loop_issue(function: ast.FunctionDef | ast.AsyncFunctionDef,
                       loop: Loop) -> Issue:
    return issue(loop, IssueDescription(
        'python/nested-loop',
        f'Nested loop in {function.name}()',
        'Check input sizes and repeated lookups. Keep the loop if the work is bounded and clear.',
        {'confidence': 'syntax-proven', 'function': function.name}, function.name,
    ))


def nested_loop_issues(function: ast.FunctionDef | ast.AsyncFunctionDef) -> list[Issue]:
    return [_nested_loop_issue(function, loop) for loop in nested_loop_nodes(function)]


def raw_dict_issue(function: ast.FunctionDef | ast.AsyncFunctionDef) -> Issue | None:
    annotation = function.returns
    if function.name.startswith('_') or annotation is None or not is_raw_dict_annotation(annotation):
        return None
    return issue(function, IssueDescription(
        'python/raw-dict-return',
        f'Public function {function.name}() returns a raw dict type',
        'Use a typed model when callers depend on the returned shape; keep dictionaries for opaque payloads passed through unchanged.',
        {'confidence': 'syntax-proven', 'annotation': ast.unparse(annotation)}, function.name,
    ))


def inline_client_issues(function: ast.FunctionDef | ast.AsyncFunctionDef,
                         in_service: bool) -> list[Issue]:
    result: list[Issue] = []
    for call in calls_in_scope(function):
        name = call_name(call)
        if name and (name in CLIENT_CONSTRUCTORS or name.endswith(CLIENT_SUFFIXES)) and not in_service:
            result.append(issue(call, IssueDescription(
                'python/inline-client',
                f'{name}() constructs a client inside {function.name}()',
                'Check client lifetime and ownership. Move construction to a service boundary if callers need to share or replace it.',
                {'confidence': 'name-based', 'constructor': name}, function.name,
            )))
    return result


def activity_issue(function: ast.FunctionDef | ast.AsyncFunctionDef,
                   limits: HeuristicLimits) -> Issue | None:
    activity = any(
        name == 'activity_defn' or name.endswith('activity.defn')
        for name in (decorator_name(decorator) for decorator in function.decorator_list)
    )
    if not activity:
        return None
    length = (function.end_lineno or function.lineno) - function.lineno + 1
    if length <= limits.max_activity_lines:
        return None
    return issue(function, IssueDescription(
        'python/fat-activity',
        f'Temporal activity {function.name}() is {length} lines (limit {limits.max_activity_lines})',
        'Check whether the activity owns business logic. Extract that logic if it has a separate owner.',
        {'confidence': 'syntax-proven', 'measured': length, 'limit': limits.max_activity_lines}, function.name,
    ))


def function_issues(function: ast.FunctionDef | ast.AsyncFunctionDef, file: str,
                    limits: HeuristicLimits) -> list[Issue]:
    normalized_file = file.replace('\\', '/')
    in_service = '/services/' in f'/{normalized_file.strip("/")}/'
    result = nested_loop_issues(function)
    raw_dict = raw_dict_issue(function)
    if raw_dict:
        result.append(raw_dict)
    result.extend(inline_client_issues(function, in_service))
    activity = activity_issue(function, limits)
    if activity:
        result.append(activity)
    return result


def prompt_issue(node: ast.Constant | ast.JoinedStr,
                 limits: HeuristicLimits) -> Issue | None:
    measured = prompt_string_lines(node)
    if measured <= limits.max_inline_prompt_lines:
        return None
    return issue(node, IssueDescription(
        'python/inline-prompt',
        f'Inline string spans {measured} lines (limit {limits.max_inline_prompt_lines})',
        'Check whether this is a prompt or template that needs its own named resource.',
        {'confidence': 'shape-based', 'measured': measured, 'limit': limits.max_inline_prompt_lines},
    ))


def targeted_heuristics(tree: ast.Module, file: str,
                        limits: HeuristicLimits) -> list[Issue]:
    functions = [node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
    result: list[Issue] = []
    for function in functions:
        result.extend(function_issues(function, file, limits))
    for node in text_literals(tree):
        finding = prompt_issue(node, limits)
        if finding:
            result.append(finding)
    return result

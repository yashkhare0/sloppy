"""Read Python files and emit the analyzer's deterministic JSON protocol."""
import ast
import io
import json
import pathlib
import re
import sys
import tokenize
from typing import TypeGuard, cast

from analysis.python.parser.health import code_health
from analysis.python.parser.heuristics import targeted_heuristics
from analysis.python.parser.metrics import (
    code_lines,
    documentation_spans,
    structure,
)
from analysis.python.parser.protocol import (
    FromImportRecord,
    HeuristicLimits,
    ImportEntry,
    ImportRecord,
    ParserRequest,
    SourceAnalysis,
    SourceError,
    SourceResult,
    Suppression,
)


def imports(tree: ast.Module) -> list[ImportEntry]:
    result: list[ImportEntry] = []
    for node in ast.walk(tree):
        result.extend(_import_records(node))
    return result


def _import_records(node: ast.AST) -> list[ImportEntry]:
    if isinstance(node, ast.Import):
        return [ImportRecord(module=alias.name, level=0, line=node.lineno) for alias in node.names]
    if isinstance(node, ast.ImportFrom):
        record = FromImportRecord(
            module=node.module or '', level=node.level,
            line=node.lineno, names=[alias.name for alias in node.names],
        )
        return [record]
    return []


def suppressions(text: str) -> list[Suppression]:
    result: list[Suppression] = []
    for token in tokenize.generate_tokens(io.StringIO(text).readline):
        if token.type == tokenize.COMMENT and _has_unexplained_suppression(token.string):
            result.append(Suppression(token.start[0], token.start[1] + 1))
    return result


def _has_unexplained_suppression(comment: str) -> bool:
    if not re.match(r'#\s*(?:(?:ruff:\s*)?noqa|type:\s*ignore|pyright:\s*ignore)', comment):
        return False
    parts = comment.split('--', 1)
    return len(parts) != 2 or len(parts[1].strip()) < 10


def _request_object(payload: object) -> dict[str, object]:
    if not isinstance(payload, dict):
        raise ValueError('Expected a JSON object with a root, source paths, and Python limits')
    fields = cast(dict[object, object], payload)
    if not all(isinstance(key, str) for key in fields):
        raise ValueError('Expected string keys in the analyzer request')
    return cast(dict[str, object], fields)


def _string_list(value: object) -> TypeGuard[list[str]]:
    if not isinstance(value, list):
        return False
    return all(isinstance(item, str) for item in cast(list[object], value))


def _integer(value: object) -> TypeGuard[int]:
    return type(value) is int


def decode_request(payload: object) -> ParserRequest:
    fields = _request_object(payload)
    root = fields.get('root')
    files = fields.get('files')
    activity_lines = fields.get('maxActivityLines')
    prompt_lines = fields.get('maxInlinePromptLines')
    if not isinstance(root, str):
        raise ValueError('Expected a root, source paths, and Python heuristic limits')
    if not _string_list(files):
        raise ValueError('Expected a root, source paths, and Python heuristic limits')
    if not _integer(activity_lines) or not _integer(prompt_lines):
        raise ValueError('Expected a root, source paths, and Python heuristic limits')
    return ParserRequest(root, files, HeuristicLimits(activity_lines, prompt_lines))


def analyze(root: str, file: str, limits: HeuristicLimits) -> SourceAnalysis:
    with tokenize.open(pathlib.Path(root, file)) as stream:
        text = stream.read()
    tree = ast.parse(text, filename=file)
    lines = code_lines(text, documentation_spans(tree))
    return SourceAnalysis(
        structure(tree, lines), imports(tree), suppressions(text),
        code_health(tree), targeted_heuristics(tree, limits),
    )


def analyze_file(request: ParserRequest, file: str) -> SourceResult:
    try:
        return analyze(request.root, file, request.limits)
    except (SyntaxError, tokenize.TokenError, UnicodeError) as error:
        return SourceError(str(error), getattr(error, 'lineno', 1) or 1)


def main() -> None:
    request = decode_request(json.load(sys.stdin))
    response = {file: analyze_file(request, file).to_json() for file in request.files}
    json.dump(response, sys.stdout)


if __name__ == '__main__':
    main()

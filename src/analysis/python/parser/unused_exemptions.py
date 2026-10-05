"""AST locations Vulture cannot safely call unused."""
import ast
import json
import pathlib
import sys
import tokenize
from functools import cache

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10 has no standard TOML reader.
    tomllib = None

NEUTRAL_BASES = {
    '', 'object', 'ABC', 'Generic', 'BaseModel', 'BaseSettings',
    'Enum', 'StrEnum', 'IntEnum', 'Flag', 'Exception',
}


def _name(node: ast.expr) -> str:
    if isinstance(node, ast.Subscript):
        return _name(node.value)
    if isinstance(node, ast.Attribute):
        return node.attr
    return node.id if isinstance(node, ast.Name) else ''


def _lines(node: ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef) -> set[int]:
    return {node.lineno, *(decorator.lineno for decorator in node.decorator_list)}


def _assigned_names(body: list[ast.stmt]) -> set[str]:
    targets = [
        target for statement in body
        for target in (
            statement.targets if isinstance(statement, ast.Assign)
            else [statement.target] if isinstance(statement, ast.AnnAssign)
            else []
        )
    ]
    return {target.id for target in targets if isinstance(target, ast.Name)}


def _orm_table(node: ast.ClassDef) -> bool:
    declared = '__tablename__' in _assigned_names(node.body)
    table = any(keyword.arg == 'table' and isinstance(keyword.value, ast.Constant)
                and keyword.value.value is True for keyword in node.keywords)
    return declared or table


def _script_target(value: object) -> tuple[tuple[str, ...], str] | None:
    if not isinstance(value, str) or ':' not in value:
        return None
    module, function = value.split(':', 1)
    return tuple(module.strip().split('.')), function.strip()


@cache
def _script_targets(pyproject: pathlib.Path) -> set[tuple[tuple[str, ...], str]]:
    if not pyproject.is_file() or tomllib is None:
        return set()
    try:
        project = tomllib.loads(pyproject.read_text()).get('project', {})
    except (OSError, tomllib.TOMLDecodeError):
        return set()
    scripts = project.get('scripts', {}) if isinstance(project, dict) else {}
    if not isinstance(scripts, dict):
        return set()
    return {target for value in scripts.values() if (target := _script_target(value)) is not None}


def _scripts(source: pathlib.Path, root: pathlib.Path) -> set[tuple[tuple[str, ...], str]]:
    targets: set[tuple[tuple[str, ...], str]] = set()
    if tomllib is None:
        return targets
    for directory in source.parents:
        if directory != root and root not in directory.parents:
            break
        targets.update(_script_targets(directory / 'pyproject.toml'))
    return targets


def _module_parts(file: str) -> tuple[str, ...]:
    parts = pathlib.PurePath(file).with_suffix('').parts
    return parts[:-1] if parts[-1:] == ('__init__',) else parts


def _class_lines(node: ast.ClassDef, local_classes: set[str]) -> set[int]:
    lines: set[int] = set()
    if _orm_table(node):
        lines.update(_lines(node))
    external_base = any(_name(base) not in local_classes | NEUTRAL_BASES for base in node.bases)
    for member in node.body:
        if isinstance(member, (ast.Assign, ast.AnnAssign)):
            lines.add(member.lineno)  # Pydantic fields and enum members are read by frameworks.
        elif external_base and isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
            lines.update(_lines(member))  # Library hooks may be called without a local reference.
    return lines


def _script_lines(root: pathlib.Path, file: str, tree: ast.Module) -> set[int]:
    module = _module_parts(file)
    names = {function for target, function in _scripts(root / file, root)
             if module[-len(target):] == target}
    return {
        line for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names
        for line in _lines(node)
    }


def _exemptions(root: pathlib.Path, file: str, tree: ast.Module,
                local_classes: set[str]) -> list[int]:
    lines = _script_lines(root, file, tree)
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            lines.update(_class_lines(node, local_classes))
    return sorted(lines)


def main() -> None:
    request = json.load(sys.stdin)
    root = pathlib.Path(request['root']).resolve()
    trees: dict[str, ast.Module] = {}
    for file in request['files']:
        try:
            with tokenize.open(root / file) as source:
                trees[file] = ast.parse(source.read(), filename=file)
        except (SyntaxError, UnicodeError, tokenize.TokenError):
            continue  # The source parser reports these errors separately.
    local_classes = {
        node.name for tree in trees.values() for node in ast.walk(tree)
        if isinstance(node, ast.ClassDef)
    }
    json.dump({file: _exemptions(root, file, tree, local_classes)
               for file, tree in trees.items()}, sys.stdout)


if __name__ == '__main__':
    main()

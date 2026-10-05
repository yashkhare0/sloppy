"""Typed records for the Python analyzer's JSON boundary."""
from dataclasses import dataclass
from typing import Literal, Mapping

Span = tuple[tuple[int, int], tuple[int, int]]


@dataclass(frozen=True, slots=True)
class HeuristicLimits:
    max_activity_lines: int
    max_inline_prompt_lines: int


@dataclass(frozen=True, slots=True)
class ParserRequest:
    root: str
    files: list[str]
    limits: HeuristicLimits


@dataclass(frozen=True, slots=True)
class Metric:
    kind: str
    value: int
    line: int
    column: int
    symbol: str | None

    def to_json(self) -> Mapping[str, object]:
        return {
            'kind': self.kind, 'value': self.value, 'line': self.line,
            'column': self.column, 'symbol': self.symbol,
        }


@dataclass(frozen=True, slots=True)
class ImportRecord:
    module: str
    level: int
    line: int

    def to_json(self) -> Mapping[str, object]:
        return {'module': self.module, 'level': self.level, 'line': self.line}


@dataclass(frozen=True, slots=True)
class FromImportRecord(ImportRecord):
    names: list[str]

    def to_json(self) -> Mapping[str, object]:
        return {
            'module': self.module, 'level': self.level,
            'names': self.names, 'line': self.line,
        }


ImportEntry = ImportRecord | FromImportRecord


@dataclass(frozen=True, slots=True)
class Suppression:
    line: int
    column: int

    def to_json(self) -> Mapping[str, object]:
        return {'line': self.line, 'column': self.column}


@dataclass(frozen=True, slots=True)
class SourceLocation:
    line: int
    column: int


@dataclass(frozen=True, slots=True)
class IssueDescription:
    rule: str
    message: str
    guidance: str
    evidence: dict[str, object]
    symbol: str | None = None


@dataclass(frozen=True, slots=True)
class Issue:
    rule: str
    location: SourceLocation
    symbol: str | None
    message: str
    guidance: str
    evidence: dict[str, object]

    def to_json(self) -> Mapping[str, object]:
        return {
            'rule': self.rule, 'line': self.location.line,
            'column': self.location.column,
            'symbol': self.symbol, 'message': self.message,
            'guidance': self.guidance, 'evidence': self.evidence,
        }


@dataclass(frozen=True, slots=True)
class CodeHealthIssue(Issue):
    severity: Literal['error', 'warning']

    def to_json(self) -> Mapping[str, object]:
        return {
            'rule': self.rule, 'line': self.location.line,
            'column': self.location.column,
            'severity': self.severity, 'message': self.message,
            'guidance': self.guidance, 'evidence': self.evidence,
        }


@dataclass(frozen=True, slots=True)
class SourceAnalysis:
    metrics: list[Metric]
    imports: list[ImportEntry]
    suppressions: list[Suppression]
    code_health: list[CodeHealthIssue]
    targeted: list[Issue]

    def to_json(self) -> Mapping[str, object]:
        return {
            'metrics': [item.to_json() for item in self.metrics],
            'imports': [item.to_json() for item in self.imports],
            'suppressions': [item.to_json() for item in self.suppressions],
            'codeHealth': [item.to_json() for item in self.code_health],
            'targeted': [item.to_json() for item in self.targeted],
        }


@dataclass(frozen=True, slots=True)
class SourceError:
    error: str
    line: int

    def to_json(self) -> Mapping[str, object]:
        return {'error': self.error, 'line': self.line}


SourceResult = SourceAnalysis | SourceError

# Sloppy report

FAIL: 5 findings; 0 critical, 5 major, 0 minor, 0 info.
3 files; 0 baseline findings.
Git revision unavailable.
Counts cover all selected sources; no baseline is configured.
Severities follow configured rule levels, not confirmed defect risk. Counts include advisory findings. Repository lint, typecheck, and tests were not run.
Tags describe the category and gate status. [review] findings need verification before editing. [blocking] findings fail the gate; [advisory] findings do not.

## Critical

None.

## Major

- `eslint/@typescript-eslint/no-explicit-any` [diagnostic] [blocking]: 1 finding, `src/unsafe.ts:1`.
- `eslint/@typescript-eslint/no-unsafe-call` [diagnostic] [blocking]: 1 finding, `src/unsafe.ts:1`.
- `eslint/@typescript-eslint/no-unsafe-member-access` [diagnostic] [blocking]: 1 finding, `src/unsafe.ts:1`.
- `eslint/@typescript-eslint/no-unsafe-return` [diagnostic] [blocking]: 1 finding, `src/unsafe.ts:1`.
- `python/nested-loop` [review] [advisory]: 1 finding, `src/loops.py:8`.

## Minor

None.

## Info

None.

## Categories

| Category | Critical | Major | Minor | Info | [blocking] | [advisory] |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| [diagnostic] | 0 | 4 | 0 | 0 | 4 | 0 |
| [review] | 0 | 1 | 0 | 0 | 0 | 1 |

## Source scope

| Paths | Files | Critical | Major | Minor | Info |
| --- | ---: | ---: | ---: | ---: | ---: |
| Source | 3 | 0 | 5 | 0 | 0 |
| Tests and fixtures | 0 | 0 | 0 | 0 | 0 |
| Scripts and repository tooling | 0 | 0 | 0 | 0 | 0 |

Path-based scope labels do not exempt files from checks. Source candidates rank before tests and tooling.

## Severity and confidence

| Severity | High | Medium | Low |
| --- | ---: | ---: | ---: |
| critical | 0 | 0 | 0 |
| major | 5 | 0 | 0 |
| minor | 0 | 0 | 0 |
| info | 0 | 0 | 0 |

Confidence measures the evidence behind a finding; it does not establish a defect.

## Files to inspect

- src/unsafe.ts [source]: 4 rules; 0 critical, 4 major, 0 minor, 0 info.
- src/loops.py [source]: 1 rule; 0 critical, 1 major, 0 minor, 0 info.

## Checks

- Skipped (Disabled in configuration): python-lint, python-types, python-unused-code, python-coverage, python-dependency-audit
- Skipped (No applicable files): javascript-lint
- Completed (4): typescript-structure, python-structure, typescript-lint, typescript-types.

Full findings and guidance: report.json. File-grouped context and dependency advisories: repair-plan.json.

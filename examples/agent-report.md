# Sloppy report

Gate FAIL. 3 files; 4 blockers; 1 review lead; 0 baseline findings.
Git revision unavailable.
Counts cover all selected sources; no baseline is configured.
Counts are findings under Sloppy's configured checks, not confirmed defects. Repository lint, typecheck, and tests were not run.

## Evidence

| Source | Blockers | Other findings |
| --- | ---: | ---: |
| Analyzer diagnostics in selected sources | 4 | 0 |
| Review leads in selected sources | 0 | 1 |

## Gate blockers

- eslint/@typescript-eslint/no-explicit-any: 1 (src/unsafe.ts:1)
- eslint/@typescript-eslint/no-unsafe-call: 1 (src/unsafe.ts:1)
- eslint/@typescript-eslint/no-unsafe-member-access: 1 (src/unsafe.ts:1)
- eslint/@typescript-eslint/no-unsafe-return: 1 (src/unsafe.ts:1)

## Review leads

Verify these before editing. Major leads are advisory; critical leads also appear under gate blockers.

- python/nested-loop: 1 (src/loops.py:8)

## Level and confidence

| Level | High | Medium | Low |
| --- | ---: | ---: | ---: |
| major | 5 | 0 | 0 |

Confidence measures the evidence behind a finding; it does not establish a defect.

## Files to inspect

- src/unsafe.ts: 4 rules, 4 findings, 4 blockers
- src/loops.py: 1 rule, 1 finding

## Checks

- Skipped (Disabled in configuration): python-lint, python-types, python-unused-code, python-coverage, python-dependency-audit
- Skipped (No applicable files): javascript-lint
- Completed (4): typescript-structure, python-structure, typescript-lint, typescript-types.

Full findings and guidance: report.json. File-grouped context and dependency advisories: repair-plan.json.

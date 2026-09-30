# Sloppy report

Result: FAIL; assessment complete.
Files: 2; new errors: 4; warnings: 0; baseline findings: 0.

## Checks

- typescript-structure: completed
- python-structure: skipped — No applicable files
- typescript-lint: completed
- typescript-types: completed
- python-lint: skipped — Disabled in configuration
- python-types: skipped — Disabled in configuration

## Agent repair instructions

Fix tool/configuration failures first. Address new errors before warnings. Preserve behavior and existing architecture. Re-run sloppy check after repairs. A listed auto-fix is a tool-provided candidate, not an instruction to apply it blindly. Baseline findings are existing debt, not verified correctness.

### ERROR eslint/@typescript-eslint/no-explicit-any

Location: src/unsafe.ts:1:31

Unexpected any. Specify a different type.

Evidence: {"endLine":1,"endColumn":34}

Repair: Correct the violation of @typescript-eslint/no-explicit-any. Consult the rule documentation; preserve the public behavior.

### ERROR eslint/@typescript-eslint/no-unsafe-return

Location: src/unsafe.ts:1:38

Unsafe return of a value of type `any`.

Evidence: {"endLine":1,"endColumn":58}

Repair: Correct the violation of @typescript-eslint/no-unsafe-return. Consult the rule documentation; preserve the public behavior.

### ERROR eslint/@typescript-eslint/no-unsafe-call

Location: src/unsafe.ts:1:45

Unsafe call of an `any` typed value.

Evidence: {"endLine":1,"endColumn":55}

Repair: Correct the violation of @typescript-eslint/no-unsafe-call. Consult the rule documentation; preserve the public behavior.

### ERROR eslint/@typescript-eslint/no-unsafe-member-access

Location: src/unsafe.ts:1:51

Unsafe member access .nope on an `any` value.

Evidence: {"endLine":1,"endColumn":55}

Repair: Correct the violation of @typescript-eslint/no-unsafe-member-access. Consult the rule documentation; preserve the public behavior.

## Requires human or agent review

- Whether abstractions earn their complexity and canonical helpers are reused.
- Whether local, URL, server, and global state have the appropriate ownership.
- Whether updates need transactional atomicity or async work can safely run in parallel.
- Runtime validation, behavioral correctness, and accessibility beyond static lint coverage.

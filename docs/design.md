# Agreed design

The CLI assesses Python and TypeScript projects using editable JSON configuration and deterministic source/compiler analysis. It does not invoke models or perform autonomous repairs.

JavaScript is detected and included in structural analysis and ESLint checks, without claiming type-check coverage. Sloppy checks its own JavaScript implementation and Python parser in CI using its committed configuration. Explicit entry-point policies and source evidence keep dead-code candidates distinct from proven unreachable statements.

`init` detects languages and framework dependencies and records explicit policies. `check` runs structural checks, naming checks, import-graph checks, language linting, and type checking. Every applicable enabled check must finish. Reports separate new errors, warnings, baseline debt, skipped checks, and operational failures. Exit status is suitable for CI and commit hooks.

Default limits and naming/state ownership policy were agreed with the user before implementation. Thresholds are project policies, not assertions that small code is inherently good. Suppressions and scoped overrides need justification. Architectural simplification and semantic state ownership remain review topics when static analysis cannot prove them.

The orchestration layer reuses TypeScript, ESLint/typescript-eslint, official React/Next lint plugins, Ruff, and Pyright. Custom analysis is restricted to the agreed structural metrics, filename conventions, explicit dependency boundaries, simple static accessibility attributes, and report/baseline handling.

Global installation exposes `sloppy`. Repository hooks preserve existing hooks and invoke the full working-tree assessment. The optional default-hook command installs a global advisory dispatcher; it resolves the active worktree and stores separate reports and automatic configs. The report provides source locations, measurements, rule IDs, and repair guidance for behavior-preserving fixes followed by a fresh assessment.

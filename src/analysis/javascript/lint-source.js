import path from 'node:path';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import next from '@next/eslint-plugin-next';
import { finding } from '../../domain/findings.js';
import { typescriptTypes } from './type-checking.js';

export async function lintTypescript(root, files, config) {
  const typed = config.checks.typescriptTypes;
  if (typed) {
    try { typescriptTypes(root, config, files); }
    catch (error) { throw new Error(error.message); }
  }
  const presets = typed ? tseslint.configs.strictTypeChecked : tseslint.configs.strict;
  const rules = {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-non-null-assertion': 'error',
    '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true, 'ts-nocheck': true, 'ts-expect-error': 'allow-with-description', minimumDescriptionLength: 10 }],
    'no-empty': ['error', { allowEmptyCatch: false }],
    'no-debugger': 'error',
    'no-unreachable': 'error',
    'no-dupe-else-if': 'error',
    'no-duplicate-case': 'error',
    'no-constant-condition': ['error', { checkLoops: false }],
    'no-useless-catch': 'error',
    'no-unreachable-loop': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true }],
  };
  if (typed) rules['@typescript-eslint/no-confusing-void-expression'] = ['error', { ignoreArrowShorthand: true }];
  const namingRule = ['error',
    { selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow' },
    { selector: 'variable', format: ['camelCase', 'PascalCase', 'UPPER_CASE'], leadingUnderscore: 'allow' },
    { selector: 'function', format: ['camelCase', 'PascalCase'] },
    { selector: 'typeLike', format: ['PascalCase'] },
    { selector: ['property', 'objectLiteralMethod', 'import'], format: null },
    { selector: 'variable', modifiers: ['destructured'], format: null },
  ];
  if (config.naming.identifiers) rules['@typescript-eslint/naming-convention'] = namingRule;
  const plugins = { quality: { rules: { 'suppression-reason': {
    meta: { type: 'problem', schema: [], messages: { reason: 'Lint suppressions require specific rule IDs and a justification after -- (at least 10 characters).' } },
    create(context) {
      return { Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const match = comment.value.trim().match(/^eslint-disable(?:-next-line|-line)?\s*(.*)$/);
          if (!match) continue;
          const [ids, reason] = match[1].split('--');
          if (!ids.trim() || !reason || reason.trim().length < 10) context.report({ loc: comment.loc, messageId: 'reason' });
        }
      } };
    },
  } } } };
  rules['quality/suppression-reason'] = 'error';
  if (config.project.react) {
    plugins['react-hooks'] = reactHooks;
    Object.assign(rules, reactHooks.configs.recommended.rules);
  }
  if (config.project.next) {
    plugins['@next/next'] = next;
    Object.assign(rules, next.configs.recommended.rules, next.configs['core-web-vitals'].rules);
  }
  const glob = ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'];
  const lint = new ESLint({
    cwd: root, overrideConfigFile: true,
    overrideConfig: [
      { ignores: config.exclude },
      ...presets.map(p => ({ ...p, files: glob })),
      {
        files: glob, plugins,
        languageOptions: { parserOptions: typed ? { project: config.typescript.projects, tsconfigRootDir: root } : { ecmaFeatures: { jsx: true } }, globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', window: 'readonly', document: 'readonly', fetch: 'readonly' } },
        linterOptions: { reportUnusedDisableDirectives: 'error' },
        settings: { next: { rootDir: root } },
        rules: { ...rules, ...config.typescript.eslintRules },
      },
      ...config.overrides.filter(o => o.naming?.identifiers !== undefined).map(o => ({ files: o.files, rules: { '@typescript-eslint/naming-convention': o.naming.identifiers ? namingRule : 'off' } })),
    ],
  });
  const results = await lint.lintFiles(files);
  return results.flatMap(result => result.messages.map(message => lintFinding(root, result.filePath, message)));
}

function lintFinding(root, file, message) {
  const { rule, guidance } = lintDiagnostic(message);
  return finding(`eslint/${rule}`, {
    file: path.relative(root, file).replaceAll('\\', '/'),
    line: Math.max(1, message.line ?? 1), column: Math.max(1, message.column ?? 1),
    message: message.message, guidance, severity: message.severity === 2 ? 'error' : 'warning',
    autoFix: Boolean(message.fix), evidence: {
      ...(rule === 'configuration' ? { originalRule: message.ruleId, locationKind: 'file-level' } : {}),
      endLine: message.endLine, endColumn: message.endColumn,
      ...(message.fix ? { replacement: message.fix } : {}),
    },
  });
}

function lintDiagnostic(message) {
  if (message.line === 0) return { rule: 'configuration', guidance: 'Resolve the compiler-option prerequisite in the applicable tsconfig; this is a file-level lint configuration failure.' };
  if (message.fatal) return { rule: 'parse', guidance: 'Fix syntax or include this file in a configured TypeScript project.' };
  if (message.ruleId) return { rule: message.ruleId, guidance: `Correct the violation of ${message.ruleId}. Consult the rule documentation; preserve the public behavior.` };
  return { rule: 'directive', guidance: 'Remove unused lint directives or correct their rule IDs; preserve the public behavior.' };
}

export function lintJavascript(root, files, config) {
  return lintTypescript(root, files, { ...config, checks: { ...config.checks, typescriptTypes: false } });
}

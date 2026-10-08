import { minimatch } from 'minimatch';

const testPatterns = ['**/tests/**', '**/test/**', '**/__tests__/**', '**/fixtures/**', '**/*.test.*', '**/*.spec.*', '**/*.e2e.*', '**/test_*.py'];
const toolingPatterns = ['**/.agents/**', '**/.claude/**', '**/.codex/**', '**/scripts/**'];

export const sourceRoleRank = { source: 0, test: 1, tooling: 2 };

export function sourceRole(file) {
  const matches = patterns => patterns.some(pattern => minimatch(file, pattern, { dot: true }));
  if (matches(testPatterns)) return 'test';
  return matches(toolingPatterns) ? 'tooling' : 'source';
}

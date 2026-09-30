import fs from 'node:fs';
import { lintTypescript } from './lint-source.js';
import { typescriptTypes } from './type-checking.js';

try {
  const { engine, root, files, config } = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!['typescript-lint', 'typescript-types'].includes(engine)) throw new Error('Unsupported engine');
  const findings = engine === 'typescript-lint' ? await lintTypescript(root, files, config) : typescriptTypes(root, config, files);
  process.stdout.write(JSON.stringify({ findings }));
} catch (error) {
  process.stdout.write(JSON.stringify({ findings: error.findings ?? [], error: error.message }));
  process.exitCode = 2;
}

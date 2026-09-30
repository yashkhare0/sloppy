import fs from 'node:fs';
import path from 'node:path';
import { run } from './process.js';

export function installHook(root) {
  const result = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
  if (result.status !== 0) throw new Error('Commit hooks require an existing Git repository');
  const hook = path.join(result.stdout.trim(), 'hooks', 'pre-commit');
  const content = '#!/bin/sh\n# sloppy managed hook\nsloppy check\n';
  if (fs.existsSync(hook) && fs.readFileSync(hook, 'utf8') !== content) throw new Error(`Existing hook preserved at ${hook}. Add 'sloppy check' to it manually.`);
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, content, { mode: 0o755 });
  return hook;
}

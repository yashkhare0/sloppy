import { spawnSync } from 'node:child_process';

export function run(executable, args, cwd, input) {
  const result = spawnSync(executable, args, { cwd, input, encoding: 'utf8', shell: false, timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.error) throw new Error(`${executable}: ${result.error.message}`);
  if (result.signal || result.status === null) throw new Error(`${executable} did not complete`);
  return result;
}

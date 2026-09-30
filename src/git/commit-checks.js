import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from "../runtime/processes.js";
import { CONFIG, defaults } from "../project/policies.js";
import { check } from "../assessment/assess-project.js";

export function installDefaultHook() {
  const directory = fileURLToPath(new URL('../../hooks', import.meta.url));
  const existing = run('git', ['config', '--global', '--get', 'core.hooksPath'], process.cwd());
  if (existing.status !== 1 && existing.status !== 0) throw new Error(existing.stderr || 'Cannot read Git hook configuration');
  if (existing.status === 0 && path.resolve(existing.stdout.trim()) !== path.resolve(directory)) throw new Error(`Existing global hooksPath preserved: ${existing.stdout.trim()}`);
  const runner = fileURLToPath(new URL("../cli/main.js", import.meta.url));
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const content = `#!/bin/sh\n# sloppy default dispatcher\nexec ${quote(process.execPath.replaceAll('\\', '/'))} ${quote(runner.replaceAll('\\', '/'))} hook-run\n`;
  const file = path.join(directory, 'pre-commit');
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== content) throw new Error(`Existing dispatcher preserved: ${file}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
  const installed = run('git', ['config', '--global', 'core.hooksPath', directory.replaceAll('\\', '/')], process.cwd());
  if (installed.status !== 0) throw new Error(installed.stderr || 'Cannot install default hook');
  return directory;
}

export async function runDefaultHook(cwd) {
  const repository = run('git', ['rev-parse', '--show-toplevel'], cwd);
  if (repository.status !== 0) throw new Error('Cannot resolve active Git worktree');
  const root = path.resolve(repository.stdout.trim());
  const localStatus = runRepositoryHook(root);
  if (localStatus !== 0) return localStatus;
  const mode = hookMode(root);
  if (mode === 'off') return 0;
  return assessWorktree(root, mode);
}
function runRepositoryHook(root) {
  // Global hooksPath hides traditional repository hooks: run them first.
  const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
  if (common.status !== 0) throw new Error(common.stderr || 'Cannot resolve repository hooks');
  const localHook = path.join(common.stdout.trim(), 'hooks', 'pre-commit');
  if (fs.existsSync(localHook)) {
    const execPath = run('git', ['--exec-path'], root);
    const bundledShell = path.resolve(execPath.stdout.trim(), '../../..', 'usr/bin/sh.exe');
    const shell = process.platform === 'win32' && fs.existsSync(bundledShell) ? bundledShell : 'sh';
    const result = run(shell, [localHook.replaceAll('\\', '/')], root);
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    if (result.status !== 0) return result.status;
  }
  return 0;
}
function hookMode(root) {
  const modeResult = run('git', ['config', '--get', 'sloppy.mode'], root);
  const mode = modeResult.status === 1 ? 'advisory' : modeResult.stdout.trim();
  if (!['advisory', 'enforce', 'off'].includes(mode)) throw new Error('sloppy.mode must be advisory, enforce, or off');
  return mode;
}
async function assessWorktree(root, mode) {
  const outputResult = run('git', ['rev-parse', '--path-format=absolute', '--git-path', 'sloppy'], root);
  if (outputResult.status !== 0) throw new Error('Cannot resolve worktree report directory');
  const output = outputResult.stdout.trim();
  let report;
  try {
    const configPath = worktreeConfig(root, output);
    if (!configPath) return 0;
    report = await check(root, output, configPath);
  }
  catch (error) { console.error(`sloppy (${mode}): INCOMPLETE: ${error.message}`); return mode === 'enforce' ? 2 : 0; }
  const status = report.complete ? report.passed ? 'PASS' : 'FAIL' : 'INCOMPLETE';
  console.error(`sloppy (${mode}): ${status}; ${report.summary.errors} errors, ${report.summary.warnings} warnings. Report: ${path.join(output, 'report.md')}`);
  if (mode !== 'enforce') return 0;
  if (!report.complete) return 2;
  return report.passed ? 0 : 1;
}
function worktreeConfig(root, output) {
  const explicit = path.join(root, CONFIG);
  if (fs.existsSync(explicit)) return explicit;
  const automatic = path.join(output, CONFIG);
  if (fs.existsSync(automatic)) return automatic;
  const config = defaults(root);
  if (!config.project.python && !config.project.typescript && !config.project.javascript) return null;
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(automatic, JSON.stringify(config, null, 2) + '\n');
  return automatic;
}

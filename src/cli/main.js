#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CONFIG, defaults, load } from "../project/policies.js";
import { check } from "../assessment/assess-project.js";
import { installHook } from "../git/repository-hooks.js";
import { installDefaultHook, runDefaultHook } from "../git/commit-checks.js";

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    root: { type: 'string' }, config: { type: 'string' }, out: { type: 'string' }, hook: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log('sloppy init [--root PATH] [--hook]\nsloppy check [--root PATH] [--config PATH] [--out PATH]\nsloppy baseline [--root PATH]\nsloppy hook [--root PATH]\nsloppy default-hook\nsloppy doctor'); return;
  }
  validateArguments(positionals, values, command);
  const root = path.resolve(values.root ?? process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Project directory does not exist: ${root}`);
  const output = path.resolve(root, values.out ?? '.sloppy');
  const handlers = {
    init: () => initialize(root, values),
    check: () => assess(root, output, values, command),
    baseline: () => assess(root, output, values, command),
    'default-hook': () => console.log(`Installed advisory default hook: ${installDefaultHook()}`),
    'hook-run': async () => { process.exitCode = await runDefaultHook(root); },
    hook: () => { load(root); console.log(`Installed ${installHook(root)}`); },
    doctor: () => doctor(root),
  };
  if (!Object.hasOwn(handlers, command)) throw new Error(`Unknown command '${command}'`);
  await handlers[command]();
}
function initialize(root, values) {
    const file = path.join(root, CONFIG);
    if (fs.existsSync(file)) throw new Error(`${CONFIG} already exists; edit it instead of overwriting it`);
    const config = defaults(root);
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
    console.log(`Created ${file}\nDetected: ${JSON.stringify(config.project)}`);
    if (values.hook) console.log(`Installed ${installHook(root)}`);
}
async function assess(root, output, values, command) {
    const report = await check(root, output, values.config ? path.resolve(values.config) : undefined);
    if (command === 'baseline') {
      if (!report.complete) throw new Error('Cannot baseline an incomplete assessment; resolve tool failures first');
      const baseline = path.join(root, '.sloppy-baseline.json');
      fs.writeFileSync(baseline, JSON.stringify({ version: 1, fingerprints: report.findings.map(f => f.fingerprint) }, null, 2) + '\n');
      const config = load(root); config.baseline = '.sloppy-baseline.json';
      fs.writeFileSync(path.join(root, CONFIG), JSON.stringify(config, null, 2) + '\n');
      console.log(`Recorded ${report.findings.length} existing findings. Commit the baseline and review changes to it.`);
    } else {
      console.log(`${report.passed ? 'PASS' : 'FAIL'}: ${report.summary.errors} errors, ${report.summary.warnings} warnings, ${report.summary.baseline} baseline findings; ${report.complete ? 'complete' : 'incomplete'}`);
      console.log(`Report: ${path.join(output, 'report.md')}\nJSON: ${path.join(output, 'report.json')}`);
      for (const c of report.checks.filter(c => c.status === 'failed')) console.error(`${c.name}: ${c.detail}`);
      process.exitCode = report.complete ? (report.passed ? 0 : 1) : 2;
    }
}
async function doctor(root) {
    const { run } = await import("../runtime/processes.js");
    const { versions } = await import('../runtime/tool-versions.js');
    console.log(JSON.stringify(versions));
    for (const [name, args] of [['python', ['--version']], ['ruff', ['--version']], ['git', ['--version']]]) {
      try { const r = run(name, args, root); if (r.status !== 0) throw new Error(r.stderr); console.log((r.stdout || r.stderr).trim()); }
      catch (error) { console.error(error.message); process.exitCode = 2; }
    }
}
main().catch(error => { console.error(`sloppy: ${error.message}`); process.exitCode = 2; });

function validateArguments(positionals, values, command) {
  if (positionals.length > 1) throw new Error('Unexpected positional arguments');
  if (values.hook && command !== 'init') throw new Error('--hook is only valid with init');
  if (values.out && !['check', 'baseline'].includes(command)) throw new Error('--out is only valid with check or baseline');
  if (values.config && command !== 'check') throw new Error('--config is only valid with check');
}

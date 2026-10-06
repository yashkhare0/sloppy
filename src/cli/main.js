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
    root: { type: 'string' }, config: { type: 'string' }, out: { type: 'string' }, hook: { type: 'boolean' },
    'coverage-report': { type: 'string' }, 'python-dependency-audit': { type: 'boolean' },
    severity: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log('sloppy init [--root PATH] [--hook]\nsloppy check [--root PATH] [--config PATH] [--out PATH] [--coverage-report PATH] [--python-dependency-audit] [--severity RULE=LEVEL (info|minor|major|critical)]\nsloppy baseline [--root PATH]\nsloppy hook [--root PATH]\nsloppy default-hook\nsloppy doctor'); return;
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
    const report = await check(root, output, values.config ? path.resolve(values.config) : undefined, {
      coverageReport: values['coverage-report'],
      pythonDependencyAudit: values['python-dependency-audit'],
      severities: values.severity,
    });
    if (command === 'baseline') {
      if (!report.complete) throw new Error('Cannot baseline an incomplete assessment; resolve tool failures first');
      const baseline = path.join(root, '.sloppy-baseline.json');
      fs.writeFileSync(baseline, JSON.stringify({ version: 1, fingerprints: report.findings.map(f => f.fingerprint) }, null, 2) + '\n');
      const config = load(root); config.baseline = '.sloppy-baseline.json';
      fs.writeFileSync(path.join(root, CONFIG), JSON.stringify(config, null, 2) + '\n');
      console.log(`Recorded ${report.findings.length} existing findings. Commit the baseline and review changes to it.`);
    } else {
      const status = !report.complete ? 'INCOMPLETE' : report.passed ? 'PASS' : 'FAIL';
      console.log(`${status}: ${report.summary.gateErrors} gate blockers, ${report.summary.reviewLeads} review leads, ${report.summary.baseline} baseline findings; ${report.summary.baselineConfigured ? 'baseline configured' : 'no baseline configured'}`);
      const levels = Object.entries(report.summary.levels).filter(([, count]) => count).map(([level, count]) => `${count} ${level}`).join(', ');
      console.log(`Rule levels (not risk ratings): ${levels || 'none'}`);
      console.log(`Report: ${path.join(output, 'report.md')}\nJSON: ${path.join(output, 'report.json')}`);
      for (const c of report.checks.filter(c => c.status === 'failed')) console.error(`${c.name}: ${c.detail}`);
      process.exitCode = report.complete ? (report.passed ? 0 : 1) : 2;
    }
}
async function doctor(root) {
    const { run } = await import("../runtime/processes.js");
    const { versions } = await import('../runtime/tool-versions.js');
    console.log(JSON.stringify(versions));
    const config = fs.existsSync(path.join(root, CONFIG)) ? load(root) : defaults(root);
    const tools = [[config.python.executable, ['--version']], [config.python.ruffExecutable, ['--version']], ['git', ['--version']]];
    if (config.checks.pythonUnusedCode) tools.push([config.python.vultureExecutable, ['--version']]);
    if (config.checks.pythonDependencyAudit) tools.push([config.python.uvExecutable, ['--version']], [config.python.pipAuditExecutable, ['--version']]);
    for (const [name, args] of tools) {
      try { const r = run(name, args, root); if (r.status !== 0) throw new Error(r.stderr); console.log((r.stdout || r.stderr).trim()); }
      catch (error) { console.error(error.message); process.exitCode = 2; }
    }
}
main().catch(error => { console.error(`sloppy: ${error.message}`); process.exitCode = 2; });

function validateArguments(positionals, values, command) {
  if (positionals.length > 1) throw new Error('Unexpected positional arguments');
  const restrictions = [
    { option: '--hook', enabled: values.hook, commands: ['init'] },
    { option: '--out', enabled: values.out, commands: ['check', 'baseline'] },
    { option: '--config', enabled: values.config, commands: ['check'] },
    { option: '--coverage-report', enabled: values['coverage-report'], commands: ['check'] },
    { option: '--python-dependency-audit', enabled: values['python-dependency-audit'], commands: ['check'] },
    { option: '--severity', enabled: values.severity?.length, commands: ['check'] },
  ];
  for (const restriction of restrictions) {
    if (restriction.enabled && !restriction.commands.includes(command)) {
      const commands = restriction.commands.join(' or ');
      throw new Error(`${restriction.option} is only valid with ${commands}`);
    }
  }
}

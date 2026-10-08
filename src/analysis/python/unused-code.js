import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finding } from '../../domain/findings.js';
import { matches } from '../../project/policies.js';
import { run } from '../../runtime/processes.js';

const FRAMEWORK_DECORATORS = [
  'route', 'get', 'post', 'put', 'patch', 'delete', 'websocket', 'api_route',
  'exception_handler', 'middleware', 'on_event',
  'field_validator', 'model_validator', 'validator', 'root_validator',
  'activity', 'entrypoint', 'defn', 'define',
  'workflow.update', 'workflow.signal', 'workflow.query', 'workflow.run',
];
const VULTURE_DECORATORS = FRAMEWORK_DECORATORS.flatMap(name => [`@${name}`, `@*.${name}`]);

function pythonExemptions(root, files, config) {
  const script = fileURLToPath(new URL('./parser/unused_exemptions.py', import.meta.url));
  const sourceRoot = path.resolve(path.dirname(script), '../../..');
  const configured = config.python.executable;
  const executable = /[\\/]/.test(configured) && !path.isAbsolute(configured)
    ? path.resolve(root, configured) : configured;
  const result = run(executable, ['-m', 'analysis.python.parser.unused_exemptions'], sourceRoot,
    JSON.stringify({ root, files }));
  if (result.status !== 0) throw new Error(result.stderr || 'Python unused-code parser failed');
  return JSON.parse(result.stdout);
}

export function unusedPython(root, files, config) {
  const exemptions = pythonExemptions(root, files, config);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sloppy-vulture-'));
  try {
    const isolatedConfig = path.join(temporaryDirectory, 'pyproject.toml');
    fs.writeFileSync(isolatedConfig, '[tool.vulture]\n');
    const result = run(config.python.vultureExecutable, [
      '--config', isolatedConfig,
      '--min-confidence', String(config.python.vultureMinConfidence),
      '--ignore-decorators', VULTURE_DECORATORS.join(','),
      '--', ...files.map(file => path.resolve(root, file)),
    ], root);
    if (![0, 3].includes(result.status) || (result.status === 3 && !result.stdout.trim())) {
      throw new Error(result.stderr || result.stdout || 'Vulture failed without producing its findings');
    }
    return parseVultureOutput(root, files, result.stdout, config, exemptions);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function parseVultureOutput(root, files, output, config, exemptions) {
  const identity = file => {
    const real = fs.realpathSync.native(file);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  const known = new Map(files.map(file => [identity(path.resolve(root, file)), file]));
  const testPatterns = config.overrides.flatMap(override => override.files);
  const findings = [];
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const match = /^(.*):(\d+): (.+)$/.exec(line);
    if (!match) throw new Error(`Vulture returned an unrecognized finding: ${line}`);
    const absolute = path.resolve(root, match[1]);
    const file = known.get(identity(absolute));
    if (!file) throw new Error(`Vulture returned a file outside the selected Python sources: ${path.relative(root, absolute).replaceAll('\\', '/')}`);
    const sourceLine = Number(match[2]);
    if (matches(file, testPatterns) || /(^|\/)migrations\//.test(file)
      || exemptions[file]?.includes(sourceLine) || /^unreachable code after /.test(match[3])) continue;
    const detail = match[3].replace(/\s+\(\d+% confidence\)$/, '');
    findings.push(unusedFinding(file, sourceLine, detail, match[3], config));
  }
  return findings;
}

function unusedFinding(file, sourceLine, detail, output, config) {
  const attribute = detail.startsWith('unused attribute ');
  return finding('python/unused-definition', {
      file, line: sourceLine, column: 1,
      symbol: detail.match(/'([^']+)'/)?.[1] ?? null,
      message: detail,
      guidance: attribute ? 'Check property setters, descriptors, and external-library consumers before changing this attribute write. Absence of local reads does not prove this write is unused.' : 'Check framework registration and external callers before removing this definition.',
      level: config.python.severities['python/unused-definition'],
      evidence: { confidence: Number(output.match(/\((\d+)% confidence\)$/)?.[1] ?? 0), analyzer: 'Vulture', candidateKind: attribute ? 'attribute-write' : 'definition' },
    });
}

import fs from 'node:fs';
import path from 'node:path';
import { finding } from '../../domain/findings.js';
import { matches } from '../../project/policies.js';
import { projectPath } from '../../project/python-policies.js';

const COVERAGE_STEP = 20;
const COVERAGE_LEVELS = ['minor', 'major', 'critical'];
export function pythonCoverage(root, files, config) {
  const context = coverageContext(root, files, config);
  const findings = [
    ...unmeasuredCoverage(context),
    ...overallCoverage(context),
    ...fileCoverage(context),
  ];
  if (context.missing.length) {
    const error = new Error(`${coverageDetail(context)} Coverage report omits selected source files; include them before using coverage as a gate.`);
    error.findings = findings;
    throw error;
  }
  return { findings, detail: coverageDetail(context) };
}

function coverageContext(root, files, config) {
  const reportPath = projectPath(root, config.python.coverageReport, 'Python coverage report');
  const summaries = readCoverageSummaries(root, reportPath, config.python.coverageReport);
  const sources = files.filter(file => !isTestFile(file, config));
  const missing = sources.filter(file => !summaries.has(path.resolve(root, file)));
  const measured = sources.filter(file => summaries.has(path.resolve(root, file))).map(file => {
    const summary = summaries.get(path.resolve(root, file));
    return { file, covered: summary.covered_lines, statements: summary.num_statements };
  });
  const covered = measured.reduce((total, file) => total + file.covered, 0);
  const statements = measured.reduce((total, file) => total + file.statements, 0);
  return {
    config, reportPath, sources, missing, measured, covered, statements,
    percent: statements ? 100 * covered / statements : 100,
    minimum: config.python.coverageMinimum,
  };
}

function readCoverageSummaries(root, reportPath, configuredPath) {
  let report;
  try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); }
  catch (error) { throw new Error(`Cannot read Python coverage report ${configuredPath}: ${error.message}`); }
  if (!report.files || typeof report.files !== 'object' || Array.isArray(report.files)) {
    throw new Error('Python coverage report must contain a files object from coverage.py JSON output');
  }
  const summaries = new Map();
  for (const [name, item] of Object.entries(report.files)) {
    summaries.set(path.resolve(root, name), coverageSummary(name, item?.summary));
  }
  return summaries;
}

function coverageSummary(name, summary) {
  if (!summary || !Number.isInteger(summary.covered_lines) || !Number.isInteger(summary.num_statements)
      || summary.covered_lines < 0 || summary.num_statements < summary.covered_lines) {
    throw new Error(`Invalid coverage summary for ${name}`);
  }
  return summary;
}

function unmeasuredCoverage({ missing, config }) {
  return missing.map(file => finding('python/coverage', {
    file, line: 1, column: 1, symbol: 'unmeasured',
    message: 'Python source file is missing from the configured coverage report',
    guidance: 'Include this module in the coverage.py source configuration and regenerate the JSON report.',
    level: config.python.severities['python/coverage'] ?? 'info',
    evidence: { report: config.python.coverageReport, measured: false },
  }));
}

function overallCoverage(context) {
  const { measured, percent, covered, statements, minimum, config } = context;
  const level = coverageLevel(percent, minimum);
  if (!level || !measured.length) return [];
  const lowest = [...measured].sort((a, b) => coveragePercent(a) - coveragePercent(b))[0];
  return [finding('python/coverage', {
    file: lowest.file, line: 1, column: 1, symbol: 'overall coverage',
    message: `Python source coverage is ${percent.toFixed(1)}% (${covered}/${statements} statements; minimum ${minimum}%)`,
    guidance: 'Add tests that execute the uncovered public behavior, then regenerate the coverage.py JSON report.',
    level: config.python.severities['python/coverage'] ?? level,
    evidence: { covered, statements, percent: Number(percent.toFixed(1)), minimum, scope: 'selected Python sources' },
  })];
}

function fileCoverage({ measured, minimum, config }) {
  return measured.filter(file => file.statements >= 10).flatMap(file => {
    const percent = coveragePercent(file);
    const level = coverageLevel(percent, minimum);
    if (!level) return [];
    return [finding('python/coverage', {
      file: file.file, line: 1, column: 1,
      message: `${percent.toFixed(0)}% covered (${file.covered}/${file.statements} statements; minimum ${minimum}%)`,
      guidance: 'Add tests for this module’s uncovered behavior and regenerate the coverage.py JSON report.',
      level: config.python.severities['python/coverage'] ?? level,
      evidence: { covered: file.covered, statements: file.statements, percent: Number(percent.toFixed(1)), minimum },
    })];
  });
}

function coverageDetail({ measured, missing, percent, statements, minimum, reportPath }) {
  return measured.length
    ? `Coverage ${percent.toFixed(1)}% across ${statements} selected-source statements (${missing.length} files unmeasured; minimum ${minimum}%).`
    : `No selected Python source files were present in ${reportPath}.`;
}

function coveragePercent(file) { return file.statements ? 100 * file.covered / file.statements : 100; }

function coverageLevel(percent, minimum) {
  if (percent >= minimum) return null;
  const step = Math.floor((minimum - percent - 1e-9) / COVERAGE_STEP);
  return COVERAGE_LEVELS[Math.min(step, COVERAGE_LEVELS.length - 1)];
}

function isTestFile(file, config) {
  return config.overrides.some(override => matches(file, override.files));
}

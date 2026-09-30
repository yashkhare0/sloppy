import path from 'node:path';
import { finding } from '../domain/findings.js';
import { matchesModule, moduleOwners, sourceModule } from '../domain/module-ownership.js';

export function assessOrganization(files, config) {
  const policy = config.organization;
  if (!policy) return [];
  const findings = [], sources = files.filter(file => sourceModule(file, policy));
  for (const file of sources) inspectModule(file, policy, findings);
  for (const root of policy.sourceRoots) {
    const direct = sources.filter(file => path.posix.dirname(file) === root);
    if (direct.length >= policy.rootFileWarning) findings.push(finding('organization/flat-source-root', { file: direct[0], line: 1, column: 1, severity: 'warning', message: `${root} contains ${direct.length} directly placed source files`, guidance: 'Group modules by their resource or use-case owner. Keep only deliberate composition roots directly under the source root.', evidence: { files: direct, threshold: policy.rootFileWarning } }));
  }
  if (policy.requireOwnerTests) inspectOwnerTests(files, sources, policy, findings);
  return findings;
}

function inspectModule(file, policy, findings) {
  if (policy.exemptions.some(exemption => matchesModule(file, exemption.files))) return;
  const name = path.posix.basename(file).replace(/\.(?:[cm]?[jt]sx?|py)$/, '');
  if (policy.forbiddenNames.includes(name)) findings.push(finding('organization/vague-module-name', { file, line: 1, column: 1, message: `Module name '${name}' is forbidden by the project vocabulary`, guidance: 'Name the module for the resource, invariant, or behavior it owns. Move its responsibilities to the canonical owner instead of simply renaming a catch-all module.' }));
  if (!policy.requireOwnership || matchesModule(file, policy.compositionRoots)) return;
  const owners = moduleOwners(file, policy);
  if (owners.length !== 1) findings.push(finding('organization/module-ownership', { file, line: 1, column: 1, message: owners.length ? 'Module has overlapping configured owners' : 'Module has no configured owner', guidance: 'Place the module under its resource owner and make ownership patterns unambiguous.', evidence: { owners: owners.map(owner => owner.name) } }));
}

function inspectOwnerTests(files, sources, policy, findings) {
  for (const owner of policy.owners) {
    const owned = sources.filter(file => matchesModule(file, owner.sources));
    if (!owned.length || files.some(file => matchesModule(file, owner.tests))) continue;
    findings.push(finding('organization/owner-tests', { file: owned[0], line: 1, column: 1, message: `Owner '${owner.name}' has no selected test file matching its test location`, guidance: 'Put observable behavior tests under the owning module’s configured test directory. Test-file presence is not proof of test coverage or test execution.', evidence: { owner: owner.name, expectedTests: owner.tests } }));
  }
}

export function organizationDefaults() {
  return { sourceRoots: ['src'], forbiddenNames: ['helpers', 'utils', 'common', 'misc', 'types'], compositionRoots: [], rootFileWarning: 8, owners: [], requireOwnership: false, requireOwnerTests: false, exemptions: [] };
}

export function validateOrganization(policy) {
  if (policy === undefined) return;
  const allowed = Object.keys(organizationDefaults());
  if (!policy || Object.keys(policy).some(key => !allowed.includes(key))) throw new Error('Invalid organization configuration');
  for (const field of ['sourceRoots', 'forbiddenNames', 'compositionRoots']) validatePatterns(policy[field], `organization.${field}`);
  for (const flag of ['requireOwnership', 'requireOwnerTests']) if (typeof policy[flag] !== 'boolean') throw new Error(`organization.${flag} must be boolean`);
  if (!Number.isInteger(policy.rootFileWarning) || policy.rootFileWarning < 1) throw new Error('organization.rootFileWarning must be a positive integer');
  validateOwners(policy.owners);
  validateExemptions(policy.exemptions);
}

function validatePatterns(patterns, label) {
  if (!Array.isArray(patterns) || patterns.some(pattern => typeof pattern !== 'string' || !pattern)) throw new Error(`${label} must be nonempty strings in an array`);
}

function validateOwners(owners) {
  if (!Array.isArray(owners)) throw new Error('organization.owners must be an array');
  const names = new Set();
  for (const owner of owners) {
    if (!owner || typeof owner.name !== 'string' || !owner.name.trim() || names.has(owner.name)) throw new Error('Organization owners require unique names');
    if (Object.keys(owner).some(key => !['name', 'sources', 'tests'].includes(key))) throw new Error('Unknown organization owner key');
    validatePatterns(owner.sources, 'owner.sources'); validatePatterns(owner.tests, 'owner.tests');
    if (!owner.sources.length) throw new Error('Owners require source patterns');
    names.add(owner.name);
  }
}

function validateExemptions(exemptions) {
  if (!Array.isArray(exemptions)) throw new Error('organization.exemptions must be an array');
  for (const exemption of exemptions) {
    if (!exemption || Object.keys(exemption).some(key => !['files', 'reason'].includes(key))) throw new Error('Invalid organization exemption');
    validatePatterns(exemption.files, 'exemption.files');
    if (!exemption.files.length || typeof exemption.reason !== 'string' || exemption.reason.trim().length < 10) throw new Error('Organization exemptions require file patterns and a meaningful reason');
  }
}

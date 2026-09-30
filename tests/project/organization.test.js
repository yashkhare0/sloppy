import test from 'node:test';
import assert from 'node:assert/strict';
import { assessOrganization, organizationDefaults, validateOrganization } from '../../src/project/organization.js';

test('organization enforces vocabulary, unique ownership and owner test locations', () => {
  const organization = { ...organizationDefaults(), requireOwnership: true, requireOwnerTests: true,
    owners: [{ name: 'orders', sources: ['src/orders/**'], tests: ['tests/orders/**'] }] };
  const issues = assessOrganization(['src/utils.ts', 'src/orders/create-order.ts'], { organization });
  assert.deepEqual(issues.map(issue => issue.ruleId).sort(), ['organization/module-ownership', 'organization/owner-tests', 'organization/vague-module-name']);
  assert.deepEqual(assessOrganization(['src/orders/create-order.ts', 'tests/orders/create-order.test.ts'], { organization }), []);
  organization.owners.push({ name: 'overlap', sources: ['src/orders/**'], tests: [] });
  assert.ok(assessOrganization(['src/orders/create-order.ts'], { organization }).some(issue => issue.ruleId === 'organization/module-ownership'));
});

test('organization exemptions need explicit reasons and legacy configurations remain valid', () => {
  validateOrganization(undefined);
  assert.deepEqual(assessOrganization(['src/utils.ts'], {}), []);
  const organization = { ...organizationDefaults(), exemptions: [{ files: ['src/components/ui/utils.ts'], reason: 'Framework-generated component utility is intentionally retained.' }] };
  validateOrganization(organization);
  assert.deepEqual(assessOrganization(['src/components/ui/utils.ts'], { organization }), []);
  assert.equal(assessOrganization(['src/utils.ts'], { organization })[0].ruleId, 'organization/vague-module-name');
  assert.throws(() => validateOrganization({ ...organization, exemptions: [{ files: ['**'], reason: '' }] }));
  assert.throws(() => validateOrganization({ ...organization, unknown: true }));
});

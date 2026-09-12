const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ensureBridge } = require('./bridge-lifecycle.cjs');
const good = { app: 'digital-terrarium', telemetryVersion: 1, version: '1.9.1' };

for (const version of [undefined, '1.8.0']) {
  test(`replaces stale bridge ${version}`, async () => {
    let current = { ...good, version }, replacements = 0;
    await ensureBridge({ version: good.version, health: async () => current,
      replace: async () => { replacements++; current = good; },
      start: () => assert.fail('must not race the existing listener'), delay: async () => {} });
    assert.equal(replacements, 1);
  });
}
test('reuses matching bridge', async () => {
  await ensureBridge({ version: good.version, health: async () => good,
    replace: () => assert.fail(), start: () => assert.fail() });
});
test('never replaces unrelated application', async () => {
  await assert.rejects(ensureBridge({ version: good.version,
    health: async () => ({ app: 'other' }), replace: () => assert.fail(), start: () => assert.fail() }), /another application/);
});
test('fails visibly if replacement remains stale', async () => {
  await assert.rejects(ensureBridge({ version: good.version,
    health: async () => ({ ...good, version: 'old' }), replace: async () => {},
    delay: async () => {} }), /did not become ready/);
});
test('starts absent bridge and waits for readiness', async () => {
  let current = null;
  await ensureBridge({ version: good.version, health: async () => current,
    start: async () => { current = good; }, delay: async () => {} });
});

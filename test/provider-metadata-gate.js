'use strict';
const assert = require('assert').strict;
const { ProviderMetadataGate, LIMIT } = require('../app/libs/provider-metadata-gate');
const { defaults, profiles } = require('../app/libs/provider-profiles');
const { validate, digest } = require('../app/libs/provider-schema');
let passed = 0;
async function test (name, fn) { await fn(); passed++; console.log('PASS ' + name); }
const error = (code, extra) => Object.assign(Error('private fixture payload'), { code, ...extra });
(async () => {
  await test('new configs have no metadata quota; legacy values are inert and byte-compatible', async () => {
    for (const profile of Object.keys(profiles)) {
      const c = defaults(profile, '1234abcd'); assert.equal(c.budgets.metadataPerHour, undefined);
      assert.equal(profiles[profile].budgetCaps.metadataPerHour, undefined);
      for (const cap of [0, 1, 24, 999]) { c.budgets.metadataPerHour = cap; assert.equal(digest(validate(c, profiles)), digest(c)); }
    }
  });
  await test('100 healthy calls are not subject to any count quota', async () => {
    const gate = new ProviderMetadataGate(); let calls = 0;
    for (let i = 0; i < 100; i++) await gate.run('A', String(i), async () => ++calls);
    assert.equal(calls, 100);
  });
  await test('same-site overlap does not queue or call upstream; different sites remain independent', async () => {
    const gate = new ProviderMetadataGate(); let release;
    const pending = gate.run('A', '1', () => new Promise(resolve => { release = resolve; }));
    await assert.rejects(() => gate.run('A', '2', () => assert.fail()), /PROVIDER_METADATA_BUSY/);
    assert.equal(await gate.run('B', '3', async () => 'ok'), 'ok'); release(); await pending;
    assert.equal(await gate.run('A', '2', async () => 'ok'), 'ok');
  });
  await test('429 honors Retry-After without caching response content and resumes after deadline', async () => {
    let now = 100000; const gate = new ProviderMetadataGate(() => now); let notice;
    await assert.rejects(() => gate.run('A', '1', async () => { throw error('PROVIDER_RATE_LIMIT', { retryAfterSeconds: 900 }); }, n => { notice = n; }));
    assert.equal(notice.until, now + 900000); assert.equal(notice.reason, 'rate-limit');
    assert(!JSON.stringify([...gate.sites.values()]).includes('private'));
    now += 899999; await assert.rejects(() => gate.run('A', '2', () => assert.fail()), e => e.metadataScope === 'site');
    now++; assert.equal(await gate.run('A', '2', async () => true), true);
  });
  await test('repeated network failures exponentially back off and success resets the failure streak', async () => {
    let now = 100000; const gate = new ProviderMetadataGate(() => now);
    for (const wait of [60000, 120000, 240000]) {
      await assert.rejects(() => gate.run('A', '1', async () => { throw error('ECONNRESET'); }), e => e.retryAt === now + wait);
      now += wait;
    }
    await gate.run('A', '1', async () => true);
    await assert.rejects(() => gate.run('A', '1', async () => { throw error('PROVIDER_TIMEOUT_BODY'); }), e => e.retryAt === now + 60000);
  });
  await test('invalid candidate backs off independently without blocking another candidate', async () => {
    let now = 100000; const gate = new ProviderMetadataGate(() => now);
    await assert.rejects(() => gate.run('A', 'bad', async () => { throw error('PROVIDER_TORRENT_INVALID'); }));
    await assert.rejects(() => gate.run('A', 'bad', () => assert.fail()), e => e.metadataScope === 'candidate');
    await gate.run('A', 'good', async () => true); now += 300000;
    await assert.rejects(() => gate.run('A', 'bad', async () => { throw error('PROVIDER_TORRENT_INVALID'); }), e => e.retryAt === now + 600000);
  });
  await test('auth errors stop the site; remaining MT detail budget remains enforced separately', async () => {
    const now = 3700000; const gate = new ProviderMetadataGate(() => now);
    await assert.rejects(() => gate.run('A', '1', async () => { throw error('PROVIDER_AUTH_OR_REDIRECT'); }), e => e.retryAt === now + 1800000);
    await assert.rejects(() => gate.run('MT', '1', async () => { throw Error('detail_budget'); }), e => e.retryAt === 7200000 && e.metadataScope === 'site');
  });
  await test('private MT download 429/503 transport errors keep site backoff and Retry-After', async () => {
    const now = 100000; const gate = new ProviderMetadataGate(() => now);
    for (const status of [429, 503]) await assert.rejects(() => gate.run(String(status), '1', async () => { throw Object.assign(Error('torrent_response'), { status, retryAfterSeconds: 600 }); }), e => e.metadataScope === 'site' && e.retryAt === now + 600000);
  });
  await test('DB/config/programming failures are not mislabeled as remote failures', async () => {
    const gate = new ProviderMetadataGate();
    for (const code of ['SQLITE_BUSY', 'PROVIDER_CONFIG_CHANGED', 'PROVIDER_IDENTITY_STORE', 'UNKNOWN']) await assert.rejects(() => gate.run('A', '1', async () => { throw error(code); }), e => !e.metadataScope);
    assert.equal(gate.sites.size + gate.items.size, 0);
  });
  await test('missing, oversized or malformed responses defer only that candidate, not unrelated work', async () => {
    const gate = new ProviderMetadataGate();
    for (const [key, e] of [['1', error('PROVIDER_HTTP', { transport: { statusCode: 404 } })], ['2', error('api_http', { status: 410 })], ['3', error('PROVIDER_ENCODING')], ['4', error('PROVIDER_BODY_LIMIT')]]) {
      await assert.rejects(() => gate.run('A', key, async () => { throw e; }), e => e.metadataScope === 'candidate');
      await gate.run('A', 'good', async () => true);
    }
    assert.equal(gate.items.size, 4);
  });
  await test('failure records are bounded, expire, and clock rollback never accelerates retries', async () => {
    let now = 100000; const gate = new ProviderMetadataGate(() => now);
    for (let i = 0; i <= LIMIT; i++) await assert.rejects(() => gate.run('A', String(i), async () => { throw error('PROVIDER_TORRENT_INVALID'); }));
    assert.equal(gate.items.size, LIMIT); now -= 1000;
    await assert.rejects(() => gate.run('A', String(LIMIT), () => assert.fail()), /PROVIDER_METADATA_BACKOFF/);
    now += 86401002; await gate.run('A', 'ok', async () => true); assert.equal(gate.items.size, 0);
  });
  console.log(JSON.stringify({ ok: true, passed, network: 'none' }));
})().catch(e => { console.error(e); process.exitCode = 1; });

'use strict';
// Local fixtures only; real persistence/budget code, no live credentials or jobs.
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const bencode = require('bencode');
const { defaults, profiles } = require('../app/libs/provider-profiles');
const parser = require('../app/libs/provider-parser');
const { ProviderStore } = require('../app/libs/provider-store');
const { ProviderIdentityCache, TTL, LIMIT } = require('../app/libs/provider-identity-cache');
const { digest } = require('../app/libs/provider-schema');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vertex-provider-admission-'));
const filename = path.resolve(__dirname, '../app/libs/torrent-providers.js');
const nativeRequire = createRequire(filename);
let sequence = 0; const results = [];
async function test (name, fn) { await fn(); results.push(name); process.stdout.write('PASS ' + name + '\n'); }
function torrentBody (size = 123456) {
  return bencode.encode({ announce: Buffer.from('https://fixture.invalid/announce'), info: { name: Buffer.from('fixture.bin'), length: size, 'piece length': 16384, pieces: Buffer.alloc(Math.ceil(size / 16384) * 20) } });
}
async function fixture (profile = 'CARPT') {
  const dir = path.join(work, String(++sequence)); fs.mkdirSync(path.join(dir, 'torrents'), { recursive: true });
  let at = Math.floor(Date.now() / 3600000) * 3600000 + 1000;
  class Clock extends Date { static now () { return at; } }
  const cfg = defaults(profile, '1234abcd'); cfg.budgets.metadataPerHour = 24;
  cfg.selection.minFreeSeconds = 60;
  const client = { id: '12345678', _client: { type: 'qBittorrent' }, maindata: { freeSpaceOnDisk: 10 ** 13, torrents: [] }, hasTorrent: async hash => f.remoteHashes.has(hash) };
  const rss = { id: cfg.rssId, clientArr: [client.id], skipSameTorrent: true };
  const globals = { runningClient: { [client.id]: client }, runningRss: { [rss.id]: rss } };
  const f = { dir, cfg, client, rss, globals, fetches: 0, dbReads: 0, before: 0, finals: 0, remoteHashes: new Set(), rows: [], pending: [], history: [], recent: null, allow: true, finalAllow: true, invalid: false };
  f.rows = [{ candidateKey: profile + ':12', siteId: profile, torrentId: '12', name: 'fixture', size: 123000, pubTime: at / 1000 - 60, fetchedAt: at / 1000, seeders: 5, leechers: 10, hrState: 'exempt', downloadFactor: 0, downloadUntil: at / 1000 + 86400, link: profiles[profile].origin + '/details.php?id=12', url: profiles[profile].origin + '/download.php?id=12' }];
  const util = {
    listRss: () => [],
    listSite: () => [],
    getRecords: async (sql, args) => { f.dbReads++; return sql.includes('vertex_rss_pending') ? f.pending : f.history.filter(r => r.id > args[1]); },
    getRecord: async (sql, args) => sql.includes('where size') ? f.recent : f.pending.find(r => r.true_hash === args[0] || r.candidate_hash === args[1])
  };
  f.reload = async () => {
    const dependencies = {
      './util': util,
      './provider-http': { request: async () => Buffer.from('<html></html>') },
      './provider-parser': { ...parser, parse: () => ({ candidates: f.rows.map(r => ({ ...r, fetchedAt: at / 1000 })), coverage: {} }), eligibility: (r, c) => parser.eligibility(r, c, at / 1000) }
    };
    const context = {
      module: { exports: {} },
      exports: {},
      __dirname: path.join(dir, 'app/libs'),
      Buffer,
      URL,
      URLSearchParams,
      Date: Clock,
      setTimeout,
      clearTimeout,
      global: globals,
      require: key => dependencies[key] || nativeRequire(key)
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    f.service = context.module.exports; f.service.store.root = path.join(dir, 'providers');
    f.service.register(rss.id, {
      check: async () => {},
      credential: async () => 'fixture-only',
      list: async (c, opts) => { await opts.charge(); if (f.personalBatch && opts.personalCharge) await opts.personalCharge(); return {}; },
      beforePrepare: async () => { f.before++; return f.allow; },
      validateFinal: async () => { f.finals++; return f.finalAllow; },
      prepare: async () => { f.fetches++; if (f.onPrepare) await f.onPrepare(); return f.invalid ? Buffer.from('not-a-torrent') : torrentBody(123456 + (f.unique ? f.fetches : 0)); },
      select: (c, rows) => f.select ? f.select(c, rows) : rows
    });
  };
  f.cycle = async () => { at += 300001; f.client.maindata.providerSnapshotAt = at / 1000; return (await f.service.begin(rss)).candidates; };
  f.prepare = row => f.service.prepare(rss, row, client);
  f.advance = ms => { at += ms; };
  f.budget = () => JSON.parse(fs.readFileSync(path.join(f.service.store.root, 'budget-' + profile + '.json')));
  f.stats = async () => (await f.service.list()).records[0].status.admission;
  await f.reload(); await f.service.store.apply(cfg, 0, async () => {});
  return f;
}
async function main () {
  await test('competition defers before metadata or DB and reconsideration uses new swarm counts', async () => {
    const f = await fixture(); f.cfg.selection.minDemandRatio = 3;
    await f.service.store.apply(f.cfg, 1, async () => {});
    assert.equal((await f.cycle()).length, 0); assert.equal(f.dbReads, 0); assert.equal(f.fetches, 0);
    assert.equal((await f.stats()).competitionSkips, 1);
    f.rows[0].leechers = 15;
    assert.equal(await f.prepare((await f.cycle())[0]), true); assert.equal(f.fetches, 1);
  });
  await test('bridge ranking cannot inject or reintroduce source-ineligible candidates', async () => {
    const f = await fixture(); f.cfg.selection.minDemandRatio = 3;
    await f.service.store.apply(f.cfg, 1, async () => {});
    f.select = () => f.rows; assert.equal((await f.cycle()).length, 0); assert.equal(f.fetches, 0);
  });
  await test('source original investment defers before metadata and completed tasks release it', async () => {
    const f = await fixture(); const h = 'a'.repeat(40); f.cfg.selection.maxInFlightGiB = 1;
    f.history = [{ id: 1, hash: h, add_time: 1, size: 1024 ** 3, record_type: 1, record_note: '添加种子' }];
    f.client.maindata.torrents = [{ hash: h, size: 1024 ** 3, progress: 0.5, state: 'pausedDL' }];
    await f.service.store.apply(f.cfg, 1, async () => {});
    for (let i = 0; i < 3; i++) assert.equal(await f.prepare((await f.cycle())[0]), false);
    assert.equal(f.fetches, 0); assert.equal(f.budget().metadata, 0); assert.equal((await f.stats()).exposureSkips, 1);
    f.client.maindata.torrents[0].progress = 1;
    assert.equal(await f.prepare((await f.cycle())[0]), true); assert.equal(f.fetches, 1);
  });
  await test('exposure rechecks metadata exact size and final reservation races without hourly quotas', async () => {
    const f = await fixture(); f.cfg.selection.maxInFlightGiB = 123200 / 1024 ** 3;
    await f.service.store.apply(f.cfg, 1, async () => {});
    assert.equal(await f.prepare((await f.cycle())[0]), false); assert.equal(f.fetches, 1); // exact size is larger
    f.cfg.selection.maxInFlightGiB = 1; await f.service.store.apply(f.cfg, 2, async () => {});
    const row = (await f.cycle())[0]; assert.equal(await f.prepare(row), true);
    f.pending = [{ true_hash: 'd'.repeat(40), candidate_hash: 'other', payload: JSON.stringify({ torrent: { hash: 'd'.repeat(40), size: 1024 ** 3, candidateKey: 'CARPT:13' } }) }];
    await assert.rejects(() => f.service.finalCheck(f.rss, row, f.client), /PROVIDER_OPPORTUNITY_DEFERRED/);
    f.pending = []; await f.service.finalCheck(f.rss, row, f.client);
    f.advance(121000); await assert.rejects(() => f.service.finalCheck(f.rss, row, f.client), /PROVIDER_OPPORTUNITY_DEFERRED/);
  });
  await test('positive site state skips before DB, identity cache, driver detail or metadata', async () => {
    const f = await fixture();
    for (const personalState of ['seeding', 'downloading']) {
      f.rows[0].personalState = personalState; assert.equal((await f.cycle()).length, 0);
      assert.equal((await f.stats()).siteActiveSkips, 1);
    }
    assert.equal(f.dbReads, 0); assert.equal(f.before, 0); assert.equal(f.fetches, 0);
    assert.equal(f.budget().metadata, 0); assert(!fs.existsSync(path.join(f.service.store.root, 'identity-CARPT.json')));
  });
  await test('a disappeared active marker is reconsidered, while inactive/history never skips local guards', async () => {
    const f = await fixture(); f.rows[0].personalState = 'seeding'; assert.equal((await f.cycle()).length, 0);
    for (const personalState of ['inactive', 'unknown', undefined]) {
      f.rows[0].personalState = personalState; assert.equal(await f.prepare((await f.cycle())[0]), true);
    }
    assert.equal(f.fetches, 3); assert.equal(f.finals, 3); assert(f.dbReads > 0);
  });
  await test('Haidan local fallback still avoids repeated metadata after an exact identity is learned', async () => {
    const f = await fixture('HAIDAN'); assert.deepEqual(f.cfg.personalStateRules, []);
    await f.prepare((await f.cycle())[0]); f.client.maindata.torrents = [{ size: 123456 }];
    for (let i = 0; i < 3; i++) assert.equal(await f.prepare((await f.cycle())[0]), false);
    assert.equal(f.fetches, 1); assert.equal((await f.stats()).duplicateSkips, 1);
  });
  await test('MT optional personal ledger is separate and preserves existing counters across reload', async () => {
    const f = await fixture('MTEAM'); f.personalBatch = true;
    await f.prepare((await f.cycle())[0]); const first = f.budget();
    assert.equal(first.personal, 1); assert.equal(first.list, 1); assert.equal(first.metadata, 1);
    await f.reload(); f.rows[0].personalState = 'seeding'; await f.cycle();
    assert.equal(f.budget().personal, 2); assert.equal(f.budget().metadata, 1);
    const saved = await f.service.store.read(f.rss.id); delete f.cfg.budgets.personalPerHour;
    await f.service.store.apply(f.cfg, saved.revision, async () => {}); await f.cycle();
    assert.equal(f.budget().personal, 2);
  });
  await test('nine cycles of the same rejected candidate consume metadata once, not nine times', async () => {
    const f = await fixture(); f.client.maindata.torrents = [{ size: 123456, hash: 'a'.repeat(40) }];
    assert.equal(await f.prepare((await f.cycle())[0]), true); // Native same-size rule would reject it.
    for (let i = 0; i < 8; i++) assert.equal(await f.prepare((await f.cycle())[0]), false);
    assert.equal(f.fetches, 1); assert.equal(f.budget().metadata, 1);
    assert.equal((await f.stats()).identityHits, 1); assert.equal((await f.stats()).duplicateSkips, 1);
  });
  await test('verified identity survives a fresh service instance without resetting the budget', async () => {
    const f = await fixture(); const row = (await f.cycle())[0]; await f.prepare(row);
    f.client.maindata.torrents = [{ hash: row.hash, size: row.size }]; await f.reload();
    assert.equal(await f.prepare((await f.cycle())[0]), false); assert.equal(f.fetches, 1); assert.equal(f.budget().metadata, 1);
    const data = fs.readFileSync(path.join(f.service.store.root, 'identity-CARPT.json'), 'utf8');
    for (const privateValue of ['fixture', 'https:', 'download.php', 'announce']) assert(!data.includes(privateValue));
  });
  await test('removed duplicate is reconsidered with fresh metadata and final guards, not permanently blacklisted', async () => {
    const f = await fixture(); await f.prepare((await f.cycle())[0]);
    f.client.maindata.torrents = [{ size: 123456 }]; assert.equal(await f.prepare((await f.cycle())[0]), false);
    f.client.maindata.torrents = []; const row = (await f.cycle())[0]; assert.equal(await f.prepare(row), true);
    await f.service.finalCheck(f.rss, row, f.client); assert.equal(f.fetches, 2); assert.equal(f.finals, 3);
  });
  await test('rounded list size is never used as an exact duplicate identity', async () => {
    const f = await fixture(); f.client.maindata.torrents = [{ size: f.rows[0].size }];
    assert.equal(await f.prepare((await f.cycle())[0]), true);
    assert.equal(await f.prepare((await f.cycle())[0]), true); assert.equal(f.fetches, 2);
  });
  await test('other qB and recent admission window retain native same-size semantics', async () => {
    const f = await fixture(); await f.prepare((await f.cycle())[0]);
    f.globals.runningClient.other = { _client: { type: 'qBittorrent' }, maindata: { torrents: [{ size: '123456' }] } };
    assert.equal(await f.prepare((await f.cycle())[0]), false);
    delete f.globals.runningClient.other; f.recent = { id: 10 };
    assert.equal(await f.prepare((await f.cycle())[0]), false);
    f.recent = null; assert.equal(await f.prepare((await f.cycle())[0]), true); assert.equal(f.fetches, 2);
  });
  await test('disabling same-size filter does not leave a hidden size blacklist', async () => {
    const f = await fixture(); await f.prepare((await f.cycle())[0]); f.rss.skipSameTorrent = false;
    f.client.maindata.torrents = [{ hash: 'f'.repeat(40), size: 123456 }];
    assert.equal(await f.prepare((await f.cycle())[0]), true); assert.equal(f.fetches, 2);
  });
  await test('exact hash and pending operation are checked before metadata even with same-size off', async () => {
    const f = await fixture(); const row = (await f.cycle())[0]; await f.prepare(row); f.rss.skipSameTorrent = false;
    f.remoteHashes.add(row.hash); assert.equal(await f.prepare((await f.cycle())[0]), false); f.remoteHashes.clear();
    f.pending = [{ candidate_hash: 'other', true_hash: row.hash, payload: JSON.stringify({ torrent: { id: 999 } }) }];
    assert.equal(await f.prepare((await f.cycle())[0]), false); assert.equal(f.fetches, 1);
  });
  await test('terminal success history protects the canonical candidate without new metadata', async () => {
    const f = await fixture(); const row = (await f.cycle())[0]; await f.prepare(row);
    f.history = [{ id: 1, hash: row.hash, link: row.link, record_type: 1 }];
    assert.equal(await f.prepare((await f.cycle())[0]), false); assert.equal(f.fetches, 1);
  });
  await test('fresh promotion, HR, beforePrepare and physical capacity gates are never replaced by hints', async () => {
    const f = await fixture('HHCLUB'); await f.prepare((await f.cycle())[0]);
    f.rows[0].downloadFactor = 1; assert.equal((await f.cycle()).length, 0);
    f.rows[0].downloadFactor = 0; f.rows[0].hrState = 'required'; assert.equal((await f.cycle()).length, 0);
    f.rows[0].hrState = 'exempt'; f.allow = false; assert.equal(await f.prepare((await f.cycle())[0]), false);
    f.allow = true; f.client.maindata.freeSpaceOnDisk = 1; assert.equal(await f.prepare((await f.cycle())[0]), false); assert.equal(f.fetches, 1);
  });
  await test('MT cache only skips existing duplicates and never bypasses driver detail validation for an addition', async () => {
    const f = await fixture('MTEAM'); await f.prepare((await f.cycle())[0]);
    f.client.maindata.torrents = [{ size: 123456 }]; assert.equal(await f.prepare((await f.cycle())[0]), false);
    f.client.maindata.torrents = []; f.onPrepare = async () => { throw Object.assign(Error('free changed'), { code: 'MT_FREE_CHANGED' }); };
    await assert.rejects(() => f.cycle().then(rows => f.prepare(rows[0])), /free changed/); assert.equal(f.fetches, 2);
  });
  await test('failed response never enters identity cache and final rejection still retains validated identity', async () => {
    const f = await fixture(); f.invalid = true;
    await assert.rejects(() => f.cycle().then(rows => f.prepare(rows[0])), /PROVIDER_TORRENT_RESPONSE/);
    assert(!fs.existsSync(path.join(f.service.store.root, 'identity-CARPT.json')));
    f.invalid = false; f.finalAllow = false; assert.equal(await f.prepare((await f.cycle())[0]), false);
    f.client.maindata.torrents = [{ size: 123456 }]; assert.equal(await f.prepare((await f.cycle())[0]), false); assert.equal(f.fetches, 2);
  });
  await test('changed content or effective config invalidates identity instead of suppressing a new torrent', async () => {
    const f = await fixture(); await f.prepare((await f.cycle())[0]); f.client.maindata.torrents = [{ size: 123456 }];
    for (const field of ['name', 'size', 'pubTime', 'torrentId']) {
      f.rows[0][field] = typeof f.rows[0][field] === 'number' ? f.rows[0][field] + 1 : f.rows[0][field] + '1';
      assert.equal(await f.prepare((await f.cycle())[0]), true);
    }
    const saved = await f.service.store.read(f.rss.id); f.cfg.selection.minLeechers = 2;
    await f.service.store.apply(f.cfg, saved.revision, async () => {});
    assert.equal(await f.prepare((await f.cycle())[0]), true); assert.equal(f.fetches, 6);
  });
  await test('legacy 24-per-hour metadata cap is inert: 30 distinct candidates proceed without resetting counters', async () => {
    const f = await fixture(); const rows = await f.cycle();
    const file = path.join(f.service.store.root, 'budget-CARPT.json'); const budget = f.budget(); budget.metadata = 24; fs.writeFileSync(file, JSON.stringify(budget));
    f.unique = true; assert.equal(await f.prepare(rows[0]), true);
    f.rows = Array.from({ length: 29 }, (_, i) => ({ ...f.rows[0], torrentId: String(i + 100), candidateKey: 'CARPT:' + (i + 100) }));
    for (const row of await f.cycle()) assert.equal(await f.prepare(row), true);
    assert.equal(f.fetches, 30); assert.equal(f.budget().metadata, 54); assert.equal((await f.stats()).deferredUntil, 0);
    assert.equal(f.budget().list, 2);
  });
  await test('cached duplicate skips even above old metadata quota and is not counted as a request', async () => {
    const f = await fixture(); await f.prepare((await f.cycle())[0]); f.client.maindata.torrents = [{ size: 123456 }];
    const file = path.join(f.service.store.root, 'budget-CARPT.json'); const budget = f.budget(); budget.metadata = 24; fs.writeFileSync(file, JSON.stringify(budget));
    assert.equal(await f.prepare((await f.cycle())[0]), false); assert.equal(f.budget().metadata, 24); assert.equal(f.fetches, 1);
  });
  await test('simultaneous preparation of the same candidate shares one guarded operation', async () => {
    const f = await fixture(); const row = (await f.cycle())[0];
    assert.deepEqual(await Promise.all([f.prepare(row), f.prepare(row)]), [true, true]);
    assert.equal(f.fetches, 1); assert.equal(f.finals, 1); assert.equal(f.budget().metadata, 1);
  });
  await test('real 429 defers other candidates without spending counters or writing history', async () => {
    const f = await fixture(); f.rows.push({ ...f.rows[0], torrentId: '13', candidateKey: 'CARPT:13' });
    const rows = await f.cycle();
    f.onPrepare = () => { throw Object.assign(Error('fixture private message'), { code: 'PROVIDER_RATE_LIMIT', retryAfterSeconds: 900 }); };
    await assert.rejects(() => f.prepare(rows[0]), e => e.metadataScope === 'site');
    await assert.rejects(() => f.prepare(rows[1]), e => e.code === 'PROVIDER_METADATA_BACKOFF');
    assert.equal(f.fetches, 1); assert.equal(f.budget().metadata, 1); assert.equal(f.history.length, 0);
    assert.equal((await f.stats()).deferReason, 'rate-limit');
    f.onPrepare = null; f.advance(900000); assert.equal(await f.prepare((await f.cycle())[0]), true);
  });
  await test('repeated invalid metadata cools down only that candidate, then retries normally', async () => {
    const f = await fixture(); f.invalid = true;
    await assert.rejects(async () => f.prepare((await f.cycle())[0]), /PROVIDER_TORRENT_RESPONSE/);
    await assert.rejects(async () => f.prepare((await f.cycle())[0]), /PROVIDER_TORRENT_RESPONSE/);
    f.invalid = false;
    await assert.rejects(async () => f.prepare((await f.cycle())[0]), e => e.code === 'PROVIDER_METADATA_BACKOFF' && e.metadataScope === 'candidate');
    assert.equal(f.fetches, 2); f.advance(600000);
    assert.equal(await f.prepare((await f.cycle())[0]), true); assert.equal(f.fetches, 3);
  });
  await test('cache is bounded, expires, rejects future timestamps, and isolates profile/config/content', async () => {
    const store = new ProviderStore(path.join(work, 'bounded')); let clock = 1000000000;
    const cache = new ProviderIdentityCache(store, () => clock);
    const cfg = defaults('CARPT', '1234abcd'); const version = { config: cfg, digest: digest(cfg) };
    const row = { siteId: 'CARPT', torrentId: '12', candidateKey: 'CARPT:12', name: 'fixture', size: 12, pubTime: 100 };
    const identity = { hash: 'a'.repeat(40), size: 123456 };
    await cache.put(version, row, identity); assert.deepEqual(await cache.get(version, row), identity);
    clock--; assert.equal(await cache.get(version, row), null); clock += TTL + 1; assert.equal(await cache.get(version, row), null);
    const entries = Array.from({ length: LIMIT }, (_, i) => ({ key: String(i).padStart(64, '0'), ...identity, verifiedAt: clock - 1 }));
    fs.writeFileSync(cache.file('CARPT'), JSON.stringify({ version: 1, entries }));
    await cache.put(version, row, identity); assert.equal((await cache.read('CARPT')).length, LIMIT); assert.deepEqual(await cache.get(version, row), identity);
    assert.equal(await cache.get({ ...version, digest: 'changed' }, row), null);
    assert.equal(await cache.get({ ...version, config: { ...cfg, profile: 'HDFANS' } }, row), null);
    assert.equal(await cache.get(version, { ...row, torrentId: '13' }), null);
  });
  await test('invalid cache and failed atomic write fail closed and preserve previous binding', async () => {
    const store = new ProviderStore(path.join(work, 'corrupt')); const cache = new ProviderIdentityCache(store);
    const cfg = defaults('CARPT', '1234abcd'); const version = { config: cfg, digest: digest(cfg) }; const row = { torrentId: '12' }; const identity = { hash: 'a'.repeat(40), size: 123456 };
    await cache.put(version, row, identity); const file = cache.file('CARPT'); const bytes = fs.readFileSync(file, 'utf8');
    const rename = fs.promises.rename; fs.promises.rename = async () => { throw Error('fixture rename failure'); };
    try { await assert.rejects(() => cache.put(version, row, { ...identity, size: 42 }), /PROVIDER_IDENTITY_STORE/); } finally { fs.promises.rename = rename; }
    assert.equal(fs.readFileSync(file, 'utf8'), bytes); assert(!fs.readdirSync(store.root).some(f => f.endsWith('.tmp')));
    for (const bad of ['{', JSON.stringify({ version: 1, entries: [{ key: 'x' }] }), ' '.repeat(1024 * 1024 + 1)]) {
      fs.writeFileSync(file, bad); await assert.rejects(() => cache.get(version, row), /PROVIDER_IDENTITY_STORE/);
    }
  });
  process.stdout.write(JSON.stringify({ ok: true, tests: results.length, network: 'fixtures-only', production: false }) + '\n');
}
main().catch(e => { process.stderr.write(e.stack + '\n'); process.exitCode = 1; }).finally(() => {
  if (path.dirname(work) !== os.tmpdir() || !path.basename(work).startsWith('vertex-provider-admission-')) throw Error('unsafe fixture cleanup');
  fs.rmSync(work, { recursive: true, force: true });
});

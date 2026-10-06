'use strict';
// Local synthetic tests only. No NAS connection, file payload or real qB calls.
const assert = require('assert').strict; const path = require('path'); const Module = require('module'); const http = require('http'); const EventEmitter = require('events');
const native = path.join(__dirname, '../app/libs/content-groups');
const I = require(path.join(native, 'identity')); const E = require(path.join(native, 'reclaim'));
const realLoad = Module._load; const realGet = http.get;
let records = []; let logs = []; let calls = []; let rows = []; let state; let manifests = {}; let afterDelete; let infoHook; let trackerHook; let filesHook; let deleteNoOp = false;
Module._load = function (name, ...args) {
  if (name === './content-groups/reclaim') return E;
  if (name === '/app/vertex/app/libs/logger') return { info: (...x) => logs.push(x) };
  if (name === '/app/vertex/app/libs/util') return { runRecord: async (...x) => records.push(x) };
  return realLoad.call(this, name, ...args);
};
const bundle = require('fs').existsSync(path.join(__dirname, '../governance-bundle')) ? '../governance-bundle' : '../app/governance';
const P = require(bundle + '/vertex-lifecycle-policy'); const D = require(bundle + '/vertex-group-delete-guard'); const A = require(bundle + '/audit-vertex-lifecycle');
const now = Math.floor(Date.now() / 1000); const clientId = '3dfcd430'; let passed = 0;
function clone (x) { return JSON.parse(JSON.stringify(x)); }
function enc (x) {
  if (Number.isInteger(x)) return Buffer.from('i' + x + 'e');
  if (typeof x === 'string')x = Buffer.from(x);
  if (Buffer.isBuffer(x)) return Buffer.concat([Buffer.from(x.length + ':'), x]);
  if (Array.isArray(x)) return Buffer.concat([Buffer.from('l'), ...x.map(enc), Buffer.from('e')]);
  return Buffer.concat([Buffer.from('d'), ...Object.keys(x).sort().flatMap(k => [enc(k), enc(x[k])]), Buffer.from('e')]);
}
function task (salt, options = {}) {
  const file = options.file || 'a.bin'; const size = 4;
  const data = enc({ info: { name: 'content', files: [{ length: size, path: [file] }], 'piece length': 16, pieces: Buffer.alloc(20, options.piece || 1), private: salt } });
  const row = {
    hash: I.metadata(data).hash,
    name: 'content',
    content_path: '/downloads/content',
    save_path: '/downloads',
    size,
    total_size: size,
    progress: 1,
    category: 'HDFANS',
    tags: '',
    tracker: 'https://hdfans.org/announce',
    seeding_time: 0,
    uploaded: 0,
    downloaded: size,
    completion_on: now - 86400,
    added_on: now - 86400,
    state: 'stalledUP',
    num_leechs: 0,
    num_seeds: 0,
    upspeed: 0,
    dlspeed: 0,
    amount_left: 0
  };
  const files = [{ index: 0, name: 'content/' + file, size, priority: 1 }];
  return { row, files, proof: I.identity(data, row, files, clientId), checkedAt: now };
}
function snapshot (items, at = now) { return { schema: 1, clientId, at, cache: Object.fromEntries(items.map(i => [i.row.hash, clone(i)])) }; }
function fixture (items = [task(0), task(1)]) {
  rows = items.map(i => clone(i.row)); manifests = Object.fromEntries(items.map(i => [i.row.hash, clone(i.files)]));
  records = []; logs = []; calls = []; afterDelete = null; infoHook = null; trackerHook = null; filesHook = null; deleteNoOp = false;
  state = {
    version: 1,
    ok: true,
    time: now,
    allSiteEnabled: true,
    yieldPolicyRevision: 1,
    groupingMode: E.MODE,
    fenceReady: true,
    otherRootProtected: true,
    exactGroups: E.prepare(snapshot(items), rows, clientId, now),
    history: {},
    audits: {},
    exitFence: {},
    nearComplete: {}
  };
  for (const g of state.exactGroups.groups) {
    const counters = Object.fromEntries(g.members.map(h => [h, { up: 0, down: 4 }]));
    state.history[g.key] = { valid: true, last: now, up: 0, down: 0, counters, members: g.members, samples: [{ time: now - 10800, up: 0, down: 0, leechers: 0 }, { time: now - 7200, up: 0, down: 0, leechers: 0 }, { time: now - 1800, up: 0, down: 0, leechers: 0 }, { time: now, up: 0, down: 0, leechers: 0 }] };
    state.audits[g.key] = { ok: true, time: now, allocated: 4, members: g.members, trackers: Object.fromEntries(g.members.map(h => [h, ['hdfans.org']])), groupKey: g.key, groupRevision: g.revision };
    state.exitFence[g.key] = { last: now, status: 'pending', path: g.paths[0], members: g.members };
  }
  return {
    _client: { id: clientId },
    supportsConfirmedGroupHistory: true,
    clientUrl: 'http://127.0.0.1:8089',
    cookie: 'synthetic',
    deleteTorrent: async () => { calls.push('native'); return true; },
    client: {
      deleteTorrent: async (base, cookie, hash, deleteFiles) => {
        calls.push({ hash, deleteFiles }); if (deleteNoOp) return; rows = rows.filter(t => t.hash !== hash); if (afterDelete)afterDelete(hash);
      }
    },
    ntf: { deleteTorrent: async () => {} }
  };
}
http.get = (u, options, cb) => {
  const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = e => req.emit('error', e);
  queueMicrotask(() => {
    try {
      const res = new EventEmitter(); res.statusCode = 200; cb(res); let out;
      if (u.pathname.endsWith('/info')) { if (infoHook)infoHook(); out = clone(rows); } else if (u.pathname.endsWith('/files')) { const h = u.searchParams.get('hash'); out = filesHook ? filesHook(h) : clone(manifests[h]); } else if (u.pathname.endsWith('/trackers')) { const h = u.searchParams.get('hash'); out = trackerHook ? trackerHook(h) : [{ url: rows.find(t => t.hash === h).tracker }]; } else throw Error('Unexpected endpoint'); res.emit('data', JSON.stringify(out)); res.emit('end');
    } catch (e) { req.emit('error', e); }
  }); return req;
};
P.loadState = () => clone(state);
async function test (name, fn) { await fn(); passed++; console.log('PASS ' + name); }
const eligible = () => P.decision(rows, rows[0], state, now).allCleanup;
async function run () {
  await test('exact cross-site identity groups names independently of qB display labels', () => {
    fixture(); rows[1].name = 'renamed display label'; assert(eligible()); assert.equal(P.structural(rows, rows[0], now, state).group.length, 2);
  });
  await test('same directory different files are separate histories and protected scopes', () => {
    fixture([task(0), task(1, { file: 'b.bin' })]); assert.equal(state.exactGroups.groups.length, 2); assert(!eligible());
    const history = P.observe({}, rows, now, state); assert.equal(Object.keys(history).length, 2);
  });
  await test('same file names and lengths but different pieces never merge', () => {
    fixture([task(0), task(1, { piece: 2 })]); assert.equal(state.exactGroups.groups.length, 2); assert(!eligible());
  });
  await test('old path-keyed audit cannot grant exact-group permission', () => {
    fixture(); const g = state.exactGroups.groups[0]; state.audits = { [P.digest('/downloads/content')]: state.audits[g.key] }; assert(!eligible());
  });
  await test('missing exact evidence never falls back to path group', () => {
    fixture(); state.exactGroups = null; assert(!eligible()); assert(P.decision(rows, rows[0], state, now).reject);
  });
  await test('unknown overlapping reference blocks all members', () => {
    fixture(); rows.push({ ...rows[0], hash: 'f'.repeat(40) }); assert(!eligible());
  });
  await test('changed added-on binding and pending check protect group', () => {
    fixture(); rows[0].added_on++; assert(!eligible()); fixture(); rows[0].state = 'checkingUP'; assert(!eligible());
  });
  await test('out-of-date cache can observe known identity but never grants deletion', () => {
    const a = task(0); const b = task(1); a.checkedAt = now - 661; b.checkedAt = now - 661; fixture([a, b]);
    assert(!eligible()); assert.equal(Object.keys(P.observe({}, rows, now, state)).length, 1);
  });
  await test('stale snapshot and wrong client are refused before preparing groups', () => {
    const a = task(0); assert.throws(() => E.prepare(snapshot([a], now - 661), [a.row], clientId, now));
    assert.throws(() => E.prepare(snapshot([a]), [a.row], 'main', now));
  });
  await test('member revision resets history even when physical path stays unchanged', () => {
    const a = task(0); const b = task(1); fixture([a, b]); const old = clone(state.history);
    state.exactGroups = E.prepare(snapshot([a]), [a.row], clientId, now); rows = [a.row];
    const history = P.observe(old, rows, now, state); const h = Object.values(history)[0]; assert.equal(h.samples.length, 1); assert.equal(P.delta(h, 7200, now), null);
  });
  await test('legacy path history is not imported or treated as zero exposure', () => {
    fixture(); state.history = P.observe({ [P.digest('/downloads/content')]: Object.values(state.history)[0] }, rows, now, state);
    assert(!eligible()); assert.equal(Object.values(state.history)[0].samples.length, 1);
  });
  await test('H&R-bearing sibling protects entire group', () => {
    fixture(); const r = rows[1]; r.tracker = 'https://tracker.carpt.net/announce'; state.audits[state.exactGroups.groups[0].key].trackers[r.hash] = ['tracker.carpt.net']; assert(!eligible());
  });
  await test('productive sibling and live counter burst protect whole group', () => {
    fixture(); rows[1].upspeed = 200000; assert(!eligible()); fixture(); rows[1].uploaded = 128 * 1024 ** 2; assert(!eligible());
  });
  await test('unknown history is not zero and near-complete extra grace remains required', () => {
    fixture(); state.history = {}; assert(!eligible()); fixture(); rows[0].progress = 0.95; rows[0].state = 'downloading'; assert(!eligible());
  });
  await test('valid exact group drains references first and files once at the end', async () => {
    const c = fixture(); D.install(c); assert(await c.deleteTorrent(rows[0], { id: D.RID })); assert.deepEqual(calls.map(x => x.deleteFiles), [false, true]);
    assert.equal(records.filter(r => r[0].startsWith('update')).length, 2); assert.equal(records.filter(r => r[0].startsWith('insert')).length, 2);
  });
  await test('source removal does not create a separate IYUU group mid-batch', async () => {
    const c = fixture(); rows[1].category = ''; rows[1].tags = 'IYUU自动辅种'; D.install(c); assert(await c.deleteTorrent(rows[0], { id: D.RID })); assert.equal(rows.length, 0);
  });
  await test('natural future membership cannot use a persisted drain capability', () => {
    fixture(); const key = state.exactGroups.groups[0].key; const removed = rows[0]; rows = rows.slice(1);
    assert(!P.decision(rows, rows[0], state, now).allCleanup);
    const live = E.draining(state, key, [removed]); assert(P.decision(rows, rows[0], live, now).allCleanup);
    assert(!P.decision(rows, rows[0], clone(live), now).allCleanup);
  });
  await test('manifest rename after first removal blocks last files', async () => {
    const c = fixture(); D.install(c); afterDelete = () => { filesHook = h => manifests[h].map(f => ({ ...f, name: 'content/other.bin' })); };
    assert(!await c.deleteTorrent(rows[0], { id: D.RID })); assert.equal(calls.length, 1); assert(!calls[0].deleteFiles); assert.equal(c.codexGroupGuardStats.blockReasons.manifest_changed, 1);
  });
  await test('selective file priority change blocks first deletion', async () => {
    const c = fixture(); D.install(c); filesHook = h => manifests[h].map(f => ({ ...f, priority: 0 })); assert(!await c.deleteTorrent(rows[0], { id: D.RID })); assert.equal(calls.length, 0);
  });
  await test('same hash readded or new sibling mid-drain blocks final files', async () => {
    let c = fixture(); D.install(c); afterDelete = () => rows[0].added_on++; assert(!await c.deleteTorrent(rows[0], { id: D.RID })); assert.equal(calls.length, 1);
    c = fixture(); D.install(c); afterDelete = () => rows.push({ ...rows[0], hash: 'f'.repeat(40) }); assert(!await c.deleteTorrent(rows[0], { id: D.RID })); assert.equal(calls.length, 1);
  });
  await test('real tracker change mid-drain still blocks final files', async () => {
    const c = fixture(); D.install(c); afterDelete = () => { trackerHook = () => [{ url: 'https://tracker.carpt.net/announce' }]; };
    assert(!await c.deleteTorrent(rows[0], { id: D.RID })); assert.equal(calls.length, 1); assert.equal(c.codexGroupGuardStats.blockReasons.tracker_changed, 1);
  });
  await test('fence loss, revision mismatch and main-client protection loss stop final files', async () => {
    for (const mutate of [() => { state.exitFence = {}; }, () => { state.audits[state.exactGroups.groups[0].key].groupRevision = 'bad'; }, () => { state.otherRootProtected = false; }]) {
      const c = fixture(); D.install(c); afterDelete = mutate; assert(!await c.deleteTorrent(rows[0], { id: D.RID })); assert.equal(calls.length, 1); assert(!calls[0].deleteFiles);
    }
  });
  await test('upload recovery after original removal saves remaining reseed and files', async () => {
    const c = fixture(); D.install(c); afterDelete = () => { rows[0].uploaded = 128 * 1024 ** 2; }; assert(!await c.deleteTorrent(rows[0], { id: D.RID })); assert.equal(calls.length, 1);
  });
  await test('confirmed removed source upload still counts in batch aggregate yield', async () => {
    const c = fixture(); rows[0].uploaded = 70 * 1024 ** 2; D.install(c); afterDelete = () => { rows[0].uploaded = 70 * 1024 ** 2; };
    assert(!await c.deleteTorrent(rows[0], { id: D.RID })); assert.equal(calls.length, 1); assert(!calls[0].deleteFiles);
  });
  await test('unconfirmed qB deletion records no success and cannot reach last files', async () => {
    const c = fixture(); D.install(c); deleteNoOp = true; assert(!await c.deleteTorrent(rows[0], { id: D.RID })); assert.equal(records.length, 0); assert.equal(calls.length, 1);
  });
  await test('old native scheduler cannot activate exact drain', async () => {
    const c = fixture(); delete c.supportsConfirmedGroupHistory; D.install(c); assert(!await c.deleteTorrent(rows[0], { id: D.RID })); assert.equal(calls.length, 0);
  });
  await test('identity-keyed fence keeps existing IYUU path and member contract', () => {
    fixture(); const groups = P.groupEntries(rows, state, now); const f = A.buildFence(state, groups, {}); const key = groups[0].key;
    assert.equal(f[key].path, '/downloads/content'); assert.equal(f[key].members.length, 2);
    const hr = A.buildHrAdmission(state, rows, f); assert(hr.groups[P.digest('/downloads/content')].draining);
  });
  await test('migration does not falsely retire live path-keyed fence for 14 days', () => {
    fixture(); const k = P.digest('/downloads/content'); const old = { exitFence: { [k]: { last: now - 300, status: 'pending', path: '/downloads/content', members: rows.map(r => r.hash) } } };
    const f = A.buildFence(state, P.groupEntries(rows, state, now), old, rows); assert(!f[k]); assert.equal(Object.keys(f).length, 1);
  });
  console.log(JSON.stringify({ passed, productionRequests: 0, actualTaskMutations: 0 }));
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { Module._load = realLoad; http.get = realGet; });

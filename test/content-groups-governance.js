'use strict';
// Local synthetic tests only. No NAS connection, file payload or real qB calls.
const assert = require('assert').strict; const path = require('path'); const Module = require('module'); const http = require('http'); const EventEmitter = require('events');
const fs = require('fs'); const vm = require('vm');
const native = path.join(__dirname, '../app/libs/content-groups');
const I = require(path.join(native, 'identity')); const E = require(path.join(native, 'reclaim'));
const Q = require(path.join(native, 'incremental')); const G = require(path.join(native, 'index'));
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
  const file = options.file || 'a.bin'; const size = 4; const content = options.content || 'content';
  const data = enc({ info: { name: content, files: [{ length: size, path: [file] }], 'piece length': 16, pieces: Buffer.alloc(20, options.piece || 1), private: salt } });
  const row = {
    hash: I.metadata(data).hash,
    name: content,
    content_path: '/downloads/' + content,
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
  const files = [{ index: 0, name: content + '/' + file, size, priority: 1 }];
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
// Exercise the real sync/maindata adapter: qB puts the hash in the object key,
// not in its value. Do not manufacture originProp with an already copied hash.
async function normalized (source = rows) {
  const holder = { exports: {} }; const body = JSON.stringify({
    server_state: {},
    torrents: Object.fromEntries(source.map(({ hash, ...props }) => [hash, props]))
  });
  const sandbox = {
    module: holder,
    exports: holder.exports,
    require (key) {
      if (key === '../util') {
        return {
          requestPromise: async options => {
            assert.equal(options.url, 'http://fixture.invalid/api/v2/sync/maindata');
            return { body };
          }
        };
      }
      if (key === '../logger') return {};
      if (['url', 'fs'].includes(key)) return require(key);
      throw Error('Unexpected adapter dependency');
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/libs/client/qb.js'), 'utf8'), sandbox);
  const data = clone(await holder.exports.getMaindata('http://fixture.invalid', 'synthetic'));
  assert(data.torrents.every(t => t.hash && !Object.hasOwnProperty.call(t.originProp, 'hash')));
  return data.torrents;
}
function nativeClient (base, torrents, clock) {
  const holder = { exports: {} }; const sandbox = {
    module: holder,
    require (key) {
      if (key === 'fixture-policy') return P;
      if (key === 'fixture-clock') return clock;
      if (key === '../libs/util') return { sleep: async () => {}, runRecord: async (...args) => records.push(args) };
      if (key === '../libs/logger') return { info () {}, debug () {}, error (...args) { throw Error('Native rule error: ' + args.length); } };
      if (key === 'moment') return () => ({ unix: () => clock.seconds, format: () => 'fixture' });
      return {};
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/common/Client.js'), 'utf8'), sandbox);
  const rule = {
    id: D.RID,
    type: 'javascript',
    alias: 'fixture',
    fitTime: '600',
    deleteNum: 1,
    code: '(maindata,torrent)=>require("fixture-policy").decision(maindata.torrents,torrent,require("fixture-policy").loadState(),require("fixture-clock").seconds).allCleanup'
  };
  return Object.assign(Object.create(holder.exports.prototype), base, {
    maindata: { torrents },
    fitTime: { [D.RID]: {} },
    deleteRules: [rule],
    rejectDeleteRules: [],
    pausedTorrentHashes: [],
    reannounceTorrent: async () => {}
  });
}
async function run () {
  await test('expired evidence can nominate refresh but never fit or authorize deletion', () => {
    const items = [task(0), task(1)]; items.forEach(t => { t.checkedAt = now - 700; }); fixture(items);
    assert(P.refreshCandidate(rows, rows[0], state, now)); assert(!eligible());
    const hints = A.buildRefreshHints(state, {}, P.groupEntries(rows, state, now, true));
    assert.equal(hints.groups.length, 1); assert.equal(hints.groups[0].members.length, 2);
    assert.equal(state.exactGroups.groups[0].checkedAt, now - 700);
  });
  await test('refresh nomination retains HR yield references near-complete and missing history guards', () => {
    for (const mutate of [
      () => { rows[0].tracker = 'https://tracker.carpt.net/announce'; state.audits = {}; },
      () => { rows[0].uploaded = 128 * 1024 ** 2; },
      () => { rows[0].upspeed = 200000; },
      () => { rows[0].progress = 0.95; rows[0].state = 'downloading'; },
      () => { rows.push({ ...rows[0], hash: 'f'.repeat(40) }); },
      () => { rows[0].added_on++; },
      () => { state.history = {}; },
      () => { state.otherRootProtected = false; },
      () => { state.time -= 661; }
    ]) {
      const items = [task(0), task(1)]; items.forEach(t => { t.checkedAt = now - 700; }); fixture(items); mutate();
      assert(!P.refreshCandidate(rows, rows[0], state, now)); assert(!eligible());
    }
  });
  await test('same 32-request task budget sustains natural fit across 1563-task backlog', async () => {
    async function simulate (hintsEnabled) {
      const start = now - 1200; const items = [task(0), task(1)]; items.forEach(t => { t.checkedAt = start - 400; }); const base = fixture(items);
      const target = new Set(rows.map(r => r.hash)); const cache = snapshot(items, start).cache;
      for (let n = 1; n <= 1561; n++) {
        const r = { ...rows[0], hash: n.toString(16).padStart(40, '0'), content_path: '/downloads/other-' + n };
        rows.push(r); cache[r.hash] = { row: clone(r), checkedAt: start - 900 };
      }
      const previous = { cache, report: G.buildIndex(items, clientId), incremental: Q.plan(rows, { cache }, [], start, 32) };
      state.time = start;
      state.exactGroups = E.prepare({ schema: 1, clientId, at: start, cache }, rows, clientId, start);
      for (const h of Object.values(state.history)) {
        h.last = start - 300; h.samples = [];
        for (let time = start - 10800; time < start; time += 300) h.samples.push({ time, up: 0, down: 0, leechers: 0 });
      }
      for (const a of Object.values(state.audits)) a.time = start;
      let hints = A.buildRefreshHints(state, {}, P.groupEntries(rows, state, start, true));
      // Exercise the native rule on the complete target group; the planner and
      // observer above still receive the entire 1563-task pool each cycle.
      const clock = { seconds: start }; const live = await normalized(rows.filter(r => target.has(r.hash))); const c = nativeClient(base, live, clock); D.install(c);
      let normalReads = 0; let maxAge = 0;
      for (let time = start; time <= now; time += 30) {
        const plan = Q.plan(rows, previous, [], time, 32, hintsEnabled ? hints : null, clientId);
        assert(plan.selected.length <= 32);
        for (const r of plan.selected) { previous.cache[r.hash].checkedAt = time; delete plan.pending[r.hash]; if (!target.has(r.hash)) normalReads++; }
        previous.incremental = plan;
        if ((time - start) % 300 === 0) {
          const old = clone(state); state.time = time;
          state.exactGroups = E.prepare({ schema: 1, clientId, at: time, cache: previous.cache }, rows, clientId, time);
          state.history = P.observe(old.history, rows, time, state);
          state.audits = {}; state.exitFence = {};
          for (const g of state.exactGroups.groups) {
            if (!P.groupLowYield(rows, rows.find(r => r.hash === g.members[0]), state, time)) continue;
            state.audits[g.key] = {
              ...old.audits[g.key],
              ok: true,
              time,
              allocated: 4,
              members: g.members,
              trackers: Object.fromEntries(g.members.map(h => [h, ['hdfans.org']])),
              groupKey: g.key,
              groupRevision: g.revision
            };
            state.exitFence[g.key] = { last: time, status: 'pending', path: g.paths[0], members: g.members };
          }
          hints = A.buildRefreshHints(state, { ...old, refreshHints: hints }, P.groupEntries(rows, state, time, true).filter(g => P.refreshCandidate(rows, g.group[0], state, time)));
        }
        clock.seconds = time; c.flashFitTime(c.deleteRules[0]);
        maxAge = Math.max(maxAge, ...items.map(t => time - previous.cache[t.row.hash].checkedAt));
      }
      const fit = c.fitTime[D.RID][items[0].row.hash];
      if (hintsEnabled) {
        assert(normalReads >= 8 * 41); assert(maxAge <= 180, JSON.stringify({ maxAge, hints, fit, age: items.map(t => now - previous.cache[t.row.hash].checkedAt) })); assert(now - fit > 600);
        await c.autoDelete(); assert.equal(calls.length, 2); assert.deepEqual(calls.map(v => v.deleteFiles), [false, true]);
      } else { assert.equal(fit, undefined); assert.equal(calls.length, 0); assert(maxAge > 660); }
    }
    await simulate(false); await simulate(true);
  });
  await test('priority hints reject stale wrong-client changed-members and binding mismatches', () => {
    const items = [task(0), task(1)]; fixture(items);
    const previous = { cache: snapshot(items).cache, report: G.buildIndex(items, clientId) };
    const hint = A.buildRefreshHints(state, {}, P.groupEntries(rows, state, now));
    for (const mutate of [h => { h.time -= 661; }, h => { h.time++; }, h => { h.clientId = 'other'; },
      h => { h.groups[0].members.pop(); }, h => { h.groups[0].revision = 'bad'; },
      h => { h.groups[0].bindings[rows[0].hash].addedOn++; }]) {
      const bad = clone(hint); mutate(bad); assert.equal(Q.refreshGroups(bad, rows, previous, now, clientId).length, 0);
    }
    rows.push({ ...rows[0], hash: 'f'.repeat(40) }); assert.equal(Q.refreshGroups(hint, rows, previous, now, clientId).length, 0);
  });
  await test('failed member keeps backoff and oversized groups make bounded oldest-first progress', () => {
    const items = Array.from({ length: 40 }, (_, i) => task(i)); items.forEach(t => { t.checkedAt = now - 400; }); fixture(items);
    let previous = { cache: snapshot(items).cache, report: G.buildIndex(items, clientId) };
    const hint = A.buildRefreshHints(state, {}, P.groupEntries(rows, state, now));
    const a = Q.plan(rows, previous, [], now, 32, hint, clientId); assert.equal(a.selected.length, 32);
    const failed = a.selected[0].hash; a.pending[failed].due = now + 300;
    for (const r of a.selected.slice(1)) { previous.cache[r.hash].checkedAt = now; delete a.pending[r.hash]; }
    previous = { ...previous, incremental: a };
    const b = Q.plan(rows, previous, [], now + 30, 32, hint, clientId);
    assert(!b.selected.some(r => r.hash === failed));
    assert(rows.filter(r => !a.selected.includes(r)).every(r => b.selected.includes(r)));
    assert.equal(b.selected.length, 8); // Do not reread the 31 recently successful siblings.
  });
  await test('one-item budget alternates priority with ordinary work and malformed hints only lose priority', () => {
    const items = [task(0), task(1, { content: 'ordinary' })]; items.forEach(t => { t.checkedAt = now - 400; }); fixture(items);
    const previous = { cache: snapshot(items).cache, report: G.buildIndex(items, clientId) };
    const hint = A.buildRefreshHints(state, {}, P.groupEntries(rows, state, now)); hint.groups = hint.groups.slice(0, 1);
    const a = Q.plan(rows, previous, [], now, 1, hint, clientId);
    const b = Q.plan(rows, { ...previous, incremental: a }, [], now + 30, 1, hint, clientId);
    assert.notEqual(a.selected[0].hash, b.selected[0].hash); assert.equal(a.selected.length, 1); assert.equal(b.selected.length, 1);
    assert.equal(Q.refreshGroups({ ...hint, groups: [null, {}] }, rows, previous, now, clientId).length, 0);
  });
  await test('reclaim ordering uses audited allocation then alternate oldest, never nominal size or unsafe group', () => {
    fixture([task(0), task(1, { content: 'other' }), task(2, { content: 'unsafe' })]);
    const groups = state.exactGroups.groups;
    state.audits[groups[0].key].allocated = 10; state.audits[groups[1].key].allocated = 100; state.audits[groups[2].key].allocated = 10000;
    rows[0].size = 1000000; rows[2].upspeed = 200000;
    state.refreshHints = { groups: groups.map((g, i) => ({ key: g.key, since: now - 500 + i * 100 })) };
    assert.equal(D.orderCandidates(rows, state, now, 0)[0], rows[1]);
    assert.equal(D.orderCandidates(rows, state, now, 1)[0], rows[0]);
    assert.equal(D.orderCandidates(rows, state, now, 0)[2], rows[2]);
  });
  await test('audit exception details are classified without leaking raw messages', () => {
    assert.equal(A.auditFailure(Error('identity_manifest_changed')), 'identity_manifest_changed');
    assert.equal(A.auditFailure(Object.assign(Error('private path'), { code: 'ENOENT' })), 'ENOENT');
    assert.equal(A.auditFailure(Error('https://secret.invalid/?passkey=synthetic')), 'unclassified');
  });
  await test('post-check distinguishes task removal from absent files without claiming net GiB', () => {
    fixture(); const missing = () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }); };
    let checks = 0;
    const absent = A.verifyRetired(state, [], now, { lstatSync: () => { checks++; return missing(); } });
    assert.equal(absent.groupsAbsent, 1); assert.equal(absent.netReleasedBytes, null); assert(checks > 0);
    const present = A.verifyRetired(state, [], now, { lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true }) });
    assert.equal(present.groupsAbsent, 0); assert.equal(present.groupsStillPresent, 1);
    const noTaskExit = A.verifyRetired(state, rows, now, { lstatSync: () => { throw Error('must not read'); } });
    assert.equal(noTaskExit.checked, 0);
    const symlink = A.verifyRetired(state, [], now, { lstatSync: () => ({ isSymbolicLink: () => true }) });
    assert.equal(symlink.groupsAbsent, 0); assert.equal(symlink.checkErrors, 1);
    const again = A.verifyRetired({ ...state, reclamationVerification: absent }, [], now + 300, { lstatSync: missing });
    assert.equal(again.groupsAbsent, 1); assert.equal(again.checked, 0);
  });
  await test('post-check is bounded and still-present files cannot starve other retired groups', () => {
    const pending = Object.fromEntries(Array.from({ length: 7 }, (_, i) => ['g' + i, { paths: ['/downloads/x' + i], files: [['/downloads/x' + i, 4]], since: now - 100 }]));
    const present = { lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true }) };
    const a = A.verifyRetired({ reclamationVerification: { pending } }, [], now, present);
    assert.equal(a.checked, 4); assert.equal(a.groupsAbsent, 0);
    const b = A.verifyRetired({ reclamationVerification: a }, [], now + 300, present);
    assert.equal(b.checked, 4); assert(Object.values(b.pending).every(v => v.lastChecked > 0));
    fixture(); const protectedRows = [{ ...rows[0], hash: 'f'.repeat(40) }]; let calls = 0;
    const protectedResult = A.verifyRetired(state, protectedRows, now, { lstatSync: () => { calls++; } });
    assert.equal(protectedResult.groupsAbsent, 0); assert.equal(calls, 0);
  });
  await test('real qB adapter rows preserve exact grouping and preparation without input mutation', async () => {
    const items = [task(0), task(1)]; fixture(items); const live = await normalized(); const before = JSON.stringify(live);
    const exact = E.prepare(snapshot(items), live, clientId, now);
    assert.deepEqual(exact, state.exactGroups);
    const entry = E.structure(live, live[0], state, now);
    assert(entry.bound && entry.valid); assert.equal(entry.group.length, 2); assert(entry.group.every(t => live.includes(t)));
    assert(P.decision(live, live[0], state, now).allCleanup); assert.equal(JSON.stringify(live), before);
  });
  await test('one normalized task also binds rather than relying on duplicate-key rejection', async () => {
    fixture([task(0)]); const live = await normalized(); assert(E.structure(live, live[0], state, now).valid);
    assert(P.decision(live, live[0], state, now).allCleanup);
  });
  await test('raw normalized and guard-style matching-hash rows are equivalent', async () => {
    fixture(); const live = await normalized(); live[1].originProp.hash = live[1].hash;
    for (const input of [live, [rows[0], live[1]], rows]) {
      const entry = E.structure(input, input[0], state, now); assert(entry.valid);
      assert(E.validateManifest(entry, input[0], manifests[input[0].hash], clientId));
      assert(E.permit(entry, state.audits[entry.key]));
    }
  });
  await test('missing invalid conflicting and duplicate identities fail closed for the entire snapshot', async () => {
    const items = [task(0), task(1)]; fixture(items);
    const mutations = [
      live => { delete live[0].hash; },
      live => { live[0].hash = ''; },
      live => { live[0].hash = 'invalid'; },
      live => { live[0].originProp.hash = 'f'.repeat(40); },
      live => { live[0].originProp.hash = null; },
      live => { live[0].originProp.hash = ''; },
      live => { live[0].hash = live[1].hash; },
      live => { live[0].originProp = []; },
      live => { live[0].originProp = null; }
    ];
    for (const mutate of mutations) {
      const live = await normalized(); mutate(live);
      assert.equal(E.context(live, state, now).groups.length, 0);
      assert(!E.structure(live, live[1], state, now).valid);
      assert.throws(() => E.prepare(snapshot(items), live, clientId, now));
    }
  });
  await test('normalized identity conflict cannot validate a manifest or grant a drain capability', async () => {
    fixture(); const live = await normalized(); const entry = E.structure(live, live[0], state, now);
    const bad = clone(live[0]); bad.originProp.hash = 'f'.repeat(40);
    assert(!E.validateManifest(entry, bad, manifests[live[0].hash], clientId));
    assert(!E.structure(live, bad, state, now).valid);
    assert.throws(() => E.draining(state, entry.key, [bad]));
  });
  await test('normalized unknown sibling still protects the physical delete scope', async () => {
    fixture(); rows.push({ ...rows[0], hash: 'f'.repeat(40) }); const live = await normalized();
    assert(!E.structure(live, live[0], state, now).valid); assert(!P.decision(live, live[0], state, now).allCleanup);
  });
  await test('normalized readded path size and checking changes cannot inherit the old binding', async () => {
    for (const mutate of [r => r.added_on++, r => { r.save_path = '/elsewhere'; }, r => { r.content_path += '/changed'; }, r => r.total_size++, r => { r.state = 'checkingUP'; }]) {
      fixture(); mutate(rows[0]); const live = await normalized(); assert(!E.structure(live, live[0], state, now).valid);
    }
  });
  await test('normalized history and removed-member upload match raw evidence', async () => {
    fixture(); const live = await normalized();
    assert.deepEqual(P.observe(state.history, live, now + 300, state), P.observe(state.history, rows, now + 300, state));
    const key = state.exactGroups.groups[0].key; const rawDrain = E.draining(state, key, [rows[0]]); const normalizedDrain = E.draining(state, key, [live[0]]);
    assert.deepEqual(E.removedRows(normalizedDrain), E.removedRows(rawDrain));
    assert(P.decision(live.slice(1), live[1], normalizedDrain, now).allCleanup);
    assert(!P.decision(live.slice(1), live[1], clone(normalizedDrain), now).allCleanup);
  });
  await test('normalized rows preserve HR yield near-complete and stale-evidence protection', async () => {
    const mutations = [
      () => { rows[1].tracker = 'https://tracker.carpt.net/announce'; state.audits[state.exactGroups.groups[0].key].trackers[rows[1].hash] = ['tracker.carpt.net']; },
      () => { rows[1].upspeed = 200000; },
      () => { rows[1].uploaded = 128 * 1024 ** 2; },
      () => { rows[0].progress = 0.95; rows[0].state = 'downloading'; },
      () => { state.history = {}; },
      () => { state.time -= 661; },
      () => { state.fenceReady = false; },
      () => { state.exactGroups.groups[0].checkedAt -= 661; }
    ];
    for (const mutate of mutations) { fixture(); mutate(); const live = await normalized(); assert(!P.decision(live, live[0], state, now).allCleanup); }
  });
  await test('actual native fit timer and guard drain normalized inputs only after 600 seconds', async () => {
    const base = fixture(); const clock = { seconds: now }; const c = nativeClient(base, await normalized(), clock); D.install(c);
    const rule = c.deleteRules[0]; c.flashFitTime(rule);
    assert.equal(Object.keys(c.fitTime[D.RID]).length, 2);
    assert(Object.values(c.fitTime[D.RID]).every(t => t === now));
    await c.autoDelete(); assert.equal(calls.length, 0);
    clock.seconds = now + 600; c.flashFitTime(rule); await c.autoDelete(); assert.equal(calls.length, 0);
    clock.seconds++; await c.autoDelete(); assert.deepEqual(calls.map(x => x.deleteFiles), [false, true]);
    assert.equal(rows.length, 0); assert.equal(c.codexGroupGuardStats.groupsDeleted, 1);
    assert.equal(c.codexGroupGuardStats.filesDeleted, 1); assert.equal(c.codexGroupGuardStats.recordErrors, 0);
  });
  await test('native fit timer resets if normalized identity or live yield stops matching', async () => {
    for (const mutate of [t => { t.originProp.hash = 'f'.repeat(40); }, t => { t.uploaded = 128 * 1024 ** 2; }]) {
      const base = fixture(); const clock = { seconds: now }; const c = nativeClient(base, await normalized(), clock); const rule = c.deleteRules[0];
      c.flashFitTime(rule); assert.equal(Object.keys(c.fitTime[D.RID]).length, 2);
      mutate(c.maindata.torrents[0]); clock.seconds += 5; c.flashFitTime(rule); assert.equal(Object.keys(c.fitTime[D.RID]).length, 0);
      await c.autoDelete(); assert.equal(calls.length, 0);
    }
  });
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
  await test('identity availability cannot suppress existing promotion expiry stop-loss', () => {
    fixture(); rows = [{ ...rows[0], category: 'HHCLUB', progress: 0.5, state: 'downloading' }];
    state.exactGroups = null;
    assert(P.promotionSafetyPause(rows, rows[0], state, now, { until: now + 60 }));
    assert(!P.decision(rows, rows[0], state, now).allCleanup);
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

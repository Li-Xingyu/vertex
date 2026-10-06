const assert = require('assert').strict;
const crypto = require('crypto');
const L = require('../app/libs/content-groups/lineage-db');
const R = require('../app/libs/content-groups/reader');
const P = require('../app/libs/content-groups/incremental');
const G = require('../app/libs/content-groups');
let count = 0;
async function test (name, fn) { await fn(); count++; process.stdout.write('PASS ' + name + '\n'); }
function relation (target = '2', added = 100) {
  return {
    schema: 1,
    proofType: 'iyuu-v1-complete-readback',
    clientId: 'brush',
    verifiedAt: 200,
    contentId: 'b882dffb6e7e23354a760b937960418bd4b68a5f7d08e7201bce727ac386395a',
    manifestDigest: '0301176ad9f434f432186afd8eaac8b1ca2deeec2d22905a54ae8fdaa55b2812',
    members: ['1', target].map(h => ({
      clientId: 'brush',
      hash: h.repeat(40),
      addedOn: added,
      savePath: '/downloads',
      contentPath: '/downloads/fixture',
      size: 4
    }))
  };
}
function event (r, id = '1') {
  const raw = JSON.stringify(r);
  return { event_id: id, record_json: raw, record_sha256: crypto.createHash('sha256').update(raw).digest('hex') };
}
function fake (events = [], stream = 'a'.repeat(32)) {
  const calls = []; let destroyed = 0;
  return {
    calls,
    get destroyed () { return destroyed; },
    connect: async () => ({
      destroy: () => { destroyed++; },
      query: async (q, args) => {
        calls.push(q.sql);
        if (q.sql.includes('schema_version')) return [[{ schema_version: 1, stream_id: stream }]];
        if (q.sql.startsWith('SELECT record_sha256')) return [events.filter(e => e.event_id === args[1]).map(e => ({ record_sha256: e.record_sha256 }))];
        if (q.sql.startsWith('SELECT event_id')) return [events.filter(e => BigInt(e.event_id) > BigInt(args[1])).slice(0, L.PAGE_SIZE)];
        return [[]];
      }
    })
  };
}
function rows (r) {
  return r.members.map(b => ({
    hash: b.hash,
    added_on: b.addedOn,
    save_path: b.savePath,
    content_path: b.contentPath,
    total_size: b.size,
    amount_left: 0,
    uploaded: 1,
    downloaded: 4,
    state: 'stalledUP'
  }));
}
async function main () {
  await test('DB stream reads only explicit tables and prioritizes both members', async () => {
    const f = fake([event(relation())]); const out = await L.readEvents({}, 'brush', {}, f.connect);
    assert.equal(out.state.cursor, '1'); assert.equal(out.priority.length, 2); assert.equal(f.destroyed, 1);
    assert(f.calls.every(sql => /^(SELECT|START TRANSACTION READ ONLY|COMMIT)/.test(sql)));
    assert(!f.calls.some(sql => /cn_reseed|cn_sites|cn_client|GET_LOCK|INSERT|UPDATE|DELETE/.test(sql)));
    const next = await L.readEvents({}, 'brush', out.state, f.connect);
    assert.equal(next.report.received, 0); assert.equal(Object.keys(next.state.records).length, 1);
  });
  await test('uncommitted local cursor replays and idempotently merges', async () => {
    const f = fake([event(relation())]);
    const a = await L.readEvents({}, 'brush', {}, f.connect); const b = await L.readEvents({}, 'brush', {}, f.connect);
    assert.deepEqual(a.state, b.state);
  });
  await test('restored/truncated streams cannot silently skip or reset', async () => {
    const e = event(relation()); const old = (await L.readEvents({}, 'brush', {}, fake([e]).connect)).state;
    await assert.rejects(() => L.readEvents({}, 'brush', old, fake([], 'b'.repeat(32)).connect), /STREAM_CHANGED/);
    await assert.rejects(() => L.readEvents({}, 'brush', old, fake([]).connect), /CURSOR_LOST/);
    await assert.rejects(() => L.readEvents({}, 'brush', { ...old, token: 'bad' }, fake([e]).connect), /CURSOR_LOST/);
  });
  await test('bad payload, other client and digest mismatch reject entire page', async () => {
    const good = event(relation());
    for (const bad of [{ ...good, record_sha256: '0'.repeat(64) }, event({ ...relation(), clientId: 'main' }), event({ ...relation(), proofType: 'Success' })]) {
      const f = fake([bad]); await assert.rejects(() => L.readEvents({}, 'brush', {}, f.connect), /CG_LINEAGE_/); assert.equal(f.destroyed, 1);
    }
  });
  await test('large IDs stay exact; database failures reveal no credentials', async () => {
    const f = fake([event(relation(), '9007199254740993')]);
    assert.equal((await L.readEvents({}, 'brush', {}, f.connect)).state.cursor, '9007199254740993');
    await assert.rejects(() => L.readEvents({}, 'brush', {}, async () => { throw Error('password=secret-fixture'); }), e => e.message === 'CG_LINEAGE_UNAVAILABLE');
  });
  await test('historical baseline is not an in-app backfill job', () => {
    const tasks = rows(relation()); const a = P.plan(tasks, {}, [], 1000, 32);
    assert.equal(a.selected.length, 0);
    const added = rows(relation('3'))[1]; const b = P.plan([...tasks, added], { incremental: a }, [], 1030, 32);
    assert.deepEqual(b.selected.map(r => r.hash), [added.hash]);
    const moved = { ...tasks[0], added_on: 101 };
    assert.equal(P.plan([moved, tasks[1]], { incremental: a }, [], 1030, 32).selected[0].hash, moved.hash);
  });
  await test('DB relation targets join same cycle without export or original-first order', async () => {
    const r = relation(); const t = rows(r); const f = fake([event(r)]); const ev = await L.readEvents({}, 'brush', {}, f.connect);
    const indexed = L.byMember(ev.state); const calls = [];
    const s = await R.collect({ clientId: 'brush', roots: ['/downloads'], maxTasks: 32, incremental: true, priorityHashes: ev.priority }, async (action) => {
      calls.push(action); if (action === 'info') return t;
      if (action === 'files') return [{ index: 0, name: 'fixture/a.bin', size: 4, priority: 1 }];
      throw Error('must_not_export');
    }, {}, async h => indexed.get(h));
    assert.equal(s.report.lineageHits, 2); assert.equal(s.report.summary.multiReferenceGroups, 1); assert(!calls.includes('export'));
    assert.equal(s.report.safety.deleteAuthorized, false); assert.equal(s.report.incremental.pending, 0);
    const next = await R.collect({ clientId: 'brush', roots: ['/downloads'], incremental: true }, async action => {
      assert.equal(action, 'info'); return t;
    }, s);
    assert.equal(next.report.selected, 0);
    const idx = G.buildIndex(t.map(row => ({ row, files: s.cache[row.hash].files, proof: s.cache[row.hash].proof })), 'brush');
    let hist = G.observe({}, t.map(row => ({ row })), idx, 1000);
    for (let n = 1030; n <= 1270; n += 30) hist = G.observe(hist, t.map(row => ({ row })), idx, n);
    assert.equal(Object.values(hist)[0].samples.length, 1);
  });
  await test('small batch defers second member durably and failed reads back off', async () => {
    const t = rows(relation()); const a = P.plan(t, {}, t.map(r => r.hash), 1000, 1);
    assert.equal(a.selected.length, 1); assert.equal(Object.keys(a.pending).length, 2);
    a.pending[t[0].hash].due = 1300;
    assert.equal(P.plan(t, { incremental: a }, [], 1030, 1).selected[0].hash, t[1].hash);
    const b = P.plan([t[1]], { incremental: a }, [], 1030, 1); assert.equal(Object.keys(b.pending).length, 1);
  });
  process.stdout.write(JSON.stringify({ passed: count, productionRequests: 0, mutations: 0 }) + '\n');
}
if (require.main === module) main().catch(e => { process.stderr.write(e.stack + '\n'); process.exitCode = 1; });
module.exports = { relation, event, rows };

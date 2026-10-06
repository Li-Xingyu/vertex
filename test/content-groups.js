const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');
const I = require('../app/libs/content-groups/identity');
const G = require('../app/libs/content-groups');
const R = require('../app/libs/content-groups/reader');
const { auditGroup } = require('../app/libs/content-groups/file-audit');
const { ContentGroupShadow } = require('../app/libs/content-groups/service');
let count = 0;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vertex-content-groups-'));
async function test (name, fn) { await fn(); count++; process.stdout.write('PASS ' + name + '\n'); }
function enc (x) {
  if (Number.isInteger(x)) return Buffer.from('i' + x + 'e');
  if (typeof x === 'string') x = Buffer.from(x);
  if (Buffer.isBuffer(x)) return Buffer.concat([Buffer.from(x.length + ':'), x]);
  if (Array.isArray(x)) return Buffer.concat([Buffer.from('l'), ...x.map(enc), Buffer.from('e')]);
  return Buffer.concat([Buffer.from('d'), ...Object.keys(x).sort().flatMap(k => [enc(k), enc(x[k])]), Buffer.from('e')]);
}
function fixture (salt = 0, file = 'a.bin', options = {}) {
  const info = {
    name: 'fixture',
    files: [{ length: 4, path: [file] }],
    'piece length': 16,
    pieces: crypto.createHash('sha1').update(options.payload || 'test').digest(),
    private: salt
  };
  const data = enc({ announce: 'http://fixture.invalid/private-credential-must-not-be-retained', info });
  const row = {
    hash: I.metadata(data).hash,
    added_on: 100,
    total_size: 4,
    save_path: options.save || '/downloads',
    content_path: (options.save || '/downloads') + '/fixture',
    amount_left: options.left === undefined ? 0 : options.left,
    uploaded: 10,
    downloaded: 4,
    state: 'stalledUP'
  };
  const files = [{ index: 0, name: 'fixture/' + file, size: 4, priority: 1 }];
  return { data, row, files, proof: I.identity(data, row, files, 'brush') };
}
async function fakeCollect (fixtures, previous, config = {}, lineages = {}) {
  const counts = { info: 0, files: 0, export: 0 };
  const get = async (action, hash) => {
    counts[action]++;
    if (action === 'info') return fixtures.map(t => t.row);
    const t = fixtures.find(t => t.row.hash === hash);
    return action === 'files' ? t.files : t.data;
  };
  const state = await R.collect({ clientId: 'brush', roots: ['/downloads'], maxTasks: 32, ...config }, get, previous, async h => lineages[h]);
  return { state, counts };
}

async function main () {
  await test('cross-site raw hashes differ but exact v1 content identity matches', () => {
    const a = fixture(0); const b = fixture(1);
    assert.notEqual(a.row.hash, b.row.hash); assert.equal(a.proof.contentId, b.proof.contentId);
    // Golden vector shared with the PHP writer; canonical serialization must not
    // vary between runtimes, or valid IYUU proofs would silently miss the cache.
    assert.equal(a.proof.contentId, 'b882dffb6e7e23354a760b937960418bd4b68a5f7d08e7201bce727ac386395a');
    assert.equal(a.proof.manifestDigest, '0301176ad9f434f432186afd8eaac8b1ca2deeec2d22905a54ae8fdaa55b2812');
    assert(!JSON.stringify(a.proof).includes('private-credential'));
  });
  await test('strict identity rejects wrong hash, length, piece count, selection and rename', () => {
    const a = fixture();
    assert.throws(() => I.identity(a.data, { ...a.row, hash: 'a'.repeat(40) }, a.files, 'brush'));
    assert.throws(() => I.identity(a.data, { ...a.row, total_size: 5 }, a.files, 'brush'));
    assert.throws(() => I.identity(a.data, a.row, [{ ...a.files[0], name: 'fixture/b.bin' }], 'brush'));
    assert.throws(() => I.identity(a.data, a.row, [{ ...a.files[0], priority: 0 }], 'brush'));
    assert.throws(() => I.metadata(enc({ info: { name: 'x', length: 2, 'piece length': 1, pieces: Buffer.alloc(20) } })));
  });
  await test('malformed bencode, unsafe names, v2 and padding fail closed', () => {
    for (const b of ['d4:infod1:ai01eee', 'd4:infod1:ai1e1:ai2eee', 'd4:infoi0ee', 'd4:infoleeextra']) assert.throws(() => I.metadata(Buffer.from(b)));
    for (const name of ['../a', '.', 'a\\b', '\u0000', '']) assert.throws(() => I.metadata(enc({ info: { name, length: 4, 'piece length': 16, pieces: Buffer.alloc(20) } })));
    assert.throws(() => I.metadata(enc({ info: { 'meta version': 2 } })));
    assert.throws(() => I.metadata(enc({ info: { name: 'x', files: [{ length: 4, path: ['p'], attr: 'p' }] } })));
  });
  await test('same content and storage form one group; no deletion authorization', () => {
    const g = G.buildIndex([fixture(0), fixture(1)], 'brush');
    assert.equal(g.groups.length, 1); assert.equal(g.groups[0].members.length, 2);
    assert.equal(g.deleteAuthorized, false); assert.deepEqual(g.groups[0].reasons, []);
  });
  await test('same directory different files split, protected deletion scopes', () => {
    const g = G.buildIndex([fixture(0), fixture(1, 'b.bin')], 'brush');
    assert.equal(g.groups.length, 2); assert.equal(g.summary.pathBucketsSplit, 1);
    assert(g.groups.every(g => g.reasons.includes('external_delete_scope')));
  });
  await test('same files different piece hashes never merge', () => {
    const g = G.buildIndex([fixture(0), fixture(1, 'a.bin', { payload: 'else' })], 'brush');
    assert.equal(g.groups.length, 2); assert(g.groups.every(g => g.reasons.includes('external_file_reference')));
  });
  await test('same content in different physical copies remains separate', () => {
    const g = G.buildIndex([fixture(0), fixture(1, 'a.bin', { save: '/copy' })], 'brush');
    assert.equal(g.groups.length, 2); assert(g.groups.every(g => !g.reasons.length));
  });
  await test('unknown overlapping references protect a verified group', () => {
    const a = fixture(0); const b = fixture(1); b.proof = null; b.files = null;
    const g = G.buildIndex([a, b], 'brush'); assert.equal(g.groups.length, 2);
    assert(g.groups[0].reasons.includes('external_delete_scope'));
  });
  await test('readded, moved, renamed and checking tasks invalidate current proof', () => {
    const a = fixture();
    for (const row of [{ ...a.row, added_on: 101 }, { ...a.row, save_path: '/else' }, { ...a.row, state: 'checkingUP' }]) assert.equal(I.current(a.proof, row, a.files, 'brush'), false);
    assert.equal(I.current(a.proof, a.row, [{ ...a.files[0], name: 'fixture/renamed' }], 'brush'), false);
    assert.equal(I.current(a.proof, a.row, a.files, 'main'), false);
  });
  await test('source removal preserves content group ID but resets member revision', () => {
    const a = fixture(0); const b = fixture(1);
    const both = G.buildIndex([a, b], 'brush'); const one = G.buildIndex([b], 'brush');
    assert.equal(both.groups[0].id, one.groups[0].id); assert.notEqual(both.groups[0].revision, one.groups[0].revision);
  });
  await test('remaining bytes dedup proven copies only, including paused tasks', () => {
    const a = fixture(0, 'a.bin', { left: 4 }); const b = fixture(1, 'a.bin', { left: 2 });
    assert.equal(G.reservation([a, b], G.buildIndex([a, b], 'brush')).bytes, 4);
    const c = fixture(2, 'b.bin', { left: 3 }); c.row.state = 'pausedDL';
    assert.equal(G.reservation([a, b, c], G.buildIndex([a, b, c], 'brush'), 5).bytes, 12);
    b.proof = null; assert.equal(G.reservation([a, b], G.buildIndex([a, b], 'brush')).bytes, 6);
  });
  await test('unknown remaining amount is conservative, never NaN or zero', () => {
    const a = fixture(); delete a.row.amount_left;
    const r = G.reservation([a], G.buildIndex([a], 'brush')); assert.equal(r.bytes, 4); assert.equal(r.uncertain, 1);
    delete a.row.total_size; a.proof = null; assert.equal(G.reservation([a], G.buildIndex([a], 'brush')).bytes, null);
  });
  await test('history resets on gaps, per-reference counter reset and membership changes', () => {
    const a = fixture(0); const b = fixture(1); const tasks = [a, b]; const idx = G.buildIndex(tasks, 'brush'); const id = idx.groups[0].id;
    const old = G.observe({}, tasks, idx, 1000); a.row.uploaded++;
    const next = G.observe(old, tasks, idx, 1300); assert.equal(next[id].samples.length, 2);
    a.row.uploaded = 0; b.row.uploaded = 1000;
    assert.equal(G.observe(next, tasks, idx, 1600)[id].samples.length, 1);
    assert.equal(G.observe(old, tasks, idx, 2000)[id].samples.length, 1);
    assert.equal(G.observe(old, [b], G.buildIndex([b], 'brush'), 1100)[id].samples.length, 1);
  });
  await test('collector cache avoids repeat metadata export but rechecks manifests', async () => {
    const tasks = [fixture(0), fixture(1)]; const first = await fakeCollect(tasks);
    assert.equal(first.counts.export, 2); const second = await fakeCollect(tasks, first.state);
    assert.equal(second.counts.export, 0); assert.equal(second.counts.files, 2); assert.equal(second.state.report.summary.groups, 1);
    tasks[0].files[0].name = 'fixture/renamed'; const third = await fakeCollect(tasks, second.state);
    assert.equal(third.state.report.summary.unproved, 1);
  });
  await test('bounded round robin does not starve unknown tasks', async () => {
    const tasks = [fixture(0), fixture(1), fixture(2)]; let state; let cacheCount = 0;
    for (let i = 0; i < 3; i++) { state = (await fakeCollect(tasks, state, { maxTasks: 1 })).state; assert(Object.keys(state.cache).length > cacheCount); cacheCount++; }
    assert.equal(cacheCount, 3);
  });
  await test('work budget reserves readback and reports partial coverage, not false completeness', async () => {
    const result = await fakeCollect([fixture()], undefined, { workDeadline: Date.now() - 1 });
    assert.equal(result.counts.info, 2); assert.equal(result.counts.files, 0);
    assert.equal(result.state.report.selected, 0); assert.equal(result.state.report.summary.unproved, 1);
  });
  await test('readback detects task instance change during metadata observation', async () => {
    const a = fixture(); let infos = 0;
    const state = await R.collect({ clientId: 'brush', roots: ['/downloads'] }, async action => {
      if (action === 'info') return [{ ...a.row, added_on: ++infos === 1 ? 100 : 101 }];
      return action === 'files' ? a.files : a.data;
    });
    assert.equal(state.report.summary.proved, 0); assert.equal(Object.keys(state.cache).length, 0);
  });
  await test('expired manifest cache remains protected without repeated cold exports', async () => {
    const tasks = [fixture(0), fixture(1)]; const initial = (await fakeCollect(tasks)).state;
    for (const item of Object.values(initial.cache)) item.checkedAt -= 3600;
    const next = await fakeCollect(tasks, initial, { maxTasks: 1 });
    assert.equal(Object.keys(next.state.cache).length, 2); assert.equal(next.counts.export, 0);
    assert.equal(next.state.report.summary.groups, 1);
    assert(next.state.report.groups[0].reasons.includes('stale_manifest'));
  });
  await test('IYUU proof requires matching current instance and manifest digest', async () => {
    const a = fixture(0); const b = fixture(1);
    const record = {
      schema: 1,
      clientId: 'brush',
      verifiedAt: 200,
      contentId: a.proof.contentId,
      manifestDigest: a.proof.manifestDigest,
      members: [a.proof.binding, b.proof.binding]
    };
    assert(R.lineageProof(record, b.row, b.files, 'brush', 300));
    assert.equal(R.lineageProof({ ...record, manifestDigest: null }, b.row, b.files, 'brush', 300), null);
    assert.equal(R.lineageProof(record, { ...b.row, added_on: 201 }, b.files, 'brush', 300), null);
    const { state, counts } = await fakeCollect([b], undefined, {}, { [b.row.hash]: record });
    assert.equal(counts.export, 0); assert.equal(state.report.lineageHits, 1);
  });
  await test('file audit detects extra files, missing files, hardlinks and bounded traversal', async () => {
    const root = path.join(work, 'payload'); fs.mkdirSync(path.join(root, 'fixture'), { recursive: true });
    const file = path.join(root, 'fixture/a.bin'); fs.writeFileSync(file, 'test');
    const group = G.buildIndex([fixture()], 'brush').groups[0]; const mappings = [{ qbitRoot: '/downloads', localRoot: root }];
    assert.equal((await auditGroup(group, mappings)).ok, true);
    assert.equal((await auditGroup(group, mappings, { maxEntries: 1 })).ok, false);
    const extra = path.join(root, 'fixture/extra'); fs.writeFileSync(extra, 'x');
    assert.equal((await auditGroup(group, mappings)).code, 'CG_UNMANAGED_OR_OVERSIZE_FILE'); fs.unlinkSync(extra);
    fs.linkSync(file, extra); assert.equal((await auditGroup(group, mappings)).code, 'CG_FILE_HARDLINK'); fs.unlinkSync(extra);
    fs.unlinkSync(file); assert.equal((await auditGroup(group, mappings)).code, 'CG_FILE_MISSING');
  });
  await test('file audit refuses symlink parents and ambiguous mappings', async () => {
    const root = path.join(work, 'target'); fs.mkdirSync(root);
    const link = path.join(work, 'link'); fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
    const group = G.buildIndex([fixture()], 'brush').groups[0];
    assert.equal((await auditGroup(group, [{ qbitRoot: '/downloads', localRoot: link }])).code, 'CG_FILE_SYMLINK');
    assert.equal((await auditGroup(group, [{ qbitRoot: '/downloads', localRoot: root }, { qbitRoot: '/downloads', localRoot: root }])).code, 'CG_FILE_MAPPING');
  });
  await test('worker ownership prevents overlap and close suppresses late success', async () => {
    class FakeWorker extends EventEmitter { terminate () { this.terminating = true; return Promise.resolve(); } }
    const c = { id: 'brush', _client: { type: 'qBittorrent' }, cookie: 'fixture-only', clientUrl: 'http://fixture.invalid' };
    const service = new ContentGroupShadow(c, { mode: 'shadow', roots: ['/downloads'] }, { Worker: FakeWorker });
    assert(service.tick()); assert.equal(service.tick(), false); const w = service.worker;
    await service.close();
    const replacement = new ContentGroupShadow(c, { mode: 'shadow', roots: ['/downloads'] }, { Worker: FakeWorker });
    assert.equal(replacement.tick(), false); await replacement.close();
    w.emit('message', { ok: true }); assert.equal(service.latest.ready, false);
    assert.equal(service.tick(), false); w.emit('exit', 0); assert.equal(service.worker, null);
    assert.throws(() => new ContentGroupShadow(c, { mode: 'active', roots: ['/downloads'] }));
  });
  await test('real worker is GET-only, stores no cookies or torrent metadata, stays shadow', async () => {
    const a = fixture(); const calls = [];
    const server = http.createServer((req, res) => {
      calls.push([req.method, new URL(req.url, 'http://localhost').pathname]);
      const action = req.url.split('?')[0].split('/').pop();
      res.end(action === 'export' ? a.data : JSON.stringify(action === 'info' ? [a.row] : a.files));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const connection = { url: 'http://127.0.0.1:' + server.address().port, cookie: 'NEVER-PERSIST-THIS' };
      const get = R.qbitReader(connection, { calls: 0, maxCalls: 1, deadline: Date.now() + 1000 });
      await assert.rejects(() => get('delete'), /CG_ACTION/);
      const stateFile = path.join(work, 'state/brush-shadow.json');
      const result = await new Promise((resolve, reject) => {
        const w = new Worker(path.join(__dirname, '../app/libs/content-groups/worker.js'), {
          workerData: {
            mode: 'shadow', clientId: 'brush', roots: ['/downloads'], maxTasks: 2, timeoutMs: 10000, connection, stateFile
          }
        });
        const timeout = setTimeout(() => { w.terminate(); reject(Error('test_timeout')); }, 12000);
        w.on('message', m => { clearTimeout(timeout); resolve(m); }); w.on('error', reject);
      });
      assert.equal(result.ok, true); assert.equal(result.deleteAuthorized, false);
      assert(calls.every(([method, url]) => method === 'GET' && /^\/api\/v2\/torrents\/(info|files|export)$/.test(url)));
      const state = fs.readFileSync(stateFile, 'utf8');
      assert(!state.includes('NEVER-PERSIST-THIS')); assert(!state.includes('private-credential')); assert(!state.includes(connection.url));
      assert.equal(JSON.parse(state).report.externalClients, 'not_checked');
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
  process.stdout.write(JSON.stringify({ passed: count, productionRequests: 0, taskMutations: 0 }) + '\n');
}
main().catch(e => { process.stderr.write(e.stack + '\n'); process.exitCode = 1; }).finally(() => {
  // This exact directory was created above and contains synthetic fixtures only.
  fs.rmSync(work, { recursive: true, force: true });
});

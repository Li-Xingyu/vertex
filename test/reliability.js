/* eslint-disable no-unused-vars */
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');
const { DatabaseQueue } = require('../app/libs/database');
const root = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vertex-db-tests-'));
let sequence = 0;
const results = [];
const fixtures = new Set();

async function test (name, fn) {
  await fn();
  results.push(name);
  process.stdout.write('PASS ' + name + '\n');
}

function makeDatabase (options = {}) {
  const filename = path.join(work, 'case-' + ++sequence + '.db');
  const imageTemplate = path.join(root, 'app/config_backup/sql.db');
  fs.copyFileSync(fs.existsSync(imageTemplate) ? imageTemplate : path.join(root, 'app/config/sql.db'), filename);
  const queue = new DatabaseQueue({ filename, ...options });
  fixtures.add(queue);
  return queue;
}

function loader (filename, dependencies, running) {
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    Buffer,
    Date,
    require (key) { return Object.prototype.hasOwnProperty.call(dependencies, key) ? dependencies[key] : require(key); },
    global: { runningClient: running },
    __dirname: path.dirname(filename)
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return module.exports;
}

async function scenario (options = {}) {
  const queue = makeDatabase();
  let clock = Math.floor(Date.now() / 1000);
  const writes = []; const posted = []; const errors = []; const warnings = []; const notices = []; const tasks = new Set();
  const running = {};
  let finishFailures = options.finishFailures || 0;
  let lookupFailures = options.lookupFailures || 0;
  const util = {
    async getRecord (sql, params, scheduling) {
      if (lookupFailures && /FROM torrents WHERE hash = \? AND rss_id/i.test(sql)) {
        lookupFailures--;
        throw Object.assign(new Error('synthetic busy'), { code: 'SQLITE_BUSY' });
      }
      return queue.request('get', sql, params, scheduling);
    },
    getRecords: (sql, params, scheduling) => queue.request('all', sql, params, scheduling),
    runRecord (sql, params, scheduling) {
      writes.push(sql);
      return queue.request('run', sql, params, scheduling);
    },
    runRecords (operations, scheduling) {
      if (finishFailures && operations.some(x => /DELETE FROM vertex_rss_pending/.test(x.sql))) {
        finishFailures--;
        return Promise.reject(Object.assign(new Error('synthetic busy'), { code: 'SQLITE_BUSY' }));
      }
      writes.push(...operations.map(x => x.sql));
      return queue.request('batch', null, operations, scheduling);
    },
    uuid: { v4: () => 'synthetic' },
    listPush: () => [],
    listRssRule: () => [],
    calSize: () => 0,
    formatSize: value => String(value)
  };
  const logger = {
    info () {},
    debug () {},
    warn (...args) { warnings.push(args.join(' ')); },
    error (...args) { errors.push(args.map(String).join(' ')); }
  };
  const moment = () => ({
    unix: () => clock,
    startOf () { return this; },
    subtract () { return { unix: () => clock - 300 }; }
  });
  const redis = { async get () { return 1; }, async set () {} };
  const admission = loader(path.join(root, 'app/libs/rss-admission.js'), { './util': util, './provider-opportunity': require('../app/libs/provider-opportunity') }, running);
  const dependencies = {
    '../libs/util': util,
    '../libs/logger': logger,
    '../libs/redis': redis,
    '../libs/rss-admission': admission,
    '../libs/torrent-providers': options.provider || { begin: async () => null, metadata: () => null, finalCheck: async () => {} },
    '../libs/rss': {},
    '../libs/client/qb': {},
    '../libs/client/de': {},
    '../libs/client/tr': {},
    'node-cron': {},
    bencode: {},
    moment,
    './Push': {}
  };
  const Client = loader(path.join(root, 'app/common/Client.js'), dependencies, running);
  const Rss = loader(path.join(root, 'app/common/Rss.js'), dependencies, running);
  const client = Object.assign(Object.create(Client.prototype), {
    id: 'fake',
    alias: 'synthetic-qB',
    status: true,
    _client: { type: 'qBittorrent' },
    maindata: { torrents: [], leechingCount: 0, freeSpaceOnDisk: 1000000000000 },
    avgUploadSpeed: 0,
    avgDownloadSpeed: 0,
    client: {
      async addTorrent (url, cookie, torrentUrl) {
        const hash = torrentUrl.split('/').pop();
        posted.push(hash);
        if (!options.delayedConfirmation) tasks.add(hash);
        if (options.httpOutcomeUnknown) throw Object.assign(new Error('synthetic transport'), { code: 'ECONNRESET' });
        return { statusCode: options.statusCode || 200 };
      },
      async addTorrentByTorrentFile (url, cookie, filepath) {
        const hash = path.basename(filepath, '.torrent');
        posted.push(hash);
        if (!options.delayedConfirmation) tasks.add(hash);
        if (options.httpOutcomeUnknown) throw Object.assign(new Error('synthetic transport'), { code: 'ECONNRESET' });
        return { statusCode: options.statusCode || 200 };
      },
      async hasTorrent (url, cookie, hash) { return tasks.has(hash); }
    },
    async login () {}
  });
  running.fake = client;
  const makeRss = (id = 'synthetic-rss', skipSameTorrent = false) => Object.assign(Object.create(Rss.prototype), {
    id,
    alias: id,
    clientArr: ['fake'],
    clientSortBy: 'freeSpaceOnDisk',
    acceptRules: [],
    rejectRules: [],
    addCount: 0,
    addCountPerHour: 0,
    countHour: Math.floor(Date.now() / 3600000),
    lastRssTime: clock,
    maxSleepTime: 3600,
    skipSameTorrent,
    async _downloadTorrent (url) {
      const hash = options.actualHash || url.split('/').pop();
      return { hash, filepath: '/tmp/' + hash + '.torrent' };
    },
    ntf: {
      async addTorrent () { notices.push('success'); },
      async addTorrentError () { notices.push('failure'); },
      async rejectTorrent () { notices.push('reject'); }
    }
  });
  return {
    queue,
    util,
    client,
    makeRss,
    admission,
    tasks,
    posted,
    errors,
    warnings,
    notices,
    writes,
    advance: seconds => { clock += seconds; },
    now: () => clock
  };
}

const torrent = (n, size = n * 1024) => {
  const hash = String(n).padStart(40, '0');
  return {
    hash,
    size,
    name: 'synthetic-' + n,
    url: 'https://example.invalid/' + hash,
    link: 'https://example.invalid/details/' + n,
    pubTime: Math.floor(Date.now() / 1000)
  };
};

async function main () {
  await test('entry fact column is additive and initialized idempotently; success facts survive exit', async () => {
    const s = await scenario(); const q = s.queue;
    const columns = await q.request('all', 'PRAGMA table_info(torrents)');
    assert.equal(columns.filter(c => c.name === 'admission_snapshot').length, 1);
    const rss = s.makeRss('1234abcd'); const torrent = {
      hash: 'a'.repeat(40),
      name: 'fixture',
      size: 100,
      link: 'https://fixture.invalid/details.php?id=12',
      siteId: 'CARPT',
      candidateKey: 'CARPT:12',
      fetchedAt: Date.now() / 1000,
      seeders: 5,
      leechers: 20
    };
    await s.admission.finish(rss, torrent, s.client, 'CARPT', 'fixture-operation');
    const before = await q.request('get', 'SELECT admission_snapshot FROM torrents WHERE hash=?', [torrent.hash]);
    assert.equal(JSON.parse(before.admission_snapshot).leechers, 20);
    await q.request('run', 'UPDATE torrents SET delete_time=?,upload=? WHERE hash=?', [s.now(), 200, torrent.hash]);
    assert.equal((await q.request('get', 'SELECT admission_snapshot FROM torrents WHERE hash=?', [torrent.hash])).admission_snapshot, before.admission_snapshot);
    await q.close();
    const reopened = new DatabaseQueue({ filename: q.filename }); fixtures.add(reopened);
    assert.equal((await reopened.request('all', 'PRAGMA table_info(torrents)')).filter(c => c.name === 'admission_snapshot').length, 1);
    assert.equal((await reopened.request('get', 'SELECT admission_snapshot FROM torrents WHERE hash=?', [torrent.hash])).admission_snapshot, before.admission_snapshot);
  });
  await test('opportunity race releases only the unsent intent without false failure history', async () => {
    const s = await scenario(); const rss = s.makeRss('1234abcd');
    const torrent = { hash: 'b'.repeat(40), name: 'fixture', size: 100 };
    const result = await rss._addTracked(torrent, s.client, 'CARPT', false, async () => { throw Object.assign(Error('deferred'), { code: 'PROVIDER_OPPORTUNITY_DEFERRED' }); });
    assert.equal(result.deferred, 'opportunity');
    assert.equal((await s.queue.request('all', 'SELECT * FROM vertex_rss_pending')).length, 0);
    assert.equal((await s.queue.request('all', 'SELECT * FROM torrents')).length, 0);
    assert.equal(s.posted.length, 0); assert.equal(s.errors.length, 0);
  });
  await test('real SQL result shapes and original durability', async () => {
    const q = makeDatabase();
    const journal = await q.request('get', 'PRAGMA journal_mode');
    assert.equal(journal.journal_mode, 'delete');
    assert.equal(await q.request('get', 'SELECT * FROM torrents WHERE id=-1'), undefined);
    const result = await q.request('run', 'INSERT INTO torrent_flow(hash,upload,download,time) VALUES(?,?,?,?)', ['synthetic', 1, 2, 3]);
    assert.equal(result.changes, 1); assert.equal(typeof result.lastInsertRowid, 'number');
  });
  await test('concurrent app writes serialize without busy', async () => {
    const q = makeDatabase();
    await Promise.all(Array.from({ length: 150 }, (_, i) => q.request('run',
      'INSERT INTO torrent_flow(hash,upload,download,time) VALUES(?,?,?,?)', ['synthetic', i, 0, 1])));
    assert.equal((await q.request('get', 'SELECT count(*) AS n FROM torrent_flow')).n, 150);
    assert.equal(q.getStats().busyRetries, 0);
  });
  await test('batch constraint failure rolls back every statement', async () => {
    const q = makeDatabase();
    await assert.rejects(q.request('batch', null, [
      { sql: 'INSERT INTO torrent_flow(hash,upload,download,time) VALUES(?,?,?,?)', params: ['synthetic', 1, 1, 1] },
      { sql: 'INSERT INTO nonexistent_table(value) VALUES(?)', params: [1] }
    ]));
    assert.equal((await q.request('get', 'SELECT count(*) AS n FROM torrent_flow')).n, 0);
  });
  await test('external writer busy wait does not freeze parent event loop', async () => {
    const q = makeDatabase(); await q.request('get', 'SELECT 1');
    const external = new Database(q.filename);
    external.exec('BEGIN IMMEDIATE');
    let heartbeat = 0; const interval = setInterval(() => heartbeat++, 10);
    const release = setTimeout(() => external.exec('ROLLBACK'), 700);
    try {
      await q.request('run', 'INSERT INTO torrent_flow(hash,upload,download,time) VALUES(?,?,?,?)', ['synthetic', 1, 0, 1]);
      assert(heartbeat > 25); assert(q.getStats().busyRetries > 0);
    } finally { clearInterval(interval); clearTimeout(release); if (external.inTransaction) external.exec('ROLLBACK'); external.close(); }
  });
  await test('queue overflow is explicit, never silent loss', async () => {
    const q = makeDatabase({ limit: 1 });
    const first = q.request('get', 'SELECT 1');
    await assert.rejects(q.request('get', 'SELECT 2'), { code: 'DB_QUEUE_FULL' });
    await first;
  });
  await test('background work cannot starve under control load', async () => {
    const q = makeDatabase(); await q.request('get', 'SELECT 1');
    const order = [];
    const first = q.request('get', 'SELECT 1');
    const background = q.request('get', 'SELECT 2', [], { priority: 'background' }).then(() => order.push('background'));
    const control = Array.from({ length: 30 }, () => q.request('get', 'SELECT 3').then(() => order.push('normal')));
    await Promise.all([first, background, ...control]);
    assert(order.indexOf('background') <= 8);
  });
  await test('committed write with lost reply is not replayed and next owner recovers', async () => {
    const q = makeDatabase({ workerFile: path.join(__dirname, 'fixtures/lost-reply-worker.js') });
    await assert.rejects(q.request('run', 'INSERT INTO torrent_flow(hash,upload,download,time) VALUES(?,?,?,?)', ['synthetic', 1, 0, 1]), { code: 'DB_OUTCOME_UNKNOWN' });
    assert.equal(q.getStats().unknownWrites, 1);
    q.workerFile = path.join(root, 'app/libs/database-worker.js');
    assert.equal((await q.request('get', 'SELECT count(*) AS n FROM torrent_flow')).n, 1);
    await q.request('run', 'INSERT INTO torrent_flow(hash,upload,download,time) VALUES(?,?,?,?)', ['synthetic', 2, 0, 2]);
    assert.equal((await q.request('get', 'SELECT count(*) AS n FROM torrent_flow')).n, 2);
  });
  await test('normal RSS and 202 response record real task success', async () => {
    const f = await scenario({ statusCode: 202 });
    await f.makeRss().rss([torrent(1), torrent(2)]);
    assert.equal(f.posted.length, 2);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM torrents WHERE record_type=1')).n, 2);
    assert.equal(f.errors.length, 0);
  });
  await test('accepted task with history failure is repaired without re-add', async () => {
    const f = await scenario({ finishFailures: 1 }); const r = f.makeRss();
    await r.rss([torrent(1)]);
    assert.equal(f.posted.length, 1); assert.equal(f.errors.length, 0); assert(f.warnings.length > 0);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM vertex_rss_pending')).n, 1);
    await r.rss([torrent(1)]);
    assert.equal(f.posted.length, 1);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM torrents WHERE record_type=1')).n, 1);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM torrent_flow')).n, 1);
  });
  await test('persistent pending state repairs after RSS object replacement', async () => {
    const f = await scenario({ finishFailures: 1 }); await f.makeRss().rss([torrent(1)]);
    await f.makeRss().rss([torrent(1)]);
    assert.equal(f.posted.length, 1); assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM vertex_rss_pending')).n, 0);
  });
  await test('persistent pending state survives real database worker restart', async () => {
    const f = await scenario({ finishFailures: 1 }); await f.makeRss().rss([torrent(1)]);
    await f.queue._stop(Object.assign(new Error('synthetic restart'), { code: 'DB_WORKER_EXITED' }));
    await f.makeRss().rss([torrent(1)]);
    assert.equal(f.posted.length, 1);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM vertex_rss_pending')).n, 0);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM torrents WHERE record_type=1')).n, 1);
  });
  await test('HTTP 202 without task confirmation is held, not marked successful', async () => {
    const f = await scenario({ delayedConfirmation: true, statusCode: 202 }); const r = f.makeRss();
    await r.rss([torrent(1)]);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM torrents')).n, 0);
    await r.rss([torrent(1)]); assert.equal(f.posted.length, 1);
    f.tasks.add(torrent(1).hash); await r.rss([torrent(1)]);
    assert.equal(f.posted.length, 1); assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM torrents')).n, 1);
  });
  await test('unknown HTTP outcome reconciles actual qB before any retry', async () => {
    const f = await scenario({ httpOutcomeUnknown: true }); const r = f.makeRss();
    await r.rss([torrent(1)]); assert.equal(f.posted.length, 1);
    await r.rss([torrent(1)]); assert.equal(f.posted.length, 1);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM torrents WHERE record_type=1')).n, 1);
  });
  await test('definite HTTP rejection releases intent and records safe failure', async () => {
    const f = await scenario({ statusCode: 403, delayedConfirmation: true });
    await f.makeRss().rss([torrent(1), torrent(2)]);
    assert.equal(f.posted.length, 2);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM vertex_rss_pending')).n, 0);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM torrents WHERE record_type=3')).n, 2);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM torrents WHERE record_type=1')).n, 0);
  });
  await test('server failure is uncertain and must not blindly resubmit', async () => {
    const f = await scenario({ statusCode: 500, delayedConfirmation: true }); const r = f.makeRss();
    await r.rss([torrent(1)]); f.advance(600); await r.rss([torrent(1)]);
    assert.equal(f.posted.length, 1);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM vertex_rss_pending')).n, 1);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM torrents')).n, 0);
  });
  await test('notification error cannot convert a successful task to failure', async () => {
    const f = await scenario(); const r = f.makeRss();
    r.ntf.addTorrent = async () => { throw new Error('synthetic notification'); };
    await r.rss([torrent(1)]); await r.rss([torrent(1)]);
    assert.equal(f.posted.length, 1);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM torrents WHERE record_type=1')).n, 1);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM torrents WHERE record_type=3')).n, 0);
  });
  await test('one candidate lookup failure does not discard remaining candidates', async () => {
    const f = await scenario({ lookupFailures: 1 }); await f.makeRss().rss([torrent(1), torrent(2)]);
    assert.equal(f.posted.length, 1); assert.equal(f.posted[0], torrent(2).hash);
  });
  await test('temporary refusal is rechecked with current rules without deleting history', async () => {
    const f = await scenario(); const r = f.makeRss(); f.client.status = false;
    await r.rss([torrent(1)]); f.client.status = true;
    f.advance(301); await r.rss([torrent(1)]);
    assert.equal(f.posted.length, 1);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM torrents')).n, 2);
  });
  await test('permanent success and ambiguous legacy failure remain protected', async () => {
    const f = await scenario();
    for (const type of [1, 3]) {
      await f.util.runRecord('INSERT INTO torrents(hash,name,size,rss_id,link,record_type,record_time,record_note) VALUES(?,?,?,?,?,?,?,?)',
        [torrent(type).hash, 'synthetic', 1024, 'synthetic-rss', 'https://example.invalid/', type, f.now() - 1000, 'synthetic']);
    }
    await f.makeRss().rss([torrent(1), torrent(3)]); assert.equal(f.posted.length, 0);
  });
  await test('rechecked refusal still honors current rejection rule', async () => {
    const f = await scenario(); const r = f.makeRss();
    await f.util.runRecord('INSERT INTO torrents(hash,name,size,rss_id,link,record_type,record_time,record_note) VALUES(?,?,?,?,?,?,?,?)',
      [torrent(1).hash, 'synthetic', 1024, r.id, 'https://example.invalid/', 2, f.now() - 1000, '拒绝原因: 不符合所有规则']);
    r.rejectRules = [{ alias: 'synthetic-rule' }]; r._fitRule = () => true;
    await r.rss([torrent(1)]); assert.equal(f.posted.length, 0);
  });
  await test('cross-RSS same-size admission uses atomic reservation', async () => {
    const f = await scenario();
    await Promise.all([f.makeRss('rss-a', true).rss([torrent(1, 4096)]), f.makeRss('rss-b', true).rss([torrent(2, 4096)])]);
    assert.equal(f.posted.length, 1);
  });
  await test('same hash across different RSS cannot post twice concurrently', async () => {
    const f = await scenario();
    await Promise.all([f.makeRss('rss-a').rss([torrent(1)]), f.makeRss('rss-b').rss([torrent(1)])]);
    assert.equal(f.posted.length, 1);
  });
  await test('atomic reserve rechecks history if prior admission finished after screening', async () => {
    const f = await scenario(); const first = f.makeRss('rss-a', true); const second = f.makeRss('rss-b', true);
    await first.rss([torrent(1, 4096)]);
    assert.equal(await f.admission.reserve(second, torrent(2, 4096), f.client, 'synthetic'), null);
    assert.equal(await f.admission.reserve(f.makeRss('rss-c'), torrent(1), f.client, 'synthetic'), null);
  });
  await test('GUID identity resolves to real infohash before posting', async () => {
    const f = await scenario({ actualHash: torrent(99).hash });
    await f.makeRss().rss([{ ...torrent(1), hash: 'synthetic-guid' }]);
    assert.equal(f.posted[0], torrent(99).hash);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM torrents WHERE record_type=1')).n, 2);
  });
  await test('different GUIDs resolving to one real hash cannot post twice', async () => {
    const f = await scenario({ actualHash: torrent(99).hash });
    await Promise.all([f.makeRss('rss-a').rss([{ ...torrent(1), hash: 'guid-a' }]),
      f.makeRss('rss-b').rss([{ ...torrent(2), hash: 'guid-b' }])]);
    assert.equal(f.posted.length, 1);
    await f.makeRss('rss-c').rss([{ ...torrent(3), hash: 'guid-c' }]);
    assert.equal(f.posted.length, 1);
  });
  await test('overlapping cycles on one RSS instance never submit twice', async () => {
    const f = await scenario(); const r = f.makeRss();
    const results = await Promise.all([r.rss([torrent(1)]), r.rss([torrent(1)])]);
    assert.equal(f.posted.length, 1);
    assert.equal(results[1].skipped, 'overlap');
    assert.equal(r.rssBusy, false);
  });
  await test('repeated database failure stops admission with bounded backpressure', async () => {
    const f = await scenario({ lookupFailures: 10 });
    await f.makeRss().rss(Array.from({ length: 10 }, (_, i) => torrent(i + 1)));
    assert.equal(f.posted.length, 0); assert.equal(f.errors.length, 3);
  });
  await test('missed hourly cron is repaired from wall-clock hour', async () => {
    const f = await scenario(); const r = f.makeRss(); r.addCountPerHour = 1; r.addCount = 1; r.countHour--;
    await r.rss([torrent(1)]); assert.equal(f.posted.length, 1);
  });
  await test('explicit zero hourly quota means unlimited', async () => {
    const f = await scenario(); const r = f.makeRss(); r.addCount = 1000;
    await r.rss([torrent(1), torrent(2)]); assert.equal(f.posted.length, 2);
  });
  await test('native record preserves all history rows and tracker delta', async () => {
    const f = await scenario();
    for (const type of [1, 2]) {
      await f.util.runRecord('INSERT INTO torrents(hash,name,size,rss_id,link,record_type,record_time,record_note) VALUES(?,?,?,?,?,?,?,?)',
        [torrent(1).hash, 'synthetic', 1024, 'synthetic-rss', 'https://example.invalid/', type, f.now(), 'synthetic']);
    }
    await f.util.runRecord('INSERT INTO torrent_flow(hash,upload,download,time) VALUES(?,?,?,?)', [torrent(1).hash, 10, 20, f.now() - 300]);
    f.client.maindata.torrents = [{ ...torrent(1), tracker: 'synthetic', uploaded: 40, downloaded: 70 }];
    await f.client.record();
    const rows = await f.util.getRecords('SELECT upload,download FROM torrents');
    assert.equal(rows.length, 2); assert(rows.every(x => x.upload === 40 && x.download === 70));
    const tracker = await f.util.getRecord('SELECT upload,download FROM tracker_flow');
    assert.equal(tracker.upload, 30); assert.equal(tracker.download, 50);
  });
  await test('record overlap is skipped and writes are bounded short batches', async () => {
    const f = await scenario();
    f.client.maindata.torrents = Array.from({ length: 100 }, (_, i) => ({ ...torrent(i + 1), tracker: 'synthetic', uploaded: 0, downloaded: 0 }));
    await Promise.all([f.client.record(), f.client.record()]);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM torrent_flow')).n, 100);
    assert.equal(f.client.recordInProgress, false);
  });
  await test('provider exact size reaches final RSS rules and native reservation before one file submit', async () => {
    const t = torrent(901); t.hash = 'provider:CARPT:901'; t.size = 100;
    const hash = '9'.repeat(40); let prepared = false; let finalChecks = 0; let accepts = 0;
    const provider = {
      begin: async () => ({ candidates: [t] }),
      prepare: async (r, row) => { row.hash = hash; row.size = 123456; prepared = true; return true; },
      metadata: () => ({ hash, filepath: '/tmp/' + hash + '.torrent' }),
      finalCheck: async () => { assert(prepared); finalChecks++; }
    };
    const f = await scenario({ provider }); const r = f.makeRss();
    r.acceptRules = [{}]; r._fitRule = (rule, row) => { assert(prepared); assert.equal(row.size, 123456); accepts++; return true; };
    r._downloadTorrent = async () => assert.fail('metadata must not be downloaded twice');
    await r.rss();
    assert.equal(f.posted.length, 1); assert.equal(f.posted[0], hash); assert.equal(accepts, 1); assert.equal(finalChecks, 2);
    const saved = await f.util.getRecord('SELECT * FROM torrents WHERE record_type=1'); assert.equal(saved.size, 123456);
  });
  await test('provider preflight refusal cannot reserve or post a torrent', async () => {
    const provider = { begin: async () => ({ candidates: [torrent(902)] }), prepare: async () => false };
    const f = await scenario({ provider }); await f.makeRss().rss();
    assert.equal(f.posted.length, 0); assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM vertex_rss_pending')).n, 0);
  });
  await test('site backoff defers a whole provider cycle without per-candidate errors or rejection history', async () => {
    let attempts = 0;
    const provider = { begin: async () => ({ candidates: [torrent(903), torrent(904), torrent(905)] }), prepare: async () => { attempts++; throw Object.assign(Error('deferred'), { code: 'PROVIDER_METADATA_BACKOFF', metadataScope: 'site' }); } };
    const f = await scenario({ provider }); const r = f.makeRss(); r.lastRssTime = f.now() - 100;
    await r.rss();
    assert.equal(attempts, 1); assert.equal(f.errors.length, 0); assert.equal(r.rssBusy, false); assert.equal(r.lastRssTime, f.now());
    assert.equal(f.posted.length, 0); assert.equal(f.notices.length, 0);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM torrents')).n, 0);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM vertex_rss_pending')).n, 0);
  });
  await test('candidate backoff does not block the next candidate and creates no rejection record', async () => {
    let attempts = 0;
    const provider = {
      begin: async () => ({ candidates: [torrent(906), torrent(907)] }),
      prepare: async () => {
        attempts++; if (attempts === 1) throw Object.assign(Error('deferred'), { code: 'PROVIDER_METADATA_BACKOFF', metadataScope: 'candidate' }); return false;
      }
    };
    const f = await scenario({ provider }); await f.makeRss().rss();
    assert.equal(attempts, 2); assert.equal(f.errors.length, 0); assert.equal(f.posted.length, 0);
    assert.equal((await f.util.getRecord('SELECT count(*) AS n FROM torrents')).n, 0);
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    passed: results.length,
    realSqlite: true,
    node: process.version,
    sqliteLibrary: require('better-sqlite3/package.json').version
  }) + '\n');
}

main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; }).finally(async () => {
  await Promise.all(Array.from(fixtures, fixture => fixture.close()));
  if (path.dirname(work) !== os.tmpdir() || !path.basename(work).startsWith('vertex-db-tests-')) throw new Error('unsafe test cleanup');
  fs.rmSync(work, { recursive: true, force: true });
});

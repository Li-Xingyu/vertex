// Explicit opt-in, disposable loopback MariaDB fixture only; never production.
const assert = require('assert').strict;
const L = require('../app/libs/content-groups/lineage-db');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Worker } = require('worker_threads');
async function main () {
  if (process.env.VERTEX_LINEAGE_LOCAL_FIXTURE !== '1') throw Error('LOCAL_FIXTURE_REQUIRED');
  const mysql = require('../app/vendor/lineage-db/node_modules/mysql2/promise');
  const cfg = {
    host: '127.0.0.1',
    port: 3306,
    database: 'lineage_fixture',
    user: 'vertex_fixture_reader',
    password: 'fixture-only',
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
    connectTimeout: 2000
  };
  const connect = c => mysql.createConnection(c);
  const first = await L.readEvents(cfg, 'brush', {}, connect);
  assert.equal(first.report.received, 3);
  assert.equal(Object.keys(first.state.records).length, 3);
  const second = await L.readEvents(cfg, 'brush', first.state, connect);
  assert.equal(second.report.received, 0);
  assert.equal(second.state.cursor, first.state.cursor);
  assert(!JSON.stringify(first.state).includes('fixture-only'));
  const c = await connect(cfg);
  try {
    await assert.rejects(() => c.query('DELETE FROM cn_vertex_lineage'), e => e.errno === 1142);
    await assert.rejects(() => c.query('SELECT * FROM unrelated_secret'), e => e.errno === 1142);
  } finally { c.destroy(); }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vertex-lineage-db-test-'));
  const members = new Map();
  for (const r of Object.values(first.state.records)) for (const b of r.members) members.set(b.hash, b);
  const calls = [];
  const server = http.createServer((req, res) => {
    const action = req.url.split('?')[0].split('/').pop(); calls.push(action);
    res.end(JSON.stringify(action === 'info'
      ? [...members.values()].map(b => ({
        hash: b.hash,
        added_on: b.addedOn,
        save_path: b.savePath,
        content_path: b.contentPath,
        total_size: b.size,
        amount_left: 0,
        uploaded: 1,
        downloaded: 4,
        state: 'stalledUP'
      }))
      : [{ index: 0, name: 'fixture/a.bin', size: 4, priority: 1 }]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    fs.writeFileSync(path.join(work, 'brush-lineage-db.json'), JSON.stringify(cfg), { mode: 0o600 });
    const run = () => new Promise((resolve, reject) => {
      const w = new Worker(path.join(__dirname, '../app/libs/content-groups/worker.js'), {
        workerData: {
          mode: 'shadow',
          clientId: 'brush',
          roots: ['/downloads'],
          maxTasks: 32,
          timeoutMs: 20000,
          lineageSource: 'database',
          stateFile: path.join(work, 'brush-shadow.json'),
          connection: { url: 'http://127.0.0.1:' + server.address().port, cookie: 'LOCAL_FIXTURE_ONLY' }
        }
      });
      let message;
      const timer = setTimeout(() => { w.terminate(); reject(Error('fixture_worker_timeout')); }, 22000);
      w.on('message', m => { message = m; }); w.on('error', reject);
      w.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(message) : reject(Error('fixture_worker_exit')); });
    });
    const a = await run(); assert.equal(a.ok, true); assert.equal(a.lineageHits, 4); assert.equal(a.summary.multiReferenceGroups, 1);
    assert.equal(a.metadataExports, 0); assert.equal(a.deleteAuthorized, false);
    const b = await run(); assert.equal(b.ok, true); assert.equal(b.lineageDb.received, 0); assert.equal(b.selected, 0);
    assert(calls.every(x => ['info', 'files'].includes(x)));
    const saved = fs.readFileSync(path.join(work, 'brush-shadow.json'), 'utf8');
    assert(!saved.includes('fixture-only')); assert(!saved.includes('LOCAL_FIXTURE_ONLY'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(work, { recursive: true, force: true }); // Exact local synthetic fixture directory.
  }
  process.stdout.write(JSON.stringify({ passed: 18, realMariaDb: true, realWorker: true, productionRequests: 0 }) + '\n');
}
main().catch(() => { process.stderr.write('LOCAL_DB_INTEGRATION_FAILED\n'); process.exitCode = 1; });

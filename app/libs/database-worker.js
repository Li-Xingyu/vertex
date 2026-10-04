const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');

let db;
const statements = new Map();
function prepare (sql) {
  if (!statements.has(sql)) {
    if (statements.size >= 256) statements.delete(statements.keys().next().value);
    statements.set(sql, db.prepare(sql));
  }
  return statements.get(sql);
}

function initialize () {
  db = new Database(workerData.filename, { fileMustExist: true, timeout: 250 });
  // Additive ledger only; do not change journal mode, durability or old history.
  db.exec(`CREATE TABLE IF NOT EXISTS vertex_rss_pending (
    operation TEXT PRIMARY KEY, reservation TEXT NOT NULL UNIQUE,
    rss_id TEXT NOT NULL, candidate_hash TEXT NOT NULL,
    client_id TEXT NOT NULL, true_hash TEXT, state TEXT NOT NULL,
    payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS vertex_rss_pending_hash ON vertex_rss_pending(true_hash) WHERE true_hash != \'\'');
  parentPort.postMessage({ ready: true });
}

let initAttempts = 0;
function start () {
  try { initialize(); } catch (error) {
    if (db) { try { db.close(); } catch (_) {} }
    db = null;
    if (error.code === 'SQLITE_BUSY' && initAttempts++ < 6) return setTimeout(start, Math.min(1000, 100 * 2 ** initAttempts));
    parentPort.postMessage({ initError: error.code || 'DB_INIT_FAILED' });
  }
}

parentPort.on('message', message => {
  const { id, method, sql, params } = message;
  try {
    if (!db) throw Object.assign(new Error('DB_NOT_READY'), { code: 'DB_NOT_READY' });
    let result;
    if (method === 'batch') {
      if (!Array.isArray(params) || params.length > 256) throw Object.assign(new Error('DB_BATCH_LIMIT'), { code: 'DB_BATCH_LIMIT' });
      result = db.transaction(operations => operations.map(operation => prepare(operation.sql).run(...operation.params)))(params);
    } else if (['run', 'get', 'all'].includes(method) && typeof sql === 'string' && Array.isArray(params)) {
      result = prepare(sql)[method](...params);
    } else {
      throw Object.assign(new Error('DB_REQUEST_INVALID'), { code: 'DB_REQUEST_INVALID' });
    }
    parentPort.postMessage({ id, result });
  } catch (error) {
    // Only a known SQLite BUSY with no open transaction is retried. Lost IPC
    // replies/termination are unknown outcomes and must never be replayed.
    parentPort.postMessage({ id, code: error.code || 'DB_OPERATION_FAILED', retryable: error.code === 'SQLITE_BUSY' && db && !db.inTransaction });
  }
});
start();

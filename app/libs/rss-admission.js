const util = require('./util');

const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const now = () => Math.floor(Date.now() / 1000);
const activeOperations = new Set();

exports.reserve = async function (rss, torrent, client, category, reseed = false) {
  const operation = rss.id + ':' + torrent.hash;
  const reservation = !reseed && rss.skipSameTorrent ? 'size:' + torrent.size : 'hash:' + torrent.hash;
  const payload = JSON.stringify({ torrent, category, reseed });
  if (Buffer.byteLength(payload) > 1024 * 1024) throw Object.assign(new Error('RSS_PAYLOAD_LIMIT'), { code: 'RSS_PAYLOAD_LIMIT' });
  const result = await util.runRecord(`INSERT OR IGNORE INTO vertex_rss_pending
    (operation,reservation,rss_id,candidate_hash,client_id,true_hash,state,payload,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (
      SELECT 1 FROM torrents WHERE record_type=1 AND add_time>? AND
        (hash=? OR (?=1 AND size=?))
    )`,
  [operation, reservation, rss.id, torrent.hash, client.id, HASH.test(torrent.hash) ? torrent.hash : '', 'prepared', payload, now(), now(),
    now() - 1200, torrent.hash, !reseed && rss.skipSameTorrent ? 1 : 0, torrent.size]);
  if (!result.changes) return null;
  activeOperations.add(operation);
  return operation;
};

exports.end = operation => activeOperations.delete(operation);

exports.mark = async function (operation, state, trueHash = '') {
  const checkHistory = state === 'submitting' && HASH.test(trueHash);
  const result = await util.runRecord(`UPDATE vertex_rss_pending SET state=?,true_hash=CASE WHEN ? != '' THEN ? ELSE true_hash END,updated_at=? WHERE operation=?
    AND NOT EXISTS (SELECT 1 FROM torrents WHERE ?=1 AND record_type=1 AND hash=? AND add_time>?)`,
  [state, trueHash, trueHash, now(), operation, checkHistory ? 1 : 0, trueHash, now() - 1200]);
  if (!result.changes) {
    const code = checkHistory ? 'RSS_ALREADY_ADMITTED' : 'RSS_INTENT_MISSING';
    throw Object.assign(new Error(code), { code });
  }
};

exports.release = async function (operation) {
  await util.runRecord('DELETE FROM vertex_rss_pending WHERE operation=?', [operation]);
};

exports.finish = async function (rss, torrent, client, category, operation, trueHash = '', reseed = false) {
  const at = now();
  const hash = trueHash || torrent.hash;
  const note = reseed ? '辅种' : '添加种子';
  const sql = 'INSERT INTO torrents (hash,name,size,rss_id,link,category,record_time,add_time,record_type,record_note) VALUES (?,?,?,?,?,?,?,?,?,?)';
  const operations = [
    { sql: 'INSERT INTO torrent_flow (hash,upload,download,time) VALUES (?,?,?,?)', params: [hash, 0, 0, at - at % 300] },
    { sql, params: [torrent.hash, torrent.name, torrent.size, rss.id, torrent.link, category, at, at, 1, note] }
  ];
  if (trueHash && trueHash !== torrent.hash) operations.push({ sql, params: [trueHash, torrent.name, torrent.size, rss.id, torrent.link, category, at, at, 1, note] });
  operations.push({ sql: 'DELETE FROM vertex_rss_pending WHERE operation=?', params: [operation] });
  // Flow + all success history + release commit together. On a lost reply, the
  // persisted intent or success history decides recovery; never re-add blindly.
  await util.runRecords(operations);
};

exports.reconcile = async function (rss) {
  const pending = await util.getRecords('SELECT * FROM vertex_rss_pending WHERE rss_id=? ORDER BY updated_at,created_at LIMIT 50', [rss.id]);
  let repaired = 0;
  let checks = 0;
  for (const item of pending) {
    if (activeOperations.has(item.operation)) continue;
    if (item.state === 'prepared') {
      await exports.release(item.operation); // Durable protocol says no HTTP yet.
      repaired++;
      continue;
    }
    const client = global.runningClient[item.client_id];
    if (!client || !client.status) continue;
    let exists = false;
    if (item.state === 'confirmed' || (item.state === 'accepted' && client._client.type !== 'qBittorrent')) exists = true;
    else if (HASH.test(item.true_hash || '') && typeof client.hasTorrent === 'function') {
      // Bound local qB lookups and rotate unresolved operations between cycles.
      if (checks >= 5) continue;
      checks++;
      await util.runRecord('UPDATE vertex_rss_pending SET updated_at=? WHERE operation=?', [now(), item.operation]);
      try { exists = await client.hasTorrent(item.true_hash); } catch (_) { continue; }
    }
    if (!exists) continue; // Uncertain/invalid hashes are held, not blindly retried.
    const data = JSON.parse(item.payload);
    await exports.finish(rss, data.torrent, client, data.category, item.operation, item.true_hash, data.reseed);
    repaired++;
  }
  return { pending: pending.length - repaired, repaired, checks };
};

exports.retryableHistory = function (record, timestamp) {
  if (!record || !record.id) return true;
  const safeFailure = +record.record_type === 3 && record.record_note === '添加种子失败: 未提交';
  if (+record.record_type !== 2 && !safeFailure) return false;
  // Re-evaluation never bypasses rules, promotion, HR, space or deduplication.
  // Keep old rows; success and legacy ambiguous failures remain protected.
  return timestamp - record.record_time >= 300;
};

exports.isHash = value => HASH.test(value || '');

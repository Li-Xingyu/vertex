'use strict';
const fs = require('fs');
const I = require('./identity');
const PAGE_SIZE = 128;
const fail = code => { throw Error('CG_LINEAGE_' + code); };
function id (value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18446744073709551615n) fail('CURSOR');
  return value;
}
function record (raw, clientId) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 65536) fail('SIZE');
  let r; try { r = JSON.parse(raw); } catch (_) { fail('JSON'); }
  if (!r || r.schema !== 1 || r.clientId !== clientId ||
      !Number.isSafeInteger(r.verifiedAt) || r.verifiedAt < 1 || r.verifiedAt > Math.floor(Date.now() / 1000) + 30 ||
      !/^[a-f0-9]{64}$/.test(r.contentId) || !/^[a-f0-9]{64}$/.test(r.manifestDigest) || !Array.isArray(r.members) || r.members.length !== 2) fail('RECORD');
  const members = r.members.map(b => {
    if (!b || b.clientId !== clientId) fail('BINDING');
    return I.binding({ hash: b.hash, added_on: b.addedOn, save_path: b.savePath, content_path: b.contentPath, total_size: b.size }, clientId);
  });
  if (members[0].hash === members[1].hash) fail('BINDING');
  // Explicit whitelist: never cache arbitrary database fields or credentials.
  return {
    schema: 1,
    clientId,
    verifiedAt: r.verifiedAt,
    contentId: r.contentId,
    manifestDigest: r.manifestDigest,
    members
  };
}
async function readConfig (file) {
  try {
    const st = await fs.promises.lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 8192 || (st.mode & 0o077)) fail('CONFIG_PERMISSIONS');
    const cfg = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    if (!cfg || typeof cfg.host !== 'string' || !/^[a-zA-Z0-9_.:-]{1,253}$/.test(cfg.host) ||
        !Number.isSafeInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535 ||
        typeof cfg.user !== 'string' || !cfg.user || typeof cfg.password !== 'string' || !cfg.password ||
        typeof cfg.database !== 'string' || !/^[a-zA-Z0-9_]{1,64}$/.test(cfg.database)) fail('CONFIG');
    return {
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      ...(cfg.ca ? { ssl: { ca: cfg.ca, rejectUnauthorized: true } } : {}),
      connectTimeout: 2000,
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      charset: 'utf8mb4',
      enableKeepAlive: false
    };
  } catch (_) { fail('CONFIG'); }
}

// Append-only stream, ordered by a writer lock held until COMMIT. Vertex never
// writes the IYUU DB, takes advisory locks, or acknowledges by deleting rows.
async function readEvents (config, clientId, previous = {}, connect) {
  I.key(clientId);
  const cursor = id(previous.cursor || '0');
  let c; let expired = false; let timer;
  const task = async () => {
    c = await connect(config);
    if (expired) { c.destroy(); fail('TIMEOUT'); }
    const query = async (sql, args = []) => (await c.query({ sql, timeout: 3000 }, args))[0];
    try {
      await query('START TRANSACTION READ ONLY');
      const meta = await query('SELECT schema_version,stream_id FROM cn_vertex_lineage_stream WHERE singleton=1');
      if (meta.length !== 1 || Number(meta[0].schema_version) !== 1 || !/^[a-f0-9]{32}$/.test(meta[0].stream_id)) fail('SCHEMA');
      const stream = meta[0].stream_id;
      if (previous.stream && previous.stream !== stream) fail('STREAM_CHANGED');
      if (cursor !== '0') {
        const anchor = await query('SELECT record_sha256 FROM cn_vertex_lineage WHERE client_key=? AND event_id=?', [clientId, cursor]);
        if (!previous.stream || anchor.length !== 1 || anchor[0].record_sha256 !== previous.token) fail('CURSOR_LOST');
      }
      const rows = await query('SELECT event_id,record_json,record_sha256 FROM cn_vertex_lineage WHERE client_key=? AND event_id>? ORDER BY event_id LIMIT ' + PAGE_SIZE, [clientId, cursor]);
      if (rows.length > PAGE_SIZE) fail('PAGE_BOUND');
      const records = { ...(previous.records || {}) }; const priority = new Set();
      let last = cursor; let token = previous.token || null;
      for (const row of rows) {
        const next = id(String(row.event_id));
        if (BigInt(next) <= BigInt(last)) fail('ORDER');
        if (typeof row.record_json !== 'string' || !/^[a-f0-9]{64}$/.test(row.record_sha256) ||
            I.bytesDigest(Buffer.from(row.record_json)) !== row.record_sha256) fail('DIGEST');
        const r = record(row.record_json, clientId);
        records[r.members[1].hash] = r;
        r.members.forEach(b => priority.add(b.hash)); last = next; token = row.record_sha256;
      }
      if (Object.keys(records).length > 10000) fail('CACHE_BOUND');
      await query('COMMIT');
      return {
        state: { stream, cursor: last, token, records },
        priority: [...priority],
        report: { received: rows.length, fullPage: rows.length === PAGE_SIZE, cursor: last, ok: true }
      };
    } finally { c.destroy(); }
  };
  try {
    return await Promise.race([task(), new Promise((resolve, reject) => {
      timer = setTimeout(() => { expired = true; if (c) c.destroy(); reject(Error('CG_LINEAGE_TIMEOUT')); }, 10000);
    })]);
  } catch (e) { throw Error(/^CG_LINEAGE_[A-Z_]+$/.test(e.message) ? e.message : 'CG_LINEAGE_UNAVAILABLE'); } finally { clearTimeout(timer); }
}
function byMember (state) {
  const map = new Map();
  for (const r of Object.values(state.records || {})) {
    for (const b of r.members) {
      if (!map.has(b.hash) || map.get(b.hash).verifiedAt < r.verifiedAt) map.set(b.hash, r);
    }
  }
  return map;
}
module.exports = { readConfig, readEvents, record, byMember, PAGE_SIZE };

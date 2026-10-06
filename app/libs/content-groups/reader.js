'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const I = require('./identity');
const G = require('./index');

// No mutation endpoint, site API, proxy, redirect, shell or Docker socket.
function qbitReader (connection, budget) {
  const base = new URL(connection.url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw Error('CG_ORIGIN');
  return async function get (action, hash) {
    if (!['info', 'files', 'export'].includes(action)) throw Error('CG_ACTION');
    const available = budget.deadline - Date.now() - (action === 'info' ? 0 : (budget.readbackReserveMs || 0));
    if (++budget.calls > budget.maxCalls || available <= 0) throw Error('CG_BUDGET');
    if (hash) I.hash(hash);
    const url = new URL(base.href.replace(/\/$/, '') + '/api/v2/torrents/' + action);
    if (hash) url.searchParams.set('hash', hash);
    const limit = action === 'export' ? I.MAX_BYTES : 32 * 1024 * 1024;
    const timeout = Math.min(5000, available);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, data) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(data); };
      const req = (url.protocol === 'https:' ? https : http).request(url, {
        method: 'GET', headers: { cookie: connection.cookie || '', 'accept-encoding': 'identity' }
      }, res => {
        if (res.statusCode !== 200) { res.resume(); finish(Error('CG_QBIT_STATUS')); return; }
        const chunks = []; let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > limit) { finish(Error('CG_RESPONSE_SIZE')); req.destroy(); } else chunks.push(chunk);
        });
        res.on('aborted', () => finish(Error('CG_QBIT_ABORT')));
        res.on('error', () => finish(Error('CG_QBIT_READ')));
        res.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks);
          if (action === 'export') finish(null, data);
          else {
            try { const value = JSON.parse(data.toString('utf8')); if (!Array.isArray(value)) throw Error(); finish(null, value); } catch (_) { finish(Error('CG_QBIT_JSON')); }
          }
        });
      });
      const timer = setTimeout(() => { finish(Error('CG_TIMEOUT')); req.destroy(); }, timeout);
      req.on('error', () => finish(Error('CG_QBIT_CONNECT'))); req.end();
    });
  };
}

function safeRow (row) {
  const result = {};
  for (const k of ['hash', 'added_on', 'save_path', 'content_path', 'total_size', 'amount_left', 'uploaded', 'downloaded', 'state']) result[k] = row[k];
  return result;
}
function safeFiles (files) {
  if (!Array.isArray(files) || files.length > 20000) throw Error('CG_FILES');
  return files.map(f => ({ index: f.index, name: f.name, size: f.size, priority: f.priority }));
}
function sameInstance (a, b, clientId) {
  try { return I.digest(I.binding(a, clientId)) === I.digest(I.binding(b, clientId)); } catch (_) { return false; }
}

function lineageProof (record, row, files, clientId, now) {
  if (!record || record.schema !== 1 || record.proofType !== 'iyuu-v1-complete-readback' || record.clientId !== clientId ||
      !Number.isSafeInteger(record.verifiedAt) || record.verifiedAt > now + 30 || record.verifiedAt <= 0 ||
      !Array.isArray(record.members) || record.members.length !== 2 || record.members[0].hash === record.members[1].hash) return null;
  const b = record.members.find(b => b.hash === row.hash);
  const proof = { schema: 1, kind: 'v1-exact', binding: b, manifestDigest: record.manifestDigest, contentId: record.contentId };
  return b && I.current(proof, row, files, clientId) ? proof : null;
}

async function readLineage (directory, hash) {
  if (!directory) return null;
  I.hash(hash);
  try {
    const dir = await fs.promises.lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink()) return null;
    const file = path.join(directory, hash + '.json');
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) return null;
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch (_) { return null; }
}

async function collect (options, get, previous = {}, loadLineage = async () => null) {
  const now = Math.floor(Date.now() / 1000); const clientId = I.key(options.clientId);
  const roots = options.roots.map(I.absolute);
  if (!roots.length || roots.length > 16) throw Error('CG_ROOTS');
  const maxTasks = Math.min(64, Math.max(1, options.maxTasks || 32));
  const allBefore = await get('info');
  if (allBefore.length > 10000) throw Error('CG_TASK_BOUND');
  const before = allBefore.map(safeRow);
  const eligible = before.filter(r => typeof r.content_path === 'string' && roots.some(root => I.within(r.content_path, root))).sort((a, b) => a.hash.localeCompare(b.hash));
  // Cached manifests are usable only in this shadow report, never deletion. Each
  // selected task is re-read. The cursor guarantees eventual cold-cache coverage.
  const cursor = Number.isSafeInteger(previous.cursor) ? previous.cursor % Math.max(1, eligible.length) : 0;
  const selected = [...eligible.slice(cursor), ...eligible.slice(0, cursor)].slice(0, maxTasks);
  const cache = {}; const errors = {}; let exportCount = 0; let lineageHits = 0;
  let processed = 0;
  for (const row of eligible) {
    const prior = previous.cache && previous.cache[row.hash];
    // Preserve metadata identity across bounded rounds. Expired manifests remain
    // explicit protection below, not permission; dropping the identity here would
    // make a large client permanently cold and re-export every round trip.
    if (prior && Number.isSafeInteger(prior.checkedAt) && now >= prior.checkedAt && sameInstance(prior.row, row, clientId)) cache[row.hash] = prior;
  }
  for (const row of selected) {
    if (options.workDeadline && Date.now() >= options.workDeadline) break;
    processed++;
    delete cache[row.hash];
    try {
      const files = safeFiles(await get('files', row.hash));
      let proof = null;
      const prior = previous.cache && previous.cache[row.hash];
      if (prior && I.current(prior.proof, row, files, clientId)) proof = prior.proof;
      if (!proof) { proof = lineageProof(await loadLineage(row.hash), row, files, clientId, now); if (proof) lineageHits++; }
      if (!proof) { exportCount++; proof = I.identity(await get('export', row.hash), row, files, clientId); }
      cache[row.hash] = { row, files, proof, checkedAt: now };
    } catch (e) {
      const code = /^CG_[A-Z_]+$/.test(e.message) ? e.message : 'CG_UNPROVED'; errors[code] = (errors[code] || 0) + 1;
    }
  }
  const allAfter = await get('info');
  if (allAfter.length > 10000) throw Error('CG_TASK_BOUND');
  const after = allAfter.map(safeRow);
  const byBefore = new Map(before.map(r => [r.hash, r]));
  for (const [h, item] of Object.entries(cache)) {
    const row = after.find(r => r.hash === h);
    if (!row || !sameInstance(item.row, row, clientId) || !sameInstance(byBefore.get(h), row, clientId)) delete cache[h];
  }
  const tasks = after.map(row => {
    const item = cache[row.hash]; return {
      row,
      files: item && item.files,
      proof: item && item.proof,
      manifestFresh: !!item && now - item.checkedAt <= 660
    };
  });
  const index = G.buildIndex(tasks, clientId);
  const observations = G.observe(previous.observations, tasks, index, now);
  return {
    schema: 1,
    mode: 'shadow',
    at: now,
    clientId,
    cursor: (cursor + processed) % Math.max(1, eligible.length),
    cache,
    observations,
    report: {
      ...index,
      at: now,
      errors,
      selected: processed,
      metadataExports: exportCount,
      lineageHits,
      coverage: {
        eligible: eligible.length,
        allClientTasks: after.length,
        freshManifests: tasks.filter(t => t.manifestFresh).length,
        manifestFreshnessLimitSeconds: 660
      },
      reservation: G.reservation(tasks, index),
      physicalAudit: 'not_performed',
      externalClients: 'not_checked',
      safety: { deleteAuthorized: false, pauses: 0, deletions: 0, pendingIntentsIncluded: false, oldHistoryImported: false }
    }
  };
}

module.exports = { qbitReader, safeRow, collect, readLineage, lineageProof };

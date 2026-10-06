'use strict';
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { qbitReader, collect, readLineage } = require('./reader');
const { auditGroup } = require('./file-audit');

async function main () {
  const options = workerData;
  const started = Date.now();
  if (options.mode !== 'shadow') throw Error('CG_SHADOW_ONLY');
  let previous = {};
  try {
    const stat = await fs.promises.lstat(options.stateFile);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32 * 1024 * 1024) previous = JSON.parse(await fs.promises.readFile(options.stateFile, 'utf8'));
  } catch (_) {}
  if (previous.schema !== 1 || previous.clientId !== options.clientId) previous = {};
  let events; let lineage = h => readLineage(options.lineageDirectory, h);
  if (options.lineageSource === 'database') {
    const L = require('./lineage-db');
    const mysql = require('../../vendor/lineage-db/node_modules/mysql2/promise');
    const config = await L.readConfig(path.join(path.dirname(options.stateFile), options.clientId + '-lineage-db.json'));
    events = await L.readEvents(config, options.clientId, previous.lineageDb, cfg => mysql.createConnection(cfg));
    const byMember = L.byMember(events.state);
    lineage = async h => byMember.get(h);
  }
  const budget = { calls: 0, maxCalls: 2 + 2 * options.maxTasks, deadline: started + options.timeoutMs - 1000, readbackReserveMs: 6000 };
  const state = await collect({ ...options, incremental: !!events, priorityHashes: events && events.priority, workDeadline: budget.deadline - budget.readbackReserveMs },
    qbitReader(options.connection, budget), previous, lineage);
  if (events) {
    // Cursor and accepted relation records publish atomically with the qB state.
    // Failed worker/state writes replay the page; nothing is acknowledged in DB.
    state.lineageDb = events.state; state.report.lineageDb = events.report;
    const present = new Set(state.report.groups.flatMap(g => g.members));
    for (const [h, r] of Object.entries(state.lineageDb.records)) {
      if (!r.members.some(b => present.has(b.hash))) delete state.lineageDb.records[h];
    }
  }
  if (Array.isArray(options.fileMappings) && options.fileMappings.length) {
    state.report.physicalAudit = 'partial_shadow';
    state.report.fileAudits = {};
    for (const group of state.report.groups.filter(g => g.proved && !g.reasons.length).slice(0, 4)) {
      state.report.fileAudits[group.id] = await auditGroup(group, options.fileMappings,
        { deadline: Math.min(budget.deadline, Date.now() + 2000) });
    }
  }
  // Only our private shadow state is writable. Never write the old audit, fence,
  // qB settings, IYUU ledger, payload files, or native fitTime.
  const parent = path.dirname(options.stateFile);
  await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
  const dir = await fs.promises.lstat(parent);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw Error('CG_STATE_DIRECTORY');
  const temp = options.stateFile + '.tmp-' + process.pid + '-' + Date.now();
  try {
    const data = JSON.stringify(state);
    if (Buffer.byteLength(data) > 32 * 1024 * 1024) throw Error('CG_STATE_BOUND');
    await fs.promises.writeFile(temp, data, { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(temp, options.stateFile);
  } finally { try { await fs.promises.unlink(temp); } catch (_) {} }
  parentPort.postMessage({
    ok: true,
    at: state.at,
    summary: state.report.summary,
    errors: state.report.errors,
    selected: state.report.selected,
    metadataExports: state.report.metadataExports,
    lineageHits: state.report.lineageHits,
    lineageDb: state.report.lineageDb,
    incremental: state.report.incremental,
    mode: 'shadow',
    deleteAuthorized: false,
    calls: budget.calls
  });
}
main().catch(e => parentPort.postMessage({ ok: false, code: /^CG_[A-Z_]+$/.test(e.message) ? e.message : 'CG_WORKER_FAILED' }));

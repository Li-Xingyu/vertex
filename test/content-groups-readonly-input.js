// Offline RAM-only diagnostic adapter. Input may contain raw torrent exports;
// output is deliberately aggregate-only. No filesystem writes or network calls.
const I = require('../app/libs/content-groups/identity');
const G = require('../app/libs/content-groups');
const { safeRow } = require('../app/libs/content-groups/reader');
let input = ''; let bytes = 0;
process.stdin.on('data', chunk => {
  bytes += chunk.length;
  if (bytes > 96 * 1024 * 1024) { process.stderr.write('CG_INPUT_BOUND\n'); process.exit(1); }
  input += chunk;
});
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input); input = '';
    if (!Array.isArray(data.rows) || data.rows.length > 10000 || Object.keys(data.exports).length > 24) throw Error();
    const errors = {}; let attempts = 0;
    const tasks = data.rows.map(raw => {
      const row = safeRow(raw); const sample = data.exports[row.hash]; let proof = null;
      if (sample) {
        attempts++;
        try { proof = I.identity(Buffer.from(sample.data, 'base64'), row, sample.files, data.clientId); } catch (e) { const code = /^CG_[A-Z_]+$/.test(e.message) ? e.message : 'CG_UNPROVED'; errors[code] = (errors[code] || 0) + 1; }
      }
      return { row, files: sample && sample.files, proof };
    });
    const index = G.buildIndex(tasks, data.clientId);
    const proven = index.groups.filter(g => g.proved); const reasons = {};
    for (const g of proven) for (const r of g.reasons) reasons[r] = (reasons[r] || 0) + 1;
    const old = new Map();
    for (const t of tasks.filter(t => t.proof)) {
      if (!old.has(t.row.content_path)) old.set(t.row.content_path, new Set());
      old.get(t.row.content_path).add(index.groups.find(g => g.members.includes(t.row.hash)).id);
    }
    process.stdout.write(JSON.stringify({
      mode: 'offline_shadow',
      tasks: tasks.length,
      attempts,
      verifiedTasks: proven.reduce((n, g) => n + g.members.length, 0),
      verifiedGroups: proven.length,
      multiReferenceGroups: proven.filter(g => g.members.length > 1).length,
      verifiedPathBucketsSplit: [...old.values()].filter(s => s.size > 1).length,
      protectionReasons: reasons,
      failures: errors,
      deleteAuthorized: false,
      physicalAudit: 'not_performed',
      externalClients: 'not_checked',
      payloadReads: 0,
      exportsPersisted: 0
    }) + '\n');
  } catch (_) { process.stderr.write('CG_INPUT_FAILED\n'); process.exitCode = 1; }
});

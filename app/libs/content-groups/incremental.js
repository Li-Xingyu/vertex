'use strict';
const I = require('./identity');
function instance (row) {
  try { return I.digest(I.binding(row, 'snapshot')); } catch (_) { return null; }
}
// Cold historical rows form a baseline, not an implicit backfill work queue.
// A separate one-time migration must supply their missing identity proofs.
function plan (rows, previous, priority, now, maxTasks) {
  const old = previous.incremental;
  const known = {}; const pending = {}; const cache = previous.cache || {};
  const changed = new Set(priority || []);
  for (const row of rows) {
    const key = instance(row); known[row.hash] = key;
    if (!key) continue;
    const item = cache[row.hash];
    const work = old && old.pending && old.pending[row.hash];
    if (work && old.known[row.hash] === key) pending[row.hash] = work;
    if ((old && old.known[row.hash] !== key) || changed.has(row.hash) ||
        (item && (instance(item.row) !== key || now - item.checkedAt >= 300))) {
      if (!pending[row.hash] || changed.has(row.hash) || (old && old.known[row.hash] !== key)) pending[row.hash] = { due: now, queued: now };
    }
  }
  const selected = rows.filter(r => pending[r.hash] && pending[r.hash].due <= now)
    .sort((a, b) => pending[a.hash].queued - pending[b.hash].queued || Number(changed.has(b.hash)) - Number(changed.has(a.hash)) || a.hash.localeCompare(b.hash))
    .slice(0, maxTasks);
  return { known, pending, selected };
}
module.exports = { plan };

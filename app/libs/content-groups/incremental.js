'use strict';
const I = require('./identity');
function instance (row) {
  try { return I.digest(I.binding(row, 'snapshot')); } catch (_) { return null; }
}
// Cold historical rows form a baseline, not an implicit backfill work queue.
// A separate one-time migration must supply their missing identity proofs.
function plan (rows, previous, priority, now, maxTasks, refresh = null, clientId = null) {
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
  const normal = () => rows.filter(r => pending[r.hash] && pending[r.hash].due <= now)
    .sort((a, b) => pending[a.hash].queued - pending[b.hash].queued || Number(changed.has(b.hash)) - Number(changed.has(a.hash)) || a.hash.localeCompare(b.hash));
  const hints = refreshGroups(refresh, rows, previous, now, clientId);
  const preferred = []; const assigned = new Set(); let overdue = 0;
  for (const g of hints) {
    const age = now - Math.min(...g.members.map(h => cache[h].checkedAt));
    if (age < 180) continue;
    if (age > 660) overdue++;
    // Renew a whole cohort before expiry, not just the triggering hash. Large
    // groups span bounded passes, oldest member first; failures retain backoff.
    for (const h of [...g.members].sort((a, b) => cache[a].checkedAt - cache[b].checkedAt || a.localeCompare(b))) {
      if (now - cache[h].checkedAt < 180) continue;
      if (!pending[h]) pending[h] = { due: now, queued: now };
      if (pending[h].due <= now && !assigned.has(h)) { assigned.add(h); preferred.push(h); }
    }
  }
  const byHash = new Map(rows.map(r => [r.hash, r]));
  const ordinary = normal().filter(r => !assigned.has(r.hash));
  // Reserve one quarter for normal work whenever it exists. A one-item budget
  // alternates rather than starving either lane. No new requests are granted.
  const turn = Number.isSafeInteger(old && old.turn) ? old.turn + 1 : 0;
  const reserve = ordinary.length ? (maxTasks === 1 ? turn % 2 : Math.ceil(maxTasks / 4)) : 0;
  const selected = preferred.slice(0, maxTasks - reserve).map(h => byHash.get(h));
  selected.push(...ordinary.slice(0, maxTasks - selected.length));
  if (selected.length < maxTasks) {
    const used = new Set(selected.map(r => r.hash));
    selected.push(...preferred.filter(h => !used.has(h)).slice(0, maxTasks - selected.length).map(h => byHash.get(h)));
  }
  return { known, pending, selected, turn, refresh: { groups: hints.length, overdue, prioritySelected: selected.filter(r => assigned.has(r.hash)).length } };
}

function refreshGroups (hint, rows, previous, now, clientId) {
  if (!hint || hint.version !== 1 || hint.clientId !== clientId || !Number.isSafeInteger(hint.time) ||
      hint.time > now || now - hint.time > 660 || !Array.isArray(hint.groups) || hint.groups.length > 8) return [];
  const present = new Map(rows.map(r => [r.hash, r])); const cache = previous.cache || {}; const scopes = I.deleteScopes(rows);
  const groups = new Map(((previous.report && previous.report.groups) || []).map(g => ['cg1:' + g.id + ':' + g.revision, g]));
  const out = []; const seen = new Set();
  for (const item of hint.groups) {
    if (!item || typeof item.key !== 'string') continue;
    const g = groups.get(item.key);
    if (!g || !g.proved || g.revision !== item.revision || !Array.isArray(item.members) ||
        I.digest(g.members) !== I.digest(item.members) || g.reasons.some(r => r !== 'stale_manifest') ||
        !['renew', 'candidate'].includes(item.phase) || !item.bindings || seen.has(item.key) ||
        I.outsideScope(g.paths, new Set(g.members), scopes)) continue;
    const valid = g.members.every(h => {
      try {
        const row = present.get(h); const c = cache[h];
        return row && c && Number.isSafeInteger(c.checkedAt) && c.checkedAt > 0 && c.checkedAt <= now &&
          !['moving', 'missingFiles', 'error', 'checkingUP', 'checkingDL', 'checkingResumeData'].includes(row.state) &&
          I.digest(I.binding(row, clientId)) === I.digest(item.bindings[h]) &&
          I.current(c.proof, row, c.files, clientId);
      } catch (_) { return false; }
    });
    if (valid) { seen.add(item.key); out.push(item); }
  }
  // Oldest deadline first within a lane. Renewals cannot be displaced by a
  // large cold pool; a hint affects GET ordering only, never reclaim validity.
  return out.sort((a, b) => Number(b.phase === 'renew') - Number(a.phase === 'renew') ||
    Math.min(...a.members.map(h => cache[h].checkedAt)) - Math.min(...b.members.map(h => cache[h].checkedAt)) || a.key.localeCompare(b.key));
}
async function readRefreshHints (stateFile, clientId) {
  try {
    const fs = require('fs').promises; const path = require('path');
    const file = path.join(path.dirname(stateFile), '../governance/state.json');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) return null;
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    const usable = state.ok === true && state.groupingMode === 'exact-v1' && state.otherRootProtected === true &&
      state.fenceReady === true && state.refreshHints && state.refreshHints.time === state.time &&
      state.refreshHints.clientId === clientId;
    return usable ? state.refreshHints : null;
  } catch (_) { return null; }
}
module.exports = { plan, refreshGroups, readRefreshHints };

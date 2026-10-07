'use strict';
// Identity adapter for the EXISTING lifecycle auditor/policy/delete guard.
// Pure metadata only: no IO, mutation API, timer, physical permission or executor.
const I = require('./identity');
const G = require('./index');
const MODE = 'exact-v1';
const MAX_AGE = 660;
function raw (row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('CG_RECLAIM_ROW');
  const hash = I.hash(row.hash);
  if (row.originProp === undefined) return row;
  const origin = row.originProp;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) throw Error('CG_RECLAIM_ROW');
  // sync/maindata stores the hash in its object key. Vertex lifts that key to
  // row.hash, while originProp contains only the value. Preserve this identity
  // without mutating either snapshot, and never hide conflicting identities.
  if (origin.hash !== undefined && I.hash(origin.hash) !== hash) throw Error('CG_RECLAIM_HASH_CONFLICT');
  return { ...origin, hash };
}
const fresh = (at, now) => Number.isSafeInteger(at) && at > 0 && now >= at && now - at <= MAX_AGE;
const same = (a, b) => I.digest(a) === I.digest(b);
const groupKey = group => 'cg1:' + group.id + ':' + group.revision;

function prepare (snapshot, rows, clientId, now) {
  I.key(clientId);
  if (!snapshot || snapshot.schema !== 1 || snapshot.clientId !== clientId || !fresh(snapshot.at, now) ||
      !Array.isArray(rows) || rows.length > 10000) throw Error('CG_RECLAIM_SNAPSHOT');
  const tasks = rows.map(value => {
    const row = raw(value); const item = snapshot.cache && snapshot.cache[row.hash];
    return {
      row,
      files: item && item.files,
      proof: item && item.proof,
      manifestFresh: !!item && fresh(item.checkedAt, now)
    };
  });
  // Rebuild against the live complete brush-client snapshot, never trust report
  // membership or use an IYUU Success row as a content identity.
  const index = G.buildIndex(tasks, clientId); const byHash = new Map(tasks.map(t => [t.row.hash, t]));
  const groups = index.groups.filter(g => g.proved).map(g => ({
    ...g,
    key: groupKey(g),
    bindings: Object.fromEntries(g.members.map(h => [h, I.binding(byHash.get(h).row, clientId)])),
    manifestDigest: byHash.get(g.members[0]).proof.manifestDigest,
    checkedAt: Math.min(...g.members.map(h => snapshot.cache[h].checkedAt))
  }));
  return { schema: 1, mode: MODE, clientId, at: now, groups, summary: index.summary };
}

// A batch can lose ONLY members already confirmed removed by that very guard
// invocation. This capability is RAM-only and must never be persisted in state.
const drains = new WeakMap();
function draining (state, key, removedRows) {
  const copy = { ...state }; const prior = state.exactGroups.groups.find(g => g.key === key);
  if (!prior || !Array.isArray(removedRows)) throw Error('CG_RECLAIM_DRAIN');
  const removed = removedRows.map(r => raw(r).hash);
  if (new Set(removed).size !== removed.length || removed.some(h => !prior.members.includes(h))) throw Error('CG_RECLAIM_DRAIN');
  for (const row of removedRows) {
    const r = raw(row);
    if (!same(I.binding(r, state.exactGroups.clientId), prior.bindings[r.hash]) ||
        !Number.isSafeInteger(r.uploaded) || r.uploaded < 0) throw Error('CG_RECLAIM_DRAIN');
  }
  drains.set(copy, { key, removed: new Set(removed), rows: removedRows.map(r => ({ ...raw(r) })) }); return copy;
}

function removedRows (state) { const d = drains.get(state); return d ? d.rows : []; }

const contexts = new WeakMap();
function context (rows, state, now) {
  let byState = contexts.get(rows);
  if (!byState) { byState = new WeakMap(); contexts.set(rows, byState); }
  const cached = byState.get(state);
  if (cached && cached.tick === Math.floor(now)) return cached;
  const result = { tick: Math.floor(now), byHash: new Map(), groups: [] };
  const proof = state.exactGroups;
  if (!proof || proof.schema !== 1 || proof.mode !== MODE || !fresh(proof.at, now) ||
      !Array.isArray(proof.groups) || proof.groups.length > 10000) return result;
  let current; let scopes;
  try {
    const normalized = rows.map(raw);
    current = new Map(normalized.map((r, i) => [r.hash, rows[i]]));
    if (current.size !== rows.length) return result;
    scopes = I.deleteScopes(normalized);
  } catch (_) { return result; }
  const drain = drains.get(state); const assigned = new Set();
  for (const g of proof.groups) {
    if (!g || !Array.isArray(g.members) || !g.members.length || !Array.isArray(g.paths) || g.paths.length !== 1 ||
        !Array.isArray(g.reasons) || !Array.isArray(g.files) || !g.files.length || !g.bindings ||
        g.key !== groupKey(g) || new Set(g.members).size !== g.members.length || g.members.some(h => assigned.has(h))) return { tick: result.tick, byHash: new Map(), groups: [] };
    for (const h of g.members) assigned.add(h);
    const removed = drain && drain.key === g.key ? drain.removed : new Set();
    const members = g.members.filter(h => !removed.has(h));
    const group = members.map(h => current.get(h));
    let bound = members.length > 0 && [...removed].every(h => !current.has(h));
    for (const row of group) {
      try {
        const r = raw(row);
        bound = bound && same(I.binding(r, proof.clientId), g.bindings[r.hash]) &&
          !['moving', 'missingFiles', 'error', 'checkingUP', 'checkingDL', 'checkingResumeData'].includes(r.state);
      } catch (_) { bound = false; }
    }
    let valid = bound && !g.reasons.length && fresh(g.checkedAt, now);
    // Separate groups sharing any delete scope protect each other; they do NOT
    // share yield/H&R/history. Unknown references are protective too.
    const outside = I.outsideScope(g.paths, new Set(members), scopes);
    if (outside) valid = false;
    // Nomination for a read-only refresh is NOT a deletion capability. Stale
    // manifests may be rechecked, but every other structural protection stays.
    const refreshable = bound && !outside && g.reasons.every(r => r === 'stale_manifest');
    let invalidReason = null;
    if (!bound) invalidReason = 'instance_changed';
    else if (outside) invalidReason = 'external_reference';
    else if (!fresh(g.checkedAt, now) || g.reasons.includes('stale_manifest')) invalidReason = 'manifest_stale';
    else if (g.reasons.length) invalidReason = 'identity_protected';
    const entry = { key: g.key, revision: g.revision, identity: g, group: group.filter(Boolean), bound, valid, refreshable, invalidReason };
    result.groups.push(entry);
    for (const h of members) result.byHash.set(h, entry);
  }
  byState.set(state, result); return result;
}

function structure (rows, row, state, now) {
  try {
    const entry = context(rows, state, now).byHash.get(raw(row).hash);
    return entry || { key: null, group: [], valid: false };
  } catch (_) { return { key: null, group: [], valid: false }; }
}

function checkManifest (entry, row, files, clientId) {
  try {
    const r = raw(row); const g = entry.identity; const manifest = I.manifest(r, files);
    if (!entry.valid || !g) return { ok: false, reason: entry.invalidReason || 'structure_invalid' };
    if (!same(I.binding(r, clientId), g.bindings[r.hash])) return { ok: false, reason: 'binding_changed' };
    if (manifest.digest !== g.manifestDigest) return { ok: false, reason: 'manifest_digest_changed' };
    if (!same(manifest.physical, g.files)) return { ok: false, reason: 'physical_manifest_changed' };
    if (!files.every(f => f.priority > 0)) return { ok: false, reason: 'selective_download' };
    return { ok: true, reason: null };
  } catch (_) { return { ok: false, reason: 'manifest_invalid' }; }
}

function validateManifest (entry, row, files, clientId) { return checkManifest(entry, row, files, clientId).ok; }

function permit (entry, audit) {
  return entry.valid && audit && Array.isArray(audit.members) && audit.groupKey === entry.key && audit.groupRevision === entry.revision &&
    same([...audit.members].sort(), [...entry.identity.members].sort());
}

module.exports = { MODE, MAX_AGE, prepare, context, structure, groupKey, validateManifest, checkManifest, permit, draining, removedRows };

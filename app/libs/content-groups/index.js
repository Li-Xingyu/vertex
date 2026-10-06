'use strict';
const I = require('./identity');

// This snapshot is NOT a deletion permit. Logical identity and physical references
// have different keys; neither a save directory nor IYUU Success joins groups.
function buildIndex (tasks, clientId) {
  I.key(clientId);
  const groups = new Map(); const references = new Map(); const oldPaths = new Map();
  const unproved = []; const seen = new Set(); const byHash = new Map(tasks.map(t => [t.row.hash, t]));
  for (const task of tasks) {
    const row = task.row; const h = I.hash(row.hash);
    if (seen.has(h)) throw Error('CG_DUPLICATE_TASK'); seen.add(h);
    let manifest; let proved = false;
    try { manifest = I.manifest(row, task.files); proved = I.current(task.proof, row, task.files, clientId); } catch (_) {}
    const id = proved ? I.digest(['content-group-v1', clientId, task.proof.contentId, manifest.physical]) : 'unproved:' + h;
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        proved,
        members: [],
        paths: new Set(),
        contentId: proved ? task.proof.contentId : null,
        reasons: new Set(proved ? [] : ['identity_unproved']),
        files: manifest ? manifest.physical : []
      });
    }
    const group = groups.get(id); group.members.push(h); group.paths.add(row.content_path);
    if (task.manifestFresh === false) group.reasons.add('stale_manifest');
    if (!proved) unproved.push(h);
    if (manifest) {
      for (const [file] of manifest.physical) {
        if (!references.has(file)) references.set(file, new Set()); references.get(file).add(h);
      }
    }
    if (!oldPaths.has(row.content_path)) oldPaths.set(row.content_path, new Set()); oldPaths.get(row.content_path).add(id);
  }
  for (const group of groups.values()) {
    group.members.sort(); const members = new Set(group.members);
    for (const [file] of group.files) {
      if ([...(references.get(file) || [])].some(h => !members.has(h))) group.reasons.add('external_file_reference');
    }
    // qB deletion may also clean a containing directory. Unknown manifests and
    // parent/child scopes must remain protective, not silently ignored.
    for (const t of tasks) {
      if (members.has(t.row.hash)) continue;
      for (const p of group.paths) {
        const q = t.row.content_path;
        if (typeof p !== 'string' || typeof q !== 'string' || !p || !q || I.within(p, q) || I.within(q, p)) group.reasons.add('external_delete_scope');
      }
    }
    group.revision = I.digest(group.members.map(h => {
      const t = byHash.get(h); return [h, t.row.added_on, t.proof && t.proof.binding, t.proof && t.proof.manifestDigest];
    }));
    group.paths = [...group.paths].sort(); group.reasons = [...group.reasons].sort();
  }
  return {
    schema: 1,
    mode: 'shadow',
    deleteAuthorized: false,
    groups: [...groups.values()],
    summary: {
      tasks: tasks.length,
      proved: tasks.length - unproved.length,
      unproved: unproved.length,
      groups: groups.size,
      multiReferenceGroups: [...groups.values()].filter(g => g.proved && g.members.length > 1).length,
      pathBucketsSplit: [...oldPaths.values()].filter(s => s.size > 1).length,
      blockedGroups: [...groups.values()].filter(g => g.reasons.length).length
    }
  };
}

// Conservative reservation, not actual free space. Proved identical instances
// reserve the maximum remaining in the group; unproved identities never dedup.
function reservation (tasks, index, pendingBytes = 0) {
  if (!Number.isSafeInteger(pendingBytes) || pendingBytes < 0) throw Error('CG_PENDING_BYTES');
  const byHash = new Map(tasks.map(t => [t.row.hash, t.row]));
  let bytes = pendingBytes; let uncertain = 0;
  for (const g of index.groups) {
    const values = g.members.map(h => {
      const r = byHash.get(h); const n = r.amount_left;
      if (!Number.isSafeInteger(n) || n < 0) { uncertain++; return Number.isSafeInteger(r.total_size) && r.total_size > 0 ? r.total_size : Infinity; }
      return n;
    });
    bytes += g.proved ? Math.max(...values) : values.reduce((a, b) => a + b, 0);
  }
  return {
    bytes: Number.isSafeInteger(bytes) ? bytes : null,
    uncertain,
    pendingBytes,
    includesPaused: true,
    usableForAdmission: false
  };
}

// Path-keyed history is deliberately NOT imported. Membership changes, missing
// samples, or counter resets start a new observation window; they never mean zero.
function observe (previous, tasks, index, now, maxGapSeconds = 660) {
  const byHash = new Map(tasks.map(t => [t.row.hash, t.row])); const result = {};
  for (const g of index.groups.filter(g => g.proved)) {
    const counters = g.members.map(h => [h, byHash.get(h).uploaded, byHash.get(h).downloaded]);
    if (counters.some(c => c.slice(1).some(n => !Number.isSafeInteger(n) || n < 0))) continue;
    const up = counters.reduce((s, c) => s + c[1], 0); const down = counters.reduce((s, c) => s + c[2], 0);
    const old = previous && previous[g.id];
    const valid = old && old.revision === g.revision && now > old.at && now - old.at <= maxGapSeconds &&
      counters.every((c, i) => old.counters[i] && c[0] === old.counters[i][0] && c[1] >= old.counters[i][1] && c[2] >= old.counters[i][2]);
    const samples = valid ? old.samples.filter(s => now - s.at <= 13 * 3600) : [];
    samples.push({ at: now, up, down });
    result[g.id] = { revision: g.revision, at: now, counters, samples, reset: !valid };
  }
  return result;
}

module.exports = { buildIndex, reservation, observe };

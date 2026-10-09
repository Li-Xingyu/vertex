'use strict';
const GiB = 1024 ** 3;
const hash = v => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(v || '');
// A resource envelope, NOT a rate quota, physical allocation estimate, content
// identity or deletion permit. Conservative hash de-duplication within ONE RSS.
function exposure (selection, owners, snapshot, pending, candidate, now, ownIntent = false) {
  const limit = selection.maxInFlightGiB;
  if (!limit) return { allowed: true, enabled: false };
  const unknown = () => ({ allowed: false, enabled: true, reason: 'exposure-unverified' });
  if (!snapshot || !Array.isArray(snapshot.torrents) || !Number.isFinite(snapshot.providerSnapshotAt) ||
    snapshot.providerSnapshotAt > now || now - snapshot.providerSnapshotAt > 120 ||
    !Array.isArray(pending) || !Number.isFinite(candidate.size) || candidate.size <= 0) return unknown();
  const live = new Map(snapshot.torrents.map(t => [t.hash, t]));
  const charges = new Map();
  for (const [key, record] of owners) {
    if (!Number.isFinite(record.at) || record.at <= 0 || record.at > now || !Number.isFinite(record.size) || record.size <= 0) return unknown();
    const t = live.get(key);
    if (t) {
      if (!Number.isFinite(t.size) || t.size <= 0 || !Number.isFinite(t.progress) || t.progress < 0 || t.progress > 1) return unknown();
      if (t.progress < 1) charges.set(key, t.size); // paused unfinished originals still cost investment
    } else if (now - record.at <= 1200) {
      // Success can be durable before the next qB snapshot; don't spend twice.
      if (!Number.isFinite(record.size) || record.size <= 0 || record.at > now) return unknown();
      charges.set(key, record.size);
    }
  }
  for (const item of pending) {
    let p;
    try { p = JSON.parse(item.payload); } catch (_) { return unknown(); }
    if (p.reseed === true) continue;
    const t = p.torrent;
    if (!t || !hash(item.true_hash || t.hash) || !Number.isFinite(t.size) || t.size <= 0) return unknown();
    const key = (item.true_hash || t.hash).toLowerCase();
    // finalCheck owns this exact existing intent; all other reservations count.
    if (ownIntent && key === candidate.hash && t.candidateKey === candidate.candidateKey) continue;
    charges.set(key, Math.max(charges.get(key) || 0, t.size));
  }
  const used = [...charges.values()].reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(used)) return unknown();
  return {
    enabled: true,
    allowed: used + candidate.size <= limit * GiB,
    reason: used + candidate.size <= limit * GiB ? null : 'inflight-investment',
    usedGiB: used / GiB,
    limitGiB: limit
  };
}
function entrySnapshot (torrent, at) {
  if (!/^[A-Z][A-Z0-9_]{1,32}$/.test(torrent.siteId || '') ||
    !new RegExp('^' + torrent.siteId + ':[1-9]\\d{0,19}$').test(torrent.candidateKey || '') ||
    !Number.isFinite(torrent.fetchedAt) || !Number.isFinite(at)) return null;
  const fields = ['size', 'seeders', 'leechers', 'pubTime', 'fetchedAt',
    'downloadFactor', 'uploadFactor', 'downloadUntil', 'uploadUntil'];
  // Whitelist facts only; no names, URLs, cookies, trackers or peer addresses.
  return JSON.stringify({
    version: 1,
    confirmedAt: at,
    siteId: torrent.siteId,
    candidateKey: torrent.candidateKey,
    hrState: ['required', 'exempt', 'unknown'].includes(torrent.hrState) ? torrent.hrState : 'unknown',
    ...Object.fromEntries(fields.map(k => [k, Number.isFinite(torrent[k]) && torrent[k] >= 0 ? torrent[k] : null]))
  });
}
module.exports = { exposure, entrySnapshot };

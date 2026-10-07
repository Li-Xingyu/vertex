'use strict';
// A page notice supplies duration only: it never makes a row FREE or H&R-free.
// Configured campaign identity, row membership and independent FREE must agree.
const norm = s => String(s || '').replace(/\s+/g, '').trim();
function evidence (dom, rules, now, epoch, offset) {
  if (!rules?.length) return [];
  const closed = e => !!e && !!dom.nodeLocation(e)?.endTag;
  const d = dom.window.document;
  if (!closed(d.documentElement) || !closed(d.body)) return [];
  return (rules || []).map(rule => {
    const intervals = [];
    for (const e of [...d.querySelectorAll(rule.selector)].slice(0, 3000)) {
      const text = e.textContent.trim();
      if (!closed(e) || text.length > 512 || !norm(text).startsWith(norm(rule.textPrefix))) continue;
      const date = label => {
        const parts = text.split(label);
        if (parts.length !== 2) return null;
        const m = parts[1].trim().match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*\(GMT([+-]\d{2}:\d{2})\)/);
        return m ? epoch(m[1].replace(' ', 'T') + m[2], offset) : null;
      };
      const start = date(rule.startLabel); const end = date(rule.endLabel);
      if (start === null || end === null || start > now || end <= now || end <= start) return { rule, end: null };
      intervals.push(start + ':' + end);
    }
    const distinct = [...new Set(intervals)];
    return { rule, end: distinct.length === 1 ? Number(distinct[0].split(':')[1]) : null };
  });
}
function apply (root, candidate, records, ownDeadlinePresent = false) {
  // Single-torrent promotion is independent of the temporary campaign. Its
  // own deadline wins; an ambiguous/malformed own timer cannot be overwritten.
  if (candidate.downloadFactor !== 0 || candidate.conflict || Number.isFinite(candidate.downloadUntil) || candidate.downloadUnlimited === true || ownDeadlinePresent) return;
  const ends = records.filter(({ rule, end }) => Number.isFinite(end) &&
    [...root.querySelectorAll(rule.rowSelector)].some(e => norm(e.textContent) === norm(rule.rowText))).map(x => x.end);
  if (ends.length) candidate.downloadUntil = Math.min(...ends);
}
module.exports = { evidence, apply };

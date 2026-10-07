'use strict';
// Only positive account activity suppresses this cycle. Inactive/history signals
// never authorise a download, establish content identity or prove H&R completion.
const states = ['seeding', 'downloading', 'inactive'];
function read (root, rules, json, valueAt) {
  const found = new Set();
  for (const r of rules || []) {
    if (json) {
      if (valueAt(root, r.path) === r.equals) found.add(r.state);
    } else {
      for (const el of root.querySelectorAll(r.selector)) {
        if (r.format === 'nexus-progress') {
          const m = /^(seeding|leeching|inactivity)\s+(\d+(?:\.\d+)?)%$/i.exec((el.getAttribute('title') || '').trim());
          if (m && +m[2] <= 100) found.add({ seeding: 'seeding', leeching: 'downloading', inactivity: 'inactive' }[m[1].toLowerCase()]);
        } else found.add(r.state);
      }
    }
  }
  return found.size === 1 ? [...found][0] : 'unknown';
}
function active (row, config, now = Date.now() / 1000) {
  return ['seeding', 'downloading'].includes(row.personalState) &&
    Number.isFinite(row.fetchedAt) && row.fetchedAt <= now + 30 && now - row.fetchedAt <= config.intervalSeconds * 2;
}
function merge (old, row) {
  // Contradictory pinned/paginated observations fall back to local dedup.
  if (old.personalState !== row.personalState) old.personalState = 'unknown';
}
module.exports = { states, read, active, merge };

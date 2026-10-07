'use strict';
const { JSDOM } = require('jsdom');
const { fail } = require('./provider-schema');
const personal = require('./provider-personal');
function valueAt (obj, path) {
  return (path || '').split('.').reduce((x, k) => x && Object.prototype.hasOwnProperty.call(x, k) ? x[k] : undefined, obj);
}
function number (s) {
  const v = String(s === undefined || s === null ? '' : s).replace(/,/g, '').trim();
  return /^\d+(?:\.\d+)?$/.test(v) && Number.isFinite(+v) ? +v : null;
}
function size (s) {
  if (typeof s === 'number') return Number.isSafeInteger(s) && s > 0 ? s : null;
  const m = String(s || '').trim().match(/^(\d+(?:\.\d+)?)\s*([KMGTPE]?)(?:i?B)$/i);
  return m ? +m[1] * 1024 ** (' KMGTPE'.indexOf(m[2].toUpperCase())) : number(s);
}
function epoch (s, offset) {
  if (s === null || s === undefined || s === '') return null;
  if (/^\d{10}(?:\.\d+)?$/.test(String(s))) return Math.floor(+s);
  if (/^\d{13}$/.test(String(s))) return Math.floor(+s / 1000);
  let text = String(s).trim();
  // A <br> between date and time can disappear in textContent. Never replace
  // missing publication with fetch time; only repair this unambiguous format.
  text = text.replace(/^(\d{4}[-/]\d{2}[-/]\d{2})(\d{2}:\d{2}(?::\d{2})?)$/, '$1T$2');
  if (/^\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(text)) {
    text = text.replace(/\//g, '-').replace(' ', 'T') + (offset >= 0 ? '+' : '-') + String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0') + ':' + String(Math.abs(offset) % 60).padStart(2, '0');
  } else if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) return null;
  const n = Date.parse(text); return Number.isFinite(n) ? Math.floor(n / 1000) : null;
}
function url (v, profile, kind) {
  if (!v) return null;
  try {
    const u = new URL(v, profile.origin);
    if (u.origin !== profile.origin || u.username || u.password || u.hash || !profile[kind + 'Paths'].includes(u.pathname)) return null;
    return u.toString();
  } catch (_) { return null; }
}
function readHtml (row, m, offset) {
  if (m.format === 'boolean') return !!m.selector && !!row.querySelector(m.selector);
  let scope = row;
  if (m.header) {
    const table = row.closest('table');
    if (!table) return null;
    const heading = [...table.rows].find(r => r.closest('table') === table && [...r.cells].some(c => c.querySelector(m.header)));
    if (!heading || heading.cells.length !== row.cells.length) return null;
    const index = [...heading.cells].findIndex(c => c.querySelector(m.header));
    scope = row.cells[index];
  }
  const matches = m.selector ? [...scope.querySelectorAll(m.selector)] : [scope];
  if (m.format === 'date') {
    // A configured date selector can match tooltips as well as timestamps.
    // Accept only one distinct valid timestamp; never take the favourable
    // first value when promotion dates disagree.
    const dates = matches.map(e => epoch(m.attribute ? e.getAttribute(m.attribute) : e.textContent.trim(), offset)).filter(v => v !== null);
    return consistent(dates);
  }
  const element = matches.find(e => m.attribute ? e.getAttribute(m.attribute) : e.textContent.trim());
  // A torrent row may contain a nested title layout. Row selectors and stable
  // site IDs perform row de-duplication; the nested title must still be readable.
  if (!element) return null;
  return m.attribute ? element.getAttribute(m.attribute) : element.textContent.replace(/\s+/g, ' ').trim();
}
function signals (root, rules, json) {
  const normalize = s => s.replace(/\s+/g, '').toLowerCase();
  return rules.filter(r => json ? valueAt(root, r.path) === r.equals : [...root.querySelectorAll(r.selector)].some(e => r.text === undefined || normalize(e.textContent) === normalize(r.text)));
}
function consistent (values) { const s = [...new Set(values.filter(v => v !== null && v !== undefined))]; return s.length === 1 ? s[0] : null; }
function parse (body, config, profile, now = Date.now() / 1000) {
  let dom;
  try {
    const json = profile.adapter === 'mteam-api';
    let rows;
    if (json) {
      const source = typeof body === 'string' ? JSON.parse(body) : body;
      rows = valueAt(source, config.mapping.rows);
      if (!Array.isArray(rows)) fail('PROVIDER_RESPONSE_SHAPE');
    } else {
      if (typeof body !== 'string' || Buffer.byteLength(body) > 8 * 1024 ** 2) fail('PROVIDER_BODY_LIMIT');
      dom = new JSDOM(body, { includeNodeLocations: !!config.hrAbsence }); // No scripts, resources or browser execution.
      const d = dom.window.document;
      if (d.querySelector('input[type="password"]') || /cf-chl-|checking your browser|verify you are human/i.test(body)) fail('PROVIDER_AUTH');
      if (!config.mapping.authenticated || !d.querySelector(config.mapping.authenticated)) fail('PROVIDER_AUTH');
      rows = [...d.querySelectorAll(config.mapping.rows)];
      if (rows.length > 3000) fail('PROVIDER_ROW_LIMIT');
    }
    const candidates = new Map(); let invalid = 0; let conflicts = 0;
    for (const root of rows.slice(0, 3000)) {
      const raw = {};
      for (const [key, m] of Object.entries(config.mapping.fields)) raw[key] = json ? valueAt(root, m.path) : readHtml(root, m, config.mapping.timezoneOffset);
      let id = raw.id;
      const im = config.mapping.fields.id;
      if (im.query && id) { try { id = new URL(id, profile.origin).searchParams.get(im.query); } catch (_) { id = null; } }
      if (!/^[1-9]\d{0,19}$/.test(String(id || '')) || !String(raw.title || '').trim()) { invalid++; continue; }
      const promos = signals(root, config.promotionRules, json); const hrs = signals(root, config.hrRules, json);
      const c = {
        candidateKey: config.profile + ':' + id,
        siteId: config.profile,
        torrentId: String(id),
        name: String(raw.title).trim().slice(0, 512),
        size: size(raw.size),
        sizeExact: false,
        seeders: number(raw.seeders),
        leechers: number(raw.leechers),
        pubTime: epoch(raw.publishedAt, config.mapping.timezoneOffset),
        fetchedAt: now,
        personalState: personal.read(root, config.personalStateRules, json, valueAt),
        downloadFactor: consistent(promos.map(r => r.downloadFactor)),
        uploadFactor: consistent(promos.map(r => r.uploadFactor)),
        downloadUntil: epoch(raw.downloadUntil, config.mapping.timezoneOffset),
        uploadUntil: epoch(raw.uploadUntil, config.mapping.timezoneOffset),
        downloadUnlimited: raw.downloadUnlimited === true,
        uploadUnlimited: raw.uploadUnlimited === true,
        hrState: consistent(hrs.map(r => r.state)) || 'unknown',
        hrEvidence: hrs.length ? 'explicit-marker' : 'missing-marker',
        link: json ? profile.origin + '/detail/' + id + '?id=' + id : url(raw.detail, profile, 'detail'),
        url: json ? null : url(raw.download, profile, 'download')
      };
      for (const k of ['seeders', 'leechers']) if (!Number.isSafeInteger(c[k])) c[k] = null;
      if (c.size !== null && (!Number.isSafeInteger(Math.ceil(c.size)) || c.size <= 0)) c.size = null;
      if (!json && config.hrAbsence && !hrs.length) {
        // A parser can repair truncated HTML. Absence is evidence only with
        // original closing tags, the configured row structure and core fields.
        const closed = e => !!e && !!dom.nodeLocation(e)?.endTag;
        const d = dom.window.document;
        if (closed(d.documentElement) && closed(d.body) && closed(root) && !root.querySelector(config.mapping.rows) &&
          config.hrAbsence.rowSelectors.every(s => [...root.querySelectorAll(s)].some(closed)) &&
          [c.size, c.seeders, c.leechers, c.pubTime].every(Number.isFinite) && c.link && c.url) {
          c.hrState = 'exempt'; c.hrEvidence = 'site-rule-unmarked';
        }
      }
      const old = candidates.get(c.candidateKey);
      if (old) {
        personal.merge(old, c);
        // Duplicate pinned rows are common. Never choose the more favourable
        // side of contradictory safety metadata.
        if (['downloadFactor', 'uploadFactor', 'hrState', 'downloadUntil', 'uploadUntil', 'downloadUnlimited', 'uploadUnlimited', 'size'].some(k => old[k] !== c[k])) {
          old.conflict = true; conflicts++;
        }
      } else candidates.set(c.candidateKey, c);
      if (candidates.size > 500) fail('PROVIDER_CANDIDATE_LIMIT');
    }
    if (!candidates.size) fail('PROVIDER_EMPTY_OR_CHANGED');
    return { candidates: [...candidates.values()], coverage: { rows: rows.length, valid: candidates.size, invalid, conflicts, scope: 'configured-pages-only' } };
  } catch (e) { if (e.code && e.code.startsWith('PROVIDER_')) throw e; fail('PROVIDER_PARSE'); } finally { if (dom) dom.window.close(); }
}
function eligibility (c, config, now = Date.now() / 1000) {
  const s = config.selection; const why = [];
  if (c.conflict) why.push('conflicting-evidence');
  if (!Number.isFinite(c.fetchedAt) || now - c.fetchedAt > config.intervalSeconds * 2 || c.fetchedAt > now + 30) why.push('stale');
  if (c.size === null || c.seeders === null || c.leechers === null || c.pubTime === null) why.push('missing-fields');
  if (c.size < s.minGiB * 1024 ** 3 || c.size > s.maxGiB * 1024 ** 3) why.push('size');
  if (c.seeders < s.minSeeders || c.leechers < s.minLeechers) why.push('supply-demand');
  if (now - c.pubTime > s.maxAgeHours * 3600 || c.pubTime > now + 300) why.push('age');
  if (s.hrPolicy === 'exclude' && c.hrState !== 'exempt') why.push('hr-not-exempt');
  if (s.freeOnly && c.downloadFactor !== 0) why.push('not-confirmed-free');
  if (s.freeOnly && ((Number.isFinite(c.downloadUntil) && c.downloadUntil - now < s.minFreeSeconds) || (!Number.isFinite(c.downloadUntil) && c.downloadUnlimited !== true))) why.push('free-expiry-unverified');
  return why;
}
function rank (a, b, config, now = Date.now() / 1000) {
  // A fresh explicit marker proves the currently advertised multiplier, not its
  // future duration. Unknown end dates remain unknown and never grant FREE.
  const factor = c => config.selection.preferUploadFactor && c.uploadFactor !== null && now - c.fetchedAt <= config.intervalSeconds * 2 && (c.uploadUntil === null || c.uploadUntil > now) ? c.uploadFactor : 1;
  const score = c => (c.leechers || 0) / Math.sqrt((c.seeders || 0) + 1) * factor(c);
  return config.selection.sort === 'demand' ? score(b) - score(a) || b.pubTime - a.pubTime : b.pubTime - a.pubTime || score(b) - score(a);
}
module.exports = { parse, eligibility, rank, number, size, epoch, valueAt };

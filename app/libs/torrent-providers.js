'use strict';
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const bencode = require('bencode');
const { ProviderStore } = require('./provider-store');
const { profiles, defaults } = require('./provider-profiles');
const { validate, digest, fail } = require('./provider-schema');
const parser = require('./provider-parser');
const transport = require('./provider-http');
const { infoSlice } = require('./provider-torrent');

const store = new ProviderStore();
const bridges = new Map(); const proofs = new Map(); const states = new Map(); const busy = new Set();
const prepared = new WeakMap();
const terminalHistory = new Map();
const contextKey = Symbol('vertex-provider-context');
const backoffUntil = new Map();
const util = () => require('./util');
const cleanCode = e => /^PROVIDER_[A-Z_]+$/.test(e.code || '') ? e.code : 'PROVIDER_UNAVAILABLE';
const latest = r => r.revisions[r.revisions.length - 1];
const bridge = c => bridges.get(c.rssId);
function register (rssId, value) {
  if (!/^[a-f0-9]{8}$/.test(rssId) || !value || typeof value.check !== 'function') fail('PROVIDER_BRIDGE');
  if (bridges.has(rssId)) fail('PROVIDER_DUPLICATE_OWNER');
  bridges.set(rssId, value);
  return () => bridges.delete(rssId);
}
function state (id) {
  if (!states.has(id)) states.set(id, { lastAttempt: 0, lastSuccess: 0, nextAttempt: 0, error: null, candidates: 0, failures: 0, observations: [] });
  return states.get(id);
}
async function credential (c) {
  if (bridge(c) && bridge(c).credential) return bridge(c).credential(c);
  if (c.credentialRef === 'driver') fail('PROVIDER_DRIVER_REQUIRED');
  if (c.credentialRef.startsWith('rss:')) {
    const r = util().listRss().find(r => r.id === c.rssId);
    if (!r || !r.cookie) fail('PROVIDER_CREDENTIAL_MISSING');
    // The credential's original RSS origin must agree; config cannot redirect it.
    if (!(r.rssUrls || []).some(v => { try { return new URL(v).origin === profiles[c.profile].origin; } catch (_) { return false; } })) fail('PROVIDER_CREDENTIAL_ORIGIN');
    return r.cookie;
  }
  const name = c.credentialRef.slice(5); const s = util().listSite().find(s => s.name === name);
  const origin = global.SITE && global.SITE.siteUrlMap && global.SITE.siteUrlMap[name];
  if (!s || !s.cookie || !origin || new URL(origin).origin !== profiles[c.profile].origin) fail('PROVIDER_CREDENTIAL_ORIGIN');
  return s.cookie;
}
async function consume (c, kind) {
  // Budget uses profile (not RSS/revision) so cloning/saving does not reset it.
  return store.serial(async () => {
    await fs.mkdir(store.root, { recursive: true, mode: 0o700 });
    const file = path.join(store.root, 'budget-' + c.profile + '.json');
    let b;
    try { b = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') fail('PROVIDER_BUDGET_STORE'); b = {}; }
    const hour = Math.floor(Date.now() / 3600000);
    if (b.hour !== hour) b = { hour, list: 0, detail: 0, metadata: 0 };
    if (!Number.isSafeInteger(b[kind]) || b[kind] < 0) fail('PROVIDER_BUDGET_STORE');
    if (b[kind] >= c.budgets[kind + 'PerHour']) fail('PROVIDER_BUDGET_EXHAUSTED');
    b[kind]++;
    const tmp = file + '.tmp'; const f = await fs.open(tmp, 'w', 0o600);
    try { await f.writeFile(JSON.stringify(b)); await f.sync(); } finally { await f.close(); }
    await fs.rename(tmp, file);
  });
}
async function fetchList (c, preview = false, observe) {
  if (observe !== undefined && typeof observe !== 'function') fail('PROVIDER_OBSERVER_INVALID');
  const p = profiles[c.profile]; const owner = bridge(c);
  if (Date.now() < (backoffUntil.get(c.profile) || 0)) fail('PROVIDER_RATE_LIMIT');
  // Independent sites do not share a concurrency quota. Keep only per-profile
  // exclusion; each source retains its own request budget and timeouts.
  if (busy.has(c.profile)) fail('PROVIDER_BUSY');
  busy.add(c.profile);
  try {
    if (p.adapter === 'mteam-api') {
      if (!owner || !owner.list || !owner.prepare) fail('PROVIDER_DRIVER_REQUIRED');
      // The MT bridge must reuse its existing ledger. Preview uses search only.
      return parser.parse(await owner.list(c, { preview, charge: () => consume(c, 'list') }), c, p);
    }
    const start = Date.now(); const t = c.listTimeouts;
    const remainingCycle = () => {
      const ms = (t ? t.cycleSeconds * 1000 : 25000) - (Date.now() - start);
      if (ms <= 0) fail('PROVIDER_CYCLE_DEADLINE');
      return ms;
    };
    const cookie = await credential(c); const all = new Map(); const coverage = [];
    let next = null;
    for (let page = 0; page < (preview ? 1 : c.pages); page++) {
      if (page && !next) break;
      remainingCycle();
      const u = new URL(p.listPath, p.origin);
      for (const [k, v] of Object.entries(c.params)) u.searchParams.set(k, v);
      if (page) u.searchParams.set('page', page);
      await consume(c, 'list');
      const options = t
        ? { connectTimeoutMs: t.connectSeconds * 1000, dnsTimeoutMs: t.connectSeconds * 1000, idleTimeoutMs: t.readSeconds * 1000, totalTimeoutMs: Math.min(t.requestSeconds * 1000, remainingCycle()) }
        : { totalTimeoutMs: Math.min(20000, remainingCycle()) };
      const text = (await transport.request(u.toString(), p.origin, cookie, undefined, options)).toString('utf8');
      remainingCycle();
      const result = parser.parse(text, c, p); coverage.push(result.coverage);
      // Private migration tooling compares the same budgeted response. Raw
      // bodies are never added to API results or persisted candidate records.
      if (observe) observe({ text, url: u.toString() });
      for (const row of result.candidates) {
        const old = all.get(row.candidateKey);
        if (old && ['downloadFactor', 'uploadFactor', 'downloadUntil', 'uploadUntil', 'downloadUnlimited', 'uploadUnlimited', 'hrState', 'size'].some(k => old[k] !== row[k])) old.conflict = true;
        else if (!old) all.set(row.candidateKey, row);
      }
      // Only follow paging observed in the authenticated response, never a URL
      // supplied by a response redirect or an unbounded page counter.
      const { JSDOM } = require('jsdom'); const dom = new JSDOM(text);
      try { next = [...dom.window.document.querySelectorAll('a[href]')].some(a => { try { const v = new URL(a.getAttribute('href'), p.origin); return v.origin === p.origin && v.pathname === p.listPath && v.searchParams.get('page') === String(page + 1); } catch (_) { return false; } }); } finally { dom.window.close(); }
      if (all.size > 500) fail('PROVIDER_CANDIDATE_LIMIT');
      remainingCycle();
    }
    return { candidates: [...all.values()], coverage: { pages: coverage, scope: 'configured-pages-only', morePagesObserved: !!next } };
  } catch (e) {
    if (e.code === 'PROVIDER_RATE_LIMIT' || e.retryAfterSeconds > 0) backoffUntil.set(c.profile, Date.now() + Math.max(c.intervalSeconds, Math.min(86400, Number(e.retryAfterSeconds) || 0)) * 1000);
    throw e;
  } finally { busy.delete(c.profile); }
}
function summary (candidate, c) {
  const { candidateKey, name, size, seeders, leechers, pubTime, fetchedAt, downloadFactor, uploadFactor, downloadUntil, uploadUntil, downloadUnlimited, uploadUnlimited, hrState, hrEvidence } = candidate;
  return { candidateKey, name, size, seeders, leechers, pubTime, fetchedAt, downloadFactor, uploadFactor, downloadUntil, uploadUntil, downloadUnlimited, uploadUnlimited, hrState, hrEvidence, reasons: parser.eligibility(candidate, c), scope: 'source-filters-only' };
}
function checkCss (c) {
  if (profiles[c.profile].adapter === 'mteam-api') return;
  const { JSDOM } = require('jsdom'); const dom = new JSDOM('<table><tr><td></td></tr></table>');
  try {
    const selectors = [c.mapping.rows, c.mapping.authenticated, ...Object.values(c.mapping.fields).flatMap(f => [f.selector, f.header]), ...c.promotionRules.map(r => r.selector), ...c.hrRules.map(r => r.selector), ...(c.hrAbsence ? c.hrAbsence.rowSelectors : [])];
    for (const selector of selectors.filter(Boolean)) dom.window.document.querySelector(selector);
  } catch (_) { fail('PROVIDER_SELECTOR_INVALID'); } finally { dom.window.close(); }
}
async function preview (config) {
  const c = validate(config, profiles); checkCss(c);
  const result = await fetchList(c, true);
  const rows = result.candidates.map(row => summary(row, c));
  // Preview proof belongs to exact config bytes, not just a site or revision.
  const token = crypto.randomBytes(24).toString('hex');
  for (const [key, p] of proofs) if (p.expires < Date.now()) proofs.delete(key);
  if (proofs.size >= 64) fail('PROVIDER_PREVIEW_LIMIT');
  proofs.set(token, { digest: digest(c), expires: Date.now() + 10 * 60000 });
  return {
    token,
    digest: digest(c),
    expiresAt: Date.now() + 10 * 60000,
    candidates: rows,
    coverage: result.coverage,
    eligible: rows.filter(r => !r.reasons.length).length,
    warning: '仅预览来源筛选；不下载 .torrent、不预留、不添加、不验证最终空间/规则。'
  };
}
async function compatible (c, r) {
  if (!r || r.rssBusy || r.autoReseed || r.onlyReseed || r.useCustomRegex || r.paused || r.clientArr.length !== 1) fail('PROVIDER_RSS_INCOMPATIBLE_OR_BUSY');
  const client = global.runningClient[r.clientArr[0]];
  if (!client || client._client.type !== 'qBittorrent') fail('PROVIDER_CLIENT_REQUIRED');
  // Production governance wrappers are not silently bypassed. Their migration
  // bridge must prove single ownership, retain space/HR/expiry guards and check
  // that old cron refresh hooks no longer mutate this site's admission state.
  if (global.codexGovernanceStartup || r.codexOtherSitesPriorityVersion || r.codexHhanPriorityVersion) {
    const owner = bridge(c);
    if (!owner || !owner.check || !owner.beforePrepare || !owner.validateFinal) fail('PROVIDER_GOVERNANCE_MIGRATION_REQUIRED');
    await owner.check(c, r);
  }
  if (profiles[c.profile].adapter === 'mteam-api' && (!bridge(c) || !bridge(c).list || !bridge(c).prepare)) fail('PROVIDER_DRIVER_REQUIRED');
}
async function active (rssId) {
  const r = await store.read(rssId);
  if (r.suspended) return { suspended: true };
  return r.active === null ? null : r.revisions.find(v => v.revision === r.active);
}
async function begin (rss, supplied) {
  const version = await active(rss.id);
  if (!version) return null;
  if (version.suspended) return { candidates: [] };
  const c = version.config;
  // rssBusy is intentionally true here, but no other compatibility gate relaxes.
  await compatible(c, { ...rss, rssBusy: false });
  if (supplied) fail('PROVIDER_EXTERNAL_FEED_CONFLICT');
  const s = state(rss.id); const now = Date.now();
  if (now < s.nextAttempt) return { candidates: [] };
  s.lastAttempt = now; s.nextAttempt = now + c.intervalSeconds * 1000;
  try {
    const result = await fetchList(c);
    // Reconcile lifecycle signals before filtering out newly required HR rows.
    // Preview/shadow fetches never call this production observer.
    if (bridge(c) && bridge(c).observe) await bridge(c).observe(c, result.candidates);
    s.lastSuccess = Date.now(); s.error = null; s.failures = 0; s.candidates = result.candidates.length;
    s.observations = result.candidates.slice(0, 100).map(row => summary(row, c));
    s.coverage = result.coverage;
    const candidates = result.candidates.filter(row => !parser.eligibility(row, c).length).sort((a, b) => parser.rank(a, b, c));
    if (bridge(c) && bridge(c).select) candidates.splice(0, candidates.length, ...await bridge(c).select(c, candidates));
    for (const row of candidates) {
      row.hash = 'provider:' + row.candidateKey; row.id = row.torrentId; row.description = '';
      const context = { version, rss, metadata: null };
      prepared.set(row, context);
      // Native rule evaluation uses shallow copies. A private Symbol retains
      // provenance through them without putting evidence tokens in JSON/history.
      Object.defineProperty(row, contextKey, { value: context, enumerable: true });
    }
    return { candidates };
  } catch (e) {
    // A preview/other cycle already owns this site. Skip this scheduled cycle
    // at its normal cadence, without counting a remote failure or clearing any
    // previous remote error. No request/budget was consumed by the busy gate.
    if (e.code === 'PROVIDER_BUSY') return { candidates: [], deferred: 'same-site-busy' };
    s.error = cleanCode(e); s.failures++;
    s.nextAttempt = now + Math.max(Math.min(86400000, Math.max(0, Number(e.retryAfterSeconds) || 0) * 1000), Math.min(3600000, c.intervalSeconds * 1000 * 2 ** Math.min(s.failures, 4)));
    // Old observations may remain visible but can never drive a new admission.
    throw Object.assign(new Error(s.error), { code: s.error });
  }
}
async function history (rss, candidate) {
  // Compare canonical site IDs without modifying or deleting historical rows.
  // Bounded batches cover the whole RSS history; overflow blocks migration/admit.
  const p = profiles[candidate.siteId];
  const key = rss.id + ':' + candidate.siteId;
  if (!terminalHistory.has(key)) terminalHistory.set(key, { after: 0, ids: new Set(), hashes: new Set() });
  const index = terminalHistory.get(key);
  for (let page = 0; page < 40; page++) {
    const rows = await util().getRecords('SELECT id,hash,link,record_type,record_note FROM torrents WHERE rss_id=? AND id>? AND record_type IN (1,3) ORDER BY id LIMIT 500', [rss.id, index.after]);
    for (const row of rows) {
      index.after = row.id;
      if (+row.record_type === 3 && row.record_note === '添加种子失败: 未提交') continue;
      index.hashes.add(row.hash);
      try {
        const link = new URL(row.link);
        const id = link.searchParams.get(candidate.siteId === 'HAIDAN' ? 'torrent_id' : 'id') || ((candidate.siteId === 'MTEAM' && link.pathname.match(/^\/detail\/(\d+)$/)) || [])[1];
        if (link.origin === p.origin && /^[1-9]\d*$/.test(String(id))) index.ids.add(String(id));
      } catch (_) {}
    }
    if (index.hashes.size > 100000) fail('PROVIDER_HISTORY_COVERAGE_LIMIT');
    if (rows.length < 500) return index.hashes.has(candidate.hash) || (candidate.siteId === 'MTEAM' && index.hashes.has('mt-free-' + candidate.torrentId)) || index.ids.has(candidate.torrentId);
  }
  fail('PROVIDER_HISTORY_COVERAGE_LIMIT');
}
async function prepare (rss, candidate, client) {
  const context = prepared.get(candidate);
  if (!context || context.rss !== rss) fail('PROVIDER_CANDIDATE_CONTEXT');
  const c = context.version.config; const p = profiles[c.profile]; const owner = bridge(c);
  const current = await active(rss.id);
  if (!current || current.suspended || current.digest !== context.version.digest) fail('PROVIDER_CONFIG_CHANGED');
  if (parser.eligibility(candidate, c).length || await history(rss, candidate)) return false;
  const pending = await util().getRecords('SELECT candidate_hash,payload FROM vertex_rss_pending WHERE rss_id=? LIMIT 501', [rss.id]);
  if (pending.length > 500) fail('PROVIDER_PENDING_COVERAGE_LIMIT');
  for (const item of pending) {
    const row = JSON.parse(item.payload).torrent;
    if (item.candidate_hash === candidate.hash || row.candidateKey === candidate.candidateKey || String(row.id) === candidate.torrentId) return false;
  }
  const free = client.maindata.freeSpaceOnDisk;
  if (!Number.isFinite(free) || free - candidate.size * 1.01 < (client.minFreeSpace || 0)) return false;
  if (owner && owner.beforePrepare && !await owner.beforePrepare(c, candidate, client)) return false;
  await consume(c, 'metadata');
  let body;
  if (owner && owner.prepare) body = await owner.prepare(c, candidate);
  else {
    if (!candidate.url) fail('PROVIDER_DOWNLOAD_LINK_MISSING');
    body = await transport.request(candidate.url, p.origin, await credential(c), 16 * 1024 ** 2);
  }
  if (!Buffer.isBuffer(body) || body.length > 16 * 1024 ** 2 || body[0] !== 100) fail('PROVIDER_TORRENT_RESPONSE');
  let decoded;
  try { decoded = bencode.decode(body); } catch (_) { fail('PROVIDER_TORRENT_INVALID'); }
  const info = decoded.info;
  if (!info || !Buffer.isBuffer(info.name) || !Buffer.isBuffer(info.pieces) || !Number.isSafeInteger(info['piece length']) || info['piece length'] <= 0 || info['meta version']) fail('PROVIDER_TORRENT_UNSUPPORTED');
  const files = info.files || [{ length: info.length }];
  const unsafe = v => !Buffer.isBuffer(v) || !v.length || /^(?:\.|\.\.)$|[\\/]/.test(v.toString()) || v.includes(0);
  if (!Array.isArray(files) || !files.length || files.length > 100000 || files.some(f => !Number.isSafeInteger(f.length) || f.length < 0 || (info.files && (!Array.isArray(f.path) || !f.path.length || f.path.some(unsafe))))) fail('PROVIDER_TORRENT_FILES');
  if (info.files && new Set(files.map(f => f.path.map(v => v.toString()).join('/'))).size !== files.length) fail('PROVIDER_TORRENT_FILES');
  const bytes = files.reduce((n, f) => n + f.length, 0);
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || unsafe(info.name) || info.pieces.length !== Math.ceil(bytes / info['piece length']) * 20) fail('PROVIDER_TORRENT_SIZE');
  const hash = crypto.createHash('sha1').update(infoSlice(body)).digest('hex');
  const next = { ...candidate, hash, size: bytes, sizeExact: true };
  if (parser.eligibility(next, c).length || await history(rss, next)) return false;
  if ((client.maindata.torrents || []).some(t => t.hash === hash) || await client.hasTorrent(hash)) return false;
  if (await util().getRecord('SELECT operation FROM vertex_rss_pending WHERE true_hash=? OR candidate_hash=? LIMIT 1', [hash, hash])) return false;
  if (owner && owner.validateFinal && !await owner.validateFinal(c, next, client)) return false;
  const check = await active(rss.id);
  if (!check || check.suspended || check.digest !== context.version.digest) fail('PROVIDER_CONFIG_CHANGED');
  const filepath = path.join(__dirname, '../../torrents', hash + '.torrent');
  const tmp = filepath + '.provider-' + crypto.randomBytes(6).toString('hex');
  await fs.writeFile(tmp, body, { mode: 0o600, flag: 'wx' }); await fs.rename(tmp, filepath);
  Object.assign(candidate, { hash, size: bytes, sizeExact: true });
  context.metadata = { hash, size: bytes, filepath };
  context.clientId = client.id;
  return true;
}
function metadata (candidate) { const context = prepared.get(candidate) || candidate[contextKey]; return context && context.metadata; }
function acceptsManaged (rssId, candidate) {
  const context = prepared.get(candidate) || candidate[contextKey];
  return !!context && context.rss.id === rssId && !!context.metadata && context.metadata.hash === candidate.hash && context.metadata.size === candidate.size && !parser.eligibility(candidate, context.version.config).length;
}
async function finalCheck (rss, candidate, client) {
  const context = prepared.get(candidate) || candidate[contextKey];
  if (!context) return;
  const c = context.version.config; const current = await active(rss.id);
  if (!current || current.suspended || current.digest !== context.version.digest || !context.metadata || context.clientId !== client.id || parser.eligibility(candidate, c).length) fail('PROVIDER_CONFIG_CHANGED');
  if (bridge(c) && bridge(c).validateFinal && !await bridge(c).validateFinal(c, candidate, client)) fail('PROVIDER_FINAL_GUARD');
}
async function list () {
  const records = await store.list();
  return {
    profiles: Object.entries(profiles).map(([id, p]) => ({ id, label: p.label, adapter: p.adapter, origin: p.origin, queryKeys: p.queryKeys, budgetCaps: p.budgetCaps })),
    rss: util().listRss().map(r => ({ id: r.id, alias: r.alias, enable: r.enable, category: r.category, driverRegistered: bridges.has(r.id) })),
    credentials: util().listSite().map(s => ({ ref: 'site:' + s.name, label: s.name })),
    records: records.map(r => ({ ...r, status: state(r.id), driverRegistered: bridges.has(r.id) }))
  };
}
async function activate (args) {
  const proof = proofs.get(args.token);
  return store.activate(args.id, args.expectedRevision, args.target, async version => {
    if (!proof || proof.expires < Date.now() || proof.digest !== version.digest) fail('PROVIDER_PREVIEW_REQUIRED');
    await compatible(version.config, global.runningRss[args.id]);
    // Retain a one-profile-one-RSS owner within this native source subsystem.
    for (const r of await store.list()) if (r.id !== args.id && r.active !== null && r.revisions.find(v => v.revision === r.active).config.profile === version.config.profile) fail('PROVIDER_DUPLICATE_OWNER');
    state(args.id).nextAttempt = 0;
  });
}
async function apply (args) {
  const c = validate(args.config, profiles); checkCss(c);
  const proof = proofs.get(args.token);
  const checkProof = version => {
    if (!proof || proof.expires <= Date.now() || proof.digest !== version.digest) fail('PROVIDER_PREVIEW_REQUIRED');
  };
  const record = await store.apply(c, args.expectedRevision, async version => {
    checkProof(version);
    await compatible(version.config, global.runningRss[c.rssId]);
    for (const r of await store.list()) if (r.id !== c.rssId && r.active !== null && r.revisions.find(v => v.revision === r.active).config.profile === c.profile) fail('PROVIDER_DUPLICATE_OWNER');
    // Recheck after waiting for compatibility/ownership checks, inside the same
    // persistence lock. Failed checks publish neither a draft nor an active pointer.
    checkProof(version);
  });
  state(c.rssId).nextAttempt = 0;
  return record;
}
module.exports = { store, profiles, defaults, validate: c => { validate(c, profiles); checkCss(c); return { valid: true, digest: digest(c) }; }, list, preview, apply, activate, register, begin, prepare, metadata, finalCheck, active, acceptsManaged, cleanCode, latest, history, parser, fetchList };

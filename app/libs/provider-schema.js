'use strict';

// This schema is shared by preview, persistence and the scheduler. No eval, XPath
// execution, user-supplied headers, URLs with credentials or arbitrary file refs.
const crypto = require('crypto');
const fields = ['id', 'title', 'size', 'seeders', 'leechers', 'publishedAt', 'detail', 'download', 'downloadUntil', 'uploadUntil', 'downloadUnlimited', 'uploadUnlimited'];
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = x => x && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
function keys (x, allowed, where) {
  if (!plain(x) || Object.keys(x).some(k => !allowed.includes(k))) fail('PROVIDER_SCHEMA_' + where);
}
function str (x, max, empty = false) { return typeof x === 'string' && x.length <= max && (empty || x.length > 0) && ![...x].some(c => c.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(c)); }
function integer (x, min, max) { return Number.isSafeInteger(x) && x >= min && x <= max; }
function path (s) { return str(s, 256) && /^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(s) && !/(?:^|\.)(?:__proto__|prototype|constructor)(?:\.|$)/.test(s); }
function mapping (m) {
  keys(m, ['selector', 'attribute', 'header', 'path', 'query', 'format'], 'FIELD');
  for (const k of ['selector', 'header']) if (m[k] !== undefined && !str(m[k], 256, true)) fail('PROVIDER_SELECTOR');
  if (m.path && !path(m.path)) fail('PROVIDER_JSON_PATH');
  if (m.attribute && !['href', 'title', 'datetime', 'data-timestamp', 'value'].includes(m.attribute)) fail('PROVIDER_ATTRIBUTE');
  if (m.query && !/^[a-zA-Z0-9_]{1,32}$/.test(m.query)) fail('PROVIDER_QUERY_KEY');
  if (m.format && !['text', 'number', 'size', 'date', 'id', 'url', 'boolean'].includes(m.format)) fail('PROVIDER_FORMAT');
}
function validate (c, profiles) {
  if (JSON.stringify(c).length > 32768) fail('PROVIDER_CONFIG_TOO_LARGE');
  keys(c, ['version', 'profile', 'rssId', 'credentialRef', 'intervalSeconds', 'pages', 'pageSize', 'params', 'mapping', 'promotionRules', 'hrRules', 'selection', 'budgets'], 'CONFIG');
  const p = profiles[c.profile];
  if (c.version !== 1 || !p || !/^[a-f0-9]{8}$/.test(c.rssId || '')) fail('PROVIDER_ID');
  if (!/^(site:[A-Za-z0-9_-]{1,48}|rss:[a-f0-9]{8}|driver)$/.test(c.credentialRef || '')) fail('PROVIDER_CREDENTIAL_REF');
  if (c.credentialRef.startsWith('rss:') && c.credentialRef !== 'rss:' + c.rssId) fail('PROVIDER_CREDENTIAL_SCOPE');
  if (!integer(c.intervalSeconds, 300, 86400) || !integer(c.pages, 1, 3) || !integer(c.pageSize, 1, 100)) fail('PROVIDER_POLL_LIMIT');
  if (p.adapter === 'mteam-api' && c.pages !== 1) fail('PROVIDER_POLL_LIMIT');
  keys(c.params, p.queryKeys, 'PARAMS');
  for (const v of Object.values(c.params)) if (!(str(v, 512, true) || (typeof v === 'number' && Number.isFinite(v))) || /[\r\n]/.test(String(v))) fail('PROVIDER_PARAM');
  keys(c.mapping, ['rows', 'authenticated', 'fields', 'timezoneOffset'], 'MAPPING');
  if (!str(c.mapping.rows, 256) || !str(c.mapping.authenticated, 256, true) || !integer(c.mapping.timezoneOffset, -720, 840)) fail('PROVIDER_MAPPING');
  keys(c.mapping.fields, fields, 'FIELDS');
  for (const k of ['id', 'title', 'size', 'seeders', 'leechers', 'publishedAt']) if (!c.mapping.fields[k]) fail('PROVIDER_REQUIRED_FIELD');
  Object.values(c.mapping.fields).forEach(mapping);
  if (!Array.isArray(c.promotionRules) || c.promotionRules.length > 40 || !Array.isArray(c.hrRules) || c.hrRules.length > 12) fail('PROVIDER_MARKER_LIMIT');
  for (const r of c.promotionRules) {
    keys(r, ['selector', 'path', 'equals', 'downloadFactor', 'uploadFactor'], 'PROMOTION');
    marker(r);
    for (const k of ['downloadFactor', 'uploadFactor']) if (r[k] !== null && (typeof r[k] !== 'number' || !Number.isFinite(r[k]) || r[k] < 0 || r[k] > 100)) fail('PROVIDER_FACTOR');
  }
  for (const r of c.hrRules) {
    keys(r, ['selector', 'path', 'equals', 'state'], 'HR'); marker(r);
    if (!['required', 'exempt'].includes(r.state)) fail('PROVIDER_HR_STATE');
  }
  keys(c.selection, ['freeOnly', 'hrPolicy', 'minGiB', 'maxGiB', 'minSeeders', 'minLeechers', 'maxAgeHours', 'minFreeSeconds', 'sort', 'preferUploadFactor'], 'SELECTION');
  const s = c.selection;
  if (typeof s.freeOnly !== 'boolean' || typeof s.preferUploadFactor !== 'boolean' || !['protect', 'exclude'].includes(s.hrPolicy) || !['publishedAt', 'demand'].includes(s.sort)) fail('PROVIDER_SELECTION');
  for (const k of ['minGiB', 'maxGiB', 'minSeeders', 'minLeechers', 'maxAgeHours', 'minFreeSeconds']) if (typeof s[k] !== 'number' || !Number.isFinite(s[k]) || s[k] < 0 || s[k] > 100000) fail('PROVIDER_THRESHOLD');
  if (s.maxGiB <= s.minGiB || s.maxAgeHours <= 0 || !Number.isInteger(s.minSeeders) || !Number.isInteger(s.minLeechers)) fail('PROVIDER_THRESHOLD');
  keys(c.budgets, ['listPerHour', 'detailPerHour', 'metadataPerHour'], 'BUDGETS');
  for (const k of Object.keys(c.budgets)) if (!integer(c.budgets[k], 1, p.budgetCaps[k])) fail('PROVIDER_BUDGET');
  return JSON.parse(JSON.stringify(c));
}
function marker (r) {
  if (!!r.selector === !!r.path) fail('PROVIDER_MARKER');
  if (r.selector && !str(r.selector, 256)) fail('PROVIDER_SELECTOR');
  if (r.path && (!path(r.path) || !['string', 'boolean', 'number'].includes(typeof r.equals))) fail('PROVIDER_ENUM');
}
function digest (c) { return crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex'); }
module.exports = { validate, fields, digest, fail, path };

'use strict';
// Isolated fixtures only. No production credentials, requests or downloaders.
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const bencode = require('bencode');
const { createRequire } = require('module');
const { profiles, defaults } = require('../app/libs/provider-profiles');
const { validate } = require('../app/libs/provider-schema');
const { parse, eligibility, size, epoch } = require('../app/libs/provider-parser');
const { publicAddress, retryAfter } = require('../app/libs/provider-http');
const { ProviderStore } = require('../app/libs/provider-store');
const { infoSlice } = require('../app/libs/provider-torrent');
const results = [];
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vertex-provider-tests-'));
const now = Math.floor(Date.now() / 1000);
const config = () => {
  const c = defaults('CARPT', '1234abcd');
  c.mapping.fields.size = { selector: '.size' };
  c.mapping.fields.publishedAt = { selector: 'time', attribute: 'datetime' };
  c.mapping.fields.downloadUntil = { selector: '.expiry', attribute: 'title' };
  c.mapping.fields.uploadUntil = { selector: '.expiry', attribute: 'title' };
  return c;
};
const row = (id = 12, marker = '', extra = '') => `<tr><td><a href="details.php?id=${id}"><img src="ignored"></a><a href="details.php?id=${id}">Fixture ${id}</a><a href="download.php?id=${id}">download</a>${marker}</td><td class="size">1.00 GiB</td><td>5</td><td>9</td><td><time datetime="${new Date(now * 1000).toISOString()}"></time><span class="expiry" title="${new Date((now + 14400) * 1000).toISOString()}"></span>${extra}</td></tr>`;
const html = rows => `<a href="logout.php">Logout</a><div class="pro_free2up"></div><table class="torrents"><tr><th>Title</th><th>Size</th><th><img alt="seeders"></th><th><img alt="leechers"></th><th>Time</th></tr>${rows}</table>`;
const hhHtml = (marker = 'promotion-tag-twoupfree', extra = '') => '<a href="logout.php">x</a><div class="torrent-table-sub-info"><a class="torrent-info-text-name" href="details.php?id=12">Fixture HH</a><a href="download.php?id=12">download</a><span class="torrent-info-text-size">1 GiB</span><span class="torrent-info-text-seeders">2</span><span class="torrent-info-text-leechers">10</span><div class="torrent-info-text-added"><span title="' + new Date((now - 60) * 1000).toISOString() + '">published</span></div><span class="promotion-tag ' + marker + '"></span><span title="' + new Date((now + 14400) * 1000).toISOString() + '">expiry</span>' + extra + '</div>';
async function test (name, fn) { await fn(); results.push(name); process.stdout.write('PASS ' + name + '\n'); }
const hhComplete = (extra = '') => '<!doctype html><html><body>' + hhHtml('promotion-tag-free', '<div class="torrent-cat"></div><div class="torrent-title"></div><div class="torrent-info"></div><div class="torrent-manage"></div>' + extra) + '</body></html><script>/* site appends scripts after html */</script>';
async function main () {
  await test('all ten defaults pass schema; invalid identifier rejected', () => {
    for (const id of Object.keys(profiles)) validate(defaults(id, '1234abcd'), profiles);
    assert.throws(() => validate({ ...config(), rssId: '../private' }, profiles));
  });
  await test('credentials URLs scripts and prototype keys are not config fields', () => {
    for (const k of ['cookie', 'token', 'url', 'code']) assert.throws(() => validate({ ...config(), [k]: 'secret' }, profiles));
    const c = config(); c.mapping.fields.id.path = '__proto__.value'; assert.throws(() => validate(c, profiles));
    c.mapping.fields.id.path = 'constructor.prototype'; assert.throws(() => validate(c, profiles));
  });
  await test('bounded intervals pages budgets and JSON paths', () => {
    for (const edit of [c => { c.pages = 4; }, c => { c.intervalSeconds = 0; }, c => { c.budgets.metadataPerHour = 999; }, c => { c.params.passkey = 'forbidden'; }]) { const c = config(); edit(c); assert.throws(() => validate(c, profiles)); }
  });
  await test('HTML timeout configuration is optional bounded and never applies to MT', () => {
    const c = config(); const old = { ...c }; delete old.listTimeouts;
    assert.equal(JSON.stringify(validate(old, profiles)), JSON.stringify(old));
    for (const t of [null, {}, { ...c.listTimeouts, connectSeconds: 31 }, { ...c.listTimeouts, readSeconds: 61 }, { ...c.listTimeouts, requestSeconds: 121 }, { ...c.listTimeouts, cycleSeconds: 181 }, { ...c.listTimeouts, requestSeconds: 14 }, { ...c.listTimeouts, cycleSeconds: 59 }, { ...c.listTimeouts, readSeconds: 1.5 }, { ...c.listTimeouts, retries: 1 }]) assert.throws(() => validate({ ...c, listTimeouts: t }, profiles));
    const mt = defaults('MTEAM', '1234abcd'); assert.equal(mt.listTimeouts, undefined);
    assert.throws(() => validate({ ...mt, listTimeouts: c.listTimeouts }, profiles));
  });
  await test('HH browser form parameters are configurable and remain site scoped', () => {
    const c = defaults('HHCLUB', '57d6ce6e'); validate(c, profiles);
    assert.deepEqual(c.params, { incldead: 1, spstate: 2, inclbookmarked: 0, 'search-mode': 0, search_area: 0, search_all: 1 });
    assert.throws(() => validate({ ...config(), params: { 'search-mode': 0 } }, profiles));
    assert.throws(() => validate({ ...c, params: { ...c.params, passkey: 'forbidden' } }, profiles));
  });
  await test('HH list alone exposes candidate fields and 2x free without invented HR exemption', () => {
    const c = defaults('HHCLUB', '57d6ce6e'); const x = parse(hhHtml(), c, profiles.HHCLUB, now).candidates[0];
    assert.equal(x.torrentId, '12'); assert.equal(x.size, 1024 ** 3); assert.equal(x.seeders, 2); assert.equal(x.leechers, 10); assert.equal(x.pubTime, now - 60);
    assert.equal(x.downloadFactor, 0); assert.equal(x.uploadFactor, 2); assert.equal(x.downloadUntil, now + 14400); assert.equal(x.uploadUntil, now + 14400);
    assert.equal(x.hrState, 'unknown'); assert.deepEqual(eligibility(x, c, now), ['hr-not-exempt']);
    assert.equal(parse(hhHtml('promotion-tag-free'), c, profiles.HHCLUB, now).candidates[0].uploadFactor, null);
  });
  await test('HH date selection ignores publication and rejects conflicting expiry evidence', () => {
    const c = defaults('HHCLUB', '57d6ce6e');
    const duplicate = parse(hhHtml('promotion-tag-free', '<span title="' + new Date((now + 14400) * 1000).toISOString() + '">same</span><span title="tooltip">tip</span>'), c, profiles.HHCLUB, now).candidates[0];
    assert.equal(duplicate.downloadUntil, now + 14400);
    const conflict = parse(hhHtml('promotion-tag-free', '<span title="' + new Date((now + 28800) * 1000).toISOString() + '">other</span>'), c, profiles.HHCLUB, now).candidates[0];
    assert.equal(conflict.downloadUntil, null); assert.equal(conflict.uploadUntil, null); assert(eligibility(conflict, c, now).includes('free-expiry-unverified'));
    const missing = parse(hhHtml().replace(/<span title="[^"]+">expiry<\/span>/, ''), c, profiles.HHCLUB, now).candidates[0]; assert.equal(missing.downloadUntil, null);
  });
  await test('HH explicit HR and conflicting promotions remain blocked', () => {
    const c = defaults('HHCLUB', '57d6ce6e');
    const marked = parse(hhHtml('promotion-tag-twoupfree', '<img alt="H&amp;R">'), c, profiles.HHCLUB, now).candidates[0];
    assert.equal(marked.hrState, 'required'); assert(eligibility(marked, c, now).includes('hr-not-exempt'));
    const conflict = parse(hhHtml('promotion-tag-free pro_50pct'), c, profiles.HHCLUB, now).candidates[0]; assert.equal(conflict.downloadFactor, null); assert(eligibility(conflict, c, now).includes('not-confirmed-free'));
  });
  await test('HH opt-in site rule accepts complete unmarked rows, not fragments or a horizontal rule as HR', () => {
    const c = defaults('HHCLUB', '57d6ce6e');
    const x = parse(hhComplete('<hr>'), c, profiles.HHCLUB, now).candidates[0];
    assert.equal(x.hrState, 'exempt'); assert.equal(x.hrEvidence, 'site-rule-unmarked'); assert.deepEqual(eligibility(x, c, now), []);
    delete c.hrAbsence; const old = parse(hhComplete(), c, profiles.HHCLUB, now).candidates[0];
    assert.equal(old.hrState, 'unknown'); assert(eligibility(old, c, now).includes('hr-not-exempt'));
  });
  await test('HR image URL, encoded URL, alt, title and text all defeat unmarked fallback', () => {
    const c = defaults('HHCLUB', '57d6ce6e');
    for (const marker of ['<img src="/seedbox_icon/h&amp;r.png">', '<img src="/seedbox_icon/h%26r.png">', '<img alt="Hit &amp; Run">', '<img title="H&amp;R">', '<span>H &amp; R</span>', '<b>h&amp;r</b>', '<span class="promotion-tag-hr"></span>']) {
      const x = parse(hhComplete(marker), c, profiles.HHCLUB, now).candidates[0]; assert.equal(x.hrState, 'required', marker); assert(eligibility(x, c, now).includes('hr-not-exempt'));
    }
    c.hrRules.push({ selector: '.exempt', state: 'exempt' });
    const conflict = parse(hhComplete('<img title="H&amp;R"><span class="exempt"></span>'), c, profiles.HHCLUB, now).candidates[0];
    assert.equal(conflict.hrState, 'unknown'); assert(eligibility(conflict, c, now).includes('hr-not-exempt'));
  });
  await test('unmarked inference fails closed for incomplete document row structure fields and foreign URLs', () => {
    const c = defaults('HHCLUB', '57d6ce6e'); const full = hhComplete();
    for (const body of [full.replace('</html>', ''), full.replace('</body>', ''), full.replace('</div></body>', '</body>'), full.replace('class="torrent-title"', 'class="changed"'), full.replace('class="torrent-info-text-size"', 'class="changed"'), full.replace('href="download.php?id=12"', 'href="https://example.invalid/download.php?id=12"'), full.replace('class="torrent-info-text-seeders">2', 'class="torrent-info-text-seeders">unknown')]) {
      const x = parse(body, c, profiles.HHCLUB, now).candidates[0]; assert.equal(x.hrState, 'unknown'); assert(eligibility(x, c, now).includes('hr-not-exempt'));
    }
    assert.throws(() => parse(full + '<input type="password">', c, profiles.HHCLUB, now));
  });
  await test('HR absence configuration is bounded HTML-only and requires a positive detector', () => {
    const c = defaults('HHCLUB', '57d6ce6e');
    for (const absence of [null, {}, { rowSelectors: [] }, { rowSelectors: [''] }, { rowSelectors: [' '] }, { rowSelectors: Array(9).fill('.row') }, { rowSelectors: ['.row'], anything: true }]) assert.throws(() => validate({ ...c, hrAbsence: absence }, profiles));
    assert.throws(() => validate({ ...c, hrRules: [] }, profiles));
    assert.throws(() => validate({ ...defaults('MTEAM', '1234abcd'), hrAbsence: c.hrAbsence }, profiles));
    assert.throws(() => validate({ ...c, hrRules: [{ selector: 'span', text: ' ', state: 'required' }] }, profiles));
    assert.throws(() => validate({ ...c, hrRules: [{ path: 'hr', equals: true, text: 'H&R', state: 'required' }] }, profiles));
  });
  await test('real fields and separate free versus upload multiplier', () => {
    const c = config(); const x = parse(html(row(12, '<span class="pro_free2up"></span>')), c, profiles.CARPT).candidates[0];
    assert.equal(x.torrentId, '12'); assert.equal(x.name, 'Fixture 12'); assert.equal(x.size, 1024 ** 3); assert.equal(x.seeders, 5); assert.equal(x.leechers, 9);
    assert.equal(x.downloadFactor, 0); assert.equal(x.uploadFactor, 2); assert.equal(x.hrState, 'unknown'); assert.deepEqual(eligibility(x, c), []);
  });
  await test('no marker stays unknown; page legend cannot exempt a row', () => {
    const c = config(); const x = parse(html(row()), c, profiles.CARPT).candidates[0];
    assert.equal(x.downloadFactor, null); assert.equal(x.uploadFactor, null); assert.equal(x.hrState, 'unknown');
    c.selection.freeOnly = true; c.selection.hrPolicy = 'exclude'; const reasons = eligibility(x, c);
    assert(reasons.includes('not-confirmed-free')); assert(reasons.includes('hr-not-exempt'));
  });
  await test('upload 2x does not imply free; half-down remains 0.5', () => {
    const c = config();
    const up = parse(html(row(12, '<span class="twoup"></span>')), c, profiles.CARPT).candidates[0];
    assert.equal(up.uploadFactor, 2); assert.equal(up.downloadFactor, null);
    const half = parse(html(row(12, '<span class="twouphalfdown"></span>')), c, profiles.CARPT).candidates[0];
    assert.equal(half.downloadFactor, 0.5); assert.equal(half.uploadFactor, 2);
  });
  await test('positive HR wins unknown; excluded policy blocks required', () => {
    const c = config(); const x = parse(html(row(12, '<img alt="H&amp;R">')), c, profiles.CARPT).candidates[0];
    assert.equal(x.hrState, 'required'); c.selection.hrPolicy = 'exclude'; assert(eligibility(x, c).includes('hr-not-exempt'));
  });
  await test('conflicting repeated pinned rows fail closed', () => {
    const c = config(); const result = parse(html(row(12, '<span class="free"></span>') + row(12)), c, profiles.CARPT);
    assert.equal(result.candidates.length, 1); assert(eligibility(result.candidates[0], c).includes('conflicting-evidence'));
  });
  await test('login challenge malformed selectors and empty shell fail', () => {
    const c = config();
    for (const body of [html(row()) + '<input type="password">', '<div>cf-chl-test</div>', '<div id="app"></div>']) assert.throws(() => parse(body, c, profiles.CARPT));
    c.mapping.rows = '['; assert.throws(() => parse(html(row()), c, profiles.CARPT));
  });
  await test('missing counts and unknown expiry do not become zero or forever', () => {
    const c = config(); c.mapping.fields.seeders = { selector: '.missing' }; c.mapping.fields.downloadUntil = { selector: '.missing' }; c.selection.freeOnly = true;
    const x = parse(html(row(12, '<span class="free"></span>')), c, profiles.CARPT).candidates[0];
    assert.equal(x.seeders, null); assert.equal(x.downloadUntil, null); assert(eligibility(x, c).includes('missing-fields')); assert(eligibility(x, c).includes('free-expiry-unverified'));
  });
  await test('haidan identifies torrent_id instead of group id', () => {
    const c = defaults('HAIDAN', '1234abcd');
    const result = parse('<a href="logout.php">x</a><div class="torrent_item"><div class="torrent_name_col torrent_cell"><a href="details.php?id=8&group_id=8&torrent_id=99">fixture</a></div></div>', c, profiles.HAIDAN);
    assert.equal(result.candidates[0].torrentId, '99');
  });
  await test('JSON API maps explicit enums and unknown HR separately', () => {
    const c = defaults('MTEAM', '1234abcd'); const x = parse({ data: [{ id: 12, name: 'fixture', size: 10000, createdDate: '2026-10-06 00:00:00', status: { seeders: '3', leechers: '7', discount: '_2X_FREE' } }] }, c, profiles.MTEAM).candidates[0];
    assert.equal(x.downloadFactor, 0); assert.equal(x.uploadFactor, 2); assert.equal(x.hrState, 'unknown'); assert.equal(x.url, null);
  });
  await test('sizes and dates are explicit, missing publication is not fetch time', () => {
    assert.equal(size('2.50 TiB'), 2.5 * 1024 ** 4); assert.equal(size('2 MiB'), 2 * 1024 ** 2); assert.equal(size('bad'), null);
    assert.equal(epoch('2026-10-06 08:00:00', 480), epoch('2026-10-06T00:00:00Z', 0)); assert.equal(epoch('2 hours ago', 480), null);
    assert.equal(epoch('2026-10-0608:00:00', 480), epoch('2026-10-06T00:00:00Z', 0));
  });
  await test('private and special-purpose destination ranges blocked', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.2.3', '192.168.1.188', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '2001:db8::1']) assert.equal(publicAddress(ip), false, ip);
    assert.equal(publicAddress('1.1.1.1'), true); assert.equal(publicAddress('2606:4700:4700::1111'), true);
  });
  await test('rate limit retry-after accepts seconds and dates with a bounded ceiling', () => {
    assert.equal(retryAfter('120'), 120); assert.equal(retryAfter('9999999'), 86400);
    assert.equal(retryAfter(new Date(120000).toUTCString(), 0), 120);
    assert.equal(retryAfter('bad'), 0); assert.equal(retryAfter('-1'), 0);
  });
  await test('missing expiry is not unlimited; explicit unlimited still obeys expired deadline', () => {
    const c = defaults('MTEAM', '1234abcd');
    const raw = { id: 12, name: 'fixture', size: 40 * 1024 ** 3, createdDate: new Date().toISOString(), status: { seeders: 3, leechers: 30, discount: '_2X_FREE' } };
    const read = t => parse({ data: [t] }, c, profiles.MTEAM).candidates[0];
    assert(eligibility(read(raw), c).includes('free-expiry-unverified'));
    assert(!eligibility(read({ ...raw, _vertex: { downloadUnlimited: true, uploadUnlimited: true } }), c).includes('free-expiry-unverified'));
    const expired = read({ ...raw, _vertex: { downloadUnlimited: true }, status: { ...raw.status, discountEndTime: '2020-01-01T00:00:00Z' } });
    assert(eligibility(expired, c).length > 0);
  });
  await test('draft save does not activate, CAS rejects concurrent stale save', async () => {
    const st = new ProviderStore(path.join(work, 'store')); const c = config();
    const one = await st.save(c, 0); assert.equal(one.active, null);
    const outcomes = await Promise.allSettled([st.save(c, 1), st.save(c, 1)]);
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await st.read(c.rssId)).revision, 2);
  });
  await test('infohash uses raw info bytes and rejects duplicate keys or trailing bytes', () => {
    const raw = Buffer.from('d4:name1:x6:lengthi1ee');
    const body = Buffer.concat([Buffer.from('d4:info'), raw, Buffer.from('e')]);
    assert(infoSlice(body).equals(raw)); assert(!bencode.encode(bencode.decode(body).info).equals(raw));
    assert.throws(() => infoSlice(Buffer.from('d4:infod1:ai1e1:ai2eee')));
    assert.throws(() => infoSlice(Buffer.concat([body, Buffer.from('extra')])));
    assert.throws(() => infoSlice(Buffer.from('d4:infole')));
  });
  await test('activation checks rollback target and persistence; suspend never selects legacy RSS', async () => {
    const st = new ProviderStore(path.join(work, 'activate')); const c = config();
    await st.save(c, 0);
    await assert.rejects(() => st.activate(c.rssId, 1, 1, async () => { throw Error('not verified'); }));
    assert.equal((await st.read(c.rssId)).active, null);
    await st.activate(c.rssId, 1, 1, async () => {});
    const reread = await new ProviderStore(path.join(work, 'activate')).read(c.rssId); assert.equal(reread.active, 1);
    const stopped = await st.suspend(c.rssId, 2); assert.equal(stopped.suspended, true); assert.equal(stopped.active, 1);
  });
  await test('corrupt active pointer fails closed instead of falling back to RSS', async () => {
    const st = new ProviderStore(path.join(work, 'corrupt')); const c = config();
    const record = await st.save(c, 0); record.active = 999; await st.write(record);
    await assert.rejects(() => st.read(c.rssId), /PROVIDER_STORE_CORRUPT/);
  });
  await test('atomic apply publishes one config; failed check and concurrent stale edit preserve current', async () => {
    const st = new ProviderStore(path.join(work, 'apply')); const c = config();
    const first = await st.apply(c, 0, async () => {}); assert.equal(first.active, 1); assert.equal(first.revisions.length, 1);
    const bytes = await fs.promises.readFile(path.join(st.root, c.rssId + '.json'), 'utf8');
    await assert.rejects(() => st.apply({ ...c, intervalSeconds: 600 }, 1, async () => { throw Error('guard'); }), /guard/);
    assert.equal(await fs.promises.readFile(path.join(st.root, c.rssId + '.json'), 'utf8'), bytes);
    const outcomes = await Promise.allSettled([st.apply(c, 1, async () => {}), st.apply(c, 1, async () => {})]);
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
    const current = await new ProviderStore(st.root).read(c.rssId);
    assert.equal(current.revision, 2); assert.equal(current.active, 2); assert.equal(current.revisions.length, 1);
  });
  await test('legacy history is readable and a full history cannot block single-config apply', async () => {
    const st = new ProviderStore(path.join(work, 'legacy-apply')); const c = config();
    const old = await st.save(c, 0);
    old.revisions = Array.from({ length: 100 }, (_, i) => ({ ...old.revisions[0], revision: i + 1 }));
    old.revision = 100; old.active = 5; old.suspended = true; await st.write(old);
    assert.equal((await st.read(c.rssId)).revisions.length, 100);
    const current = await st.apply({ ...c, intervalSeconds: 600 }, 100, async () => {});
    assert.equal(current.revisions.length, 1); assert.equal(current.active, 101); assert.equal(current.suspended, false);
    assert.equal(current.revisions[0].config.intervalSeconds, 600);
  });
  await test('rename failure leaves exact previous config on disk', async () => {
    const st = new ProviderStore(path.join(work, 'rename-failure')); const c = config();
    await st.apply(c, 0, async () => {}); const file = path.join(st.root, c.rssId + '.json'); const bytes = fs.readFileSync(file, 'utf8');
    const rename = fs.promises.rename;
    fs.promises.rename = async (a, b) => { if (b === file) throw Object.assign(Error('fixture write failure'), { code: 'EIO' }); return rename(a, b); };
    try { await assert.rejects(() => st.apply({ ...c, intervalSeconds: 600 }, 1, async () => {}), /fixture write failure/); } finally { fs.promises.rename = rename; }
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.equal((await st.read(c.rssId)).active, 1);
    assert.equal(fs.readdirSync(st.root).filter(n => n.endsWith('.tmp')).length, 0);
  });
  await test('directory sync failure after rename reports uncertainty, not a fictitious rollback', async () => {
    if (process.platform === 'win32') return;
    const st = new ProviderStore(path.join(work, 'sync-failure')); const c = config();
    await st.apply(c, 0, async () => {}); const open = fs.promises.open;
    fs.promises.open = async (file, ...args) => file === st.root ? { sync: async () => { throw Error('fixture directory sync'); }, close: async () => {} } : open(file, ...args);
    try { await assert.rejects(() => st.apply({ ...c, intervalSeconds: 600 }, 1, async () => {}), /PROVIDER_COMMIT_UNCERTAIN/); } finally { fs.promises.open = open; }
    assert.equal((await st.read(c.rssId)).revisions[0].config.intervalSeconds, 600);
  });
  await runtimeTests();
  process.stdout.write(JSON.stringify({ ok: true, tests: results.length, network: 'fixtures-only', production: false }) + '\n');
}

async function runtimeTests () {
  const filename = path.resolve(__dirname, '../app/libs/torrent-providers.js'); const nativeRequire = createRequire(filename);
  const cfg = config(); let requests = 0; let qbCalls = 0; let historyRows = []; const pending = [];
  const historyUtil = {
    listRss: () => [{ id: cfg.rssId, alias: 'fixture', cookie: 'never-output', rssUrls: ['https://carpt.net/torrentrss.php'] }],
    listSite: () => [],
    getRecords: async sql => sql.includes('vertex_rss_pending') ? pending : historyRows,
    getRecord: async () => null
  };
  const client = { id: '12345678', _client: { type: 'qBittorrent' }, maindata: { freeSpaceOnDisk: 10 * 1024 ** 4, torrents: [] }, hasTorrent: async () => { qbCalls++; return false; } };
  const rss = { id: cfg.rssId, _rss: { enable: true }, clientArr: [client.id], autoReseed: false, onlyReseed: false, useCustomRegex: false, paused: false };
  const globals = { runningRss: { [rss.id]: rss }, runningClient: { [client.id]: client } };
  let clockOffset = 0;
  class Clock extends Date { static now () { return Date.now() + clockOffset; } }
  let transportHook = async () => Buffer.from(html(row()));
  const context = { module: { exports: {} }, exports: {}, __dirname: path.join(work, 'app/libs'), Buffer, URL, URLSearchParams, Date: Clock, setTimeout, clearTimeout, global: globals, require: key => key === './util' ? historyUtil : key === './provider-http' ? { request: async (...args) => { requests++; return transportHook(...args); } } : nativeRequire(key) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename }); const service = context.module.exports;
  service.store.root = path.join(work, 'runtime'); await fs.promises.mkdir(path.join(work, 'torrents'));
  await test('HR absence selectors are validated before any network request', () => {
    const c = defaults('HHCLUB', '57d6ce6e'); c.hrAbsence.rowSelectors = ['['];
    const before = requests; assert.throws(() => service.validate(c), /PROVIDER_SELECTOR_INVALID/); assert.equal(requests, before);
  });
  // Cross-realm schema uses a strict plain-object test, so pass config through
  // the host module defaults and serialize only in the actual persistence path.
  await test('preview never touches qB or metadata, output excludes credentials and links', async () => {
    const preview = await service.preview(cfg); assert.equal(requests, 1); assert.equal(qbCalls, 0);
    assert.equal(preview.candidates.length, 1); assert(!JSON.stringify(preview).includes('never-output')); assert(!JSON.stringify(preview).includes('download.php'));
  });
  await test('internal shadow observes one budgeted list without RSS or download side effects', async () => {
    const before = requests; let observed = 0;
    const result = await service.fetchList(cfg, true, response => {
      observed++; assert(response.text.includes('Fixture 12')); assert.equal(new URL(response.url).pathname, '/torrents.php');
    });
    assert.equal(observed, 1); assert.equal(requests - before, 1); assert.equal(qbCalls, 0);
    assert(!JSON.stringify(result).includes('<table')); assert.equal((await service.store.list()).length, 0);
    await assert.rejects(() => service.fetchList(cfg, true, {}), /PROVIDER_OBSERVER_INVALID/);
  });
  await test('legacy governed production cannot activate without an explicit migration bridge', async () => {
    await service.store.save(cfg, 0); const preview = await service.preview(cfg); globals.codexGovernanceStartup = { version: 1 };
    await assert.rejects(() => service.activate({ id: cfg.rssId, expectedRevision: 1, target: 1, token: preview.token }), /PROVIDER_GOVERNANCE_MIGRATION_REQUIRED/);
    assert.equal((await service.store.read(cfg.rssId)).active, null); delete globals.codexGovernanceStartup;
  });
  await test('activation requires exact fresh preview; single native scheduler owns candidates', async () => {
    await assert.rejects(() => service.activate({ id: cfg.rssId, expectedRevision: 1, target: 1, token: 'invalid' }), /PROVIDER_PREVIEW_REQUIRED/);
    const preview = await service.preview(cfg); await service.activate({ id: cfg.rssId, expectedRevision: 1, target: 1, token: preview.token });
    await assert.rejects(() => service.begin(rss, []), /PROVIDER_EXTERNAL_FEED_CONFLICT/);
  });
  const torrentBody = bencode.encode({ announce: Buffer.from('https://fixture.invalid/announce'), info: { name: Buffer.from('fixture.bin'), length: 123456, 'piece length': 16384, pieces: Buffer.alloc(160) } });
  let lifecycleObservations = 0;
  service.register(cfg.rssId, { check: async () => {}, observe: async (c, rows) => { lifecycleObservations++; assert.equal(rows.length, 1); }, beforePrepare: async () => true, validateFinal: async () => true, prepare: async () => torrentBody });
  let candidate;
  await test('exact metadata precedes native final filters/reservation, then final config is rechecked', async () => {
    const cycle = await service.begin(rss); candidate = cycle.candidates[0]; assert(candidate);
    assert.equal(lifecycleObservations, 1);
    assert.equal(await service.prepare(rss, candidate, client), true);
    assert.equal(candidate.size, 123456); assert.equal(candidate.sizeExact, true); assert.match(candidate.hash, /^[a-f0-9]{40}$/);
    assert.equal(service.metadata(candidate).size, 123456); await service.finalCheck(rss, candidate, client);
  });
  await test('native shallow rule copies retain provenance but JSON lookalikes do not', () => {
    assert(service.acceptsManaged(rss.id, { ...candidate }));
    assert(!service.acceptsManaged(rss.id, JSON.parse(JSON.stringify(candidate))));
    assert(!service.acceptsManaged('deadbeef', { ...candidate }));
    assert(!service.acceptsManaged(rss.id, { ...candidate, size: candidate.size + 1 }));
  });
  await test('legacy success at the same site ID blocks even when RSS hash differs', async () => {
    historyRows = [{ id: 1, hash: 'a'.repeat(40), link: 'https://carpt.net/details.php?id=12', record_type: 1 }];
    assert.equal(await service.history(rss, candidate), true); historyRows = [];
  });
  await test('stop during preparation blocks submit instead of falling back to old RSS', async () => {
    await service.store.suspend(cfg.rssId, 2);
    await assert.rejects(() => service.finalCheck(rss, candidate, client), /PROVIDER_CONFIG_CHANGED/);
    assert.equal((await service.begin(rss)).candidates.length, 0);
  });
  await test('budget persists across fresh service/store reads', async () => {
    const budget = JSON.parse(await fs.promises.readFile(path.join(service.store.root, 'budget-CARPT.json')));
    assert.equal(budget.metadata, 1); assert(budget.list >= 4);
    assert.equal(qbCalls, 1); assert.equal(historyRows.length, 0); assert.equal(pending.length, 0);
  });
  await test('apply rejects missing changed and expired previews without persisting any config', async () => {
    const before = fs.readFileSync(path.join(service.store.root, cfg.rssId + '.json'), 'utf8');
    await assert.rejects(() => service.apply({ config: cfg, expectedRevision: 3, token: 'invalid' }), /PROVIDER_PREVIEW_REQUIRED/);
    const proof = await service.preview(cfg);
    await assert.rejects(() => service.apply({ config: { ...cfg, intervalSeconds: 600 }, expectedRevision: 3, token: proof.token }), /PROVIDER_PREVIEW_REQUIRED/);
    await assert.rejects(() => service.apply({ config: { ...cfg, listTimeouts: { ...cfg.listTimeouts, readSeconds: 40 } }, expectedRevision: 3, token: proof.token }), /PROVIDER_PREVIEW_REQUIRED/);
    clockOffset = 601000;
    try { await assert.rejects(() => service.apply({ config: cfg, expectedRevision: 3, token: proof.token }), /PROVIDER_PREVIEW_REQUIRED/); } finally { clockOffset = 0; }
    assert.equal(fs.readFileSync(path.join(service.store.root, cfg.rssId + '.json'), 'utf8'), before);
  });
  await test('apply retains RSS compatibility and governance gates and publishes no draft on rejection', async () => {
    const proof = await service.preview(cfg); rss.paused = true;
    await assert.rejects(() => service.apply({ config: cfg, expectedRevision: 3, token: proof.token }), /PROVIDER_RSS_INCOMPATIBLE_OR_BUSY/); rss.paused = false;
    const other = { ...cfg, rssId: 'deadbeef', credentialRef: 'rss:deadbeef' };
    globals.runningRss[other.rssId] = { ...rss, id: other.rssId, codexOtherSitesPriorityVersion: 1 };
    const unregister = service.register(other.rssId, { check: async () => {}, credential: async () => 'never-output' });
    const otherProof = await service.preview(other);
    await assert.rejects(() => service.apply({ config: other, expectedRevision: 0, token: otherProof.token }), /PROVIDER_GOVERNANCE_MIGRATION_REQUIRED/);
    assert.equal((await service.store.read(other.rssId)).revision, 0); unregister();
    assert.equal((await service.store.read(cfg.rssId)).revision, 3);
  });
  await test('apply replaces and resumes one config without resetting budget or submitting tasks', async () => {
    const proof = await service.preview(cfg); const file = path.join(service.store.root, 'budget-CARPT.json'); const before = fs.readFileSync(file, 'utf8');
    const saved = await service.apply({ config: cfg, expectedRevision: 3, token: proof.token });
    assert.equal(saved.active, 4); assert.equal(saved.revisions.length, 1); assert.equal(saved.suspended, false);
    assert.equal(fs.readFileSync(file, 'utf8'), before); assert.equal(qbCalls, 1);
  });
  await test('apply rejects a second owner even while the original source is suspended', async () => {
    await service.store.suspend(cfg.rssId, 4);
    const other = { ...cfg, rssId: 'deadbeef', credentialRef: 'rss:deadbeef' };
    globals.runningRss[other.rssId] = { ...rss, id: other.rssId };
    const unregister = service.register(other.rssId, { check: async () => {}, credential: async () => 'never-output' });
    const proof = await service.preview(other);
    await assert.rejects(() => service.apply({ config: other, expectedRevision: 0, token: proof.token }), /PROVIDER_DUPLICATE_OWNER/);
    assert.equal((await service.store.read(other.rssId)).revision, 0); unregister();
  });
  await test('HTML pages use configured timeouts and share one inclusive cycle budget', async () => {
    clockOffset = 7200000; const options = []; const before = requests;
    transportHook = async (url, origin, credential, limit, opts) => {
      assert.equal(new URL(url).pathname, '/torrents.php'); options.push(opts);
      clockOffset += options.length === 1 ? 55000 : 1000;
      return Buffer.from(html(row()) + '<a href="/torrents.php?page=1">next</a>');
    };
    const c = { ...cfg, pages: 2, listTimeouts: { ...cfg.listTimeouts, cycleSeconds: 70 } };
    const result = await service.fetchList(c);
    assert.equal(requests - before, 2); assert.equal(result.coverage.pages.length, 2);
    assert.equal(options[0].connectTimeoutMs, 15000); assert.equal(options[0].idleTimeoutMs, 30000);
    assert(options[0].totalTimeoutMs <= 60000 && options[0].totalTimeoutMs > 59000);
    assert(options[1].totalTimeoutMs <= 15000 && options[1].totalTimeoutMs > 14000);
  });
  await test('cycle expiry after parse observer rejects partial results without RSS fallback or extra requests', async () => {
    const before = requests;
    transportHook = async () => Buffer.from(html(row()) + '<a href="/torrents.php?page=1">next</a>');
    await assert.rejects(() => service.fetchList({ ...cfg, pages: 2 }, false, () => { clockOffset += 120001; }), /PROVIDER_CYCLE_DEADLINE/);
    assert.equal(requests - before, 1);
  });
  await test('credential time consumes the same cycle and cannot start HTTP after expiry', async () => {
    const before = requests;
    const unregister = service.register('deadfeed', { check: async () => {}, credential: async () => { clockOffset += 120001; return 'never-output'; } });
    try { await assert.rejects(() => service.fetchList({ ...cfg, rssId: 'deadfeed', credentialRef: 'driver' }), /PROVIDER_CYCLE_DEADLINE/); } finally { unregister(); }
    assert.equal(requests, before);
  });
  await test('transport failure never fetches RSS or adds automatic retry and releases busy gate', async () => {
    const before = requests;
    transportHook = async () => { throw Object.assign(Error('PROVIDER_TIMEOUT_BODY'), { code: 'PROVIDER_TIMEOUT_BODY' }); };
    await assert.rejects(() => service.fetchList(cfg), /PROVIDER_TIMEOUT_BODY/);
    assert.equal(requests - before, 1);
    transportHook = async (url, origin, credential, limit, opts) => {
      assert.equal(new URL(url).pathname, '/torrents.php'); assert(opts.totalTimeoutMs <= 20000); assert.equal(opts.connectTimeoutMs, undefined);
      return Buffer.from(html(row()));
    };
    const old = { ...cfg }; delete old.listTimeouts;
    assert.equal((await service.fetchList(old)).candidates.length, 1);
    assert.equal(requests - before, 2); assert.equal(qbCalls, 1); assert.equal(pending.length, 0);
  });
  await test('HH fetch consumes one filtered list request and produces no RSS or download request', async () => {
    const c = defaults('HHCLUB', '57d6ce6e'); c.credentialRef = 'driver';
    const unregister = service.register(c.rssId, { check: async () => { throw Error('PROVIDER_HHAN_PROOF_MIGRATION_REQUIRED'); }, credential: async () => 'fixture-session' });
    const before = requests; let observed = 0;
    transportHook = async (url, origin, credential) => {
      const u = new URL(url); assert.equal(u.pathname, '/torrents.php'); assert.equal(u.searchParams.get('spstate'), '2'); assert.equal(u.searchParams.get('search_all'), '1'); assert.equal(credential, 'fixture-session');
      return Buffer.from(hhHtml());
    };
    try {
      const result = await service.fetchList(c, true, () => { observed++; });
      assert.equal(result.candidates.length, 1); assert.equal(requests - before, 1); assert.equal(observed, 1); assert.equal(qbCalls, 1); assert.equal(pending.length, 0);
      assert.equal((await service.store.read(c.rssId)).revision, 0); assert.equal(result.candidates[0].hrState, 'unknown');
    } finally { unregister(); transportHook = null; }
  });
}
main().catch(e => { process.stderr.write('PROVIDER_TEST_FAILED ' + (e.code || e.message) + '\n' + e.stack + '\n'); process.exitCode = 1; });

'use strict';
// Synthetic authenticated pages only. No site requests, credentials or jobs.
const assert = require('assert').strict;
const { JSDOM } = require('jsdom');
const { defaults, profiles } = require('../app/libs/provider-profiles');
const { validate } = require('../app/libs/provider-schema');
const { parse, valueAt } = require('../app/libs/provider-parser');
const personal = require('../app/libs/provider-personal');
let passed = 0;
function test (name, run) { run(); passed++; process.stdout.write('PASS ' + name + '\n'); }
function read (profile, html) {
  const d = new JSDOM('<div id="row">' + html + '</div>');
  try { return personal.read(d.window.document.querySelector('#row'), defaults(profile, '1234abcd').personalStateRules, false, valueAt); } finally { d.window.close(); }
}
test('all defaults valid; old configs remain byte compatible and do not auto-enable queries', () => {
  for (const profile of Object.keys(profiles)) {
    const c = defaults(profile, '1234abcd'); validate(c, profiles);
    delete c.personalStateRules; delete c.budgets.personalPerHour;
    assert.equal(JSON.stringify(validate(c, profiles)), JSON.stringify(c));
  }
});
test('six standard sites use strict bounded personal progress, not swarm counts', () => {
  for (const site of ['CARPT', 'ZMPT', 'KUFEI', 'HDKYLIN', 'HDFANS', 'HHCLUB']) {
    assert.equal(read(site, '<span title="seeding 100%"></span>'), 'seeding');
    assert.equal(read(site, '<span title="leeching 0.25%"></span>'), 'downloading');
    assert.equal(read(site, '<span title="inactivity 100%"></span>'), 'inactive');
    for (const t of ['seeders 100', 'seeding 101%', 'leeching -1%', 'seeding NaN%', 'seeding 1% tooltip', '100']) assert.equal(read(site, '<span title="' + t + '"></span>'), 'unknown');
  }
});
test('Nanyang cell evidence does not match an unrelated header or swarm link', () => {
  assert.equal(read('NANYANG', '<table><tr><td title="Seeding">1</td></tr></table>'), 'seeding');
  assert.equal(read('NANYANG', '<table><tr><td title="Downloading">1</td></tr></table>'), 'downloading');
  assert.equal(read('NANYANG', '<a title="Seeding">100</a>'), 'unknown');
});
test('BTSchool only recognizes active custom markers; completed/partial inactivity stays inactive', () => {
  assert.equal(read('BTSCHOOL', '<div class="progressarea" title="做种中"><div class="progress_seeding"></div></div>'), 'seeding');
  assert.equal(read('BTSCHOOL', '<div class="progressarea" title="正在下载 10%"><div class="progress_downloading"></div></div>'), 'downloading');
  for (const cls of ['progress_completed', 'progress_no_downloading']) assert.equal(read('BTSCHOOL', '<div class="progressarea"><div class="' + cls + '"></div></div>'), 'inactive');
  assert.equal(read('BTSCHOOL', '<div class="progress_downloading"></div>'), 'unknown');
});
test('Haidan remains unknown even when a generic completion column looks active', () => {
  assert.equal(read('HAIDAN', '<div class="snatched_col" title="seeding 100%">100</div>'), 'unknown');
});
test('conflicting states and stale observations fall back locally', () => {
  assert.equal(read('CARPT', '<span title="seeding 100%"></span><span title="inactivity 100%"></span>'), 'unknown');
  const c = defaults('CARPT', '1234abcd');
  assert(personal.active({ personalState: 'seeding', fetchedAt: 1000 }, c, 1000));
  for (const fetchedAt of [undefined, null, NaN, 0, 2000]) assert(!personal.active({ personalState: 'seeding', fetchedAt }, c, 1000));
  assert(!personal.active({ personalState: 'inactive', fetchedAt: 1000 }, c, 1000));
});
test('personal JSON mapping only reads explicit enum, never history or global seeders', () => {
  const rules = defaults('MTEAM', '1234abcd').personalStateRules;
  assert.equal(personal.read({ _vertex: { personalState: 'seeding' } }, rules, true, valueAt), 'seeding');
  assert.equal(personal.read({ status: { seeders: 100 }, history: { downloaded: 100 } }, rules, true, valueAt), 'unknown');
  assert.equal(personal.read({ _vertex: { personalState: true } }, rules, true, valueAt), 'unknown');
});
test('invalid rules and cross-adapter rules are rejected; no regex/code in config', () => {
  const c = defaults('CARPT', '1234abcd');
  for (const r of [null, { selector: '[title]', format: 'eval' }, { selector: '[title]', state: 'finished' }, { selector: '[title]', format: 'nexus-progress', state: 'seeding' }, { path: '_vertex.personalState', equals: 'seeding', state: 'seeding' }, { selector: '[title]', regex: '.*', state: 'seeding' }]) assert.throws(() => validate({ ...c, personalStateRules: [r] }, profiles));
  assert.throws(() => validate({ ...c, personalStateRules: Array(13).fill(c.personalStateRules[0]) }, profiles));
  assert.throws(() => validate({ ...c, budgets: { ...c.budgets, personalPerHour: 12 } }, profiles));
  const mt = defaults('MTEAM', '1234abcd'); mt.budgets.personalPerHour = 25; assert.throws(() => validate(mt, profiles));
});
test('parser stays row-scoped, handles pinned conflicts and does not confuse global legends', () => {
  const c = defaults('CARPT', '1234abcd');
  c.mapping.rows = '.fixture'; c.mapping.authenticated = '#auth';
  c.mapping.fields = { id: { selector: '.id' }, title: { selector: '.name' }, size: { selector: '.size' }, seeders: { selector: '.seed' }, leechers: { selector: '.leech' }, publishedAt: { selector: 'time', attribute: 'datetime' } };
  const row = marker => '<div class="fixture"><b class="id">12</b><b class="name">Synthetic</b><span class="size">1 GiB</span><span class="seed">5</span><span class="leech">9</span><time datetime="2026-10-07T00:00:00Z"></time>' + marker + '</div>';
  const html = rows => '<div id="auth"></div><div title="seeding 100%">Legend</div>' + rows;
  assert.equal(parse(html(row('')), c, profiles.CARPT).candidates[0].personalState, 'unknown');
  assert.equal(parse(html(row('<i title="leeching 2%"></i>')), c, profiles.CARPT).candidates[0].personalState, 'downloading');
  const merged = parse(html(row('<i title="seeding 100%"></i>') + row('')), c, profiles.CARPT);
  assert.equal(merged.candidates.length, 1); assert.equal(merged.candidates[0].personalState, 'unknown');
  assert.throws(() => parse('<input type="password">' + html(row('')), c, profiles.CARPT));
});
process.stdout.write(JSON.stringify({ passed, networkRequests: 0, productionWrites: 0 }) + '\n');

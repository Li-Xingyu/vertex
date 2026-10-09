'use strict';
const assert = require('assert').strict;
const { exposure, entrySnapshot } = require('../app/libs/provider-opportunity');
const { defaults, profiles } = require('../app/libs/provider-profiles');
const { validate, digest } = require('../app/libs/provider-schema');
const { eligibility } = require('../app/libs/provider-parser');
const GiB = 1024 ** 3; const now = 1791500000; const a = 'a'.repeat(40); const b = 'b'.repeat(40);
let tests = 0;
function test (name, fn) { fn(); tests++; process.stdout.write('PASS ' + name + '\n'); }
const config = defaults('MTEAM', '1234abcd');
const candidate = {
  hash: b,
  candidateKey: 'MTEAM:12',
  siteId: 'MTEAM',
  size: 20 * GiB,
  seeders: 100,
  leechers: 9,
  pubTime: now - 60,
  fetchedAt: now,
  hrState: 'exempt',
  downloadFactor: 0,
  uploadFactor: 2,
  downloadUntil: now + 86400
};
const owners = new Map([[a, { at: now - 3000, size: 100 * GiB }]]);
const snapshot = { providerSnapshotAt: now, torrents: [{ hash: a, size: 100 * GiB, progress: 0.5, state: 'pausedDL' }] };
const pending = (key = b, size = 20 * GiB, extra = {}) => ({
  true_hash: key,
  payload: JSON.stringify({ torrent: { ...candidate, hash: key, size }, ...extra })
});
test('absent optional fields preserve saved digest and eligibility', () => {
  const before = digest(config); assert.deepEqual(validate(config, profiles), config);
  assert.equal(digest(config), before); assert.deepEqual(eligibility(candidate, config, now), []);
  assert.deepEqual(exposure({}, owners, null, null, candidate, now), { allowed: true, enabled: false });
});
test('competition gate is independent of 2x multiplier and temporary', () => {
  config.selection.minDemandRatio = 0.25;
  assert(eligibility(candidate, config, now).includes('competition-deferred'));
  assert(!eligibility({ ...candidate, leechers: 25 }, config, now).includes('competition-deferred'));
  assert(!eligibility(candidate, { ...config, selection: { ...config.selection, minDemandRatio: 0 } }, now).includes('competition-deferred'));
});
test('zero supply uses denominator one, unknown and negative counts never pass', () => {
  assert(!eligibility({ ...candidate, seeders: 0, leechers: 1 }, config, now).includes('competition-deferred'));
  for (const value of [null, undefined, -1, NaN, Infinity]) {
    assert(eligibility({ ...candidate, seeders: value }, config, now).includes('competition-deferred'));
    assert(eligibility({ ...candidate, leechers: value }, config, now).includes('competition-deferred'));
  }
});
test('promotion, HR and freshness gates remain independently effective', () => {
  config.selection.hrPolicy = 'exclude';
  assert(eligibility({ ...candidate, leechers: 100, hrState: 'required' }, config, now).includes('hr-not-exempt'));
  assert(eligibility({ ...candidate, leechers: 100, fetchedAt: now - 1000 }, config, now).includes('stale'));
  assert(eligibility({ ...candidate, leechers: 100, downloadFactor: 1 }, config, now).includes('not-confirmed-free'));
});
test('new thresholds validate without admitting strings, negatives or NaN', () => {
  for (const key of ['minDemandRatio', 'maxInFlightGiB']) {
    for (const value of [-1, '0.25', NaN, Infinity, 100001, null]) assert.throws(() => validate({ ...config, selection: { ...config.selection, [key]: value } }, profiles));
    validate({ ...config, selection: { ...config.selection, [key]: 0 } }, profiles);
  }
});
test('unfinished full size counts, including paused tasks, with inclusive bound', () => {
  assert.equal(exposure({ maxInFlightGiB: 120 }, owners, snapshot, [], candidate, now).allowed, true);
  const result = exposure({ maxInFlightGiB: 119 }, owners, snapshot, [], candidate, now);
  assert.equal(result.allowed, false); assert.equal(result.reason, 'inflight-investment'); assert.equal(result.usedGiB, 100);
});
test('completed original releases envelope; unrelated downloads and reseeds do not own it', () => {
  const live = { ...snapshot, torrents: [{ ...snapshot.torrents[0], progress: 1 }, { hash: b, size: 900 * GiB, progress: 0 }] };
  assert.equal(exposure({ maxInFlightGiB: 20 }, owners, live, [pending(a, 900 * GiB, { reseed: true })], candidate, now).allowed, true);
});
test('pending and live same hash charge once, new pending still consumes investment', () => {
  assert.equal(exposure({ maxInFlightGiB: 120 }, owners, snapshot, [pending(a, 100 * GiB)], candidate, now).allowed, true);
  assert.equal(exposure({ maxInFlightGiB: 120 }, owners, snapshot, [pending()], candidate, now).allowed, false);
});
test('final check excludes only the exact own intent, not another candidate identity', () => {
  assert.equal(exposure({ maxInFlightGiB: 120 }, owners, snapshot, [pending()], candidate, now, true).allowed, true);
  const other = { true_hash: b, payload: JSON.stringify({ torrent: { ...candidate, candidateKey: 'MTEAM:13' } }) };
  assert.equal(exposure({ maxInFlightGiB: 120 }, owners, snapshot, [other], candidate, now, true).allowed, false);
});
test('durable success not yet in snapshot holds a conservative 20 minute reservation', () => {
  const recent = new Map([[a, { at: now - 600, size: 100 * GiB }]]);
  const empty = { ...snapshot, torrents: [] };
  assert.equal(exposure({ maxInFlightGiB: 119 }, recent, empty, [], candidate, now).allowed, false);
  assert.equal(exposure({ maxInFlightGiB: 20 }, owners, empty, [], candidate, now).allowed, true);
});
test('stale, missing, future snapshots and malformed pending evidence defer, not zero', () => {
  for (const snap of [null, {}, { ...snapshot, providerSnapshotAt: now - 121 }, { ...snapshot, providerSnapshotAt: now + 1 }]) assert.equal(exposure({ maxInFlightGiB: 1000 }, owners, snap, [], candidate, now).reason, 'exposure-unverified');
  for (const row of [{ payload: '{' }, pending('provider:MTEAM:12'), pending(b, -1)]) assert.equal(exposure({ maxInFlightGiB: 1000 }, owners, snapshot, [row], candidate, now).reason, 'exposure-unverified');
});
test('entry snapshot is facts only, includes multiplier uncertainty and excludes credentials', () => {
  const raw = entrySnapshot({ ...candidate, name: 'private title', url: 'https://secret.invalid/', cookie: 'private cookie' }, now);
  const record = JSON.parse(raw); assert.equal(record.confirmedAt, now); assert.equal(record.leechers, 9); assert.equal(record.uploadUntil, null);
  for (const value of ['private', 'secret', 'https:']) assert(!raw.includes(value));
  assert.equal(entrySnapshot({ hash: a }, now), null);
});
process.stdout.write(JSON.stringify({ ok: true, tests, production: false, siteRequests: 0 }) + '\n');

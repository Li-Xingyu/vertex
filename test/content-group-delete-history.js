'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const calls = [];
const util = { sleep: async () => {}, runRecord: async sql => { calls.push(sql); } };
const logger = { info () {}, debug () {} };
const holder = { exports: {} };
const context = vm.createContext({
  module: holder,
  Buffer,
  Date,
  require (key) {
    if (key === '../libs/util') return util;
    if (key === '../libs/logger') return logger;
    if (key === 'moment') return () => ({ unix: () => 1000 });
    return {};
  }
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/common/Client.js'), 'utf8'), context);
const Client = holder.exports;
function fixture (managed, fit = true) {
  calls.length = 0;
  return Object.assign(Object.create(Client.prototype), {
    maindata: { torrents: [{ hash: 'synthetic', size: 4, completedTime: 100, addedTime: 1 }] },
    rejectDeleteRules: [],
    deleteRules: [{ id: 'group-test', alias: 'fixture' }],
    pausedTorrentHashes: [],
    groupDeleteOwnsHistory: managed ? new Set(['group-test']) : undefined,
    _fitDeleteRule: () => fit,
    reannounceTorrent: async () => {},
    deleteTorrent: async () => { calls.push('guard-blocked'); return false; }
  });
}
async function main () {
  await fixture(true).autoDelete(); assert.deepEqual(calls, ['guard-blocked']);
  await fixture(false).autoDelete(); assert.equal(calls.length, 3); assert(calls[0].startsWith('update torrents'));
  await fixture(true, false).autoDelete(); assert.equal(calls.length, 0);
  const c = fixture(true); c.deleteTorrent = async () => { calls.push('confirmed-update', 'confirmed-flow'); return true; };
  await c.autoDelete(); assert.deepEqual(calls, ['confirmed-update', 'confirmed-flow']);
  process.stdout.write(JSON.stringify({ passed: 4, productionRequests: 0 }) + '\n');
}
main().catch(e => { console.error(e); process.exitCode = 1; });

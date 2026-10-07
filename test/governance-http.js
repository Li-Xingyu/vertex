'use strict';
// Only synthetic loopback and EventEmitter fixtures; never NAS or PT traffic.
const assert = require('assert').strict; const fs = require('fs'); const path = require('path');
const vm = require('vm'); const http = require('http'); const EventEmitter = require('events');
const { Worker } = require('worker_threads'); const { once } = require('events');
const bundle = fs.existsSync(path.join(__dirname, '../governance-bundle')) ? '../governance-bundle' : '../app/governance';
const source = fs.readFileSync(path.join(__dirname, bundle, 'audit-vertex-lifecycle.js'), 'utf8');
let passed = 0;
const target = 'http://127.0.0.1:8089/api/v2/torrents/files?hash=synthetic';
function moduleWith (transport, text = source, timers = {}) {
  const holder = { exports: {} };
  vm.runInNewContext(text, {
    module: holder,
    Buffer,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    ...timers,
    require (name) {
      if (name === 'http') return transport;
      if (name === 'path') return path;
      if (['fs', 'child_process', './vertex-lifecycle-policy'].includes(name)) return {};
      throw Error('Unexpected dependency');
    }
  }); return holder.exports;
}
function mock (respond) {
  let calls = 0; let req; let res;
  const timers = new Set();
  const api = moduleWith({
    request (url, options, callback) {
      calls++; assert.equal(options.agent, false); assert.equal(url.hostname, '127.0.0.1');
      req = new EventEmitter(); req.setTimeout = (ms, cb) => { req.idle = cb; }; req.write = () => {};
      req.destroy = e => { req.destroyed = true; queueMicrotask(() => req.emit('error', e)); };
      req.end = () => queueMicrotask(() => {
        res = new EventEmitter(); res.statusCode = 200; res.headers = {}; res.complete = true; callback(res);
        respond(req, res, options);
      }); return req;
    }
  }, source, {
    setTimeout (cb) { timers.add(cb); return cb; },
    clearTimeout (cb) { timers.delete(cb); }
  });
  return { api, count: () => calls, timers, request: () => req, response: () => res };
}
async function test (name, fn) { await fn(); passed++; console.log('PASS ' + name); }
async function run () {
  await test('real idle-close race reproduces with reuse and disappears with fresh audit sockets', async () => {
    const worker = new Worker(`
      const { parentPort } = require('worker_threads');
      const server = require('http').createServer((req, res) => {
        res.setHeader('Keep-Alive', 'timeout=5'); res.end('synthetic');
      });
      server.keepAliveTimeout = 30; server.keepAliveTimeoutBuffer = 0;
      server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
    `, { eval: true });
    const agent = new http.Agent({ keepAlive: true, timeout: 5000 });
    try {
      const [port] = await once(worker, 'message');
      const traces = [];
      const transport = {
        request (url, options, cb) {
        // Rewrite only this synthetic test's allowed endpoint to its own worker.
          assert.equal(url.href, target);
          const req = http.request('http://127.0.0.1:' + port + '/fixture', { agent, ...options }, cb);
          req.on('socket', () => traces.push(req.reusedSocket)); return req;
        }
      };
      const legacy = moduleWith(transport, source.replace('method,agent:false,headers:', 'method,headers:'));
      const fixed = moduleWith(transport);
      assert.equal((await legacy.request(target)).body, 'synthetic');
      // Let the completed socket enter the idle pool before blocking the main
      // thread. The independent server worker can still close it meanwhile.
      await new Promise(resolve => setImmediate(resolve));
      assert(Object.values(agent.freeSockets).some(sockets => sockets.length));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      await assert.rejects(legacy.request(target), { code: 'ECONNRESET' }); assert.equal(traces[1], true);
      assert.equal((await fixed.request(target)).body, 'synthetic');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      assert.equal((await fixed.request(target)).body, 'synthetic');
      assert.deepEqual(traces.slice(2), [false, false]);
    } finally { agent.destroy(); await worker.terminate(); }
  });
  await test('response abort rejects immediately and clears total deadline', async () => {
    const f = mock((req, res) => { res.emit('aborted'); res.emit('error', Object.assign(Error('synthetic'), { code: 'ECONNRESET' })); });
    await assert.rejects(f.api.request(target, 'GET', '', '', 500), { message: 'response_aborted' });
    assert.equal(f.timers.size, 0); assert.equal(f.count(), 1);
  });
  await test('response stream error and incomplete body never become a success', async () => {
    const a = mock((req, res) => res.emit('error', Object.assign(Error('synthetic'), { code: 'ECONNRESET' })));
    await assert.rejects(a.api.request(target), { code: 'ECONNRESET' });
    const b = mock((req, res) => { res.complete = false; res.emit('data', Buffer.from('partial')); res.emit('end'); });
    await assert.rejects(b.api.request(target), { message: 'response_incomplete' });
  });
  await test('body limit and idle timeout stay bounded without retry', async () => {
    const a = mock((req, res) => res.emit('data', Buffer.alloc(32 * 1024 ** 2 + 1)));
    await assert.rejects(a.api.request(target), { message: 'response_size' }); assert.equal(a.count(), 1);
    const b = mock(req => req.idle()); await assert.rejects(b.api.request(target), { message: 'timeout' }); assert.equal(b.count(), 1);
  });
  await test('total deadline terminates a stalled request without automatic retries', async () => {
    const f = mock(() => {}); const result = f.api.request(target, 'GET', '', '', 500);
    await Promise.resolve(); for (const cb of f.timers) cb();
    await assert.rejects(result, { message: 'timeout' }); assert.equal(f.timers.size, 0); assert.equal(f.count(), 1);
  });
  await test('POST errors are never retried and successful responses release deadlines', async () => {
    const a = mock(req => req.destroy(Object.assign(Error('synthetic'), { code: 'ECONNRESET' })));
    await assert.rejects(a.api.request(target, 'POST', 'synthetic', '', 500), { code: 'ECONNRESET' }); assert.equal(a.count(), 1);
    const b = mock((req, res) => { res.emit('data', Buffer.from('ok')); res.emit('end'); });
    assert.equal((await b.api.request(target, 'GET', '', '', 500)).body, 'ok'); assert.equal(b.timers.size, 0);
  });
  await test('destination guard rejects external endpoints before sending credentials', async () => {
    const api = moduleWith({ request () { throw Error('must not connect'); } });
    for (const url of ['https://127.0.0.1:8089/', 'http://example.invalid:8089/', 'http://127.0.0.1:9999/']) {
      await assert.rejects(api.request(url, 'POST', 'synthetic', 'synthetic'), { message: 'destination' });
    }
  });
  await test('failure classification includes transport codes without persisting private messages', () => {
    const api = moduleWith({});
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOENT']) {
      assert.equal(api.auditFailure(Object.assign(Error('private-synthetic-url-and-path'), { code })), code);
    }
    for (const message of ['response_aborted', 'response_incomplete', 'invalid_json']) assert.equal(api.auditFailure(Error(message)), message);
    assert.equal(api.auditFailure(Object.assign(Error('private-synthetic'), { code: 'private-synthetic' })), 'unclassified');
  });
  console.log(JSON.stringify({ passed, productionRequests: 0, actualTaskMutations: 0 }));
}
run().catch(e => { console.error(e); process.exitCode = 1; });

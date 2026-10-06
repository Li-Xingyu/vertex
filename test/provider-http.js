'use strict';
// Transport fixtures only: no DNS, network, credentials or production mounts.
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const zlib = require('zlib');
const source = fs.readFileSync(path.join(__dirname, '../app/libs/provider-http.js'), 'utf8');
let passed = 0;
function fixture (options = {}) {
  const req = new EventEmitter(); const res = new PassThrough(); let captured; let requests = 0; let lookups = 0; let now = 0; let sequence = 0;
  const timers = new Map(); const delays = [];
  req.destroy = () => { req.destroyed = true; res.destroy(); };
  res.statusCode = options.status || 200;
  res.headers = options.headers || {};
  const module = { exports: {} };
  const context = {
    module,
    Buffer,
    URL,
    Date: options.manualClock ? { now: () => now } : Date,
    setTimeout: options.manualClock ? (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); delays.push(ms); return id; } : setTimeout,
    clearTimeout: options.manualClock ? id => timers.delete(id) : clearTimeout,
    require (name) {
      if (name === 'dns') {
        return {
          promises: {
            lookup: async () => {
              lookups++;
              if (options.dnsError) throw Error('https://secret.invalid/?token=synthetic');
              if (options.stallAt === 'DNS') return new Promise(() => {});
              now += options.dnsElapsed || 0;
              return options.addresses || [{ address: '1.1.1.1', family: 4 }];
            }
          }
        };
      }
      if (name === 'https') {
        return {
          get (url, config, callback) {
            requests++; captured = { url, config };
            setImmediate(() => {
              const socket = new EventEmitter(); req.emit('socket', socket);
              if (options.stallAt === 'TCP') return;
              if (options.socketTimeout) return req.emit('timeout');
              socket.emit('connect');
              if (options.stallAt === 'TLS') return;
              socket.emit('secureConnect');
              if (options.stallAt === 'HEADERS') return;
              callback(res);
              if (options.abort) return res.emit('aborted');
              if (options.stallAt === 'BODY') { res.write(Buffer.from('partial')); return; }
              res.end(options.body || Buffer.from('fixture'));
            });
            return req;
          }
        };
      }
      if (name === './provider-schema') return { fail (code) { throw Object.assign(Error(code), { code }); } };
      return require(name);
    }
  };
  vm.runInNewContext(source, context);
  return {
    request: (limit, config, credential = 'synthetic-cookie') => module.exports.request('https://fixture.invalid/torrents.php', 'https://fixture.invalid', credential, limit, config),
    req,
    captured: () => captured,
    requests: () => requests,
    lookups: () => lookups,
    delays,
    timers,
    fire (ms) { const entry = [...timers].find(([id, v]) => v.ms === ms); assert(entry, 'expected active deadline'); now += ms; entry[1].fn(); }
  };
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
async function test (name, fn) { await fn(); passed++; process.stdout.write('PASS ' + name + '\n'); }
async function main () {
  await test('identity remains accepted and DNS is pinned once', async () => {
    const f = fixture(); assert.equal((await f.request()).toString(), 'fixture');
    const c = f.captured().config; assert.equal(c.headers['Accept-Encoding'], 'gzip, identity');
    c.lookup('fixture.invalid', {}, (error, ip, family) => { assert.equal(error, null); assert.equal(ip, '1.1.1.1'); assert.equal(family, 4); });
    assert.equal(f.requests(), 1);
  });
  await test('gzip resolves complete decoded content', async () => {
    const f = fixture({ headers: { 'content-encoding': 'gzip' }, body: zlib.gzipSync(Buffer.from('complete fixture')) });
    assert.equal((await f.request()).toString(), 'complete fixture');
  });
  await test('gzip expansion is bounded independently of wire bytes', async () => {
    const f = fixture({ headers: { 'content-encoding': 'gzip' }, body: zlib.gzipSync(Buffer.alloc(100000, 65)) });
    await assert.rejects(f.request(1024), { code: 'PROVIDER_BODY_LIMIT' }); assert(f.req.destroyed);
  });
  await test('oversized identity and compressed transfers are rejected', async () => {
    for (const encoding of ['identity', 'gzip']) {
      const f = fixture({ headers: { 'content-encoding': encoding }, body: Buffer.alloc(2000) });
      await assert.rejects(f.request(1000), { code: 'PROVIDER_BODY_LIMIT' }); assert(f.req.destroyed);
    }
  });
  await test('truncated gzip never returns partial content', async () => {
    const body = zlib.gzipSync(Buffer.from('incomplete fixture')).slice(0, -5);
    await assert.rejects(fixture({ headers: { 'content-encoding': 'gzip' }, body }).request(), { code: 'PROVIDER_ENCODING' });
  });
  await test('corrupt gzip and unnegotiated encodings fail closed', async () => {
    for (const encoding of ['gzip', 'br', 'gzip, identity']) await assert.rejects(fixture({ headers: { 'content-encoding': encoding } }).request(), { code: 'PROVIDER_ENCODING' });
  });
  await test('redirect and rate limit never decode or follow responses', async () => {
    const redirect = fixture({ status: 302, headers: { location: 'https://elsewhere.invalid/' } });
    await assert.rejects(redirect.request(), { code: 'PROVIDER_AUTH_OR_REDIRECT' }); assert.equal(redirect.requests(), 1);
    await assert.rejects(fixture({ status: 429, headers: { 'retry-after': '90' } }).request(), { code: 'PROVIDER_RATE_LIMIT', retryAfterSeconds: 90 });
  });
  await test('timeout and aborted body reject without retrying', async () => {
    const f = fixture({ socketTimeout: true }); await assert.rejects(f.request(), { code: 'PROVIDER_TIMEOUT_TCP' }); assert.equal(f.requests(), 1);
    await assert.rejects(fixture({ abort: true }).request(), { code: 'PROVIDER_NETWORK' });
  });
  await test('private DNS blocks before a network request', async () => {
    const f = fixture({ addresses: [{ address: '127.0.0.1', family: 4 }] });
    await assert.rejects(f.request(), { code: 'PROVIDER_PRIVATE_ADDRESS' }); assert.equal(f.requests(), 0);
  });
  await test('DNS timeout has a separate safe code and starts no HTTP request', async () => {
    const f = fixture({ manualClock: true, stallAt: 'DNS' }); const p = f.request();
    const checked = assert.rejects(p, { code: 'PROVIDER_TIMEOUT_DNS' }); f.fire(5000); await checked;
    assert.equal(f.requests(), 0); assert.equal(f.timers.size, 0);
  });
  await test('DNS failures never expose the resolver exception', async () => {
    await assert.rejects(fixture({ dnsError: true }).request(), e => {
      assert.equal(e.code, 'PROVIDER_DNS'); assert.equal(e.transport.phase, 'DNS');
      assert(!JSON.stringify(e).includes('secret')); assert(!e.message.includes('token')); return true;
    });
  });
  await test('inclusive legacy budget subtracts DNS rather than adding five seconds', async () => {
    const f = fixture({ manualClock: true, dnsElapsed: 4000, stallAt: 'HEADERS' });
    const p = f.request(undefined, { totalTimeoutMs: 18000, idleTimeoutMs: 18000, dnsTimeoutMs: 18000 });
    await flush(); assert.deepEqual(f.delays, [18000, 14000]);
    const checked = assert.rejects(p, e => e.code === 'PROVIDER_TIMEOUT_HEADERS' && e.transport.elapsedMs === 18000 && e.transport.timeoutKind === 'deadline');
    f.fire(14000); await checked; assert(f.req.destroyed); assert.equal(f.timers.size, 0);
  });
  await test('short residual budget applies to DNS too', async () => {
    const f = fixture({ manualClock: true, stallAt: 'DNS' });
    const checked = assert.rejects(f.request(undefined, { totalTimeoutMs: 1200 }), { code: 'PROVIDER_TIMEOUT_DNS' });
    f.fire(1200); await checked; assert.equal(f.requests(), 0);
  });
  await test('DNS completing after the inclusive deadline cannot start HTTP', async () => {
    const f = fixture({ manualClock: true, dnsElapsed: 19000 });
    await assert.rejects(f.request(undefined, { totalTimeoutMs: 18000 }), { code: 'PROVIDER_TIMEOUT_DNS' });
    assert.equal(f.requests(), 0); assert.equal(f.timers.size, 0);
  });
  await test('each network phase distinguishes deadline and idle expiry without retry', async () => {
    for (const phase of ['TCP', 'TLS', 'HEADERS', 'BODY']) {
      for (const kind of ['deadline', 'idle']) {
        const f = fixture({ manualClock: true, stallAt: phase }); const p = f.request(); await flush();
        const checked = assert.rejects(p, e => {
          assert.equal(e.code, 'PROVIDER_TIMEOUT_' + phase); assert.equal(e.transport.phase, phase); assert.equal(e.transport.timeoutKind, kind);
          assert.equal(e.transport.statusCode, phase === 'BODY' ? 200 : 0);
          assert.equal(e.transport.wireBytes, phase === 'BODY' ? 7 : 0);
          assert(!JSON.stringify(e).includes('synthetic-cookie')); assert(!JSON.stringify(e).includes('fixture.invalid')); return true;
        });
        if (kind === 'deadline') f.fire(20000); else f.req.emit('timeout');
        await checked; assert(f.req.destroyed); assert.equal(f.requests(), 1); assert.equal(f.timers.size, 0);
      }
    }
  });
  await test('defaults preserve existing provider time budgets', async () => {
    const f = fixture({ manualClock: true, dnsElapsed: 4000 }); await f.request();
    assert.deepEqual(f.delays, [5000, 20000]); assert.equal(f.captured().config.timeout, 15000); assert.equal(f.timers.size, 0);
  });
  await test('legacy user agent is retained and RSS sends no cookie', async () => {
    const f = fixture(); await f.request(undefined, { totalTimeoutMs: 18000, userAgent: 'Mozilla/5.0' }, '');
    assert.equal(f.captured().config.headers['User-Agent'], 'Mozilla/5.0'); assert(!('Cookie' in f.captured().config.headers));
  });
  await test('invalid or expanded request budgets fail before DNS', async () => {
    for (const options of [{ totalTimeoutMs: 0 }, { totalTimeoutMs: 20001 }, { totalTimeoutMs: NaN }, { idleTimeoutMs: 18001 }, { idleTimeoutMs: 0 }, { dnsTimeoutMs: 0 }, { dnsTimeoutMs: 18001 }, { userAgent: 'injected\r\nheader' }]) {
      const f = fixture(); await assert.rejects(f.request(undefined, options), { code: 'PROVIDER_REQUEST_BUDGET' }); assert.equal(f.lookups(), 0);
    }
    for (const bytes of [0, -1, 16 * 1024 ** 2 + 1, Infinity]) await assert.rejects(fixture().request(bytes), { code: 'PROVIDER_REQUEST_BUDGET' });
  });
  await test('existing torrent metadata caller retains its explicit 16 MiB cap', async () => {
    const f = fixture(); assert.equal((await f.request(16 * 1024 ** 2)).toString(), 'fixture');
  });
  process.stdout.write(JSON.stringify({ passed }) + '\n');
}
main().catch(e => { process.stderr.write(e.stack + '\n'); process.exitCode = 1; });

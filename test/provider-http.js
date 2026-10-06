'use strict';
// Synthetic transport fixtures; the two socket cases use loopback only.
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
  const tunnel = new EventEmitter(); const tunnelSocket = new PassThrough(); const secureSocket = new PassThrough(); let proxyCaptured; let tlsCaptured;
  tunnel.destroy = () => { tunnel.destroyed = true; };
  tunnel.end = () => setImmediate(() => {
    if (options.stallAt === 'PROXY') return;
    tunnel.emit('connect', { statusCode: options.proxyStatus || 200 }, tunnelSocket, Buffer.alloc(0));
  });
  const timers = new Map(); const delays = [];
  req.destroy = () => { req.destroyed = true; res.destroy(); };
  res.statusCode = options.status || 200;
  res.headers = options.headers || {};
  const module = { exports: {} };
  const context = {
    module,
    Buffer,
    URL,
    proxy: options.proxy,
    domains: 'unrelated.invalid',
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
          Agent: class { destroy () { this.destroyed = true; } },
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
      if (name === 'http') return { request (url, config) { proxyCaptured = { url, config }; return tunnel; } };
      if (name === 'tls') {
        return {
          connect (config) {
            tlsCaptured = config;
            setImmediate(() => {
              if (options.tlsError) secureSocket.emit('error', Error('secret certificate details'));
              else if (options.stallAt !== 'TLS') secureSocket.emit('secureConnect');
            });
            return secureSocket;
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
    proxyCaptured: () => proxyCaptured,
    tlsCaptured: () => tlsCaptured,
    tunnel,
    tunnelSocket,
    secureSocket,
    context,
    delays,
    timers,
    res,
    advance (ms) { now += ms; },
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
    for (const options of [{ totalTimeoutMs: 0 }, { totalTimeoutMs: 120001 }, { totalTimeoutMs: NaN }, { idleTimeoutMs: 60001 }, { idleTimeoutMs: 0 }, { dnsTimeoutMs: 0 }, { dnsTimeoutMs: 30001 }, { connectTimeoutMs: 0 }, { connectTimeoutMs: 30001 }, { connectTimeoutMs: NaN }, { userAgent: 'injected\r\nheader' }]) {
      const f = fixture(); await assert.rejects(f.request(undefined, options), { code: 'PROVIDER_REQUEST_BUDGET' }); assert.equal(f.lookups(), 0);
    }
    for (const bytes of [0, -1, 16 * 1024 ** 2 + 1, Infinity]) await assert.rejects(fixture().request(bytes), { code: 'PROVIDER_REQUEST_BUDGET' });
  });
  await test('existing torrent metadata caller retains its explicit 16 MiB cap', async () => {
    const f = fixture(); assert.equal((await f.request(16 * 1024 ** 2)).toString(), 'fixture');
  });
  const configured = { connectTimeoutMs: 15000, dnsTimeoutMs: 15000, idleTimeoutMs: 30000, totalTimeoutMs: 60000 };
  await test('configured connection deadline includes DNS TCP and TLS, then releases', async () => {
    for (const phase of ['TCP', 'TLS']) {
      const f = fixture({ manualClock: true, dnsElapsed: 4000, stallAt: phase }); const p = f.request(undefined, configured); await flush();
      const checked = assert.rejects(p, e => e.code === 'PROVIDER_TIMEOUT_' + phase && e.transport.timeoutKind === 'connect' && e.transport.elapsedMs === 15000);
      f.fire(11000); await checked; assert.equal(f.timers.size, 0);
    }
    const f = fixture({ manualClock: true, stallAt: 'HEADERS' }); const p = f.request(undefined, configured); await flush();
    assert(![...f.timers.values()].some(t => t.ms === 15000));
    const checked = assert.rejects(p, e => e.code === 'PROVIDER_TIMEOUT_HEADERS' && e.transport.timeoutKind === 'idle');
    f.fire(30000); await checked; assert.equal(f.timers.size, 0);
  });
  await test('progressing page beyond twenty seconds completes, idle resets but total does not', async () => {
    const f = fixture({ manualClock: true, stallAt: 'BODY' }); const p = f.request(undefined, configured); await flush();
    const totalTimer = [...f.timers].find(([, t]) => t.ms === 60000)[0];
    const idleTimer = [...f.timers].find(([, t]) => t.ms === 30000)[0];
    f.advance(12000); f.res.write(Buffer.from(' more')); await flush();
    assert(!f.timers.has(idleTimer)); assert(f.timers.has(totalTimer));
    f.advance(12000); f.res.end(Buffer.from(' complete'));
    assert.equal((await p).toString(), 'partial more complete'); assert.equal(f.requests(), 1); assert.equal(f.timers.size, 0);
  });
  await test('configured stalled body fails idle; continuous progress cannot defeat total deadline', async () => {
    for (const kind of ['idle', 'deadline']) {
      const f = fixture({ manualClock: true, stallAt: 'BODY' }); const p = f.request(undefined, configured); await flush();
      const checked = assert.rejects(p, e => e.code === 'PROVIDER_TIMEOUT_BODY' && e.transport.timeoutKind === kind);
      f.fire(kind === 'idle' ? 30000 : 60000); await checked;
      assert(f.req.destroyed); assert.equal(f.requests(), 1); assert.equal(f.timers.size, 0);
    }
  });
  await test('cycle residual deadline wins over configured connection and read limits', async () => {
    const f = fixture({ manualClock: true, dnsElapsed: 500, stallAt: 'TLS' }); const p = f.request(undefined, { ...configured, totalTimeoutMs: 1200 }); await flush();
    const checked = assert.rejects(p, e => e.code === 'PROVIDER_TIMEOUT_TLS' && e.transport.elapsedMs === 1200 && e.transport.timeoutKind === 'deadline');
    f.fire(700); await checked; assert.equal(f.timers.size, 0);
  });
  await test('saved proxy applies without domain membership and CONNECT never contains site credentials', async () => {
    const f = fixture({ proxy: 'http://proxyuser:proxypass@proxy.invalid:7890' });
    assert.equal((await f.request()).toString(), 'fixture');
    const c = f.proxyCaptured().config;
    assert.equal(c.method, 'CONNECT'); assert.equal(c.path, 'fixture.invalid:443');
    assert.equal(c.headers['Proxy-Authorization'], 'Basic ' + Buffer.from('proxyuser:proxypass').toString('base64'));
    assert(!JSON.stringify(c).includes('synthetic-cookie'));
    assert.equal(f.tlsCaptured().servername, 'fixture.invalid'); assert.equal(f.tlsCaptured().rejectUnauthorized, true);
    assert(f.captured().config.agent); assert(!f.captured().config.lookup);
    assert.equal(f.captured().config.headers.Cookie, 'synthetic-cookie');
    assert(!f.captured().config.headers['Proxy-Authorization']);
    assert(f.secureSocket.destroyed); assert(f.tunnelSocket.destroyed);
  });
  await test('clearing proxy returns subsequent calls to direct routing', async () => {
    const f = fixture({ proxy: 'http://proxy.invalid:7890' });
    f.context.proxy = ''; await f.request();
    assert(!f.proxyCaptured()); assert(f.captured().config.lookup);
  });
  await test('bad proxy configuration cannot silently fall back to direct', async () => {
    for (const proxy of ['socks5://proxy.invalid:7890', 'invalid', 'http://proxy.invalid/path', 'http://proxy.invalid/?token=secret', 'http://%ZZ@proxy.invalid']) {
      const f = fixture({ proxy });
      await assert.rejects(f.request(), { code: 'PROVIDER_PROXY_CONFIG' });
      assert.equal(f.lookups(), 0); assert.equal(f.requests(), 0);
    }
  });
  await test('proxy refusal and TLS verification failure never send origin GET or cookie', async () => {
    for (const extra of [{ proxyStatus: 407 }, { tlsError: true }]) {
      const f = fixture({ proxy: 'http://proxy.invalid:7890', ...extra });
      await assert.rejects(f.request(), e => ['PROVIDER_PROXY_CONNECT', 'PROVIDER_NETWORK'].includes(e.code) && !JSON.stringify(e).includes('secret'));
      assert.equal(f.requests(), 0); assert(f.tunnel.destroyed); assert(f.tunnelSocket.destroyed);
    }
  });
  await test('proxy and tunneled TLS stalls obey deadline and close pending connections', async () => {
    for (const phase of ['PROXY', 'TLS']) {
      const f = fixture({ proxy: 'http://proxy.invalid:7890', manualClock: true, stallAt: phase });
      const p = f.request(undefined, configured); await flush();
      const checked = assert.rejects(p, { code: 'PROVIDER_TIMEOUT_' + phase });
      f.fire(15000); await checked; assert.equal(f.requests(), 0); assert(f.tunnel.destroyed);
      if (phase === 'TLS') { assert(f.tunnelSocket.destroyed); assert(f.secureSocket.destroyed); }
      assert.equal(f.timers.size, 0);
    }
  });
  await test('real CONNECT refusal and stalled proxy close sockets without origin credentials', async () => {
    for (const status of [407, 0]) {
      const http = require('http'); const sockets = new Set(); let observed;
      const server = http.createServer();
      server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      server.on('connect', (req, socket) => {
        observed = { url: req.url, headers: req.headers };
        socket.resume();
        socket.on('end', () => socket.end());
        if (status) socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const module = { exports: {} };
      vm.runInNewContext(source, {
        module,
        Buffer,
        URL,
        setTimeout,
        clearTimeout,
        proxy: 'http://127.0.0.1:' + server.address().port,
        require: name => name === 'dns' ? { promises: { lookup: async () => [{ address: '1.1.1.1', family: 4 }] } } : name === './provider-schema' ? { fail: code => { throw Object.assign(Error(code), { code }); } } : require(name)
      });
      try {
        await assert.rejects(module.exports.request('https://fixture.invalid/list', 'https://fixture.invalid', 'synthetic-cookie', 1024, { connectTimeoutMs: 200, totalTimeoutMs: 500 }), { code: status ? 'PROVIDER_PROXY_CONNECT' : 'PROVIDER_TIMEOUT_PROXY' });
        assert.equal(observed.url, 'fixture.invalid:443'); assert(!observed.headers.cookie);
        await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(sockets.size, 0);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
      }
    }
  });
  process.stdout.write(JSON.stringify({ passed }) + '\n');
}
main().catch(e => { process.stderr.write(e.stack + '\n'); process.exitCode = 1; });

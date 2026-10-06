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
  const req = new EventEmitter(); const res = new PassThrough(); let captured; let requests = 0;
  req.destroy = () => { req.destroyed = true; res.destroy(); };
  res.statusCode = options.status || 200;
  res.headers = options.headers || {};
  const module = { exports: {} };
  const context = {
    module,
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
    require (name) {
      if (name === 'dns') return { promises: { lookup: async () => options.addresses || [{ address: '1.1.1.1', family: 4 }] } };
      if (name === 'https') {
        return {
          get (url, config, callback) {
            requests++; captured = { url, config };
            setImmediate(() => {
              if (options.socketTimeout) return req.emit('timeout');
              callback(res);
              if (options.abort) return res.emit('aborted');
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
  return { request: limit => module.exports.request('https://fixture.invalid/torrents.php', 'https://fixture.invalid', 'synthetic-cookie', limit), req, captured: () => captured, requests: () => requests };
}
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
    const f = fixture({ socketTimeout: true }); await assert.rejects(f.request(), { code: 'PROVIDER_TIMEOUT' }); assert.equal(f.requests(), 1);
    await assert.rejects(fixture({ abort: true }).request(), { code: 'PROVIDER_NETWORK' });
  });
  await test('private DNS blocks before a network request', async () => {
    const f = fixture({ addresses: [{ address: '127.0.0.1', family: 4 }] });
    await assert.rejects(f.request(), { code: 'PROVIDER_PRIVATE_ADDRESS' }); assert.equal(f.requests(), 0);
  });
  process.stdout.write(JSON.stringify({ passed }) + '\n');
}
main().catch(e => { process.stderr.write(e.stack + '\n'); process.exitCode = 1; });

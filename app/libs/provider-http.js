'use strict';
const https = require('https');
const dns = require('dns').promises;
const net = require('net');
const zlib = require('zlib');
const { fail } = require('./provider-schema');

function retryAfter (value, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 128) return 0;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value.trim()) : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(86400, Math.ceil(seconds)) : 0;
}

function publicAddress (address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  // Only global unicast IPv6; mapped IPv4, ULA, link-local and multicast fail.
  return net.isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:0:|db8:)/i.test(address);
}
async function request (url, origin, credential, maxBytes = 8 * 1024 ** 2) {
  const u = new URL(url);
  if (u.origin !== origin || u.protocol !== 'https:' || u.username || u.password || u.hash || net.isIP(u.hostname)) fail('PROVIDER_DESTINATION');
  // Resolve once and pin the TCP endpoint: a second DNS lookup cannot rebind.
  let addresses;
  let timer;
  try { addresses = await Promise.race([dns.lookup(u.hostname, { all: true }), new Promise((resolve, reject) => { timer = setTimeout(() => reject(Error()), 5000); })]); } catch (_) { fail('PROVIDER_DNS'); } finally { clearTimeout(timer); }
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) fail('PROVIDER_PRIVATE_ADDRESS');
  const ip = addresses[0];
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'Mozilla/5.0 Vertex list provider', 'Accept-Encoding': 'gzip, identity' };
    if (credential) headers.Cookie = credential;
    let done = false; let decoder;
    const finish = (error, value, retryAfterSeconds = 0) => {
      if (done) return;
      done = true; clearTimeout(deadline);
      if (error) {
        if (decoder) decoder.destroy();
        q.destroy();
        reject(Object.assign(new Error(error), { code: error, retryAfterSeconds }));
      } else resolve(value);
    };
    const q = https.get(u, { headers, lookup: (host, options, cb) => cb(null, ip.address, ip.family), timeout: 15000 }, r => {
      const encoding = String(r.headers['content-encoding'] || 'identity').trim().toLowerCase();
      if (r.statusCode !== 200) {
        r.resume(); const e = r.statusCode === 429 ? 'PROVIDER_RATE_LIMIT' : r.statusCode === 401 || r.statusCode === 403 || (r.statusCode >= 300 && r.statusCode < 400) ? 'PROVIDER_AUTH_OR_REDIRECT' : 'PROVIDER_HTTP';
        finish(e, null, r.statusCode === 429 || r.statusCode === 503 ? retryAfter(r.headers['retry-after']) : 0); q.destroy(); return;
      }
      if (!['identity', 'gzip'].includes(encoding)) { r.resume(); finish('PROVIDER_ENCODING'); return; }
      const chunks = []; let wireBytes = 0; let decodedBytes = 0;
      // Bound both transfer and decompressed content; never synchronously
      // inflate an untrusted response or resolve a partial gzip stream.
      r.on('data', chunk => { wireBytes += chunk.length; if (wireBytes > maxBytes) finish('PROVIDER_BODY_LIMIT'); });
      const body = encoding === 'gzip' ? (decoder = zlib.createGunzip()) : r;
      body.on('data', chunk => {
        if (done) return;
        decodedBytes += chunk.length;
        if (decodedBytes > maxBytes) finish('PROVIDER_BODY_LIMIT');
        else chunks.push(chunk);
      });
      body.on('end', () => finish(null, Buffer.concat(chunks)));
      if (decoder) { decoder.on('error', () => finish('PROVIDER_ENCODING')); r.pipe(decoder); }
      r.on('aborted', () => finish('PROVIDER_NETWORK')); r.on('error', () => finish('PROVIDER_NETWORK'));
    });
    const deadline = setTimeout(() => { finish('PROVIDER_TIMEOUT'); q.destroy(); }, 20000);
    q.on('timeout', () => { finish('PROVIDER_TIMEOUT'); q.destroy(); }); q.on('error', () => finish('PROVIDER_NETWORK'));
  });
}
module.exports = { request, publicAddress, retryAfter };

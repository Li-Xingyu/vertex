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
async function request (url, origin, credential, maxBytes = 8 * 1024 ** 2, options = {}) {
  const u = new URL(url);
  if (u.origin !== origin || u.protocol !== 'https:' || u.username || u.password || u.hash || net.isIP(u.hostname)) fail('PROVIDER_DESTINATION');
  const total = options.totalTimeoutMs; const idle = options.idleTimeoutMs === undefined ? 15000 : options.idleTimeoutMs;
  const dnsTimeout = options.dnsTimeoutMs === undefined ? 5000 : options.dnsTimeoutMs;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 16 * 1024 ** 2 ||
    (total !== undefined && (!Number.isFinite(total) || total <= 0 || total > 20000)) ||
    !Number.isFinite(idle) || idle <= 0 || idle > 18000 ||
    !Number.isFinite(dnsTimeout) || dnsTimeout <= 0 || dnsTimeout > 18000 ||
    (options.userAgent !== undefined && (typeof options.userAgent !== 'string' || options.userAgent.length > 1024 || /[\r\n]/.test(options.userAgent)))) fail('PROVIDER_REQUEST_BUDGET');
  const started = Date.now(); let phase = 'DNS'; let wireBytes = 0; let decodedBytes = 0; let statusCode = 0;
  // This object contains only bounded diagnostics, never a URL, header, IP or
  // underlying exception message. Codes also survive the public API sanitizer.
  const error = (code, retryAfterSeconds = 0, timeoutKind = '') => Object.assign(new Error(code), {
    code,
    retryAfterSeconds,
    transport: { phase, elapsedMs: Math.max(0, Date.now() - started), wireBytes, decodedBytes, statusCode, timeoutKind }
  });
  // Resolve once and pin the TCP endpoint: a second DNS lookup cannot rebind.
  let addresses;
  let timer; let dnsTimedOut = false;
  try {
    addresses = await Promise.race([dns.lookup(u.hostname, { all: true }), new Promise((resolve, reject) => {
      timer = setTimeout(() => { dnsTimedOut = true; reject(Error()); }, Math.min(dnsTimeout, total === undefined ? dnsTimeout : total));
    })]);
  } catch (_) { throw error(dnsTimedOut ? 'PROVIDER_TIMEOUT_DNS' : 'PROVIDER_DNS', 0, dnsTimedOut ? 'deadline' : ''); } finally { clearTimeout(timer); }
  // Legacy callers supply an inclusive wall-clock budget. Default provider
  // callers retain their existing 5s DNS + 20s request / 15s idle ceilings.
  const remaining = total === undefined ? 20000 : total - (Date.now() - started);
  if (remaining <= 0) throw error('PROVIDER_TIMEOUT_DNS', 0, 'deadline');
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) fail('PROVIDER_PRIVATE_ADDRESS');
  const ip = addresses[0];
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': options.userAgent === undefined ? 'Mozilla/5.0 Vertex list provider' : options.userAgent, 'Accept-Encoding': 'gzip, identity' };
    if (credential) headers.Cookie = credential;
    let done = false; let decoder; let q;
    phase = 'TCP';
    const finish = (code, value, retryAfterSeconds = 0, timeoutKind = '') => {
      if (done) return;
      done = true; clearTimeout(deadline);
      if (code) {
        if (decoder) decoder.destroy();
        if (q) q.destroy();
        reject(error(code, retryAfterSeconds, timeoutKind));
      } else resolve(value);
    };
    const timeout = kind => finish('PROVIDER_TIMEOUT_' + phase, null, 0, kind);
    const deadline = setTimeout(() => timeout('deadline'), remaining);
    try {
      q = https.get(u, { headers, lookup: (host, options, cb) => cb(null, ip.address, ip.family), timeout: idle }, r => {
        if (done) { r.destroy(); return; }
        phase = 'BODY'; statusCode = r.statusCode;
        const encoding = String(r.headers['content-encoding'] || 'identity').trim().toLowerCase();
        if (r.statusCode !== 200) {
          r.resume(); const e = r.statusCode === 429 ? 'PROVIDER_RATE_LIMIT' : r.statusCode === 401 || r.statusCode === 403 || (r.statusCode >= 300 && r.statusCode < 400) ? 'PROVIDER_AUTH_OR_REDIRECT' : 'PROVIDER_HTTP';
          finish(e, null, r.statusCode === 429 || r.statusCode === 503 ? retryAfter(r.headers['retry-after']) : 0); return;
        }
        if (!['identity', 'gzip'].includes(encoding)) { r.resume(); finish('PROVIDER_ENCODING'); return; }
        const chunks = [];
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
      q.on('socket', socket => {
        if (done) return;
        if (q.reusedSocket) phase = 'HEADERS';
        socket.once('connect', () => { if (!done) phase = 'TLS'; });
        socket.once('secureConnect', () => { if (!done) phase = 'HEADERS'; });
      });
      q.on('timeout', () => timeout('idle')); q.on('error', () => finish('PROVIDER_NETWORK'));
    } catch (_) { finish('PROVIDER_NETWORK'); }
  });
}
module.exports = { request, publicAddress, retryAfter };

'use strict';
const https = require('https');
const http = require('http');
const tls = require('tls');
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
  // Reuse Vertex's saved proxy address. The trusted proxy owns routing; the
  // legacy global.domains allowlist does not apply to provider acquisition.
  let proxy;
  if (globalThis.proxy) {
    try {
      proxy = new URL(globalThis.proxy);
      if (!['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname || proxy.pathname !== '/' || proxy.search || proxy.hash) throw Error();
      decodeURIComponent(proxy.username); decodeURIComponent(proxy.password);
    } catch (_) { fail('PROVIDER_PROXY_CONFIG'); }
  }
  const total = options.totalTimeoutMs; const idle = options.idleTimeoutMs === undefined ? 15000 : options.idleTimeoutMs;
  const connect = options.connectTimeoutMs;
  const dnsTimeout = options.dnsTimeoutMs === undefined ? 5000 : options.dnsTimeoutMs;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 16 * 1024 ** 2 ||
    (total !== undefined && (!Number.isFinite(total) || total <= 0 || total > 120000)) ||
    (connect !== undefined && (!Number.isFinite(connect) || connect <= 0 || connect > 30000)) ||
    !Number.isFinite(idle) || idle <= 0 || idle > 60000 ||
    !Number.isFinite(dnsTimeout) || dnsTimeout <= 0 || dnsTimeout > 30000 ||
    (options.userAgent !== undefined && (typeof options.userAgent !== 'string' || options.userAgent.length > 1024 || /[\r\n]/.test(options.userAgent)))) fail('PROVIDER_REQUEST_BUDGET');
  const started = Date.now(); let phase = 'DNS'; let wireBytes = 0; let decodedBytes = 0; let statusCode = 0;
  // This object contains only bounded diagnostics, never a URL, header, IP or
  // underlying exception message. Codes also survive the public API sanitizer.
  const error = (code, retryAfterSeconds = 0, timeoutKind = '') => Object.assign(new Error(code), {
    code,
    retryAfterSeconds,
    transport: { phase, elapsedMs: Math.max(0, Date.now() - started), wireBytes, decodedBytes, statusCode, timeoutKind }
  });
  // Direct connections pin validated DNS. With an explicit trusted proxy,
  // CONNECT carries the approved hostname so its DNS and routing rules apply.
  let addresses;
  let timer; let dnsTimedOut = false;
  try {
    addresses = await Promise.race([dns.lookup(u.hostname, { all: true }), new Promise((resolve, reject) => {
      timer = setTimeout(() => { dnsTimedOut = true; reject(Error()); }, Math.min(dnsTimeout, total === undefined ? Infinity : total, connect === undefined ? Infinity : connect));
    })]);
  } catch (_) { throw error(dnsTimedOut ? 'PROVIDER_TIMEOUT_DNS' : 'PROVIDER_DNS', 0, dnsTimedOut ? 'deadline' : ''); } finally { clearTimeout(timer); }
  // Legacy callers supply an inclusive wall-clock budget. Default provider
  // callers retain their existing 5s DNS + 20s request / 15s idle ceilings.
  const remaining = total === undefined ? 20000 : total - (Date.now() - started);
  if (remaining <= 0) throw error('PROVIDER_TIMEOUT_DNS', 0, 'deadline');
  const connectRemaining = connect === undefined ? null : connect - (Date.now() - started);
  if (connectRemaining !== null && connectRemaining <= 0) throw error('PROVIDER_TIMEOUT_DNS', 0, 'connect');
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) fail('PROVIDER_PRIVATE_ADDRESS');
  const ip = addresses[0];
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': options.userAgent === undefined ? 'Mozilla/5.0 Vertex list provider' : options.userAgent, 'Accept-Encoding': 'gzip, identity' };
    if (credential) headers.Cookie = credential;
    let done = false; let decoder; let q; let connectTimer; let readTimer;
    let tunnelRequest; let tunnelSocket; let secureSocket; let agent;
    phase = proxy ? 'PROXY' : 'TCP';
    const finish = (code, value, retryAfterSeconds = 0, timeoutKind = '') => {
      if (done) return;
      done = true; clearTimeout(deadline); clearTimeout(connectTimer); clearTimeout(readTimer);
      if (tunnelRequest) tunnelRequest.destroy();
      if (secureSocket) secureSocket.destroy();
      if (tunnelSocket) tunnelSocket.destroy();
      if (agent) agent.destroy();
      if (code) {
        if (decoder) decoder.destroy();
        if (q) q.destroy();
        reject(error(code, retryAfterSeconds, timeoutKind));
      } else resolve(value);
    };
    const timeout = kind => finish('PROVIDER_TIMEOUT_' + phase, null, 0, kind);
    const deadline = setTimeout(() => timeout('deadline'), remaining);
    if (connectRemaining !== null) connectTimer = setTimeout(() => timeout('connect'), connectRemaining);
    // A read timeout measures lack of response progress, not total page time.
    // Keep the inclusive request deadline as a separate slow-stream ceiling.
    const reading = () => {
      if (connect === undefined || done) return;
      clearTimeout(connectTimer); clearTimeout(readTimer);
      readTimer = setTimeout(() => timeout('idle'), idle);
    };
    const startRequest = () => {
      if (done) return;
      try {
        const transport = proxy ? { agent } : { lookup: (host, options, cb) => cb(null, ip.address, ip.family) };
        q = https.get(u, { headers, ...transport, timeout: connect === undefined ? idle : 0 }, r => {
          if (done) { r.destroy(); return; }
          phase = 'BODY'; statusCode = r.statusCode; reading();
          const encoding = String(r.headers['content-encoding'] || 'identity').trim().toLowerCase();
          if (r.statusCode !== 200) {
            r.resume(); const e = r.statusCode === 429 ? 'PROVIDER_RATE_LIMIT' : r.statusCode === 401 || r.statusCode === 403 || (r.statusCode >= 300 && r.statusCode < 400) ? 'PROVIDER_AUTH_OR_REDIRECT' : 'PROVIDER_HTTP';
            finish(e, null, r.statusCode === 429 || r.statusCode === 503 ? retryAfter(r.headers['retry-after']) : 0); return;
          }
          if (!['identity', 'gzip'].includes(encoding)) { r.resume(); finish('PROVIDER_ENCODING'); return; }
          const chunks = [];
          // Bound both transfer and decompressed content; never synchronously
          // inflate an untrusted response or resolve a partial gzip stream.
          r.on('data', chunk => { wireBytes += chunk.length; reading(); if (wireBytes > maxBytes) finish('PROVIDER_BODY_LIMIT'); });
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
          if (q.reusedSocket) { phase = 'HEADERS'; reading(); }
          socket.once('connect', () => { if (!done) phase = 'TLS'; });
          socket.once('secureConnect', () => { if (!done) { phase = 'HEADERS'; reading(); } });
        });
        q.on('timeout', () => timeout('idle')); q.on('error', () => finish('PROVIDER_NETWORK'));
      } catch (_) { finish('PROVIDER_NETWORK'); }
    };
    if (!proxy) return startRequest();
    // Own the CONNECT request and both sockets so deadlines also cancel a
    // stalled proxy handshake, before Node has attached a socket to the GET.
    try {
      const authority = u.hostname + ':' + (u.port || '443');
      const proxyHeaders = { Host: authority };
      if (proxy.username || proxy.password) proxyHeaders['Proxy-Authorization'] = 'Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64');
      tunnelRequest = (proxy.protocol === 'https:' ? https : http).request(proxy, {
        method: 'CONNECT',
        path: authority,
        headers: proxyHeaders,
        agent: false,
        maxHeaderSize: 16384,
        timeout: connect === undefined ? idle : 0
      });
      tunnelRequest.on('connect', (response, socket, head) => {
        if (done) { socket.destroy(); return; }
        tunnelSocket = socket;
        if (response.statusCode !== 200 || head.length) { finish('PROVIDER_PROXY_CONNECT'); return; }
        phase = 'TLS';
        try {
          secureSocket = tls.connect({ socket, servername: u.hostname, rejectUnauthorized: true });
          secureSocket.on('error', () => finish('PROVIDER_NETWORK'));
          secureSocket.once('secureConnect', () => {
            if (done) { secureSocket.destroy(); return; }
            agent = new https.Agent({ keepAlive: false });
            agent.createConnection = () => secureSocket;
            phase = 'HEADERS'; reading(); startRequest();
          });
        } catch (_) { finish('PROVIDER_NETWORK'); }
      });
      tunnelRequest.on('response', r => { r.destroy(); finish('PROVIDER_PROXY_CONNECT'); });
      tunnelRequest.on('timeout', () => timeout('idle'));
      tunnelRequest.on('error', () => finish('PROVIDER_NETWORK'));
      tunnelRequest.end();
    } catch (_) { finish('PROVIDER_PROXY_CONNECT'); }
  });
}
module.exports = { request, publicAddress, retryAfter };

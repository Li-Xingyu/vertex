// Run ONLY inside a fresh, network-isolated test container. No credential output.
const assert = require('assert').strict;
const fs = require('fs');
const http = require('http');
let phase = 'http';

function request (method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) };
    if (cookie) headers.cookie = cookie;
    const req = http.request({ hostname: '127.0.0.1', port: 3000, method, path, headers, timeout: 3000 }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, cookie: (res.headers['set-cookie'] || []).map(x => x.split(';')[0]).join('; '), data }));
    });
    req.on('timeout', () => req.destroy(new Error('SMOKE_TIMEOUT')));
    req.on('error', reject);
    req.end(payload);
  });
}

async function main () {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { ready = (await request('GET', '/')).status === 302; } catch (_) {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(ready, 'fresh container HTTP startup failed');
  phase = 'login';
  const setting = JSON.parse(fs.readFileSync('/vertex/data/setting.json', 'utf8'));
  const login = await request('POST', '/api/user/login', { username: setting.username, password: setting.password });
  assert.equal(JSON.parse(login.data).success, true, 'fresh container login failed');
  phase = 'databaseHistory';
  const history = await request('GET', '/api/torrent/listHistory?page=1&length=10', null, login.cookie);
  assert.equal(history.status, 200);
  assert.equal(JSON.parse(history.data).success, true, 'real application database query failed');
  phase = 'compiledUi';
  const index = await request('GET', '/index', null, login.cookie);
  assert.equal(index.status, 200);
  assert(index.data.includes('id="app"'), 'compiled Vue UI missing');
  process.stdout.write(JSON.stringify({ ok: true, http: true, login: true, databaseHistory: true, compiledUi: true }) + '\n');
}

main().catch(() => { process.stderr.write('STARTUP_SMOKE_FAILED: ' + phase + '\n'); process.exitCode = 1; });

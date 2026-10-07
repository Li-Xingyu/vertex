'use strict';
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { digest, fail } = require('./provider-schema');

// A bounded, persistent rejection hint, NOT admission or promotion evidence.
// Store no cookie, URL, title or .torrent body. A hit may only avoid a request
// when a current duplicate guard still blocks; a miss uses normal preparation.
const TTL = 72 * 3600000;
const LIMIT = 2000;
const MAX_BYTES = 1024 * 1024;
class ProviderIdentityCache {
  constructor (store, clock = () => Date.now()) { this.store = store; this.clock = clock; }
  file (profile) {
    if (!/^[A-Z][A-Z0-9]{0,31}$/.test(profile)) fail('PROVIDER_IDENTITY_STORE');
    return path.join(this.store.root, 'identity-' + profile + '.json');
  }

  async read (profile) {
    try {
      const file = this.file(profile);
      if ((await fs.stat(file)).size > MAX_BYTES) fail('PROVIDER_IDENTITY_STORE');
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > LIMIT) fail('PROVIDER_IDENTITY_STORE');
      const seen = new Set();
      for (const e of data.entries) {
        if (!e || !/^[a-f0-9]{64}$/.test(e.key) || seen.has(e.key) || !/^[a-f0-9]{40}$/.test(e.hash) || !Number.isSafeInteger(e.size) || e.size <= 0 || !Number.isSafeInteger(e.verifiedAt) || e.verifiedAt < 0 || Object.keys(e).some(k => !['key', 'hash', 'size', 'verifiedAt'].includes(k))) fail('PROVIDER_IDENTITY_STORE');
        seen.add(e.key);
      }
      return data.entries;
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      fail('PROVIDER_IDENTITY_STORE');
    }
  }

  key (version, candidate) {
    // Changed parser/config or content fields invalidate the association.
    // Dynamic swarm/free/HR fields are deliberately NOT cached: those always
    // come from the current authenticated list and existing final guards.
    return digest([version.digest, version.config.rssId, version.config.profile, candidate.siteId, candidate.torrentId, candidate.candidateKey, candidate.name, candidate.size, candidate.pubTime]);
  }

  fresh (entry) { const age = this.clock() - entry.verifiedAt; return age >= 0 && age < TTL; }
  async get (version, candidate) {
    return this.store.serial(async () => {
      const key = this.key(version, candidate);
      const entry = (await this.read(version.config.profile)).find(e => e.key === key && this.fresh(e));
      return entry ? { hash: entry.hash, size: entry.size } : null;
    });
  }

  async put (version, candidate, identity) {
    return this.store.serial(async () => {
      if (!/^[a-f0-9]{40}$/.test(identity.hash) || !Number.isSafeInteger(identity.size) || identity.size <= 0) fail('PROVIDER_IDENTITY_STORE');
      const key = this.key(version, candidate);
      const entries = (await this.read(version.config.profile)).filter(e => e.key !== key && this.fresh(e));
      entries.push({ key, hash: identity.hash, size: identity.size, verifiedAt: this.clock() });
      entries.sort((a, b) => b.verifiedAt - a.verifiedAt);
      const body = JSON.stringify({ version: 1, entries: entries.slice(0, LIMIT) });
      if (Buffer.byteLength(body) > MAX_BYTES) fail('PROVIDER_IDENTITY_STORE');
      await fs.mkdir(this.store.root, { recursive: true, mode: 0o700 });
      const file = this.file(version.config.profile); const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
      try {
        const handle = await fs.open(tmp, 'wx', 0o600);
        try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(tmp, file);
      } catch (_) {
        try { await fs.unlink(tmp); } catch (_) { /* Only our unpublished file. */ }
        fail('PROVIDER_IDENTITY_STORE');
      }
    });
  }
}
module.exports = { ProviderIdentityCache, TTL, LIMIT };

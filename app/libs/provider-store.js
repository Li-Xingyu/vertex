'use strict';
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { validate, digest, fail } = require('./provider-schema');
const { profiles } = require('./provider-profiles');

// One document/atomic rename publishes config + active pointer together. Local
// mutex serialises API requests. Vertex is one process; no second writer exists.
class ProviderStore {
  constructor (root = path.join(__dirname, '../data/providers')) { this.root = root; this.tail = Promise.resolve(); }
  async read (id) {
    if (!/^[a-f0-9]{8}$/.test(id || '')) fail('PROVIDER_ID');
    try {
      const record = JSON.parse(await fs.readFile(path.join(this.root, id + '.json'), 'utf8'));
      if (record.id !== id || record.version !== 1 || !Array.isArray(record.revisions) || record.revisions.length > 100 || !Number.isSafeInteger(record.revision) || record.revision < 0 || typeof record.suspended !== 'boolean') fail('PROVIDER_STORE_CORRUPT');
      const seen = new Set();
      for (const r of record.revisions) {
        validate(r.config, profiles);
        if (r.config.rssId !== id || !Number.isSafeInteger(r.revision) || r.revision < 1 || r.revision > record.revision || seen.has(r.revision) || digest(r.config) !== r.digest) fail('PROVIDER_STORE_CORRUPT');
        seen.add(r.revision);
      }
      // An invalid active pointer must block the source, never silently select
      // legacy RSS and resurrect a second owner after file corruption.
      if (record.active !== null && !seen.has(record.active)) fail('PROVIDER_STORE_CORRUPT');
      return record;
    } catch (e) { if (e.code === 'ENOENT') return { id, version: 1, revision: 0, active: null, suspended: false, revisions: [] }; throw e; }
  }

  async list () {
    let names; try { names = await fs.readdir(this.root); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return Promise.all(names.filter(n => /^[a-f0-9]{8}\.json$/.test(n)).map(n => this.read(n.slice(0, 8))));
  }

  async serial (fn) { const job = this.tail.then(fn); this.tail = job.catch(() => {}); return job; }
  async write (record) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = path.join(this.root, record.id + '.json');
    const tmp = target + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      const handle = await fs.open(tmp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(tmp, target);
    } catch (e) {
      try { await fs.unlink(tmp); } catch (_) { /* Only our unpublished temporary file may be removed. */ }
      throw e;
    }
    // fsync directory on Linux. Windows does not expose directory handles.
    try {
      if (process.platform !== 'win32') { const dir = await fs.open(this.root, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
    } catch (_) {
      // Rename already published the new document. Do not report that the old
      // config is still active or blindly replay a write whose durability is unknown.
      fail('PROVIDER_COMMIT_UNCERTAIN');
    }
    return record;
  }

  async apply (config, expectedRevision, check) {
    config = validate(config, profiles);
    return this.serial(async () => {
      const record = await this.read(config.rssId);
      if (record.revision !== expectedRevision) fail('PROVIDER_REVISION_CONFLICT');
      const revision = record.revision + 1;
      if (!Number.isSafeInteger(revision)) fail('PROVIDER_STORE_CORRUPT');
      const current = { revision, config, digest: digest(config), createdAt: new Date().toISOString() };
      await check(current);
      // Retain the on-disk reader contract, not a user-facing revision history.
      // Legacy documents remain readable; only a successful explicit apply
      // replaces their config snapshots with the single effective configuration.
      return this.write({ ...record, revision, active: revision, suspended: false, revisions: [current], activatedAt: current.createdAt });
    });
  }

  async save (config, expectedRevision) {
    config = validate(config, profiles);
    return this.serial(async () => {
      const record = await this.read(config.rssId);
      if (record.revision !== expectedRevision) fail('PROVIDER_REVISION_CONFLICT');
      if (record.revisions.length >= 100) fail('PROVIDER_REVISION_LIMIT');
      const revision = record.revision + 1;
      record.revisions.push({ revision, config, digest: digest(config), createdAt: new Date().toISOString() });
      record.revision = revision;
      return this.write(record);
    });
  }

  async activate (id, expectedRevision, target, check) {
    return this.serial(async () => {
      const record = await this.read(id);
      if (record.revision !== expectedRevision) fail('PROVIDER_REVISION_CONFLICT');
      const version = record.revisions.find(r => r.revision === target);
      if (!version) fail('PROVIDER_REVISION_NOT_FOUND');
      await check(version);
      record.active = target; record.suspended = false; record.revision++;
      record.activatedAt = new Date().toISOString();
      return this.write(record);
    });
  }

  async suspend (id, expectedRevision) {
    return this.serial(async () => {
      const record = await this.read(id);
      if (record.revision !== expectedRevision) fail('PROVIDER_REVISION_CONFLICT');
      // Suspend fetching, not qB. Never silently resume the old RSS source.
      record.suspended = true; record.revision++;
      return this.write(record);
    });
  }
}
module.exports = { ProviderStore };

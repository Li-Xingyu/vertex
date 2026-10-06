'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const { key, absolute } = require('./identity');
const owners = new Map();

// Per-downloader background read-only observation. No independent daemon, no
// payload mounts required for phase one, no implicit enablement from autoDelete.
class ContentGroupShadow {
  constructor (client, options, dependencies = {}) {
    this.client = client; this.options = options; this.Worker = dependencies.Worker || Worker;
    this.worker = null; this.closed = false; this.latest = { mode: 'shadow', ready: false, deleteAuthorized: false };
    key(client.id);
    if (!options || options.mode !== 'shadow' || client._client.type !== 'qBittorrent') throw Error('CG_SHADOW_ONLY');
    if (!Array.isArray(options.roots) || !options.roots.length || options.roots.length > 16) throw Error('CG_ROOTS');
    options.roots.forEach(absolute);
    this.maxTasks = Math.min(64, Math.max(1, Number.isSafeInteger(options.maxTasks) ? options.maxTasks : 32));
    this.timeoutMs = 45000;
    const intervalMs = Math.max(300000, Number.isSafeInteger(options.intervalMs) ? options.intervalMs : 300000);
    this.timer = setInterval(() => this.tick(), intervalMs); this.timer.unref();
    this.first = setTimeout(() => this.tick(), 15000); this.first.unref();
  }

  tick () {
    if (this.closed || this.worker || owners.has(this.client.id) || !this.client.cookie) return false;
    let worker;
    try {
      worker = new this.Worker(path.join(__dirname, 'worker.js'), {
        workerData: {
          mode: 'shadow',
          clientId: this.client.id,
          roots: this.options.roots,
          maxTasks: this.maxTasks,
          timeoutMs: this.timeoutMs,
          connection: { url: this.client.clientUrl, cookie: this.client.cookie },
          stateFile: path.join(__dirname, '../../data/content-groups', this.client.id + '-shadow.json'),
          fileMappings: Array.isArray(this.options.fileMappings) ? this.options.fileMappings : [],
          lineageDirectory: typeof this.options.lineageDirectory === 'string' ? this.options.lineageDirectory : null
        },
        resourceLimits: { maxOldGenerationSizeMb: 192 }
      });
    } catch (_) { this.latest = { ok: false, code: 'CG_WORKER_START', deleteAuthorized: false }; return false; }
    this.worker = worker;
    owners.set(this.client.id, worker);
    let received = false;
    const timeout = setTimeout(() => {
      this.latest = { ok: false, code: 'CG_WORKER_TIMEOUT', deleteAuthorized: false };
      worker.terminate(); // Do not release ownership until exit, even on timeout.
    }, this.timeoutMs);
    worker.on('message', message => {
      received = true;
      if (!this.closed && this.worker === worker) this.latest = { ...message, mode: 'shadow', deleteAuthorized: false };
    });
    worker.on('error', () => { this.latest = { ok: false, code: 'CG_WORKER_ERROR', deleteAuthorized: false }; });
    worker.on('exit', code => {
      clearTimeout(timeout);
      if (owners.get(this.client.id) === worker) owners.delete(this.client.id);
      if (this.worker === worker) {
        this.worker = null;
        if (!received && !this.closed && code !== 0) this.latest = { ok: false, code: 'CG_WORKER_EXIT', deleteAuthorized: false };
      }
    });
    return true;
  }

  close () {
    this.closed = true; clearInterval(this.timer); clearTimeout(this.first);
    if (this.worker) return this.worker.terminate();
    return Promise.resolve();
  }
}
module.exports = { ContentGroupShadow };

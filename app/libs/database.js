const path = require('path');
const { Worker } = require('worker_threads');

function failure (code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

// One owner for ALL application SQL. Never replay a write after a lost reply.
class DatabaseQueue {
  constructor (options = {}) {
    this.filename = options.filename || path.join(__dirname, '../db/sql.db');
    this.limit = options.limit || 4096;
    this.timeout = options.timeout || 120000;
    this.workerFile = options.workerFile || path.join(__dirname, 'database-worker.js');
    this.queue = [];
    this.active = null;
    this.worker = null;
    this.ready = false;
    this.closed = false;
    this.sequence = 0;
    this.normalRuns = 0;
    this.stats = { completed: 0, failures: 0, busyRetries: 0, unknownWrites: 0, lastWaitMs: 0, lastRunMs: 0 };
  }

  request (method, sql, params = [], options = {}) {
    if (this.closed) return Promise.reject(failure('DB_CLOSED'));
    if (this.queue.length >= this.limit) return Promise.reject(failure('DB_QUEUE_FULL'));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.sequence, method, sql, params, options, resolve, reject, queued: Date.now(), retries: 0 });
      this._pump();
    });
  }

  _start () {
    if (this.worker || this.closed) return;
    let worker;
    try { worker = new Worker(this.workerFile, { workerData: { filename: this.filename } }); } catch (_) {
      for (const job of this.queue.splice(0)) job.reject(failure('DB_WORKER_FAILED'));
      return;
    }
    this.worker = worker;
    this.initTimer = setTimeout(() => this._stop(failure('DB_INIT_TIMEOUT')), this.timeout);
    worker.on('message', message => {
      if (this.worker !== worker) return;
      if (message.ready) {
        clearTimeout(this.initTimer);
        this.ready = true;
        this._pump();
        return;
      }
      if (message.initError) {
        this._stop(failure(message.initError));
        return;
      }
      const job = this.active;
      if (!job || message.id !== job.id) return;
      if (message.code === 'SQLITE_BUSY' && message.retryable && job.retries < 6) {
        job.retries++;
        this.stats.busyRetries++;
        clearTimeout(job.timer);
        job.timer = setTimeout(() => {
          if (this.active === job && this.worker === worker) this._send(job);
        }, Math.min(1000, 50 * 2 ** job.retries));
        return;
      }
      clearTimeout(job.timer);
      this.active = null;
      this.stats.lastRunMs = Date.now() - job.started;
      if (message.code) {
        this.stats.failures++;
        job.reject(failure(message.code));
      } else {
        this.stats.completed++;
        job.resolve(message.result);
      }
      this._pump();
    });
    worker.on('error', () => {
      if (this.worker === worker) this._stop(failure('DB_WORKER_FAILED'));
    });
    worker.on('exit', () => {
      if (this.worker === worker) this._stop(failure('DB_WORKER_EXITED'));
    });
  }

  _send (job) {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => this._stop(failure('DB_REQUEST_TIMEOUT')), this.timeout);
    try {
      this.worker.postMessage({ id: job.id, method: job.method, sql: job.sql, params: job.params });
    } catch (_) {
      this._stop(failure('DB_WORKER_FAILED'));
    }
  }

  _pump () {
    if (this.closed || this.active || !this.queue.length) return;
    this._start();
    if (!this.ready) return;
    // Prefer control work, but admit aged/background work to prevent starvation.
    let index = this.queue.findIndex(job => job.options.priority !== 'background');
    if (index < 0 || this.normalRuns >= 8 || Date.now() - this.queue[0].queued > 5000) index = 0;
    const job = this.queue.splice(index, 1)[0];
    this.normalRuns = job.options.priority === 'background' ? 0 : this.normalRuns + 1;
    this.active = job;
    job.started = Date.now();
    this.stats.lastWaitMs = job.started - job.queued;
    this._send(job);
  }

  async _stop (error) {
    const worker = this.worker;
    if (!worker || this.stopping) return;
    this.stopping = true;
    clearTimeout(this.initTimer);
    this.ready = false;
    if (this.active) clearTimeout(this.active.timer);
    // Wait for termination before releasing the owner or allowing another worker.
    try { await worker.terminate(); } catch (_) {}
    this.worker = null;
    const active = this.active;
    this.active = null;
    if (active) {
      this.stats.failures++;
      const write = ['run', 'batch'].includes(active.method);
      if (write) this.stats.unknownWrites++;
      active.reject(write ? failure('DB_OUTCOME_UNKNOWN') : error);
    }
    for (const job of this.queue.splice(0)) job.reject(failure('DB_UNAVAILABLE'));
    this.stopping = false;
  }

  getStats () {
    return { ...this.stats, queued: this.queue.length, active: !!this.active, ready: this.ready };
  }

  async close () {
    this.closed = true;
    if (this.worker) await this._stop(failure('DB_CLOSED'));
    for (const job of this.queue.splice(0)) job.reject(failure('DB_CLOSED'));
  }
}

const database = new DatabaseQueue();
module.exports = database;
module.exports.DatabaseQueue = DatabaseQueue;

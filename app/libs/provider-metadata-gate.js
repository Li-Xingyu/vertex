'use strict';

// No hourly admission quota. This gate only suppresses overlapping work and
// retries of actual failures. No credentials, URLs, response bodies or titles.
const LIMIT = 2000;
const RETAIN = 86400000;
class ProviderMetadataGate {
  constructor (clock = () => Date.now()) {
    this.clock = clock; this.busy = new Set(); this.sites = new Map(); this.items = new Map();
  }

  sweep (map, now) {
    for (const [key, value] of map) if (now - value.at > RETAIN) map.delete(key);
  }

  async run (profile, key, operation, observe = () => {}) {
    const now = this.clock();
    this.sweep(this.sites, now); this.sweep(this.items, now);
    for (const [scope, entry] of [['site', this.sites.get(profile)], ['candidate', this.items.get(key)]]) {
      if (entry && now < entry.until) {
        observe({ scope, until: entry.until, reason: entry.reason });
        throw Object.assign(Error('PROVIDER_METADATA_BACKOFF'), { code: 'PROVIDER_METADATA_BACKOFF', metadataScope: scope, retryAt: entry.until });
      }
    }
    if (this.busy.has(profile)) throw Object.assign(Error('PROVIDER_METADATA_BUSY'), { code: 'PROVIDER_METADATA_BUSY' });
    this.busy.add(profile);
    try {
      const value = await operation();
      this.sites.delete(profile); this.items.delete(key);
      return value;
    } catch (error) {
      const code = error.code || error.message;
      const status = error.transport?.statusCode || error.status;
      const rate = code === 'PROVIDER_RATE_LIMIT' || status === 429;
      const auth = code === 'PROVIDER_AUTH_OR_REDIRECT' || status === 401 || status === 403;
      const detailBudget = code === 'detail_budget';
      const missing = status === 404 || status === 410;
      const network = !missing && (status >= 500 || /^(?:PROVIDER_(?:NETWORK|DNS|TIMEOUT_.*|HTTP|PROXY_CONNECT|TLS)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|request_timeout|api_http)$/.test(code));
      const invalid = missing || /^(?:PROVIDER_(?:TORRENT_.*|BODY_LIMIT|ENCODING)|torrent_response|torrent_info|torrent_hash|api_json|api_rejected|free_changed|response_size)$/.test(code);
      if (rate || auth || detailBudget || network || invalid) {
        const scope = rate || auth || detailBudget || network ? 'site' : 'candidate';
        const map = scope === 'site' ? this.sites : this.items;
        const id = scope === 'site' ? profile : key;
        const old = map.get(id); const at = this.clock();
        const failures = Math.min(8, (old?.failures || 0) + 1);
        const seconds = Number(error.retryAfterSeconds);
        const requested = Number.isFinite(seconds) && seconds > 0 ? Math.min(86400, seconds) * 1000 : 0;
        const delay = auth ? 1800000 : Math.min(1800000, (scope === 'site' ? 60000 : 300000) * 2 ** (failures - 1));
        const until = detailBudget ? (Math.floor(at / 3600000) + 1) * 3600000 : at + Math.max(delay, requested);
        const reason = detailBudget ? 'detail-budget' : rate ? 'rate-limit' : auth ? 'authentication' : network ? 'network' : 'candidate-response';
        map.delete(id); map.set(id, { at, until, failures, reason });
        while (map.size > LIMIT) map.delete(map.keys().next().value);
        error.metadataScope = scope; error.retryAt = until;
        observe({ scope, until, reason });
      }
      throw error;
    } finally { this.busy.delete(profile); }
  }
}
module.exports = { ProviderMetadataGate, LIMIT };

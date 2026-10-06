'use strict';
const providers = require('../libs/torrent-providers');

class Provider {
  async handle (req, res, fn) {
    try {
      if (req.method === 'POST') {
        // JSON + custom same-origin header cannot be submitted by a cross-site
        // HTML form. Existing session auth applies before every provider route.
        if (!req.is('application/json') || req.get('X-Vertex-Config') !== '1' || req.get('Sec-Fetch-Site') === 'cross-site') throw Object.assign(Error(), { code: 'PROVIDER_REQUEST_ORIGIN' });
        if (Buffer.byteLength(JSON.stringify(req.body || {})) > 40000) throw Object.assign(Error(), { code: 'PROVIDER_CONFIG_TOO_LARGE' });
      }
      res.set('Cache-Control', 'no-store');
      res.send({ success: true, data: await fn() });
    } catch (e) {
      // No raw remote errors, response HTML, credentials or signed URLs.
      res.status(e.code === 'PROVIDER_REVISION_CONFLICT' ? 409 : 400).send({ success: false, message: providers.cleanCode(e) });
    }
  }

  list (req, res) { return this.handle(req, res, () => providers.list()); }
  defaults (req, res) { return this.handle(req, res, () => providers.defaults(req.query.profile, req.query.rssId)); }
  validate (req, res) { return this.handle(req, res, () => providers.validate(req.body.config)); }
  apply (req, res) { return this.handle(req, res, () => providers.apply(req.body)); }
  preview (req, res) { return this.handle(req, res, () => providers.preview(req.body.config)); }
  suspend (req, res) { return this.handle(req, res, () => providers.store.suspend(req.body.id, req.body.expectedRevision)); }
}
// Express calls controller methods without a receiver in this codebase.
module.exports = class BoundProvider extends Provider {
  constructor () { super(); for (const key of ['list', 'defaults', 'validate', 'apply', 'preview', 'suspend']) this[key] = this[key].bind(this); }
};

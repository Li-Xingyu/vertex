'use strict';

// Declarative defaults, NOT evidence of a live site's current semantics. UI
// edits are revisioned separately. In particular, absence of HR is never proof.
const profiles = require('./provider-profiles.json');
const clone = x => JSON.parse(JSON.stringify(x));
function defaults (profile, rssId) {
  const p = profiles[profile];
  if (!p) throw Error('PROVIDER_PROFILE');
  const mapping = clone(p.mapping);
  for (const key of ['downloadUntil', 'uploadUntil']) if (!mapping.fields[key]) mapping.fields[key] = { selector: '', attribute: 'title' };
  for (const key of ['downloadUnlimited', 'uploadUnlimited']) mapping.fields[key] = p.adapter === 'mteam-api' ? { path: '_vertex.' + key } : { selector: '', format: 'boolean' };
  return {
    version: 1,
    profile,
    rssId,
    credentialRef: p.adapter === 'mteam-api' ? 'driver' : 'rss:' + rssId,
    intervalSeconds: 300,
    pages: 1,
    pageSize: 100,
    params: clone(p.params),
    mapping,
    promotionRules: clone(p.promotionRules || profiles.NEXUS_TEMPLATE.promotionRules),
    hrRules: clone(p.hrRules || profiles.NEXUS_TEMPLATE.hrRules),
    selection: { freeOnly: ['MTEAM', 'HHCLUB'].includes(profile), hrPolicy: profile === 'HHCLUB' ? 'exclude' : 'protect', minGiB: 0, maxGiB: 600, minSeeders: 1, minLeechers: 1, maxAgeHours: 168, minFreeSeconds: 7200, sort: 'publishedAt', preferUploadFactor: true },
    budgets: { listPerHour: 12, detailPerHour: 12, metadataPerHour: 12 }
  };
}
module.exports = { profiles: Object.fromEntries(Object.entries(profiles).filter(([k]) => k !== 'NEXUS_TEMPLATE')), defaults };

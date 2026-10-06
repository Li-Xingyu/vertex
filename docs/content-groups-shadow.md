# Content groups: native shadow observation

_2026-10-07 — implemented first migration stage; not an active deletion engine._

## 🎯 Scope and status

The observer runs in a bounded worker inside Vertex. It does not introduce a daemon, Docker socket, site crawler, deletion executor or new database writer. Existing acquisition, H&R rules, fitTime, IYUU exit fences and cleanup execution are unchanged.

Implemented: strict v1 metadata identity, task-instance binding, content/mapping groups, a separate file-reference index, optional read-only filesystem audit, bounded qB collection, private cache/history and aggregate status in `listMainInfo`.

Not implemented in this stage: active cleanup using the new index, main-downloader physical namespace integration, physical disk/share capacity reconciliation, pending admission reservations, H&R/fence permission issuance, historic IYUU database import, or removal of the existing external auditor. The module only accepts `mode: shadow`; changing it to `active` cannot enable deletion.

## 🔗 Data flow

```mermaid
flowchart TB
    accTitle: Native content group shadow observation
    accDescr: IYUU exact proofs and qB metadata feed a Vertex worker. The worker produces shadow reports only. Existing audit and deletion remain independent until a separately approved migration.
    iyuu_proof["IYUU verified source and target"] --> proof_store[("Private relation records")]
    proof_store --> vertex_worker["Vertex background worker"]
    qbit_metadata["qB task and metadata reads"] --> vertex_worker
    vertex_worker --> content_groups["Content identity groups"]
    vertex_worker --> file_references["Separate file reference index"]
    content_groups --> shadow_report["Comparison and coverage report"]
    file_references --> shadow_report
    old_auditor["Existing protected audit"] --> old_cleanup["Existing Vertex cleanup"]
```

No connection from the shadow report to deletion is intentional, not a missing configuration toggle.

## 🔍 Identity and safety contract

- Compare the original torrent info bytes to qB's hash. Do not re-encode to calculate infohash.
- Content identity includes the ordered file paths/lengths, piece length and every v1 piece hash through a SHA256 digest. Tracker/source/private differences outside that identity do not split identical content.
- Group key also includes the selected downloader and its exact advertised file mapping. Copies under different save paths stay separate. The original can disappear without changing the content group ID; membership revision changes.
- File mapping here is qB metadata, **not proof of physical ownership**. Temp download directories, aliases, mixed layouts and other downloader namespaces require additional verification before active cleanup.
- Same parent directory, name, size, IYUU Success or group_id never proves identity. Partial overlap stays a safety relationship, not a yield/H&R group.
- Re-add timestamp, path, size or manifest changes invalidate a proof. Checking/moving/error states are unproved. Unsupported v2/hybrid, padding, selective downloads and renamed layouts fail closed; they are not paused or deleted.
- Cached manifests older than 660 seconds remain explicitly protected. Metadata identity stays cached to avoid a cold-cache loop on large clients. Cached reports are never final deletion checks.
- Yield observations use group membership revisions and per-member counters. Gaps, new members and counter resets restart the observation window; missing history is not zero yield. Old path-keyed history is not imported.
- The shadow reservation includes paused tasks and deduplicates only proved identities. It is a diagnostic estimate, not physical free space or admission authority; pending intents are explicitly absent.
- The optional filesystem audit only walks bounded directory/stat metadata and rejects extra files, missing files, symlinks, hardlinks, ambiguous mapping and overlapping task scopes. It does not hash file payload or grant deletion permission. Logical file sizes are not net freed GiB.

## ⚙️ Opt-in configuration

This is operator-only migration configuration, not a replacement for the user's selection or exit rules. No existing client is enabled automatically.

Add to **only the brushing downloader** after deployment approval:

```json
{
  "contentGroups": {
    "mode": "shadow",
    "roots": ["/downloads"],
    "maxTasks": 32,
    "intervalMs": 300000,
    "lineageDirectory": "/vertex/iyuu-lineage"
  }
}
```

Bounds: at most 64 inspected tasks per cycle, interval at least five minutes, 45-second worker deadline, five-second request deadline and six seconds reserved for final qB readback. Initial 32-task cycles need many rounds to cover a large client. Report sample coverage; never imply full validation after one cycle. A failed read cannot refresh a prior success timestamp.

The worker uses the existing downloader cookie in RAM and only GETs `torrents/info`, `torrents/files`, `torrents/export`. It sends no site requests, uses no torrent proxy settings and follows no redirects. It writes only `app/data/content-groups/<client-id>-shadow.json`, mode 0600; raw exports, URLs and cookies are not retained. Client status exposes aggregate counts only.

The companion authored IYUU hook lives in the private Devops project, not this public fork. Its optional `lineage` object contains `enabled`, the exact Vertex `clientKey` and a verified shared `readerGid`. It atomically writes one sanitized record per target under `/data/vertex-lineage`. Two `members` are ordered source then target. Records contain both task instances, content and manifest digests, proof type and verification time; they are not H&R or ownership permits. Writing failure logs only a fixed status and does not pause/recheck an already successful reseed.

IYUU owns this directory; Vertex needs a **read-only** bind mount. Use verified runtime UID/GID permissions (directory 2750, record 0640 when shared), not a writable IYUU database mount. With lineage disabled there is no new directory write or extra proof-read request.

Optional `fileMappings` entries have `qbitRoot` and `localRoot` and require separately approved read-only payload mounts. Leave empty for first rollout. At most four protected-scope-free groups are stat-audited per cycle; this partial coverage cannot replace the production auditor.

## ✅ Validation and rollout gates

Run `test/content-groups.js` in the deployed Node 14 runtime with a network-isolated local fixture container. Existing `reliability.js`, `providers.js` and `provider-http.js` remain required. PHP proof writer and finish-hook integration fixtures run locally without NAS assets, DB, real qB or site requests.

The bounded live preflight samples real qB metadata in RAM and executes the native identity engine locally. It does not create production fixtures or run payload scans. A successful sample validates only selected metadata identities, not filesystem ownership, H&R or a full-client migration.

Next release requires explicit approval for a Vertex rebuild, IYUU worker reload, private hook/config writes and a read-only lineage mount. Preserve existing qB, IYUU tasks, database history, API budgets, storage floors and old audit/cleanup chain. Do not run an old installer that injects canary torrents as a shortcut.

Before any subsequent active cutover, implement and verify: complete physical namespace/reference coverage (including read-only main downloader protection), IYUU fencing, current H&R gates, near-completion protection, group stability, pending/physical/share reservations, safe group transaction outcomes and final-reference file verification. Retire the host auditor only after that migration is proven.

## 🔄 Rollback

For this shadow stage, remove the opt-in `contentGroups` config and disable IYUU `lineage.enabled`, then restore the exact prior image/hook if required. Keep the old auditor and cleanup chain throughout. Shadow caches and relation records can remain inert; no cleanup operation is required for rollback. Never feed shadow state into the old audit reader.

No claim is made that reverting code restores files deleted by an active engine; this stage has no deletion capability.

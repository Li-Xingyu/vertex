# Database and RSS reliability build

Base source: upstream stable `c8bbfe70827ce293291c97f87a2405d4e751bc84`.
Branch: `fix/async-db-rss-reliability`. This is an isolated build, not a production deployment.

## Changes

- `util.getRecord/getRecords/runRecord` keep their Promise interfaces and SQL result shapes. All built-in application SQL runs in one dedicated worker with one SQLite connection, rather than synchronously in the web thread.
- The queue is bounded at 4096 waiting requests. Normal control queries have priority; background work is admitted after eight normal requests or when the oldest request is over five seconds old. This is scheduling fairness, not a guarantee of SQL latency on a slow disk.
- SQLite's busy wait is 250 ms in the worker. A known `SQLITE_BUSY` with a rolled-back/no-open transaction has at most six delayed retries. The main event loop does not wait synchronously for that lock.
- Worker startup and each execution have a 120-second watchdog. The old worker must terminate before a replacement starts. Writes with lost replies return `DB_OUTCOME_UNKNOWN` and are never blindly replayed. Queued requests fail explicitly if the owner is lost.
- Each downloader has at most one native flow-record run in flight. Its torrent snapshot is written in batches of at most 64 statements (32 torrents), with other queries admitted between batches. Existing history rows and tracker-delta semantics are preserved. A failed/partially committed sampling cycle is reported, not blindly replayed.
- RSS operations persist an intent in the additive `vertex_rss_pending` table before qB submission. Initial flow, successful history rows and intent removal commit together in one short transaction.
- qB RSS candidates resolve the real infohash from the `.torrent` metadata, including RSS URL mode. The metadata is fetched by Vertex and submitted as a file; the payload is still downloaded by qB. Custom URL replacement runs before metadata fetching. Existing ordinary download/reseed flags remain unchanged.
- HTTP 200/202/204 is not treated as proof of a qB task. The real hash must appear in qB's local API before success is finalized. A history-write failure after acceptance is distinct from an add failure. Lost HTTP outcomes are held for reconciliation, not resubmitted automatically.
- Reconciliation checks at most five uncertain qB hashes per RSS cycle and rotates unresolved operations. It does not consume tracker detail/search APIs. Legacy ambiguous failures remain protected. Transmission/Deluge keep response-based confirmation; uncertain outcomes are conservatively held.
- Concurrent RSS admission uses durable unique reservations and rechecks recent success history atomically. The real infohash also has a unique pending reservation. `skipSameTorrent` retains the original size heuristic, including its 20-minute history window; equal size is **not** proof of identical content and this is **not** a global file-reference manager.
- Rejection history (`record_type=2`) can be reevaluated after five minutes. It is not deleted: every current selection, free/H&R, downloader, space and deduplication check runs again. Only newly classified definite pre-submission failures may similarly retry. Successes and ambiguous old failures do not automatically retry. Website/API budgets still need to be enforced by the existing policy layer.
- Explicit numeric/string `addCountPerHour=0` means unlimited. Missing/blank values retain the official default of 20. When a nonzero quota is configured, wall-clock hour changes repair a missed cron reset.
- SQL parameter debug interpolation is removed. Internal queue statistics are available through `util.getDatabaseStats()` without logging credentials or SQL parameters.

## Intentionally unchanged

No journal-mode/durability downgrade, FUSE bypass, history pruning, task/file deletion, downloader limit change, H&R policy relaxation, IYUU modification or NAS restart is performed by this build.

The fork does not contain machine-specific hooks, cookies, passkeys, RSS signatures, or policy scripts. Existing external scripts that write the database can still contend with the single application owner. They must be audited separately before production cutover.

In particular, live full-file checksum hooks or patches to `Client.record`, `Rss.rss` or common database wrappers may override/reject these implementations. HR and cross-client shared-file cleanup guards must be verified in isolation; this image must not be blindly substituted into a hooked production container. The official delete implementation is unchanged, not a replacement for a site's custom shared-content lifecycle protection.

## Build and verification

The build pins the official runtime by digest and replaces the backend with this branch. It retains the existing compiled UI and Node 14 / better-sqlite3 7.5.3 runtime; this is deliberately not a runtime/dependency upgrade. CI builds Linux amd64 for the current NAS target.

```sh
docker build -f docker/Dockerfile.reliability \
  --build-arg VERTEX_REVISION="$(git rev-parse HEAD)" -t vertex-reliability-test .
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,nosuid,size=128m --entrypoint node \
  vertex-reliability-test test/reliability.js
```

CI also lints the changed modules and performs a fresh-container smoke test, with no external network or published ports: official entrypoint, Redis, login, real history API query through the application database worker, and compiled UI.

Tests use synthetic metadata, mock downloader transport, a real SQLite library and isolated temporary databases. They cover lock waits, rollback, committed writes with lost replies, owner restart, accepted-but-unrecorded tasks, deferred 202 confirmation, uncertain HTTP failure, definite rejection, notification errors, temporary rejection rechecks, concurrent reservations, GUID/infohash identity, missed quota resets, and native flow-record behavior. They do not prove live tracker, NAS FUSE or custom-hook compatibility, nor an upload-speed improvement.

## Distribution and cutover

The `Reliability image` workflow publishes only a tested immutable tag:

`ghcr.io/li-xingyu/vertex:sha-<full-commit>`

It does not overwrite the official Docker Hub repository, `stable`, or `latest`. Package access/visibility is separate from the public source repository. Record the pushed digest and verify pull access before a separately authorized NAS deployment.

The additional ledger is backward-compatible with the official schema. Reverting the image does not remove the ledger or replay its unresolved operations. Before rollback, reconcile held intents and audit external safety hooks; otherwise an old version lacks the new reconciliation protocol. Never run old and new Vertex controllers against the same database/downloader simultaneously.

# Verified content groups in the existing reclamation pipeline

## 🧭 Scope

The existing brush-downloader rule and serial deletion guard are still the only
executor. `app/libs/content-groups/reclaim.js` is a pure metadata adapter, not a
second scheduler. The existing lineage observer remains read-only; its legacy
`shadow` configuration name does not mean the reclamation consumer is disabled.

The operator explicitly enables the consumer with
`/vertex/data/governance/content-group-reclaim-config.json` containing
`{"mode":"exact-v1","clientId":"3dfcd430"}`. This deployment targets the
existing brush client only. Other clients are protective file references, never
members to delete.

## 🔎 Membership and permission are different

- Logical membership uses verified torrent content identity, physical manifest,
  and current client/hash/add-time/path/size bindings. A same-directory match,
  a display name, or an IYUU success row alone cannot establish identity.
- The observer's cache is rebound against the current complete qB task list by
  the existing auditor. Unknown, changed or unproved tasks never fall back to
  path-based grouping.
- Yield history, near-completion observation, permits and IYUU pending fences
  use `content-id + member revision`. Old directory history is not imported.
- Bound identity can accumulate yield history with an old manifest, but cannot
  authorize deletion until all required manifests are fresh.
- A shared or nested deletion scope with a different or unknown group blocks
  file removal without merging that group's yield or H&R obligations.

## 🛡️ Existing protections

H&R, actual upload observation, near-completion grace, other-downloader physical
references, file links, IYUU fence and the native 600-second stable-match gate
remain required. Before every member removal, the guard rechecks current
members, manifests, tracker identities and permission. References are removed
serially, and only the final reference requests file deletion.

Confirmed removals retain their uploaded counters in a RAM-only batch context,
so removing the original cannot make a productive reseed appear unproductive.
The native scheduler delegates history writing for this single rule to the
guard, which records only confirmed exits.

IYUU's existing fence remains advisory, not an atomic cross-service transaction.
qB has no delete-if-last-reference transaction; manual concurrent additions can
still race the final API call. No claim of strict atomicity is made.

## 📦 Packaging and activation

The image contains a versioned `governance-bundle`, but startup never installs
it into persisted configuration automatically. During an authorized release,
hold the existing auditor lock briefly, install the three governance files and
the adapter's `identity.js`, `index.js`, `reclaim.js`, then select exact mode.
Keep the target rule non-matching until fresh exact-mode audit, fence and
other-root protection are confirmed. Activate only guard version 4; all other
rules and budgets stay unchanged.

Do not reset database history or fabricate exposure. New group histories need
their normal observation windows plus the native stable-match gate. Unproved
tasks stay running/protected; this feature does not create pause states.

Rollback must first disable this rule, restore the previous code/config/image,
and wait for a fresh compatible audit before re-enabling legacy reclamation.
An image rollback cannot restore files already deleted by natural reclamation.

## ✅ Isolated tests

`test/content-groups.js`, `test/content-groups-db.js`,
`test/content-group-delete-history.js` and `test/content-groups-governance.js`
run without production credentials or network access. The latter tests the
existing governance policy/guard with the new identity adapter, including
mid-batch membership, yield, manifest, tracker and fence changes.

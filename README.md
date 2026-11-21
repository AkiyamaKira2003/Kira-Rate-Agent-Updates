# KIRA LC — Signed Agent Updates

Public distribution channel for the KIRA Rate Agent. The source of truth for updates is `stable.json`.

- Only three allowed runtime modules are distributed in `vNN/`.
- Every release manifest is Ed25519-signed and contains per-file SHA-256 hashes.
- Agent verifies the pinned public key before downloading or applying any update.
- **Never place `.env`, update-control secrets, rate data, or private keys in this repository.**
- Rate collection and Server Pulse analytics are independent data pipelines.

## Offline release integrity gate

Run **node --test tests/verify-release.test.mjs** and
**node scripts/verify-release.mjs** before merging release changes. GitHub
Actions runs the same checks on Ubuntu and Windows with read-only repository
permissions. The check independently verifies the pinned **Ed25519 public
key**, the same canonical JSON field order as the shipped updater, the exact
three-module allowlist and release URLs, SHA-256 of each committed module,
and that the release directory contains no extra tracked files.

Also run **node --test tests/updater-lifecycle.test.mjs** to exercise the
actual signed updater in a newly created, automatically removed **temporary
agent root**. This tests application of staged signed modules, rollback to
byte-identical synthetic previous files, successful confirmation, and
fail-closed behavior for altered staged bytes or signed metadata. The test
runs the updater's local file-handling commands but does not start the actual
Agent server or market collector, contact update servers, modify user settings,
or use a signing key. GitHub Actions runs these integration tests on both
Ubuntu and Windows.

The verifier uses **Git blob bytes from HEAD** rather than working-tree
bytes: Windows may change LF to CRLF on checkout, making hashes computed
from local files disagree with the signed manifest. The .gitattributes file
also pins JavaScript/JSON files to LF in new checkouts. Verification is
offline, has no dependencies beyond Node.js and Git, never executes an
agent module and requires **no signing private key**.

This is a release-source consistency check, not a replacement for the
updater's live-download verification, a TUF rollback/freeze prevention
system, artifact provenance attestation, or independent proof that signing
keys were never compromised. To update the trusted public key, coordinate
a separate verified key-rotation process; do not silently copy a new key
from an untrusted release. Never put private keys or production data here.
The isolated lifecycle checks are not a live Agent deployment test or proof
of behavior under power loss, concurrent updates, or production filesystem
permissions.

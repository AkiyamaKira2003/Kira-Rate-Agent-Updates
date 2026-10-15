# KIRA LC — Signed Agent Updates

Public distribution channel for the KIRA Rate Agent. The source of truth for updates is `stable.json`.

- Only three allowed runtime modules are distributed in `vNN/`.
- Every release manifest is Ed25519-signed and contains per-file SHA-256 hashes.
- Agent verifies the pinned public key before downloading or applying any update.
- **Never place `.env`, update-control secrets, rate data, or private keys in this repository.**
- Rate collection and Server Pulse analytics are independent data pipelines.

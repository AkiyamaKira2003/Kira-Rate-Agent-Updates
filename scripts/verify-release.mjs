// Offline, read-only validation of committed signed release data.
// Git blobs retain canonical LF bytes even if a Windows checkout uses CRLF.
import { execFileSync } from "node:child_process";
import { createHash, verify } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ALLOWED = ["server.mjs", "market-pulse.mjs", "agent-updater.mjs"];
const REPO_URL = "https://raw.githubusercontent.com/AkiyamaKira2003/Kira-Rate-Agent-Updates/main/";
const PINNED_KEY = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAJW70LBa87lLl6GyzyL0wX2ccO3Qj4uS/3CZ2f6mQIv0=\n-----END PUBLIC KEY-----";
const MAX_MODULE_BYTES = 1_500_000; // Same limit as the shipped updater.

function invalid(reason) { throw Error(reason); }
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value, keys) =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

/** Uses the exact canonical JSON field order deployed by agent-updater.mjs. */
export function verifyReleaseMetadata(manifest, readPayload) {
  if (!isObject(manifest) ||
      !hasExactKeys(manifest, ["channel", "releaseNumber", "version", "files", "signature"]) ||
      manifest.channel !== "stable" ||
      !Number.isSafeInteger(manifest.releaseNumber) ||
      manifest.releaseNumber < 31 || manifest.releaseNumber > 10_000_000) {
    invalid("invalid_release");
  }
  if (typeof manifest.version !== "string" ||
      !/^20\d{2}-\d{2}-\d{2}\.\d{2,8}[-a-z0-9.]*$/.test(manifest.version)) {
    invalid("invalid_version");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== ALLOWED.length) {
    invalid("invalid_files");
  }
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!isObject(entry) || !hasExactKeys(entry, ["name", "sha256", "url"]) ||
        !ALLOWED.includes(entry.name) || seen.has(entry.name) ||
        typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      invalid("invalid_file_record");
    }
    if (entry.url !== REPO_URL + "v" + manifest.releaseNumber + "/" + entry.name) {
      invalid("invalid_release_url");
    }
    seen.add(entry.name);
  }
  const signedBytes = Buffer.from(JSON.stringify({
    channel: manifest.channel,
    releaseNumber: manifest.releaseNumber,
    version: manifest.version,
    files: manifest.files,
  }));
  if (typeof manifest.signature !== "string" ||
      !/^[A-Za-z0-9+/]{86}==$/.test(manifest.signature) ||
      !verify(null, signedBytes, PINNED_KEY, Buffer.from(manifest.signature, "base64"))) {
    invalid("invalid_update_signature");
  }
  for (const entry of manifest.files) {
    let bytes;
    try {
      bytes = readPayload(entry.name);
    } catch {
      invalid("missing_release_blob_" + entry.name);
    }
    if (!Buffer.isBuffer(bytes)) invalid("invalid_release_blob");
    if (bytes.length === 0 || bytes.length > MAX_MODULE_BYTES) {
      invalid("payload_too_large");
    }
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      invalid("checksum_mismatch_" + entry.name);
    }
  }
  return { releaseNumber: manifest.releaseNumber, verifiedNames: ALLOWED.slice() };
}

/** Fail closed if a release folder would publish unexpected or missing files. */
export function verifyReleaseDirectory(paths, releaseNumber) {
  const actual = [...paths].sort();
  const expected = ALLOWED.map((name) => "v" + releaseNumber + "/" + name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    invalid("release_directory_contains_unexpected_files");
  }
}

function committedBlob(name) {
  try {
    return execFileSync("git", ["show", "HEAD:" + name], {
      cwd: ROOT, maxBuffer: MAX_MODULE_BYTES + 16_384,
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    invalid("missing_committed_blob");
  }
}

/** Verify only HEAD, not mutable working-tree bytes or network responses. */
export function verifyCommittedRelease() {
  const manifestBytes = committedBlob("stable.json");
  if (manifestBytes.length > 100_000) invalid("manifest_too_large");
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    invalid("invalid_manifest_json");
  }
  const result = verifyReleaseMetadata(manifest, (name) =>
    committedBlob("v" + manifest.releaseNumber + "/" + name));
  let listing;
  try {
    listing = execFileSync("git", [
      "ls-tree", "-r", "--name-only", "HEAD", "v" + manifest.releaseNumber + "/",
    ], { cwd: ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 100_000,
      stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    invalid("release_tree_unavailable");
  }
  verifyReleaseDirectory(listing.trim().split(/\r?\n/), manifest.releaseNumber);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyCommittedRelease();
    console.log("PASS: signed release " + result.releaseNumber + " with " +
      result.verifiedNames.length + " verified Git blobs");
  } catch (error) {
    console.error("FAIL: " + error.message);
    process.exitCode = 1;
  }
}

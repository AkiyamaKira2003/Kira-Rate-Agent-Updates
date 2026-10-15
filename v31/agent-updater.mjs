// Signed pull-only updater. Apply and rollback are invoked outside the running Agent.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(ROOT, "updates");
const STAGE = path.join(DIR, "staging");
const PENDING = path.join(DIR, "pending.json");
const VERIFYING = path.join(DIR, "verification.json");
const STATUS = path.join(DIR, "status.json");
const RELEASE = path.join(ROOT, "release.json");
const ALLOWED = ["server.mjs", "market-pulse.mjs", "agent-updater.mjs"];
const KEY = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAJW70LBa87lLl6GyzyL0wX2ccO3Qj4uS/3CZ2f6mQIv0=\n-----END PUBLIC KEY-----";
const COMMAND = process.argv[2] || "check";
const DEFAULT_URL = "https://kiralc.io.vn/agent-updates/stable.json";

async function readJson(file, fallback = null) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; } }
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".writing";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}
async function loadConfig() {
  const raw = (await fs.readFile(path.join(ROOT, ".env"), "utf8").catch(() => "")).replace(/^\uFEFF/, "");
  const obj = {};
  for (const line of raw.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0 && !line.trimStart().startsWith("#")) obj[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return obj;
}
function safeUrl(raw, env) {
  const url = new URL(raw);
  const production = url.protocol === "https:" && url.hostname === "kiralc.io.vn" && !url.port && url.pathname.startsWith("/agent-updates/");
  const test = env.UPDATE_ALLOW_LOCAL_TEST === "1" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if ((!production && !test) || url.username || url.password) throw Error("update_url_not_allowlisted");
  return url.toString();
}
async function fetchBytes(url, max = 1_500_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "error", cache: "no-store" });
  if (!res.ok) throw Error("update_http_" + res.status);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > max) throw Error("update_response_too_large");
  return bytes;
}
function validate(m, env) {
  if (!m || m.channel !== "stable" || !Number.isSafeInteger(m.releaseNumber) || m.releaseNumber < 31 || m.releaseNumber > 10000000) throw Error("invalid_release");
  if (typeof m.version !== "string" || !/^20\d{2}-\d{2}-\d{2}\.\d{2,8}[-a-z0-9.]*$/.test(m.version)) throw Error("invalid_version");
  if (!Array.isArray(m.files) || m.files.length !== ALLOWED.length) throw Error("invalid_files");
  const found = new Set();
  for (const f of m.files) {
    if (!f || !ALLOWED.includes(f.name) || found.has(f.name) || !/^[a-f0-9]{64}$/.test(f.sha256)) throw Error("invalid_file_record");
    safeUrl(f.url, env);
    found.add(f.name);
  }
  const bytes = Buffer.from(JSON.stringify({ channel: m.channel, releaseNumber: m.releaseNumber, version: m.version, files: m.files }));
  if (typeof m.signature !== "string" || !/^[A-Za-z0-9+/=]+$/.test(m.signature) || !crypto.verify(null, bytes, KEY, Buffer.from(m.signature, "base64"))) throw Error("invalid_update_signature");
  return m;
}
async function localRelease() { return await readJson(RELEASE, { releaseNumber: 31, version: "2026-10-15.31-market-pulse" }); }
async function check() {
  const env = await loadConfig();
  if (env.UPDATE_ENABLED !== "1") {
    await writeJson(STATUS, { state: "disabled", at: new Date().toISOString() });
    return 0;
  }
  const url = safeUrl(env.UPDATE_MANIFEST_URL || DEFAULT_URL, env);
  const manifest = validate(JSON.parse((await fetchBytes(url, 100000)).toString("utf8")), env);
  const local = await localRelease();
  if (manifest.releaseNumber <= local.releaseNumber) {
    await writeJson(STATUS, { state: "up-to-date", version: local.version, latestVersion: manifest.releaseNumber === local.releaseNumber ? local.version : manifest.version, at: new Date().toISOString() });
    return 0;
  }
  await fs.mkdir(STAGE, { recursive: true });
  for (const f of manifest.files) {
    const bytes = await fetchBytes(safeUrl(f.url, env));
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (hash !== f.sha256) throw Error("checksum_mismatch_" + f.name);
    await fs.writeFile(path.join(STAGE, f.name), bytes);
  }
  await writeJson(PENDING, manifest);
  await writeJson(STATUS, { state: "staged", version: local.version, latestVersion: manifest.version, at: new Date().toISOString() });
  return 10;
}
async function apply() {
  const manifest = await readJson(PENDING);
  if (!manifest) return 0;
  const env = await loadConfig();
  validate(manifest, env);
  const old = await localRelease();
  if (manifest.releaseNumber <= old.releaseNumber) { await fs.unlink(PENDING); return 0; }
  for (const f of manifest.files) {
    const bytes = await fs.readFile(path.join(STAGE, f.name));
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== f.sha256) throw Error("staging_checksum_mismatch");
    // Refuse syntactically broken release before modifying the installed Agent.
    execFileSync(process.execPath, ["--check", path.join(STAGE, f.name)], { windowsHide: true, timeout: 5000, stdio: "pipe" });
  }
  const backup = path.join(DIR, "backup-" + old.releaseNumber + "-" + Date.now());
  await fs.mkdir(backup, { recursive: true });
  for (const name of ALLOWED) await fs.copyFile(path.join(ROOT, name), path.join(backup, name));
  try {
    for (const f of manifest.files) {
      await fs.copyFile(path.join(STAGE, f.name), path.join(ROOT, f.name + ".new"));
      await fs.rename(path.join(ROOT, f.name + ".new"), path.join(ROOT, f.name));
    }
    await writeJson(RELEASE, { releaseNumber: manifest.releaseNumber, version: manifest.version });
    await writeJson(VERIFYING, { backup, old, target: manifest.version });
    await fs.unlink(PENDING);
    await writeJson(STATUS, { state: "verifying", version: manifest.version, at: new Date().toISOString() });
  } catch (error) {
    for (const name of ALLOWED) await fs.copyFile(path.join(backup, name), path.join(ROOT, name)).catch(() => {});
    await writeJson(RELEASE, old);
    throw error;
  }
  return 0;
}
async function rollback() {
  const data = await readJson(VERIFYING);
  if (!data) return 0;
  const backup = path.resolve(data.backup || "");
  if (path.dirname(backup) !== DIR || !path.basename(backup).startsWith("backup-")) throw Error("rollback_path_invalid");
  for (const name of ALLOWED) await fs.copyFile(path.join(backup, name), path.join(ROOT, name));
  await writeJson(RELEASE, data.old);
  await fs.unlink(VERIFYING);
  await writeJson(STATUS, { state: "rolled-back", version: data.old.version, failedTarget: data.target, at: new Date().toISOString() });
  return 0;
}
async function confirm() {
  const data = await readJson(VERIFYING);
  if (!data) return 0;
  await fs.unlink(VERIFYING);
  await writeJson(STATUS, { state: "updated", version: data.target, at: new Date().toISOString() });
  return 0;
}
try {
  process.exitCode = COMMAND === "check" ? await check()
    : COMMAND === "apply" ? await apply()
      : COMMAND === "rollback-if-pending" ? await rollback()
        : COMMAND === "confirm" ? await confirm()
          : (() => { throw Error("invalid_updater_command"); })();
} catch (error) {
  await writeJson(STATUS, { state: "error", error: error.message, at: new Date().toISOString() }).catch(() => {});
  process.stderr.write("[kira-updater] " + error.message + "\n");
  process.exitCode = 1;
}

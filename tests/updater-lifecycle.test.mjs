/**
 * End-to-end test of the signed update agent's APPLY/ROLLBACK/CONFIRM lifecycle.
 * All files live in a unique temporary root: no service, browser, live agent,
 * user configuration, network call, or signing key is involved.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { verifyCommittedRelease } from "../scripts/verify-release.mjs";

// The signature, module allowlist and SHA-256s are verified before loading
// the signed updater source into the synthetic execution root.
const verified = verifyCommittedRelease();
const releaseNumber = verified.releaseNumber;
const gitBlob = (relativePath) => execFileSync("git", [
  "show", "HEAD:" + relativePath,
], { maxBuffer: 1_600_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
const manifest = JSON.parse(gitBlob("stable.json").toString("utf8"));
const stagedFiles = new Map(manifest.files.map((file) => [
  file.name, gitBlob("v" + releaseNumber + "/" + file.name),
]));
const previous = {
  releaseNumber: releaseNumber - 1,
  version: "synthetic-previous-release",
};
const names = ["server.mjs", "market-pulse.mjs", "agent-updater.mjs"];

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (filename) => JSON.parse(await fs.readFile(filename, "utf8"));
const isPresent = async (filename) => fs.access(filename).then(() => true, () => false);

async function sandbox(t) {
  const base = path.resolve(os.tmpdir());
  const root = mkdtempSync(path.join(base, "kira-rate-e2e-"));
  if (path.dirname(root) !== base ||
      !/^kira-rate-e2e-[a-zA-Z0-9]+$/.test(path.basename(root))) {
    throw Error("unsafe_temporary_root");
  }
  t.after(async () => {
    // Never recursively delete a path outside this test's unique temp child.
    assert.equal(path.dirname(root), base);
    assert.match(path.basename(root), /^kira-rate-e2e-[a-zA-Z0-9]+$/);
    await fs.rm(root, { recursive: true, force: true });
  });

  const updates = path.join(root, "updates");
  const staging = path.join(updates, "staging");
  await fs.mkdir(staging, { recursive: true });

  // Synthetic old app content. Only the updater is authentic v45 source,
  // and it is executed solely with local apply/rollback/confirm commands.
  const old = new Map([
    ["server.mjs", Buffer.from("// synthetic previous server\nexport const version = 0;\n")],
    ["market-pulse.mjs", Buffer.from("// synthetic previous market\nexport const version = 0;\n")],
    ["agent-updater.mjs", stagedFiles.get("agent-updater.mjs")],
  ]);
  for (const name of names) {
    await fs.writeFile(path.join(root, name), old.get(name));
    await fs.writeFile(path.join(staging, name), stagedFiles.get(name));
  }
  await fs.writeFile(path.join(root, "release.json"), JSON.stringify(previous));
  await fs.writeFile(path.join(updates, "pending.json"), JSON.stringify(manifest));
  return { root, updates, staging, old };
}

function invoke(root, command) {
  const result = spawnSync(process.execPath, [
    path.join(root, "agent-updater.mjs"), command,
  ], {
    cwd: root, timeout: 15_000, encoding: "utf8", windowsHide: true,
    // Do not forward credentials or NODE_OPTIONS to the sandbox process.
    env: {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      windir: process.env.windir ?? "",
    },
  });
  assert.equal(result.error, undefined, String(result.error));
  return result;
}

async function assertOld(root, old) {
  assert.deepEqual(await readJson(path.join(root, "release.json")), previous);
  for (const name of names) {
    assert.equal(digest(await fs.readFile(path.join(root, name))), digest(old.get(name)), name);
  }
}

async function assertNew(root) {
  const release = await readJson(path.join(root, "release.json"));
  assert.equal(release.releaseNumber, manifest.releaseNumber);
  assert.equal(release.version, manifest.version);
  for (const name of names) {
    assert.equal(digest(await fs.readFile(path.join(root, name))),
      digest(stagedFiles.get(name)), name);
  }
}

test("staged signed release apply then rollback restores complete synthetic old release", async (t) => {
  const { root, updates, old } = await sandbox(t);
  const apply = invoke(root, "apply");
  assert.equal(apply.status, 0, apply.stderr);
  await assertNew(root);
  const verification = await readJson(path.join(updates, "verification.json"));
  assert.equal(path.dirname(verification.backup), updates);
  assert.match(path.basename(verification.backup), /^backup-\d+-\d+$/);
  assert.equal(verification.old.releaseNumber, previous.releaseNumber);
  assert.equal(await isPresent(path.join(updates, "pending.json")), false);
  assert.equal((await readJson(path.join(updates, "status.json"))).state, "verifying");
  for (const name of names) {
    assert.equal(digest(await fs.readFile(path.join(verification.backup, name))),
      digest(old.get(name)));
  }

  const rollback = invoke(root, "rollback-if-pending");
  assert.equal(rollback.status, 0, rollback.stderr);
  await assertOld(root, old);
  assert.equal(await isPresent(path.join(updates, "verification.json")), false);
  assert.equal((await readJson(path.join(updates, "status.json"))).state, "rolled-back");
});

test("staged signed release apply then confirm preserves new complete release", async (t) => {
  const { root, updates } = await sandbox(t);
  assert.equal(invoke(root, "apply").status, 0);
  const confirm = invoke(root, "confirm");
  assert.equal(confirm.status, 0, confirm.stderr);
  await assertNew(root);
  assert.equal(await isPresent(path.join(updates, "verification.json")), false);
  assert.equal((await readJson(path.join(updates, "status.json"))).state, "updated");
  // A later rollback check must not downgrade an already confirmed release.
  assert.equal(invoke(root, "rollback-if-pending").status, 0);
  await assertNew(root);
});

test("staging checksum failure fails before modifying installed files", async (t) => {
  const { root, updates, staging, old } = await sandbox(t);
  const bad = Buffer.from(stagedFiles.get("server.mjs"));
  bad[0] ^= 1;
  await fs.writeFile(path.join(staging, "server.mjs"), bad);
  const apply = invoke(root, "apply");
  assert.equal(apply.status, 1);
  assert.match(apply.stderr, /staging_checksum_mismatch/);
  await assertOld(root, old);
  assert.equal(await isPresent(path.join(updates, "pending.json")), true);
  assert.equal(await isPresent(path.join(updates, "verification.json")), false);
  assert.equal((await readJson(path.join(updates, "status.json"))).state, "error");
  assert.deepEqual((await fs.readdir(updates)).filter((entry) =>
    entry.startsWith("backup-")), []);
});

test("tampered signed pending metadata cannot trigger local apply", async (t) => {
  const { root, updates, old } = await sandbox(t);
  const pending = structuredClone(manifest);
  pending.version += "-tampered";
  await fs.writeFile(path.join(updates, "pending.json"), JSON.stringify(pending));
  const apply = invoke(root, "apply");
  assert.equal(apply.status, 1);
  assert.match(apply.stderr, /invalid_update_signature/);
  await assertOld(root, old);
  assert.equal(await isPresent(path.join(updates, "verification.json")), false);
});

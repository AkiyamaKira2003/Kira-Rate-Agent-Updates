import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  verifyReleaseMetadata, verifyReleaseDirectory, verifyCommittedRelease,
} from "../scripts/verify-release.mjs";

const commitBytes = (name) =>
  execFileSync("git", ["show", `HEAD:${name}`], { maxBuffer: 1_700_000, windowsHide: true });
const manifest = JSON.parse(commitBytes("stable.json").toString("utf8"));
const payload = (name) => commitBytes(`v${manifest.releaseNumber}/${name}`);
const clone = () => structuredClone(manifest);

test("current committed Ed25519 manifest matches all three Git blob SHA-256 digests", () => {
  const evidence = verifyReleaseMetadata(clone(), payload);
  assert.equal(evidence.releaseNumber, manifest.releaseNumber);
  assert.deepEqual(evidence.verifiedNames, [
    "server.mjs", "market-pulse.mjs", "agent-updater.mjs",
  ]);
});

test("corrupt payload bytes are rejected without echoing source", () => {
  assert.throws(
    () => verifyReleaseMetadata(clone(), (name) =>
      name === "server.mjs" ? Buffer.from("PRIVATE_FAKE_AGENT_SCRIPT") : payload(name)),
    /checksum_mismatch_server\.mjs/,
  );
});

test("modified manifest metadata fails signature verification", () => {
  const edited = clone();
  edited.version += "-tampered";
  assert.throws(() => verifyReleaseMetadata(edited, payload), /invalid_update_signature/);
});

test("invalid URL paths and duplicated module names cannot be signed into release check", () => {
  const redirected = clone();
  redirected.files[0].url = "https://evil.invalid/steal";
  assert.throws(() => verifyReleaseMetadata(redirected, payload), /invalid_release_url/);
  const duplicate = clone();
  duplicate.files[1].name = duplicate.files[0].name;
  assert.throws(() => verifyReleaseMetadata(duplicate, payload), /invalid_file_record/);
});

test("missing blobs and oversized payloads fail closed", () => {
  assert.throws(() => verifyReleaseMetadata(clone(), () => {
    throw Error("simulated_missing_file");
  }), /missing_release_blob_server\.mjs/);
  assert.throws(
    () => verifyReleaseMetadata(clone(), () => Buffer.alloc(1_500_001)),
    /payload_too_large/,
  );
});

test("exact committed source may be verified without checkout line-ending conversion", () => {
  const result = verifyCommittedRelease();
  assert.deepEqual(result.verifiedNames, [
    "server.mjs", "market-pulse.mjs", "agent-updater.mjs",
  ]);
});

test("release tree allowlist rejects an extra tracked file or a missing module", () => {
  const expected = manifest.files.map((file) =>
    "v" + manifest.releaseNumber + "/" + file.name);
  assert.doesNotThrow(() => verifyReleaseDirectory(expected, manifest.releaseNumber));
  assert.throws(
    () => verifyReleaseDirectory([...expected, "v" + manifest.releaseNumber + "/.env"], manifest.releaseNumber),
    /release_directory_contains_unexpected_files/,
  );
  assert.throws(
    () => verifyReleaseDirectory(expected.slice(1), manifest.releaseNumber),
    /release_directory_contains_unexpected_files/,
  );
});

test("every module and stable manifest explicitly request LF for new Windows checkouts", () => {
  for (const file of ["stable.json", ...manifest.files.map((entry) =>
    "v" + manifest.releaseNumber + "/" + entry.name)]) {
    const output = execFileSync("git", ["check-attr", "eol", "--", file], {
      encoding: "utf8", windowsHide: true,
    });
    assert.match(output, /eol: lf\s*$/);
  }
});

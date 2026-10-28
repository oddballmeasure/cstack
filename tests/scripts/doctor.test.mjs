import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCTOR = path.resolve(HERE, "../../skills/doctor/scripts/doctor.sh");
const FAKE_BIN = path.resolve(HERE, "../fixtures/bin");
const TEMPLATE = JSON.parse(readFileSync(path.resolve(HERE, "../../templates/config.json"), "utf8"));
const LABELS = ["ready", "in-progress", "done", "error", "needs-human", "investigate", "proposed"].map((l) => `cstack:${l}`).join("\n");

chmodSync(path.join(FAKE_BIN, "gh"), 0o755);

function target(cfg = {}, { gitignore = ".cstack/*\n!.cstack/config.json\n", writeConfig = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "cstack-doctor-"));
  spawnSync("git", ["init", "-q", root]);
  if (gitignore !== null) writeFileSync(path.join(root, ".gitignore"), gitignore);
  mkdirSync(path.join(root, "scripts"));
  writeFileSync(path.join(root, "scripts/test.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(root, "scripts/test.sh"), 0o755);
  if (writeConfig) {
    mkdirSync(path.join(root, ".cstack"));
    const full = { ...TEMPLATE, repo: "o/r", test_command: ["./scripts/test.sh"], ...cfg };
    writeFileSync(path.join(root, ".cstack/config.json"), typeof cfg === "string" ? cfg : JSON.stringify(full));
  }
  return root;
}

function doctor(root, args = [], env = {}) {
  const r = spawnSync("sh", [DOCTOR, ...args, root], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${FAKE_BIN}:${process.env.PATH}`, FAKE_GH_LABELS: LABELS, ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

test("a correct repo passes, including a repo-relative test command", () => {
  const r = doctor(target());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS test_command: \.\/scripts\/test\.sh/);
  assert.match(r.out, /PASS hooks: guard self-test/);
  assert.match(r.out, /WARN required checks/);
  assert.match(r.out, /doctor: ok/);
});

test("missing config fails and names setup-cstack", () => {
  const r = doctor(target({}, { writeConfig: false }));
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL config: .*setup-cstack/);
});

test("schema errors are each reported", () => {
  const r = doctor(target({ autonomy: "yolo", models: { code: "gpt", judge: "fable", review: "sonnet", gather: "haiku" }, extra: 1 }));
  assert.equal(r.code, 1);
  assert.match(r.out, /autonomy must be stop or send/);
  assert.match(r.out, /models.code must be/);
  assert.match(r.out, /unknown key extra/);
});

test("optional retry_after_hours, scout and deploy are checked when present", () => {
  const ok = doctor(target({ retry_after_hours: 24, scout: { autonomy: "auto", categories: ["bug"] }, deploy: { transport: "local", local_directory: "~/deploys", auto: false } }));
  assert.equal(ok.code, 0, ok.out);
  const ssh = doctor(target({ deploy: { transport: "ssh" }, scout: null }));
  assert.equal(ssh.code, 0, ssh.out);
  const bad = doctor(
    target({
      retry_after_hours: 2,
      scout: { autonomy: "yes", categories: ["chore"], areas_per_pass: 7, cooldown_days: -1, max_proposals_per_pass: 1.5, max_files: 0, repro: "y", auto_min_decided: 0, auto_min_approval: 2, auto_min_done: -1, at: "09:00" },
      deploy: { transport: "local", local_directory: 3, auto: "no", host: "x" },
    }),
  );
  assert.equal(bad.code, 1);
  for (const msg of [
    "retry_after_hours must be null or a number >= 24",
    "scout.autonomy must be propose or auto",
    "scout.categories must be",
    "scout.areas_per_pass must be an integer 1 to 6",
    "scout.cooldown_days must be",
    "scout.max_proposals_per_pass must be an integer 1 to 10",
    "scout.max_files must be",
    "scout.repro must be true or false",
    "scout.auto_min_decided must be",
    "scout.auto_min_approval must be 0 to 1",
    "scout.auto_min_done must be 0 to 1",
    "unknown key scout.at",
    "deploy.local_directory is required for transport local",
    "deploy.local_directory must be a string",
    "deploy.auto must be true or false",
    "unknown key deploy.host",
  ]) {
    assert.ok(bad.out.includes(`FAIL config schema: ${msg}`), msg);
  }
  const shapes = doctor(target({ scout: [], deploy: "ssh" }));
  assert.match(shapes.out, /scout must be an object or null/);
  assert.match(shapes.out, /deploy must be an object or null/);
  assert.match(doctor(target({ deploy: { transport: "ftp" } })).out, /deploy.transport must be local or ssh/);
});

test("placeholder repo name fails", () => {
  const r = doctor(target({ repo: "owner/name" }));
  assert.match(r.out, /FAIL config schema: repo must be owner\/name/);
});

test("unresolvable test command fails", () => {
  const r = doctor(target({ test_command: ["./nope.sh"] }));
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL test_command/);
});

test("missing labels and branch fail; offline skips them", () => {
  const root = target({ base_branch: "trunk" });
  const r = doctor(root, [], { FAKE_GH_LABELS: "cstack:ready" });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL base branch/);
  assert.match(r.out, /FAIL labels: missing: cstack:in-progress/);
  const off = doctor(root, ["--offline"], { FAKE_GH_LABELS: "" });
  assert.equal(off.code, 0, off.out);
  assert.doesNotMatch(off.out, /labels/);
});

test("gh not logged in fails", () => {
  const r = doctor(target(), [], { FAKE_GH_AUTH: "0" });
  assert.match(r.out, /FAIL gh auth/);
});

test("missing gitignore entry is only a warning", () => {
  const r = doctor(target({}, { gitignore: "" }));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /WARN gitignore/);
});

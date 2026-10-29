import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCTOR = path.resolve(HERE, "../../skills/doctor/scripts/doctor.mjs");
const FAKE_BIN = path.resolve(HERE, "../fixtures/bin");
const TEMPLATE = JSON.parse(readFileSync(path.resolve(HERE, "../../templates/config.json"), "utf8"));
const LABELS = ["ready", "in-progress", "done", "error", "needs-human", "investigate", "proposed"].map((l) => `cstack:${l}`).join("\n");

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
  const r = spawnSync(process.execPath, [DOCTOR, ...args, root], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH}`, FAKE_GH_LABELS: LABELS, ...env },
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

test("permissions_allow takes permission rules only", () => {
  assert.equal(doctor(target({ permissions_allow: ["Bash(make lint)", "Monitor"] })).code, 0);
  assert.equal(doctor(target({ permissions_allow: null })).code, 0);
  for (const bad of ["Bash(make lint)", ["make lint"], [3], ["Bash()"]]) {
    const r = doctor(target({ permissions_allow: bad }));
    assert.equal(r.code, 1, JSON.stringify(bad));
    assert.match(r.out, /permissions_allow must be an array of permission rules/);
  }
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

test("optional harness, models_codex, codex_sandbox and host are checked when present", () => {
  const ok = doctor(target({ harness: "codex", models_codex: { code: "gpt-5.5", judge: "inherit" }, codex_sandbox: "workspace-write", host: { supervisor: "taskscheduler" } }));
  assert.equal(ok.code, 0, ok.out);
  assert.equal(doctor(target({ harness: null, models_codex: null, codex_sandbox: null, host: {} })).code, 0);
  const bad = doctor(target({ harness: "gpt", models_codex: { code: "", review: 5, extra: "x" }, codex_sandbox: "yolo", host: { supervisor: "cron", user: "me" } }));
  assert.equal(bad.code, 1);
  for (const msg of [
    "harness must be auto, claude or codex",
    "models_codex.code must be a non-empty string",
    "models_codex.review must be a non-empty string",
    "unknown key models_codex.extra",
    "codex_sandbox must be read-only, workspace-write or danger-full-access",
    "host.supervisor must be auto, systemd, launchd, taskscheduler or detached",
    "unknown key host.user",
  ]) {
    assert.ok(bad.out.includes(`FAIL config schema: ${msg}`), msg);
  }
  const shapes = doctor(target({ models_codex: "gpt", host: "detached" }));
  assert.match(shapes.out, /models_codex must be an object or null/);
  assert.match(shapes.out, /host must be an object or null/);
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

test("under Codex, doctor fails until the guard has seen this session", () => {
  const root = target();
  const id = `doctor-${process.pid}-${Date.now()}`;
  const before = doctor(root, ["--offline"], { CODEX_SESSION_ID: id });
  assert.equal(before.code, 1);
  assert.match(before.out, /FAIL hooks \(codex\): .*\/hooks/);
  mkdirSync(path.join(tmpdir(), "cstack-hook-seen"), { recursive: true });
  writeFileSync(path.join(tmpdir(), "cstack-hook-seen", id), "");
  const after = doctor(root, ["--offline"], { CODEX_SESSION_ID: id });
  assert.equal(after.code, 0, after.out);
  assert.match(after.out, /PASS hooks \(codex\)/);
  assert.doesNotMatch(doctor(root, ["--offline"], { CODEX_SESSION_ID: "" }).out, /hooks \(codex\)/);
});

test("node version is checked on the node in PATH, which runs the hooks", { skip: process.platform === "win32" && "the fake node is a shell script" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cstack-oldnode-"));
  writeFileSync(path.join(dir, "node"), "#!/bin/sh\necho 18.20.0\n");
  chmodSync(path.join(dir, "node"), 0o755);
  const r = doctor(target(), ["--offline"], { PATH: `${dir}${path.delimiter}${FAKE_BIN}${path.delimiter}${process.env.PATH}` });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL node version: v18 is below 22/);
});

test("a gh without pr checks --json or baseRefOid fails (cstack#32)", () => {
  const ok = doctor(target(), ["--offline"]);
  assert.match(ok.out, /PASS gh features/);
  const old = doctor(target(), ["--offline"], { FAKE_GH_OLD: "1" });
  assert.equal(old.code, 1);
  assert.match(old.out, /FAIL gh features: this gh lacks/);
});

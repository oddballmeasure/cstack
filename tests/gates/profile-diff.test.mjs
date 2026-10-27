import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { makeRepo, commit, gate, git, write, failChecks, existsSync, path } from "./helpers.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const profileOf = (root) => JSON.parse(readFileSync(path.join(root, ".cstack/profile.json"), "utf8"));
const setProfile = (root, files) => write(root, ".cstack/profile.json", JSON.stringify({ version: 1, files }));
const entry = (text, extra = {}) => ({ sha256: sha(text), summary: "s", capabilities: [], status: "active", ...extra });

test("profile-diff with no profile lists every profilable file as new", () => {
  const { root } = makeRepo();
  const res = gate("profile-diff.mjs", [root, "--json"]);
  assert.equal(res.code, 0, res.err);
  assert.equal(res.json.approved, false);
  assert.ok(res.json.new.includes("src/app.js"));
  assert.ok(!res.json.new.some((f) => f.startsWith("tests/acceptance/")), "hidden suite is never profiled");
  assert.deepEqual([res.json.changed, res.json.removed, res.json.same], [[], [], 0]);
  assert.equal(res.json.profile, path.join(root, ".cstack/profile.json"));

  const text = gate("profile-diff.mjs", [root]);
  assert.equal(text.code, 0);
  assert.match(text.out, /^FAIL new: src\/app\.js$/m);
  assert.match(text.out, /gate profile-diff: rejected/);
});

test("profile-diff classifies new, changed, removed and same, and skips vendor, hidden and deleted files", () => {
  const { root } = makeRepo();
  commit(root, { "src/b.js": "b\n", "node_modules/x/i.js": "v\n", "lib/vendor/y.js": "v\n", "src/gone.js": "g\n" }, "more");
  symlinkSync("app.js", path.join(root, "src/link.js"));
  const head = git(root, "rev-parse", "HEAD");
  git(root, "update-index", "--add", "--cacheinfo", `160000,${head},sub`);
  mkdirSync(path.join(root, "sub"));
  git(root, "add", "-A");
  git(root, "commit", "-qm", "link and submodule");
  rmSync(path.join(root, "src/gone.js"));

  setProfile(root, {
    "src/app.js": entry("export const x = 1;\n"),
    "src/b.js": entry("old\n"),
    "src/link.js": entry("link:app.js"),
    sub: entry("dir:sub"),
    "src/gone.js": entry("g\n"),
    "src/deleted-long-ago.js": entry("d\n"),
  });
  const res = gate("profile-diff.mjs", [root, "--json"]);
  assert.equal(res.code, 0, res.err);
  assert.deepEqual(res.json.changed, ["src/b.js"]);
  assert.deepEqual(res.json.removed, ["src/deleted-long-ago.js", "src/gone.js"]);
  assert.ok(!res.json.new.some((f) => f.includes("node_modules") || f.includes("vendor")), "vendor dirs skipped");
  assert.ok(!res.json.new.includes("src/app.js") && !res.json.new.includes("sub"));
  assert.equal(res.json.same, 3, "app.js, the symlink and the submodule");
  assert.deepEqual([...new Set(failChecks(res))].sort(), ["changed", "new", "removed"]);
});

test("profile-diff --write-hashes drops removed entries and fills missing hashes only", () => {
  const { root } = makeRepo({ paths_hidden: [] });
  commit(root, { "src/b.js": "b\n", "src/c.js": "c\n" }, "more");
  setProfile(root, {
    "src/app.js": { summary: "re-described", capabilities: ["x"], status: "active" },
    "src/b.js": entry("stale\n"),
    "src/c.js": entry("c\n"),
    "src/old.js": entry("o\n"),
  });
  const res = gate("profile-diff.mjs", [root, "--write-hashes", "--json"]);
  assert.equal(res.code, 0, res.err);
  const p = profileOf(root);
  assert.deepEqual(Object.keys(p.files), ["src/app.js", "src/b.js", "src/c.js"]);
  assert.equal(p.files["src/app.js"].sha256, sha("export const x = 1;\n"));
  assert.equal(p.files["src/app.js"].summary, "re-described");
  assert.equal(p.files["src/b.js"].sha256, sha("stale\n"), "a skipped changed file keeps its old hash");
  assert.deepEqual(res.json.changed, ["src/b.js"]);
  assert.deepEqual(res.json.removed, []);
  assert.ok(res.json.new.includes("tests/acceptance/lanes.txt"), "no paths_hidden, so the suite is profilable");

  for (const rel of [...res.json.new, ...res.json.changed]) p.files[rel] = { summary: "s", capabilities: [], status: "support" };
  write(root, ".cstack/profile.json", JSON.stringify(p));
  const done = gate("profile-diff.mjs", [root, "--write"]);
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /gate profile-diff: approved/);
  assert.match(done.out, /PASS same: 8 of 8 profilable files unchanged/);
});

test("profile-diff --write-hashes creates the profile when none exists", () => {
  const { root } = makeRepo();
  rmSync(path.join(root, ".cstack/profile.json"), { force: true });
  assert.equal(gate("profile-diff.mjs", [root, "--write-hashes"]).code, 0);
  assert.deepEqual(profileOf(root), { version: 1, files: {} });
});

test("profile-diff refuses bad usage and bad profiles", () => {
  const { root } = makeRepo();
  assert.equal(gate("profile-diff.mjs", []).code, 2, "no repo");
  assert.equal(gate("profile-diff.mjs", [root, "--nope"]).code, 2, "unknown flag");
  const pf = ".cstack/profile.json";
  for (const [text, why] of [
    ["{", "does not parse"],
    ["[]", "must be {version: 1"],
    ['{"version":2,"files":{}}', "must be {version: 1"],
    ['{"version":1,"files":[]}', "must be {version: 1"],
    ['{"version":1,"files":{"a":null,"b":[]}}', "entries must be objects: a, b"],
  ]) {
    write(root, pf, text);
    const res = gate("profile-diff.mjs", [root]);
    assert.equal(res.code, 2, text);
    assert.ok(res.err.includes(why), `${text}: ${res.err}`);
  }
  assert.ok(existsSync(path.join(root, pf)));
});

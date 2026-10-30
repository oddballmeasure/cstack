// The local forge backend (gates/lib/forge-local.mjs) against real git repos: one with a bare origin, one with none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { local } from "../../gates/lib/forge-local.mjs";
import { git, makeRepo, commit, sh } from "./helpers.mjs";

const CI = [process.execPath, "-e", "process.exit(require('fs').existsSync('src/broken') ? 1 : 0)"];

function body(dir, text) {
  const f = path.join(dir, `body-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(f, text);
  return f;
}

// A clone with origin, a config naming the local forge, and a pushed feature branch one commit ahead of main.
function withRemote(cfg = {}) {
  const r = makeRepo({ forge: "local", ci_command: CI, required_checks: ["ci"], ...cfg });
  sh(r.root, "git", ["config", "user.name", "t"]);
  git(r.root, "checkout", "-q", "-b", "feat");
  const head = commit(r.root, { "src/feature.js": "export const f = 1;\n" }, "Add a feature");
  git(r.root, "push", "-q", "origin", "feat");
  git(r.root, "checkout", "-q", "main");
  const forge = local({ forge: "local", repo: "o/r", base_branch: "main", ci_command: CI, ...cfg }, r.root);
  return { ...r, head, forge };
}

test("issues: create, view, relabel, comment, list and search, detail", () => {
  const r = withRemote();
  const f = r.forge;
  const one = f.createIssue({ title: "First", bodyFile: body(r.base, "Cstack-Scout: x\n"), label: "cstack:ready" });
  const two = f.createIssue({ title: "Second", bodyFile: body(r.base, "plain\n") });
  assert.deepEqual([one, two.id], [{ ok: true, id: 1, url: "local:issue/1" }, 2]);
  assert.deepEqual(f.relabel(1, { add: ["cstack:in-progress"], remove: ["cstack:ready"] }), { ok: true, error: "" });
  assert.equal(f.comment(1, body(r.base, "done\n")).ok, true);
  const v = f.issue(1, ["labels", "comments"]);
  assert.deepEqual([v.ok, v.labels, v.comments, v.state], [true, ["cstack:in-progress"], ["done\n"], "open"]);
  assert.deepEqual([f.issue(9, []).ok, f.relabel(9, {}).ok, f.comment(9, body(r.base, "x")).ok], [false, false, false]);
  assert.match(f.issue(9, []).error, /local issue 9 not found/);
  assert.deepEqual(f.issues({ want: [] }).map((i) => i.number), [2, 1]);
  assert.deepEqual(f.issues({ label: "cstack:in-progress", want: [] }).map((i) => i.number), [1]);
  assert.deepEqual(f.issues({ state: "all", search: "Cstack-Scout", want: [] }).map((i) => i.number), [1]);
  assert.deepEqual(f.issues({ search: "Sec", within: "title", want: [], limit: 1 }).map((i) => i.number), [2]);
  assert.deepEqual(f.issues({ state: "closed", want: [] }), []);
  const d = f.issueDetail(1);
  assert.deepEqual([d.url, d.author, d.comments[0].body], ["local:issue/1", "t", "done\n"]);
  assert.ok(existsSync(path.join(r.root, ".cstack/forge/issues/1.json")), "records live in the main checkout");
});

test("changes: create, view, files, merge state, detail, find, edit, comment, threads", () => {
  const r = withRemote();
  const f = r.forge;
  assert.match(f.createChange({ head: "nope", base: "main", title: "x", bodyFile: body(r.base, "x") }).error, /branch nope not found on origin or locally/);
  const c = f.createChange({ head: "feat", base: "main", title: "Feature", bodyFile: body(r.base, "Closes #1\n") });
  assert.deepEqual(c, { ok: true, id: 1, url: "local:change/1", via: "local" });
  assert.match(f.createChange({ head: "feat", base: "main", title: "again", bodyFile: body(r.base, "x") }).error, /change !1 is already open for feat/);
  const v = f.change(1);
  assert.deepEqual([v.state, v.head, v.base, v.merge, v.behind, v.files, v.draft], ["open", r.head, "main", "clean", 0, ["src/feature.js"], false]);
  assert.equal(v.baseSha, git(r.root, "rev-parse", "main"));
  assert.deepEqual(f.change(1, []).files, [], "files only when asked");
  const d = f.changeDetail(1);
  assert.deepEqual([d.title, d.branch, d.body, d.autoMerge, d.headRepo], ["Feature", "feat", "Closes #1\n", false, "o/r"]);
  assert.deepEqual(f.findChanges({ head: "feat", base: "main" }).map((x) => x.id), [1]);
  assert.deepEqual(f.findChanges({ state: "merged" }), []);
  assert.deepEqual(f.changesOn("--head", "feat"), [{ pr: 1, state: "OPEN", branch: "feat", base: "main" }]);
  assert.deepEqual(f.changesOn("--base", "main").length, 1);
  assert.deepEqual(f.editChange(1, { title: "Feature, renamed", bodyFile: body(r.base, "Closes #1, edited\n") }).ok, true);
  assert.equal(f.editChange(1).ok, true);
  assert.equal(f.changeDetail(1).title, "Feature, renamed");
  assert.equal(f.markReady(1).ok, true);
  assert.equal(f.commentChange(1, body(r.base, "looks fine\n")).ok, true);
  assert.deepEqual(f.reviews(1).map((x) => [x.kind, x.body]), [["comment", "looks fine\n"]]);
  // Threads come from the store; seed one as a reviewer tool would.
  const file = path.join(r.root, ".cstack/forge/changes/1.json");
  const rec = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...rec, threads: [{ id: "t1", resolved: false, path: "src/feature.js", line: 1, comments: [{ author: "rev", body: "why?", createdAt: "t" }] }, { id: "t2", resolved: true, comments: [] }] }));
  assert.deepEqual(f.threads(1).map((t) => [t.id, t.resolved, t.author, t.body, t.path]), [["t1", false, "rev", "why?", "src/feature.js"], ["t2", true, null, "", null]]);
  assert.deepEqual(f.replyThread(1, "t1", body(r.base, "because\n")), { ok: true, url: null });
  assert.equal(f.resolveThread(1, "t1").ok, true);
  assert.deepEqual(f.threads(1)[0].comments.length, 2);
  assert.equal(f.threads(1)[0].resolved, true);
  assert.match(f.replyThread(1, "t9", body(r.base, "x")).error, /thread t9 not found/);
  assert.match(f.resolveThread(1, "t9").error, /thread t9 not found/);
  assert.throws(() => f.change(7), /local change 7 not found/);
});

test("checks run ci_command once per SHA in a clean worktree; failures, tails and reruns", () => {
  const r = withRemote();
  const f = r.forge;
  const [c] = f.checks(r.head);
  assert.deepEqual([c.name, c.state, c.status, c.conclusion, c.id], ["ci", "pass", "completed", "success", r.head]);
  assert.ok(existsSync(path.join(r.root, `.cstack/forge/checks/${r.head}.json`)));
  assert.equal(f.checks(r.head)[0].started_at, c.started_at, "a recorded verdict is reused");
  git(r.root, "checkout", "-q", "-b", "bad");
  const bad = commit(r.root, { "src/broken": "1\n" }, "Break it");
  const [b] = f.checks(bad);
  assert.deepEqual([b.state, b.conclusion], ["fail", "failure"]);
  assert.equal(f.rerunHandle(b), bad);
  assert.equal(f.rerunHandle({}), null);
  assert.equal(f.rerun(bad).ok, true);
  assert.equal(f.checks(bad)[0].state, "fail");
  assert.match(f.checkTail({ id: "0".repeat(40) }, 5), /cannot check out|no log/);
  const missing = f.checks("f".repeat(40));
  assert.equal(missing[0].state, "fail");
  assert.match(f.checkTail(missing[0], 5), /cannot check out f{40}/);
  assert.equal(f.checkTail({ id: "e".repeat(40) }, 5), "(no log)");
  assert.deepEqual(f.requiredChecks("main"), ["ci"]);
  const noCi = local({ forge: "local" }, r.root);
  assert.deepEqual([noCi.checks(git(r.root, "rev-parse", "main")), noCi.requiredChecks(), noCi.rerun("x").ok], [[], [], false]);
  writeFileSync(path.join(r.root, ".cstack/forge/checks/q.json"), JSON.stringify({ name: "ci", sha: "q", status: "completed", conclusion: "success", log: "" }));
  assert.equal(f.checkTail({ id: "q" }, 3), "(no output)");
});

test("merge: only at the exact head, as a merge commit pushed to origin; then merged", () => {
  const r = withRemote();
  const f = r.forge;
  f.createChange({ head: "feat", base: "main", title: "Feature", bodyFile: body(r.base, "x") });
  assert.match(f.merge(1, "0".repeat(40)).error, /head of feat is [0-9a-f]{12}, not 000000000000/);
  const before = git(r.root, "rev-parse", "origin/main");
  assert.deepEqual(f.merge(1, r.head), { ok: true, error: "" });
  git(r.root, "fetch", "-q", "origin");
  const after = git(r.root, "rev-parse", "origin/main");
  assert.notEqual(after, before);
  assert.equal(git(r.root, "rev-parse", `${after}^2`), r.head, "a merge commit whose second parent is the judged head");
  assert.match(git(r.root, "log", "-1", "--format=%s", after), /^Merge change !1: Feature$/);
  const m = f.change(1);
  assert.deepEqual([m.state, m.mergeSha, m.head, m.baseSha], ["merged", after, r.head, before]);
  assert.ok(m.mergedAt);
  assert.match(f.merge(1, r.head).error, /change 1 is merged/);
  assert.deepEqual(f.recentMerged(5).map((x) => [x.id, x.title]), [[1, "Feature"]]);
  assert.deepEqual(f.changesOn("--head", "feat")[0].state, "MERGED");
  assert.equal(git(r.root, "worktree", "list").split("\n").length, 1, "the merge worktree is gone");
  assert.equal(f.repoInfo().url, git(r.root, "remote", "get-url", "origin"));
});

test("merge refusals: a base that does not exist, and a push origin rejects", () => {
  const r = withRemote();
  const f = r.forge;
  f.createChange({ head: "feat", base: "ghost", title: "To nowhere", bodyFile: body(r.base, "x") });
  assert.match(f.merge(1, r.head).error, /cannot check out ghost/);
  f.createChange({ head: "feat", base: "main", title: "Feature", bodyFile: body(r.base, "x") });
  writeFileSync(path.join(r.origin, "hooks", "pre-receive"), "#!/bin/sh\necho rejected >&2\nexit 1\n", { mode: 0o755 });
  assert.match(f.merge(2, r.head).error, /could not move main to the merge \(did the base move\?\)/);
  assert.equal(f.change(2).state, "open");
});

test("conflicts read as conflict and do not merge; behind counts base commits", () => {
  const r = withRemote();
  const f = r.forge;
  commit(r.root, { "src/feature.js": "export const f = 2;\n" }, "Main changes the same file");
  git(r.root, "push", "-q", "origin", "main");
  f.createChange({ head: "feat", base: "main", title: "Feature", bodyFile: body(r.base, "x") });
  const v = f.change(1);
  assert.deepEqual([v.merge, v.behind], ["conflict", 1]);
  assert.match(f.merge(1, r.head).error, /^merge failed:/);
  assert.equal(f.change(1).state, "open");
});

test("without a remote, the merge updates the local base branch; repo info and identity", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cstack-local-"));
  sh(dir, "git", ["init", "-q", "-b", "main", dir]);
  sh(dir, "git", ["config", "user.name", "t"]);
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  git(dir, "checkout", "-q", "-b", "feat");
  const head = commit(dir, { "a.txt": "a\n" }, "A");
  git(dir, "checkout", "-q", "main");
  const f = local({ forge: "local", ci_command: CI }, dir);
  assert.equal(f.repo, path.basename(dir));
  assert.deepEqual(f.repoInfo(), { path: path.basename(dir), defaultBranch: "main", url: dir });
  assert.deepEqual(f.currentUser(), { login: "t", name: "t", bot: false });
  assert.match(f.createChange({ head: "nope", base: "main", title: "A", bodyFile: body(dir, "x") }).error, /^branch nope not found; push it first$/);
  assert.equal(f.createChange({ head: "feat", base: "main", title: "A", bodyFile: body(dir, "x") }).ok, true);
  assert.equal(f.changeDetail(1).headRepo, null, "no configured repo");
  assert.deepEqual(f.merge(1, head), { ok: true, error: "" });
  assert.equal(git(dir, "rev-parse", "main^2"), head);
  assert.deepEqual(f.ensureLabels(["a", "b"]), { ok: true, done: ["a", "b"], failed: [] });
  const named = local({ forge: "local", repo: "me/app", base_branch: "trunk" }, dir);
  assert.deepEqual([named.repo, named.repoInfo().path, named.repoInfo().defaultBranch], ["me/app", "me/app", "trunk"]);
  git(dir, "checkout", "-q", "--detach");
  assert.equal(local({}, dir).repoInfo().defaultBranch, "main", "a detached HEAD falls back to main");
  assert.throws(() => local({}, mkdtempSync(path.join(tmpdir(), "cstack-nogit-"))), /git rev-parse .* failed/);
  git(dir, "config", "user.name", "");
  assert.equal(local({}, dir).currentUser().login, "local", "no git user name");
});

test("the id lock: a held lock is waited on, then reported", () => {
  const r = withRemote();
  mkdirSync(path.join(r.root, ".cstack/forge/.lock"), { recursive: true });
  assert.throws(() => r.forge.createIssue({ title: "x", bodyFile: body(r.base, "x") }), /\.lock is held; remove it if no cstack session is running/);
});

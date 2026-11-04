import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { makeRepo, commit, gate, git, failChecks, approve, path, FAKE_BIN } from "./helpers.mjs";

// A repo whose origin has a PR branch, plus a ledger store and a fake gh scenario.
// The PR head commits headFiles, after prepare(root) runs (for a git mv). headConfig: (base config) => the config
// text the head commits, for a PR that changes it. pr.files is only the forge's list, which may differ.
function setup({ cfg = {}, approve: approved = true, review = true, pr = {}, checkRuns = [], extraRules = [], runJson, env = {}, headFiles = { "src/f.js": "1\n" }, headConfig, prepare } = {}) {
  const r = makeRepo(cfg);
  const baseSha = git(r.root, "rev-parse", "HEAD");
  git(r.root, "checkout", "-q", "-b", "cstack/u1");
  headFiles = { ...headFiles };
  if (headConfig) headFiles[".cstack/config.json"] = headConfig(JSON.parse(readFileSync(path.join(r.root, ".cstack/config.json"), "utf8")));
  prepare?.(r.root);
  const head = commit(r.root, headFiles, "F\n\nCstack-Unit: U1");
  git(r.root, "push", "-q", "origin", "cstack/u1");
  git(r.root, "checkout", "-q", "main");

  const store = mkdtempSync(path.join(tmpdir(), "cstack-store-"));
  if (runJson !== undefined) writeFileSync(path.join(store, "run.json"), typeof runJson === "string" ? runJson : JSON.stringify(runJson));
  const orch = (...a) => gate("orch.mjs", ["--store", store, ...a]);
  assert.equal(orch("init").code, 0);
  if (approved) approve(store, "U1", head, { pr: 5 });
  if (review) {
    writeFileSync(path.join(store, "review-U1-rounds.tsv"), `round\thead\tmodel\tverdict\tusage\n1\t${head}\tsonnet\tAPPROVE\tnot exposed\n`);
    writeFileSync(path.join(store, "review-U1.tsv"), "id\tround\tseverity\tlocation\tclaim\toutcome\treplies\tevidence\nS1\t1\tnit\tsrc/f.js:1\tname\topen\t0\tx\n");
  }

  const view = {
    number: 5,
    state: "OPEN",
    isDraft: false,
    headRefOid: head,
    baseRefName: "main",
    baseRefOid: baseSha,
    mergeStateStatus: "CLEAN",
    reviewDecision: "",
    mergeCommit: null,
    files: [{ path: "src/f.js" }],
    ...pr,
  };
  const scenario = path.join(r.base, "gh.json");
  writeFileSync(
    scenario,
    JSON.stringify({
      rules: [
        ...extraRules.map((x) => (typeof x === "function" ? x({ head, view }) : x)),
        { match: "^pr view 5", responses: [{ json: view }] },
        { match: "^api repos/o/r/commits/", responses: [{ stdout: JSON.stringify(checkRuns) + "\n" }] },
      ],
    }),
  );
  const run = (...a) => gate("check-merge.mjs", ["5", "--unit", "U1", "--repo-dir", r.root, "--store", store, "--json", ...a], { env: { FAKE_GH_SCENARIO: scenario, FAKE_GH_LOG: path.join(r.base, "gh.log"), ...env } });
  return { ...r, head, baseSha, run, store, scenario };
}

const run1 = (status, conclusion, started = "2026-10-27T10:00:00Z", name = "ci") => ({ name, status, conclusion, started_at: started });

test("approves a verified, green, clean PR and does not merge without --merge", () => {
  const s = setup({ cfg: { required_checks: ["ci"] }, checkRuns: [run1("completed", "failure", "2026-10-27T09:00:00Z"), run1("completed", "success")] });
  const res = s.run();
  assert.equal(res.code, 0, res.out + res.err);
  assert.equal(res.json.merge_sha, null);
});

test("rejects each failure mode", () => {
  const s = setup({
    cfg: { required_checks: ["ci", "lint", "e2e"] },
    approve: false,
    review: false,
    pr: { isDraft: true, reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "UNKNOWN" },
    checkRuns: [run1("in_progress", null), run1("completed", "failure", "2026-10-27T10:00:00Z", "lint")],
  });
  const res = s.run();
  assert.equal(res.code, 1);
  assert.deepEqual(failChecks(res).sort(), ["check ci", "check e2e", "check lint", "ledger", "merge state", "pr state", "review", "reviews"].sort());
  assert.match(res.out, /still computing/);
});

test("an approval for a different head does not count", () => {
  const s = setup({ pr: { headRefOid: "b".repeat(40) } });
  assert.deepEqual(failChecks(s.run()).sort(), ["ledger", "review"]);
});

test("review: an open should finding blocks; a docs-only diff needs no review", () => {
  const s = setup();
  writeFileSync(path.join(s.store, "review-U1.tsv"), "S2\t1\tshould\tsrc/f.js:1\tmissing check\topen\t0\tx\n");
  const res = s.run();
  assert.deepEqual(failChecks(res), ["review"]);
  assert.match(res.out, /open review findings: S2/);
  const d = setup({ review: false, headFiles: { "docs/a.md": "x\n" }, pr: { files: [{ path: "docs/a.md" }] } });
  const ok = d.run();
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /docs-only change/);
});

// The forge's file list for a set of committed files.
const listed = (files) => Object.keys(files).map((p) => ({ path: p }));

test("review: the docs-only rule reads the local diff, not the forge's file list", () => {
  const docs = (opts) => setup({ review: false, ...opts });
  // git mv of product code into docs/: the forge lists only the new path.
  const moved = docs({ headFiles: {}, prepare: (root) => (mkdirSync(path.join(root, "docs")), git(root, "mv", "src/app.js", "docs/app.md")), pr: { files: [{ path: "docs/app.md" }] } }).run();
  assert.deepEqual(failChecks(moved), ["review"], "a rename out of src/ needs a review");
  // A large PR whose forge list is truncated to its docs: the local diff still holds the product file.
  const truncated = docs({ headFiles: { "docs/a.md": "x\n", "src/f.js": "1\n" }, pr: { files: [{ path: "docs/a.md" }] } }).run();
  assert.deepEqual(failChecks(truncated), ["review"], "a truncated list does not hide product code");
  // A git failure means a review: a base SHA with no common history with the head has no merge base.
  const s = docs({ headFiles: { "docs/a.md": "x\n" }, pr: { files: [{ path: "docs/a.md" }] } });
  const orphan = git(s.root, "commit-tree", git(s.root, "rev-parse", "main^{tree}"), "-m", "orphan");
  const scenario = JSON.parse(readFileSync(s.scenario, "utf8"));
  scenario.rules.find((r) => r.match === "^pr view 5").responses[0].json.baseRefOid = orphan;
  writeFileSync(s.scenario, JSON.stringify(scenario));
  assert.deepEqual(failChecks(s.run()), ["review"], "no merge base means a review");
});

test("review: a first path that starts with a space is matched as git wrote it", () => {
  const lead = { " notes.md": "x\n" };
  const ok = setup({ cfg: { docs_paths: [" notes.md"] }, review: false, headFiles: lead, pr: { files: listed(lead) } }).run();
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /docs-only change/);
});

test("review: config docs_paths replaces the default doc test", () => {
  const cfg = { docs_paths: ["docs/**", "README.md"] };
  const skill = { "skills/x/SKILL.md": "x\n" };
  const product = setup({ cfg, review: false, headFiles: skill, pr: { files: listed(skill) } }).run();
  assert.deepEqual(failChecks(product), ["review"], "markdown outside docs_paths is product and needs a review");
  const readme = { "README.md": "x\n", "docs/a.md": "x\n" };
  const ok = setup({ cfg, review: false, headFiles: readme, pr: { files: listed(readme) } }).run();
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /docs-only change/);
  const none = { "docs/a.md": "x\n" };
  const empty = setup({ cfg: { docs_paths: [] }, review: false, headFiles: none, pr: { files: listed(none) } }).run();
  assert.deepEqual(failChecks(empty), ["review"], "docs_paths [] means no file is a doc");
  const unset = setup({ review: false, headFiles: skill, pr: { files: listed(skill) } }).run();
  assert.equal(unset.code, 0, "unset docs_paths keeps today's default: any .md is docs");
});

// A commit that touches only the hidden suite, and the forge's file list for it.
const SUITE = { "tests/acceptance/a.test.mjs": "x\n" };

test("review: a suite unit touching only the hidden suite and config needs no review round; anything else does", () => {
  // unit: the id to gate; track: its units.tsv track, or null for no row. A suite unit records its pass by hand;
  // any other unit gets the row check-verdict would write. units: replaces units.tsv after setup.
  const merge = (headFiles, unit, track, { units } = {}) => {
    const s = setup({ review: false, headFiles, pr: { files: listed(headFiles) } });
    const orch = (...a) => gate("orch.mjs", ["--store", s.store, ...a]);
    if (track) assert.equal(orch("unit", "add", unit, "--track", track).code, 0);
    if (track === "e2e" && unit.startsWith("E2E")) {
      assert.equal(orch("ledger", "record", unit, s.head, "approved", "--evidence", "e2e-plan.md", "--verifier", "check-e2e").code, 0);
    } else approve(s.store, unit, s.head);
    if (units !== undefined) writeFileSync(path.join(s.store, "units.tsv"), units);
    return gate("check-merge.mjs", ["5", "--unit", unit, "--repo-dir", s.root, "--store", s.store, "--json"], { env: { FAKE_GH_SCENARIO: s.scenario } });
  };
  for (const unit of ["E2E", "E2E-UI"]) {
    const ok = merge(SUITE, unit, "e2e");
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /hidden e2e suite change on track e2e/);
  }
  const review = (res, why) => assert.deepEqual(failChecks(res), ["review"], why);
  review(merge({ ...SUITE, "src/f.js": "1\n" }, "E2E-UI", "e2e"), "product code on a suite unit needs a review");
  review(merge({ ...SUITE, "docs/e2e.md": "x\n" }, "E2E", "e2e"), "a doc beside the suite needs a review");
  review(merge(SUITE, "U2", "e2e"), "track e2e without a suite id does not count");
  review(merge(SUITE, "E2E", "issue"), "a suite id on another track does not count");
  review(merge(SUITE, "E2E", null), "the id alone, with no units.tsv row, does not count");
  review(merge(SUITE, "E2E", "e2e", { units: "not a units file\n" }), "an unreadable store means a review");
});

// Gate unit E2E-UI (track e2e, hand-recorded pass) on a PR built by setup(opts).
// after(s) runs once the PR and store exist, just before the gate.
function suiteMerge({ after, env = {}, ...opts }) {
  const s = setup({ review: false, ...opts });
  assert.equal(gate("orch.mjs", ["--store", s.store, "unit", "add", "E2E-UI", "--track", "e2e"]).code, 0);
  assert.equal(gate("orch.mjs", ["--store", s.store, "ledger", "record", "E2E-UI", s.head, "approved", "--evidence", "e2e-plan.md"]).code, 0);
  after?.(s);
  return gate("check-merge.mjs", ["5", "--unit", "E2E-UI", "--repo-dir", s.root, "--store", s.store, "--json"], { env: { FAKE_GH_SCENARIO: s.scenario, ...env } });
}
const needsReview = (res, why) => assert.deepEqual(failChecks(res), ["review"], why);

test("review: a suite unit's config change is exempt only for e2e_command, judged against the merge base's config", () => {
  const configPr = (headConfig, { headFiles = SUITE, pr = {} } = {}) =>
    suiteMerge({ headFiles, headConfig, pr: { files: [...listed(headFiles), { path: ".cstack/config.json" }], ...pr } });
  const json = (c) => `${JSON.stringify(c, null, 2)}\n`;
  const ok = configPr((c) => json({ ...c, e2e_command: ["node", "--test", "--test-reporter=tap", "x"] }));
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /hidden e2e suite change/);
  needsReview(configPr((c) => json({ ...c, required_checks: [...c.required_checks, "lint"] })), "required_checks needs a review");
  needsReview(configPr((c) => json({ ...c, autonomy: "send" })), "autonomy needs a review");
  // A head that widens paths_hidden cannot hide product code: the merge base's paths_hidden decides.
  const widened = (c) => json({ ...c, paths_hidden: [...c.paths_hidden, "src/**"] });
  needsReview(configPr(widened), "paths_hidden needs a review");
  needsReview(configPr(widened, { headFiles: { ...SUITE, "src/f.js": "1\n" } }), "a widened paths_hidden is read from the merge base, not the head");
  needsReview(configPr(() => "{ not json"), "a head config that does not parse needs a review");
  const gone = configPr((c) => json(c), { pr: { baseRefOid: "0".repeat(40) } });
  needsReview(gone, "a base SHA missing locally needs a review");
  const why = gone.json.findings.find((f) => f.check === "review").detail;
  assert.match(why, new RegExp(`Review required: .+${"0".repeat(40)} not available locally after fetch`));
  // Each fetch's outcome is in the finding: the base fetch worked, the head ref is not on this origin.
  assert.match(why, /\(fetch main: ok; fetch pull\/5\/head: exit \d+, .*pull\/5\/head/);
});

// Runs fn(env, log) with a git wrapper first on PATH. On a fetch the wrapper runs `onFetch` (shell, may exit);
// everything else, and a fetch onFetch lets through, goes to the real git. The wrapper dir is removed after.
const POSIX_ONLY = { skip: process.platform === "win32" && "the git wrapper is a POSIX shell script" };
function withGitWrapper(onFetch, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "cstack-git-"));
  try {
    const log = path.join(dir, "fetch.log");
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(path.join(dir, "git"), `#!/bin/sh\ncase " $* " in *" fetch "*) LOG="${log}"; ${onFetch};; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    return fn({ PATH: `${dir}${path.delimiter}${FAKE_BIN}${path.delimiter}${process.env.PATH}` }, log);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("review: the gate's fetches never prompt and keep the configured credential helper", POSIX_ONLY, () => {
  withGitWrapper(`echo "prompt=$GIT_TERMINAL_PROMPT gcm=$GCM_INTERACTIVE args=$*" >> "$LOG"`, (env, log) => {
    const ok = suiteMerge({ headFiles: SUITE, pr: { files: listed(SUITE) }, env });
    assert.equal(ok.code, 0, ok.out);
    const fetches = readFileSync(log, "utf8").trim().split("\n");
    assert.ok(fetches.length >= 3, `base and head ref fetched before judging, base again after: ${fetches.join(" | ")}`);
    for (const f of fetches) {
      assert.match(f, /^prompt=0 gcm=never args=-C \S+ fetch --quiet origin \S+$/);
      assert.doesNotMatch(f, /credential/, "no -c credential.helper= override: a configured helper (gh auth setup-git) still applies");
    }
  });
});

test("review: a failed fetch's stderr is redacted and capped in every finding", POSIX_ONLY, () => {
  // Every fetch fails and echoes a token URL, a user:pass URL, a bare-token URL, a second line and a long tail.
  const fail = `printf '%s\\n' "fatal: unable to access 'https://x-access-token:ghs_SECRET1@github.com/o/r.git/': 403" "remote: see https://bob:pw@SECRET2@git.example.com/o and https://glpat_SECRET3@host/x $(printf 'z%.0s' $(seq 1 400))" >&2; exit 128`;
  withGitWrapper(fail, (env) => {
    const res = suiteMerge({ headFiles: SUITE, pr: { files: listed(SUITE), baseRefOid: "0".repeat(40) }, env });
    assert.deepEqual(failChecks(res).sort(), ["base", "review"]);
    assert.doesNotMatch(res.out, /SECRET/, "no credential reaches the output or --json");
    const base = res.json.findings.find((f) => f.check === "base").detail;
    assert.match(base, /^git fetch failed: fatal: unable to access 'https:\/\/\*\*\*@github\.com\/o\/r\.git\/': 403 remote: see https:\/\/\*\*\*@git\.example\.com\/o and https:\/\/\*\*\*@host\/x z+$/);
    assert.equal(base.length, "git fetch failed: ".length + 300, "one line of at most 300 characters");
    const review = res.json.findings.find((f) => f.check === "review").detail;
    assert.match(review, /fetch main: exit 128, fatal: unable to access 'https:\/\/\*\*\*@github\.com/);
    assert.doesNotMatch(review, /\n/);
  });
});

test("review: the gate fetches the PR head ref before it judges a suite-only diff", () => {
  // The head lives only on origin under the forge's head ref, as a fork PR's head does.
  const ok = suiteMerge({
    headFiles: SUITE,
    pr: { files: listed(SUITE) },
    after: (s) => {
      git(s.root, "push", "-q", "origin", `${s.head}:refs/pull/5/head`);
      git(s.root, "push", "-q", "origin", "--delete", "cstack/u1");
      git(s.root, "branch", "-q", "-D", "cstack/u1");
      git(s.root, "update-ref", "-d", "refs/remotes/origin/cstack/u1");
      git(s.root, "reflog", "expire", "--expire=now", "--all");
      git(s.root, "gc", "-q", "--prune=now");
      assert.notEqual(spawnSync("git", ["-C", s.root, "cat-file", "-e", `${s.head}^{commit}`]).status, 0, "the head is not local before the gate runs");
    },
  });
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /hidden e2e suite change/);
});

test("review: suite paths with a space, non-ASCII, and (off Windows) a tab or a quote still match paths_hidden", () => {
  // git quotes a path with non-ASCII, a tab or a quote unless -z is set. Windows forbids tab and quote in names.
  const name = process.platform === "win32" ? "a b é" : 'a\tb "é"';
  const odd = { [`tests/acceptance/${name}.test.mjs`]: "x\n" };
  const ok = suiteMerge({ headFiles: odd, pr: { files: listed(odd) } });
  assert.equal(ok.code, 0, ok.out);
});

test("review: the suite-only rule reads the local diff, not the forge's file list", () => {
  // git mv of product code into the suite: the forge lists only the new path.
  const moved = suiteMerge({
    headFiles: {},
    prepare: (root) => git(root, "mv", "src/app.js", "tests/acceptance/app.js"),
    pr: { files: [{ path: "tests/acceptance/app.js" }] },
  });
  needsReview(moved, "a rename out of src/ needs a review");
  // A large PR whose forge list is truncated to the suite files: the local diff still holds the product file.
  needsReview(suiteMerge({ headFiles: { ...SUITE, "src/f.js": "1\n" }, pr: { files: listed(SUITE) } }), "a truncated list does not hide product code");
  // The local diff decides both ways: a suite-only commit passes whatever extra paths the forge lists.
  const ok = suiteMerge({ headFiles: SUITE, pr: { files: [...listed(SUITE), { path: "src/other.js" }] } });
  assert.equal(ok.code, 0, ok.out);
});

test("base moves: refuses when new base commits touch PR files, allows otherwise", () => {
  const s = setup();
  commit(s.root, { "src/f.js": "conflict\n" }, "base edit");
  git(s.root, "push", "-q", "origin", "main");
  const res = s.run();
  assert.deepEqual(failChecks(res), ["base"]);
  assert.match(res.out, /touched: src\/f.js/);

  const t = setup();
  commit(t.root, { "docs/other.md": "x\n" }, "base edit elsewhere");
  git(t.root, "push", "-q", "origin", "main");
  assert.equal(t.run().code, 0);
});

test("a failed fetch is a finding; required checks unreadable is a finding", () => {
  const s = setup({ cfg: { required_checks: ["ci"] }, extraRules: [{ match: "^api repos/o/r/commits/", responses: [{ code: 1, stderr: "HTTP 502" }] }] });
  git(s.root, "remote", "set-url", "origin", "/nonexistent/repo.git");
  const res = s.run();
  assert.deepEqual(failChecks(res).sort(), ["base", "required checks"]);
});

test("--merge under autonomy stop leaves the PR for a human", () => {
  const s = setup();
  const res = s.run("--merge");
  assert.deepEqual(failChecks(res), ["autonomy"]);
});

test("--merge under autonomy send merges at the verified head", () => {
  const s = setup({
    cfg: { autonomy: "send" },
    extraRules: [
      { match: "^pr merge 5 --repo o/r --merge --match-head-commit [0-9a-f]{40}$", responses: [{ stdout: "" }] },
      ({ head, view }) => ({ match: "^pr view 5", responses: [{ json: view }, { json: { ...view, state: "MERGED", mergeCommit: { oid: "m".repeat(40) } } }] }),
    ],
  });
  const res = s.run("--merge");
  assert.equal(res.code, 0, res.out);
  assert.equal(res.json.merge_sha, "m".repeat(40));
});

const mergeRules = [
  { match: "^pr merge 5 --repo o/r --merge --match-head-commit [0-9a-f]{40}$", responses: [{ stdout: "" }] },
  ({ view }) => ({ match: "^pr view 5", responses: [{ json: view }, { json: { ...view, state: "MERGED", mergeCommit: { oid: "c".repeat(40) } } }] }),
];

test("run.json autonomy stop lowers config send: no merge", () => {
  const s = setup({ cfg: { autonomy: "send" }, runJson: { autonomy: "stop" }, env: { CSTACK_PROGRAM_AUTONOMY: "send" }, extraRules: mergeRules });
  const res = s.run("--merge");
  assert.deepEqual(failChecks(res), ["autonomy"]);
  assert.match(res.out, /autonomy is stop \(run\.json\)/);
});

test("run.json autonomy send raises config stop only with CSTACK_PROGRAM_AUTONOMY=send", () => {
  const refused = setup({ runJson: { autonomy: "send" }, extraRules: mergeRules }).run("--merge");
  assert.deepEqual(failChecks(refused), ["autonomy"], "a run.json written by anyone cannot raise autonomy");
  assert.match(refused.out, /may only lower autonomy/);

  const launched = setup({ runJson: { autonomy: "send" }, env: { CSTACK_PROGRAM_AUTONOMY: "send" }, extraRules: mergeRules }).run("--merge");
  assert.equal(launched.code, 0, launched.out);
  assert.equal(launched.json.merge_sha, "c".repeat(40));
  assert.match(launched.out, /send \(run\.json \+ CSTACK_PROGRAM_AUTONOMY\)/);

  const envOnly = setup({ env: { CSTACK_PROGRAM_AUTONOMY: "send" }, extraRules: mergeRules }).run("--merge");
  assert.deepEqual(failChecks(envOnly), ["autonomy"], "the env alone does not raise config stop");
});

test("an unreadable run.json fails closed: no merge even under config send", () => {
  const res = setup({ cfg: { autonomy: "send" }, runJson: "{broken", env: { CSTACK_PROGRAM_AUTONOMY: "send" }, extraRules: mergeRules }).run("--merge");
  assert.deepEqual(failChecks(res), ["autonomy"]);
  assert.match(res.out, /does not parse/);
});

test("a merge error still counts when GitHub shows it merged at the head; otherwise fails", () => {
  const merged = setup({
    cfg: { autonomy: "send" },
    extraRules: [
      { match: "^pr merge", responses: [{ code: 1, stderr: "GraphQL: timeout" }] },
      ({ view }) => ({ match: "^pr view 5", responses: [{ json: view }, { json: { ...view, state: "MERGED", mergeCommit: { oid: "a".repeat(40) } } }] }),
    ],
  });
  const ok = merged.run("--merge");
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /reported an error, GitHub shows it merged/);

  const failed = setup({ cfg: { autonomy: "send" }, extraRules: [{ match: "^pr merge", responses: [{ code: 1, stderr: "Head branch was modified" }] }] });
  const bad = failed.run("--merge");
  assert.deepEqual(failChecks(bad), ["merge"]);
  assert.match(bad.out, /Head branch was modified/);

  const silent = setup({ cfg: { autonomy: "send" }, extraRules: [{ match: "^pr merge", responses: [{ code: 1 }] }] });
  assert.match(silent.run("--merge").out, /merge failed: OPEN/);
});

test("defaults: repo dir is the cwd and the store comes from CSTACK_RUN", () => {
  const s = setup();
  assert.equal(gate("orch.mjs", ["--run", "r1", "init"], { cwd: s.root }).code, 0);
  approve(path.join(s.root, ".cstack/runs/r1"), "U1", s.head, { pr: 5, evidence: "x" });
  writeFileSync(path.join(s.root, ".cstack/runs/r1/review-U1-rounds.tsv"), `1\t${s.head}\tsonnet\tAPPROVE\tnot exposed\n`);
  const res = gate("check-merge.mjs", ["5", "--unit", "U1"], { cwd: s.root, env: { FAKE_GH_SCENARIO: s.scenario, CSTACK_RUN: "r1" } });
  assert.equal(res.code, 0, res.out + res.err);
});

test("with no store and no CSTACK_RUN, ledger and review both fail", () => {
  const s = setup({ approve: false, review: false });
  const res = gate("check-merge.mjs", ["5", "--unit", "U1", "--repo-dir", s.root, "--json"], { env: { FAKE_GH_SCENARIO: s.scenario, CSTACK_RUN: "" } });
  assert.deepEqual(failChecks(res).sort(), ["ledger", "review"]);
});

test("usage errors exit 2", () => {
  const s = setup({ extraRules: [{ match: "^pr view 6", responses: [{ code: 1, stderr: "not found" }] }] });
  assert.equal(gate("check-merge.mjs", ["abc", "--unit", "U1"]).code, 2);
  assert.equal(gate("check-merge.mjs", ["5"]).code, 2);
  const res = gate("check-merge.mjs", ["6", "--unit", "U1", "--repo-dir", s.root], { env: { FAKE_GH_SCENARIO: s.scenario } });
  assert.equal(res.code, 2);
  assert.match(res.err, /gh pr view 6 failed/);
});

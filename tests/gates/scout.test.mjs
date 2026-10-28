import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, symlinkSync, mkdirSync } from "node:fs";
import { makeRepo, gate, commit, git, write, failChecks, path } from "./helpers.mjs";

const pad = (n, from = 1) => Array.from({ length: n }, (_, i) => `// filler ${from + i}`);
const NOTES = [
  "// notes",
  "export const LIMIT = 100;",
  "",
  "export function addNote(list, text) {",
  "  if (text.length > LIMIT) {",
  "    return { status: 200, error: null };",
  "  }",
  "  list.push(text);",
  "  return { status: 201 };",
  "}",
  ...pad(30, 11),
  "export const FAR_AWAY_MARKER = 'only-once';",
].join("\n");
const DUP = [...pad(4), "  return cache.get(key);", ...pad(6, 6), "  return cache.get(key);", ...pad(3, 13)].join("\n");

function repo(cfg = {}, extra = {}) {
  const r = makeRepo(cfg);
  write(r.root, "src/link", "");
  const files = {
    "src/notes.js": `${NOTES}\n`,
    "src/dup.js": `${DUP}\n`,
    "README.md": "# Notes\n\nPOST /notes returns 201.\n\n```sh\ncurl -X POST /notes\n```\n",
    ".github/workflows/ci.yml": "name: ci\n",
    ...extra,
  };
  commit(r.root, files, "files");
  return r;
}

const evidence = (o = {}) => ({ path: "src/notes.js", line_start: 5, line_end: 6, quote: "if (text.length > LIMIT) { return { status: 200, error: null };", ...o });
const proposal = (o = {}) => ({
  category: "bug",
  title: "POST /notes returns 200 instead of 413 for long notes",
  problem: "addNote returns status 200 with error null when the text is longer than LIMIT (100), so callers think it saved.",
  evidence: [evidence()],
  expected: "Return status 413 for text over 100 characters.",
  acceptance: ["a 101-character note returns status 413"],
  files: ["src/notes.js"],
  ...o,
});

function check(r, kind, doc, args = [], env = {}) {
  const file = path.join(r.base, `${kind}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, typeof doc === "string" ? doc : JSON.stringify(doc));
  return gate("scout-check.mjs", [kind, file, "--repo-dir", r.root, "--json", ...args], { env });
}

const details = (res) => res.json.findings.map((f) => f.detail).join("\n");

test("scout-check usage errors exit 2", () => {
  const r = repo();
  assert.equal(gate("scout-check.mjs", []).code, 2);
  assert.equal(gate("scout-check.mjs", ["nope", "x"]).code, 2);
  assert.equal(gate("scout-check.mjs", ["repro", r.root]).code, 2);
  assert.equal(check(r, "plan", "{not json").code, 2);
  assert.equal(check(r, "proposals", { proposals: 1 }).code, 2);
});

test("plan: 3-6 areas over tracked files, one covering the docs", () => {
  const r = repo();
  const good = {
    areas: [
      { name: "notes api", paths: ["src/notes.js"], focus: "status codes" },
      { name: "cache", paths: ["/src/"], focus: "eviction" },
      { name: "docs", paths: ["README.md", "src/notes.js"], focus: "README against the code" },
    ],
  };
  const ok = check(r, "plan", good);
  assert.equal(ok.code, 0, ok.out);
  const bad = check(r, "plan", {
    areas: [
      { name: "a", paths: ["src/notes.js"], focus: "x" },
      { name: "hidden", paths: ["tests/acceptance"], focus: "x" },
      { name: "all", paths: ["."], focus: "x" },
      { name: "", paths: ["src"], focus: "x" },
      { name: "nofocus", paths: ["src"] },
      { name: "many", paths: Array(9).fill("src"), focus: "x" },
      { name: "none", paths: [], focus: "x" },
    ],
  });
  assert.equal(bad.code, 1);
  const text = details(bad);
  assert.match(text, /7 areas; a plan has 3-6/);
  assert.match(text, /names tests\/acceptance, which holds no tracked file/);
  assert.match(text, /names the whole repository/);
  assert.match(text, /needs a name and a focus/);
  assert.match(text, /needs 1-8 paths/);
  assert.match(text, /no area covers the documentation/);
  assert.equal(check(r, "plan", [null]).code, 1, "a plan that is not an object has 0 areas");
  const nulls = check(r, "plan", { areas: [null, { name: "n", paths: "src", focus: "x" }, { name: "o", paths: ["src"], focus: "y" }] });
  assert.match(details(nulls), /#1: needs a name and a focus|needs a name/);
});

test("plan: a repo with no documentation needs no docs area", () => {
  const r = makeRepo();
  const file = path.join(r.base, "plan.json");
  writeFileSync(file, JSON.stringify({ areas: ["a", "b", "c"].map((n) => ({ name: n, paths: ["src"], focus: "f" })) }));
  const res = gate("scout-check.mjs", ["plan", file], { cwd: r.root });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /tracks no documentation/);
});

test("proposals: a quote within 10 lines is kept and its range corrected; --out writes fingerprints", () => {
  const r = repo();
  const out = path.join(r.base, "kept.json");
  const res = check(r, "proposals", [proposal({ evidence: [evidence({ line_start: 12, line_end: 13 })] }), proposal({ title: "Another distinct notes title here", evidence: [evidence({ quote: "export const LIMIT = 100;", line_start: 2, line_end: 2 })] })], ["--out", out]);
  assert.equal(res.code, 0, res.out);
  assert.equal(res.json.kept, 2);
  const kept = JSON.parse(readFileSync(out, "utf8")).proposals;
  assert.deepEqual([kept[0].evidence[0].line_start, kept[0].evidence[0].line_end], [5, 6]);
  assert.deepEqual(kept[0].evidence[0].corrected_from, [12, 13]);
  assert.match(kept[0].fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(kept[1].evidence[0].corrected_from, undefined, "an exact citation is not corrected");
  assert.match(res.out, /1 evidence ranges corrected/);
});

test("proposals: the nearest of several occurrences wins; a unique far quote is found; an ambiguous far one is not", () => {
  const r = repo();
  const q = "return cache.get(key);";
  const nearSecond = proposal({ category: "enhancement", title: "Cache lookup returns stale entries first", files: ["src/dup.js"], evidence: [{ path: "src/dup.js", line_start: 11, line_end: 11, quote: q }] });
  const nearFirst = proposal({ category: "feature", title: "Cache lookup lacks a miss counter", files: ["src/dup.js"], evidence: [{ path: "src/dup.js", line_start: 6, line_end: 6, quote: q, corrected_from: [1, 1] }] });
  const far = proposal({ category: "enhancement", title: "Marker constant is exported needlessly", evidence: [evidence({ quote: "export const FAR_AWAY_MARKER = 'only-once';", line_start: 1, line_end: 1 })] });
  const out = path.join(r.base, "k.json");
  const res = check(r, "proposals", [nearSecond, nearFirst, far], ["--out", out]);
  assert.equal(res.code, 0, res.out);
  const kept = JSON.parse(readFileSync(out, "utf8")).proposals;
  assert.equal(kept[0].evidence[0].line_start, 12);
  assert.equal(kept[1].evidence[0].line_start, 5);
  assert.deepEqual(kept[1].evidence[0].corrected_from, [1, 1], "an earlier correction is kept");
  assert.equal(kept[2].evidence[0].line_start, 41);
  const amb = check(r, "proposals", [proposal({ files: ["src/dup.js"], evidence: [{ path: "src/dup.js", line_start: 40, line_end: 40, quote: q }] })]);
  assert.match(details(amb), /past the end of the file \(15 lines\)/);
  const amb2 = check(r, "proposals", [proposal({ evidence: [evidence({ path: "src/dup.js", line_start: 30 - 29, line_end: 1, quote: "no such text in this file" })] })]);
  assert.match(details(amb2), /does not contain the quoted text, nor do the 10 lines around it/);
});

test("proposals: every rule drops what breaks it", () => {
  const r = repo({ scout: { categories: ["bug", "docs", "enhancement"], max_files: 2 } });
  symlinkSync("notes.js", path.join(r.root, "src/alias.js"));
  git(r.root, "add", "-A");
  git(r.root, "commit", "-qm", "link");
  const cases = [
    [proposal({ category: "feature" }), /category feature is not enabled/],
    [proposal({ category: "docs" }), /a docs proposal may change only documentation files/],
    [proposal({ files: ["src/notes.js", "src/dup.js", "src/app.js"] }), /would change 3 files; the limit is 2/],
    [proposal({ files: ["src/new.js"] }), /file to change src\/new.js is not a tracked file/],
    [proposal({ files: [".github/workflows/ci.yml"] }), /file to change .github\/workflows\/ci.yml is off limits/],
    [proposal({ acceptance: ["it works better"] }), /names no exact value: "it works better"/],
    [proposal({ evidence: [evidence({ path: "src/missing.js" })] }), /evidence src\/missing.js is not a tracked file/],
    [proposal({ evidence: [evidence({ path: "src/alias.js" })] }), /evidence src\/alias.js is not a tracked file/],
    [proposal({ evidence: [evidence({ path: ".github/workflows/ci.yml", line_start: 1, line_end: 1, quote: "name: ci here" })] }), /is off limits/],
    [proposal({ evidence: [evidence({ line_start: 1, line_end: 41 })] }), /is not a range of 1-40 lines/],
    [proposal({ evidence: [evidence({ line_start: 6, line_end: 5 })] }), /is not a range of 1-40 lines/],
    ["text", /not a JSON object/],
    [proposal({ category: "chore" }), /category must be one of/],
    [proposal({ title: "short" }), /title must be 8-100/],
    [proposal({ problem: "too short" }), /problem must be at least 40/],
    [proposal({ evidence: [{ path: "src/notes.js", line_start: 0, line_end: 1, quote: "x".repeat(9) }] }), /evidence must be 1-5 items/],
    [proposal({ evidence: [null] }), /evidence must be 1-5 items/],
    [proposal({ evidence: [evidence({ quote: "        a" })] }), /evidence must be 1-5 items/],
    [proposal({ evidence: [evidence({ quote: undefined })] }), /evidence must be 1-5 items/],
    [proposal({ expected: "fix" }), /expected must be at least 10/],
    [proposal({ acceptance: [] }), /acceptance must be 1-6/],
    [proposal({ files: [] }), /files must name at least one file/],
  ];
  const res = check(r, "proposals", { proposals: cases.map(([p]) => p) });
  assert.equal(res.code, 1);
  assert.equal(res.json.kept, 0);
  res.json.findings.forEach((f, i) => assert.match(f.detail, cases[i][1], `case ${i + 1}: ${f.detail}`));
  const twice = check(r, "proposals", [proposal(), proposal()]);
  assert.match(details(twice), /proposed twice in this pass/);
  assert.equal(twice.json.kept, 1);
});

function reproRepo({ broken = false, timeout } = {}) {
  const r = makeRepo(timeout ? { limits: { ...JSON.parse(readFileSync(path.resolve("templates/config.json"), "utf8")).limits, test_timeout_seconds: timeout } } : {});
  const files = {
    "scripts/test.sh": '#!/bin/sh\n[ -e src/broken ] && { echo base broken; exit 1; }\nfor f in tests/unit/*.sh; do [ -f "$f" ] || continue; sh "$f" || exit 1; done\necho ok\n',
  };
  if (broken) files["src/broken"] = "1\n";
  commit(r.root, files, "suite");
  return r;
}
const repro = (r, name = "limit_rejects_101") => gate("scout-check.mjs", ["repro", r.root, "--test-name", name, "--out", path.join(r.base, "repro.diff"), "--json"]);

test("repro: one failing test file that names the test is ok, and its diff is written", () => {
  const r = reproRepo();
  write(r.root, "tests/unit/limit.sh", 'echo "not ok - limit_rejects_101"\nexit 1\n');
  const res = repro(r);
  assert.equal(res.code, 0, res.out);
  assert.equal(res.json.status, "ok");
  assert.match(readFileSync(path.join(r.base, "repro.diff"), "utf8"), /\+\+\+ b\/tests\/unit\/limit.sh/);
});

test("repro: no change, a non-test change, a red base, a passing test, an unnamed failure and a timeout are not repros", () => {
  const none = reproRepo();
  assert.match(repro(none).json.findings[0].detail, /wrote no test/);
  const other = reproRepo();
  write(other.root, "src/app.js", "changed\n");
  write(other.root, "tests/unit/a.sh", "exit 1\n");
  assert.match(repro(other).json.findings[0].detail, /not tests: src\/app.js/);
  const red = reproRepo({ broken: true });
  write(red.root, "tests/unit/a.sh", "exit 1\n");
  assert.match(repro(red).json.findings[0].detail, /fails on the base branch, so no new test/);
  const pass = reproRepo();
  write(pass.root, "tests/unit/a.sh", "exit 0\n");
  const p = repro(pass);
  assert.equal(p.json.status, "refuted");
  assert.match(p.json.findings[0].detail, /did not reproduce/);
  const quiet = reproRepo();
  write(quiet.root, "tests/unit/a.sh", "echo something else\nexit 1\n");
  assert.match(repro(quiet).json.findings[0].detail, /not visibly on limit_rejects_101/);
  const slow = reproRepo({ timeout: 1 });
  write(slow.root, "tests/unit/a.sh", "echo limit_rejects_101; sleep 3\n");
  const s = repro(slow);
  assert.equal(s.json.status, "invalid");
  assert.match(s.json.findings[0].detail, /not visibly/);
});

// ---------------------------------------------------------------- scout-gate

const DAY = 86400e3;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const body = (fp, category, mode) => `## Problem\nx\n---\nCategory: ${category}\nCstack-Scout: ${fp}\nCstack-Scout-Mode: ${mode}\n`;
const issue = (n, { fp = String(n).padStart(16, "a"), category = "bug", mode = "proposed", labels = [], state = "OPEN", days = 1 } = {}) => ({
  number: n,
  title: `Scout issue number ${n} about things`,
  state,
  labels: labels.map((name) => ({ name: `cstack:${name}` })),
  body: body(fp, category, mode),
  createdAt: iso(days),
});

function scout(cfg = {}, extra = {}) {
  const r = repo(cfg, extra);
  const store = path.join(r.root, ".cstack/runs/scout");
  let n = 0;
  const run = (args, { issues = [], open = [], create = { stdout: "https://github.com/o/r/issues/77\n" }, cwd } = {}) => {
    const scenario = path.join(r.base, `gh-${n++}.json`);
    const rules = [
      { match: "^issue list --repo o/r --state all --search", responses: [{ json: issues }] },
      { match: "^issue list --repo o/r --state open", responses: [{ json: open }] },
      { match: "^issue create", responses: [create] },
    ];
    writeFileSync(scenario, JSON.stringify({ rules }));
    const log = path.join(r.base, "gh.log");
    const res = gate("scout-gate.mjs", [...args, "--json"], { env: { FAKE_GH_SCENARIO: scenario, FAKE_GH_LOG: log }, cwd });
    return { ...res, log: existsSync(log) ? readFileSync(log, "utf8") : "" };
  };
  const jsonFile = (doc) => {
    const f = path.join(r.base, `doc-${n++}.json`);
    writeFileSync(f, typeof doc === "string" ? doc : JSON.stringify(doc));
    return f;
  };
  const file = (bundle, opts = {}, extraArgs = []) => run(["file", jsonFile(bundle), "--store", store, "--pass", opts.pass ?? "p1", ...extraArgs], opts);
  return { ...r, store, run, file, jsonFile };
}

const AUTO = { autonomy: "auto", auto_min_decided: 2, auto_min_approval: 0.5, auto_min_done: 0.5 };

test("scout-gate usage errors exit 2", () => {
  const s = scout();
  assert.equal(s.run([]).code, 2);
  assert.equal(s.run(["record", "extra"]).code, 2);
  assert.equal(s.run(["choose", "plan.json"]).code, 2);
  assert.equal(s.run(["mark", "plan.json", "--store", s.store]).code, 2);
  assert.equal(s.run(["file", "b.json", "--store", s.store]).code, 2);
  assert.equal(s.run(["file", "b.json", "--store", s.store, "--pass", "a b"]).code, 2);
  assert.equal(s.run(["choose", s.jsonFile({}), "--store", s.store]).code, 2);
  assert.equal(s.run(["choose", s.jsonFile("{bad"), "--store", s.store]).code, 2);
  assert.equal(s.run(["mark", s.jsonFile({ areas: [] }), "--store", s.store, "--area", "x"]).code, 2);
  assert.equal(s.file(null).code, 2, "a bundle with no proposal");
  assert.equal(s.file({ proposal: proposal(), review: { verdict: "maybe", reason: "x" } }).code, 2);
  assert.equal(s.file({ proposal: proposal() }).code, 2);
  assert.equal(s.file({ proposal: proposal(), review: { verdict: "confirmed", reason: 3 } }).code, 2);
  assert.equal(s.file({ proposal: proposal(), review: { verdict: "confirmed", reason: "  " } }).code, 2);
});

test("record: only a person's decisions count; auto-filed issues count toward the done-rate only", () => {
  const s = scout({ scout: AUTO });
  const issues = [
    issue(1, { labels: ["ready"] }),
    issue(2, { labels: ["in-progress"] }),
    issue(3, { labels: ["done"], state: "CLOSED" }),
    issue(4, { labels: ["error"] }),
    issue(5, { state: "CLOSED" }),
    issue(6, { mode: "auto", labels: ["ready"] }),
    issue(7, { mode: "auto", labels: ["done"], state: "CLOSED" }),
    issue(8, { mode: "auto", state: "CLOSED" }),
    issue(9, { mode: "needs_human", labels: ["ready"] }),
    issue(10, { labels: ["ready"], days: 61 }),
    { number: 11, title: "no marker", state: "OPEN", labels: [], body: "plain", createdAt: iso(1) },
    issue(12),
    issue(13, { category: "docs", labels: ["ready"] }),
    issue(14, { category: "docs", labels: ["done"], state: "CLOSED" }),
    issue(15, { category: "docs", state: "CLOSED", days: 70 }),
  ];
  const res = s.run(["record", "--repo-dir", s.root], { issues });
  assert.equal(res.code, 0, res.out);
  const bug = res.json.categories.bug;
  assert.deepEqual([bug.decided, bug.approved, bug.rejected, bug.done, bug.error], [6, 4, 2, 2, 1]);
  assert.equal(bug.approval, 0.667);
  assert.equal(bug.done_rate, 0.667);
  assert.equal(bug.gate, "auto");
  assert.match(bug.why, /and a test that fails on the base branch/);
  assert.equal(res.json.categories.docs.gate, "auto");
  assert.doesNotMatch(res.json.categories.docs.why, /a test that fails/);
  assert.equal(res.json.categories.feature.gate, "proposed");
  assert.match(res.json.categories.feature.why, /0 decided feature proposals in 60 days, under 2; approval 0% is under 50%; no landed issues, under 50%/);
  assert.deepEqual(res.json.rejected.map((i) => i.number), [5, 8]);
});

test("record: propose autonomy, a low done-rate, no repro, and auto with nothing landed", () => {
  const plain = scout({ scout: null });
  const p = plain.run(["record"], { cwd: plain.root });
  assert.equal(p.code, 0, p.out);
  assert.equal(p.json.categories.bug.why, "autonomy is propose", "no scout object means Cardinal's defaults");
  assert.deepEqual(Object.keys(p.json.categories), ["bug", "regression", "docs", "enhancement", "feature"]);
  const low = scout({ scout: { ...AUTO, repro: false } });
  const lowIssues = [issue(1, { labels: ["error"] }), issue(2, { labels: ["error"] }), issue(3, { labels: ["done"] })];
  const l = low.run(["record", "--repo-dir", low.root], { issues: lowIssues });
  assert.match(l.json.categories.bug.why, /done-rate 33%, under 50%; no test that fails on the base branch/);
  const none = scout({ scout: { ...AUTO, auto_min_done: 0 } });
  const n = none.run(["record", "--repo-dir", none.root], { issues: [issue(1, { category: "docs", labels: ["ready"] }), issue(2, { category: "docs", labels: ["ready"] })] });
  assert.equal(n.json.categories.docs.gate, "auto");
  assert.match(n.json.categories.docs.why, /100% approved, no landed issues/);
});

test("choose and mark: cooldown, least recently surveyed first, at most areas_per_pass", () => {
  const s = scout({ scout: { cooldown_days: 7, areas_per_pass: 2 } });
  const plan = s.jsonFile({
    areas: [
      { name: "recent", paths: ["src/notes.js"] },
      { name: "old", paths: ["src/dup.js"] },
      { name: "never", paths: ["README.md"] },
      { name: "older", paths: ["src/app.js/"] },
      { name: "same as never", paths: ["/README.md"] },
      { name: "nopaths" },
    ],
  });
  mkdirSync(s.store, { recursive: true });
  writeFileSync(path.join(s.store, "areas.tsv"), [`src/notes.js\t${iso(1)}`, `src/dup.js\t${iso(8)}`, `src/app.js\t${iso(20)}`, `src/dup.js\t${iso(9)}`].join("\n") + "\n");
  const res = s.run(["choose", plan, "--store", s.store]);
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(res.json.areas.map((a) => a.name), ["never", "nopaths"]);
  assert.ok(res.json.passes.some((p) => p.check === "skip recent"));
  const m = s.run(["mark", plan, "--store", s.store, "--area", "never"]);
  assert.equal(m.code, 0, m.out);
  const m2 = s.run(["mark", plan, "--store", s.store, "--area", "nopaths"]);
  assert.equal(m2.code, 0);
  const again = s.run(["choose", plan, "--store", s.store]);
  assert.deepEqual(again.json.areas.map((a) => a.name), ["older", "old"]);
  assert.match(again.json.passes.find((p) => p.check === "survey older").detail, /last surveyed/);
  const fresh = scout();
  const f = fresh.run(["choose", fresh.jsonFile({ areas: [{ name: "a", paths: ["src"] }] }), "--store", fresh.store]);
  assert.equal(f.json.passes[0].detail, "never surveyed");
});

const bundle = (o = {}, r = {}) => ({ proposal: proposal(o), review: { verdict: "confirmed", reason: "src/notes.js:6 returns 200 for long text.", ...r } });

test("file: a confirmed proposal files once as proposed, with Cardinal's body and the footer", () => {
  const s = scout();
  const res = s.file(bundle());
  assert.equal(res.code, 0, res.out);
  assert.equal(res.json.issue, 77);
  assert.equal(res.json.label, "cstack:proposed");
  assert.match(res.log, /issue create --repo o\/r --title POST \/notes returns 200 instead of 413 for long notes --body-file .* --label cstack:proposed/);
  const text = readFileSync(path.join(s.store, `issue-${res.json.fingerprint}.md`), "utf8");
  for (const h of ["## Problem", "## Evidence", "## Expected", "## Acceptance", "## Files"]) assert.ok(text.includes(h), h);
  assert.match(text, /`src\/notes.js:5-6`\n```\nif \(text.length/);
  assert.match(text, /- \[ \] a 101-character note returns status 413/);
  assert.match(text, /Approve by swapping `cstack:proposed` for `cstack:ready`/);
  assert.match(text, /Cstack-Scout-Mode: proposed/);
  assert.ok(text.trimEnd().endsWith(readFileSync(path.resolve("templates/footer.md"), "utf8").trim()));
  assert.doesNotMatch(text, /Suggested test/);
  const ledger = readFileSync(path.join(s.store, "ledger.tsv"), "utf8").trim().split("\n");
  assert.deepEqual(ledger.slice(1).map((l) => l.split("\t")[3]), ["filing", "filed"]);
});

test("file: auto files ready only with the track record and a repro; product decisions go to needs-human", () => {
  const s = scout({ scout: AUTO });
  const record = [issue(1, { labels: ["done"] }), issue(2, { labels: ["done"] })];
  const diff = path.join(s.base, "repro.diff");
  writeFileSync(diff, "diff --git a/tests/unit/a.test.js b/tests/unit/a.test.js\n+++ b/tests/unit/a.test.js\n+it fails\n");
  const auto = s.file({ ...bundle(), repro_diff: diff }, { issues: record });
  assert.equal(auto.code, 0, auto.out);
  assert.equal(auto.json.label, "cstack:ready");
  const text = readFileSync(path.join(s.store, `issue-${auto.json.fingerprint}.md`), "utf8");
  assert.match(text, /## Suggested test\nThis test fails on the base branch/);
  assert.match(text, /Filed ready by cstack's scout: 2 decided bug proposals/);
  const noRepro = s.file(bundle({ title: "Second distinct bug about notes" }), { issues: record });
  assert.equal(noRepro.json.label, "cstack:proposed");
  const pd = s.file(bundle({ title: "Should long notes be truncated instead" }, { verdict: "product_decision" }), { issues: record });
  assert.equal(pd.json.label, "cstack:needs-human");
  assert.match(readFileSync(path.join(s.store, `issue-${pd.json.fingerprint}.md`), "utf8"), /found a product decision/);
});

test("file: drops what the reviewer rejects, re-checks the reviewer's evidence, and applies its category", () => {
  const s = scout({ scout: { categories: ["bug", "enhancement", "docs"] } });
  const wrong = s.file(bundle({}, { verdict: "wrong" }));
  assert.equal(wrong.code, 1);
  assert.match(wrong.json.findings[0].detail, /reviewer: wrong: src\/notes.js:6/);
  const badEvidence = s.file(bundle({}, { evidence: [evidence({ quote: "not in the file at all" })] }));
  assert.match(badEvidence.json.findings[0].detail, /after review: evidence .* does not contain/);
  const recat = s.file(bundle({}, { category: "enhancement", evidence: [evidence({ line_start: 4, line_end: 5 })] }), { pass: "p2" });
  assert.equal(recat.code, 0, recat.out);
  assert.ok(recat.json.passes.some((p) => /recategorised bug as enhancement/.test(p.detail)));
  const toDocs = s.file(bundle({ title: "Docs drift on note limits here" }, { category: "docs" }), { pass: "p2" });
  assert.match(toDocs.json.findings[0].detail, /a docs proposal may change only documentation files/);
  const ignored = s.file(bundle({ title: "Ignored category on this proposal" }, { category: "feature", verdict: "product_decision", evidence: [evidence({ quote: "nope nope nope" })] }), { pass: "p2" });
  assert.equal(ignored.code, 0, "a disabled category and a product decision's evidence are ignored");
  const diff = path.join(s.base, "bad.diff");
  writeFileSync(diff, "+++ b/src/notes.js\n");
  assert.match(s.file({ ...bundle({ title: "Repro touches source files" }), repro_diff: diff }).json.findings[0].detail, /not tests: src\/notes.js/);
  writeFileSync(diff, "nothing\n");
  assert.match(s.file({ ...bundle({ title: "Repro touches nothing at all" }), repro_diff: diff }).json.findings[0].detail, /not tests: none/);
});

test("file: duplicates by fingerprint and by title, the per-pass cap, and an interrupted filing", () => {
  const s = scout({ scout: { max_proposals_per_pass: 1 } });
  const b = bundle();
  const first = s.file(b, { create: { stdout: "https://github.com/o/r/issues/5\n" } });
  const fp = first.json.fingerprint;
  const prior = (o) => [{ ...issue(5, { fp, ...o }) }];
  assert.match(s.file(b, { issues: prior({}) }).json.findings[0].detail, /already filed as #5 \(undecided\)/);
  assert.match(s.file(b, { issues: prior({ labels: ["ready"] }) }).json.findings[0].detail, /\(approved\)/);
  assert.match(s.file(b, { issues: prior({ labels: ["error"] }) }).json.findings[0].detail, /\(error\)/);
  assert.match(s.file(b, { issues: prior({ state: "CLOSED" }) }).json.findings[0].detail, /\(rejected\)/);
  const open = [{ number: 9, title: "POST /notes returns 200 instead of 413 for long notes" }];
  assert.match(s.file(b, { issues: prior({ state: "CLOSED", days: 90 }), open }).json.findings[0].detail, /duplicates open issue #9/);
  const held = s.file({ ...b, proposal: { ...b.proposal, fingerprint: fp } }, { issues: prior({ labels: ["done"], state: "CLOSED" }), open: [{ number: 1, title: "unrelated" }] });
  assert.equal(held.json.action, "held");
  assert.ok(existsSync(path.join(s.store, "held", `${fp}.json`)));
  const next = s.file(JSON.parse(readFileSync(path.join(s.store, "held", `${fp}.json`), "utf8")), { pass: "p2", issues: prior({ labels: ["done"], state: "CLOSED" }) });
  assert.equal(next.code, 0, next.out);
  assert.ok(!existsSync(path.join(s.store, "held", `${fp}.json`)), "a filed held proposal leaves held/");
  const crash = scout();
  const failed = crash.file(bundle(), { create: { code: 1, stderr: "HTTP 502" } });
  assert.equal(failed.json.action, "file-error");
  assert.match(failed.json.findings[0].detail, /HTTP 502/);
  const again = crash.file(bundle());
  assert.equal(again.json.action, "filed", "a file-error row is retried");
  const ledgerFile = path.join(crash.store, "ledger.tsv");
  writeFileSync(ledgerFile, readFileSync(ledgerFile, "utf8") + `x\tp9\t${again.json.fingerprint}\tfiling\tbug\t\tt\tr\n`);
  const stuck = crash.file(bundle());
  assert.equal(stuck.json.action, "filing");
  assert.match(stuck.json.findings[0].detail, /interrupted/);
});

test("file: --dry-run prints the body and files nothing; quotes with fences and one-line citations render", () => {
  const s = scout();
  const docs = {
    category: "docs",
    title: "README shows curl without the JSON body",
    files: ["README.md"],
    evidence: [
      { path: "README.md", line_start: 3, line_end: 3, quote: "POST /notes returns 201." },
      { path: "README.md", line_start: 5, line_end: 7, quote: "```sh curl -X POST /notes ```" },
    ],
  };
  const res = s.file(bundle(docs), { open: [{ number: 3, title: "!!" }] }, ["--dry-run"]);
  assert.equal(res.code, 0, res.out);
  assert.equal(res.json.action, "dry-run");
  assert.match(res.json.body, /`README.md:3`\n```\nPOST/);
  assert.match(res.json.body, /`README.md:5-7`\n````\n```sh curl/);
  assert.doesNotMatch(res.log, /issue create/);
  assert.deepEqual(failChecks(res), []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GUARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../hooks/scripts/guard.mjs");

function repo(config = { paths_hidden: ["tests/acceptance/**"], paths_off_limits: [".github/workflows/**"] }) {
  const root = mkdtempSync(path.join(tmpdir(), "cstack-guard-"));
  mkdirSync(path.join(root, ".cstack"));
  mkdirSync(path.join(root, "src"));
  if (config !== null) writeFileSync(path.join(root, ".cstack", "config.json"), typeof config === "string" ? config : JSON.stringify(config));
  return root;
}

function run(root, tool_name, tool_input, env = {}, cwd = root) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name, tool_input, cwd }),
    env: { ...process.env, CSTACK_ROLE: "", CSTACK_RUN: "", CSTACK_UNIT: "", CSTACK_COORDINATOR: "", CSTACK_HEADLESS: "", ...env },
    encoding: "utf8",
  });
  return { code: r.status, err: r.stderr };
}

test("allows ordinary reads and writes", () => {
  const r = repo();
  assert.equal(run(r, "Read", { file_path: path.join(r, "src/a.js") }).code, 0);
  assert.equal(run(r, "Write", { file_path: "src/a.js" }).code, 0);
  assert.equal(run(r, "Grep", { pattern: "x", path: r }).code, 0);
});

test("hidden-paths blocks Read, Edit, Grep and Glob targets inside the hidden area", () => {
  const r = repo();
  for (const [tool, input] of [
    ["Read", { file_path: path.join(r, "tests/acceptance/e1.test.js") }],
    ["Read", { file_path: "tests/acceptance" }],
    ["Edit", { file_path: "tests/acceptance/e1.test.js" }],
    ["Grep", { pattern: "x", path: "tests/acceptance" }],
    ["Glob", { pattern: "tests/acceptance/**/*.js" }],
    ["Grep", { pattern: "x", glob: "tests/acceptance/*" }],
  ]) {
    const out = run(r, tool, input);
    assert.equal(out.code, 2, `${tool} ${JSON.stringify(input)}`);
    assert.match(out.err, /hidden-paths/);
  }
});

test("hidden-paths resolves relative paths from a subdirectory", () => {
  const r = repo();
  const out = run(r, "Read", { file_path: "../tests/acceptance/e1.test.js" }, {}, path.join(r, "src"));
  assert.equal(out.code, 2);
});

test("hidden-paths blocks Bash commands that name the hidden area", () => {
  const r = repo();
  const out = run(r, "Bash", { command: "cat tests/acceptance/e1.test.js" });
  assert.equal(out.code, 2);
  assert.match(out.err, /hidden-paths/);
});

test("hidden-paths refuses git listings that would print hidden names", () => {
  const r = repo();
  for (const command of ["git ls-files", "git ls-files -z", "git ls-files 2>/dev/null", "git ls-files | wc -l", "git -C /x ls-files", "cd src && git ls-files .", "git ls-files ./", "git ls-files ..", "git ls-files tests", "git ls-files tests/", "git ls-files 'tests'", "git ls-files '*.js'", "git ls-tree -r HEAD", "git ls-tree HEAD tests", "git ls-files src; git ls-files"]) {
    const out = run(r, "Bash", { command });
    assert.equal(out.code, 2, command);
    assert.match(out.err, /hidden-paths.*would list hidden file names/, command);
  }
});

test("hidden-paths allows git listings that stay outside the hidden area", () => {
  const r = repo();
  for (const command of ["git ls-files src", "git ls-files ./src/ docs", "git ls-files -- src", "git ls-files src > /tmp/list", "git ls-files src 2>/dev/null", "git ls-tree -r HEAD src", "git ls-files tests/unit", "git log --oneline"]) {
    assert.equal(run(r, "Bash", { command }).code, 0, command);
  }
});

test("git listings are unrestricted for privileged roles and without hidden paths", () => {
  const r = repo();
  assert.equal(run(r, "Bash", { command: "git ls-files" }, { CSTACK_ROLE: "grader" }).code, 0);
  assert.equal(run(repo({ paths_hidden: [], paths_off_limits: [] }), "Bash", { command: "git ls-files" }).code, 0);
});

test("hidden-paths never matches Agent or Skill prompt text", () => {
  const r = repo();
  assert.equal(run(r, "Agent", { prompt: "do not read tests/acceptance" }).code, 0);
});

test("grader and e2e-author roles may read the hidden area", () => {
  const r = repo();
  assert.equal(run(r, "Read", { file_path: "tests/acceptance/e1.test.js" }, { CSTACK_ROLE: "grader" }).code, 0);
  assert.equal(run(r, "Write", { file_path: "tests/acceptance/e1.test.js" }, { CSTACK_ROLE: "e2e-author" }).code, 0);
});

test("e2e-author may not write outside the hidden area", () => {
  const r = repo();
  const out = run(r, "Write", { file_path: "src/a.js" }, { CSTACK_ROLE: "e2e-author" });
  assert.equal(out.code, 2);
  assert.match(out.err, /off-limits/);
});

test("off-limits blocks writes to configured paths, .git and vendor dirs", () => {
  const r = repo();
  for (const p of [".github/workflows/ci.yml", ".git/config", "node_modules/x/index.js", ".cstack/config.json"]) {
    const out = run(r, "Write", { file_path: p });
    assert.equal(out.code, 2, p);
    assert.match(out.err, /off-limits/);
  }
  assert.equal(run(r, "Read", { file_path: ".github/workflows/ci.yml" }).code, 0, "reads stay allowed");
  assert.equal(run(r, "Write", { file_path: ".cstack/runs/issue-1/intake.json" }).code, 0, "the run store stays writable");
});

test("no-sleep-loops blocks polling loops and long sleeps", () => {
  const r = repo();
  for (const cmd of ["while true; do gh pr checks 1; sleep 30; done", "until done; do sleep 5; done", "for i in 1 2 3; do sleep 2; done", "sleep 60 && gh pr view"]) {
    const out = run(r, "Bash", { command: cmd });
    assert.equal(out.code, 2, cmd);
    assert.match(out.err, /no-sleep-loops/);
  }
  assert.equal(run(r, "Bash", { command: "sleep 2 && ls" }).code, 0, "short single sleep is fine");
});

test("no-admin-merge blocks direct merges", () => {
  const r = repo();
  for (const cmd of ["gh pr merge 3 --merge", "gh pr merge 3 --admin --squash", "gh api -X PUT repos/o/r/pulls/3/merge"]) {
    const out = run(r, "Bash", { command: cmd });
    assert.equal(out.code, 2, cmd);
    assert.match(out.err, /no-admin-merge/);
  }
  assert.equal(run(r, "Bash", { command: "gh pr view 3 --json mergeable" }).code, 0);
});

test("no-autonomy-raise blocks setting CSTACK_PROGRAM_AUTONOMY and allows reading it", () => {
  const r = repo();
  for (const cmd of [
    "CSTACK_PROGRAM_AUTONOMY=send node gates/check-merge.mjs 5 --unit U1 --merge",
    "export CSTACK_PROGRAM_AUTONOMY",
    "env CSTACK_PROGRAM_AUTONOMY = send x",
    "systemctl --user set-environment CSTACK_PROGRAM_AUTONOMY",
    "systemd-run --user --setenv=CSTACK_PROGRAM_AUTONOMY=send claude -p x",
  ]) {
    const out = run(r, "Bash", { command: cmd });
    assert.equal(out.code, 2, cmd);
    assert.match(out.err, /no-autonomy-raise/);
  }
  assert.equal(run(r, "Bash", { command: "printenv CSTACK_PROGRAM_AUTONOMY" }).code, 0);
});

test("no-deploy-approval blocks the approved deploy command and allows a plan", () => {
  const r = repo();
  for (const cmd of ["node /p/gates/deploy.mjs abc --approved", "node gates/deploy.mjs abc --repo-dir . --approved --json"]) {
    const out = run(r, "Bash", { command: cmd });
    assert.equal(out.code, 2, cmd);
    assert.match(out.err, /no-deploy-approval/);
  }
  assert.equal(run(r, "Bash", { command: "node gates/deploy.mjs abc --plan --json" }).code, 0);
  assert.equal(run(r, "Bash", { command: "node gates/deploy.mjs abc --json" }).code, 0);
});

test("no-eval-publish blocks claude plugin eval without --no-publish", () => {
  const r = repo();
  for (const cmd of ["claude plugin eval . --ablation none", "cd /x && claude plugins eval /tmp/p --json out.json"]) {
    const out = run(r, "Bash", { command: cmd });
    assert.equal(out.code, 2, cmd);
    assert.match(out.err, /no-eval-publish/);
  }
  assert.equal(run(r, "Bash", { command: "claude plugin eval . --ablation none --no-publish" }).code, 0);
  assert.equal(run(r, "Bash", { command: "claude plugin eval --help" }).code, 0, "help runs nothing");
});

test("outside a cstack context every rule is off", () => {
  const r = repo(null); // .cstack/ exists but has no config.json: not a cstack repo
  for (const cmd of [
    "gh pr merge 1 --squash",
    "gh api -X PUT repos/o/r/pulls/3/merge",
    "while true; do sleep 30; done",
    "sleep 60",
    "export CSTACK_PROGRAM_AUTONOMY=send",
    "node gates/deploy.mjs abc --approved",
    "claude plugin eval .",
  ]) {
    assert.equal(run(r, "Bash", { command: cmd }).code, 0, cmd);
  }
  assert.equal(run(r, "Read", { file_path: "tests/acceptance/x" }).code, 0);
  assert.equal(run(r, "Write", { file_path: ".git/config" }).code, 0);
});

test("a cstack env marker turns the Bash rules on without a config; path rules stay off", () => {
  const r = repo(null);
  for (const marker of ["CSTACK_ROLE", "CSTACK_RUN", "CSTACK_UNIT", "CSTACK_COORDINATOR"]) {
    const out = run(r, "Bash", { command: "gh pr merge 1" }, { [marker]: "1" });
    assert.equal(out.code, 2, marker);
    assert.match(out.err, /no-admin-merge/);
  }
  assert.equal(run(r, "Read", { file_path: "tests/acceptance/x" }, { CSTACK_RUN: "prog" }).code, 0);
});

test("a call from outside that targets a cstack repo is in context", () => {
  const r = repo();
  const elsewhere = repo(null);
  assert.equal(run(r, "Write", { file_path: path.join(r, ".cstack/config.json") }, {}, elsewhere).code, 2);
  assert.equal(run(r, "Read", { file_path: path.join(r, "tests/acceptance/e1.test.js") }, {}, elsewhere).code, 2);
  assert.equal(run(r, "Grep", { pattern: "x", path: path.join(r, "src") }, {}, elsewhere).code, 0);
  for (const cmd of [`cd ${r} && gh pr merge 1`, `git -C "${r}" status; gh pr merge 1`, `(cd '${r}/src' && gh pr merge 1)`]) {
    const out = run(r, "Bash", { command: cmd }, {}, elsewhere);
    assert.equal(out.code, 2, cmd);
    assert.match(out.err, /no-admin-merge/);
  }
  assert.equal(run(r, "Bash", { command: "cd /tmp && gh pr merge 1" }, {}, elsewhere).code, 0);
  assert.equal(run(r, "Bash", { command: "cd ~ && ls" }, {}, elsewhere).code, 0);
});

test("paths match the same with either separator, and a name that starts with .. is inside the repo", () => {
  const r = repo();
  const slashed = r.split(path.sep).join("/");
  for (const p of [`${slashed}/tests/acceptance/e1.test.js`, path.join(r, "tests", "acceptance", "e1.test.js"), "tests/acceptance/../acceptance/e1.test.js"]) {
    assert.equal(run(r, "Read", { file_path: p }).code, 2, p);
  }
  for (const cmd of ["type tests\\acceptance\\e1.test.js", "cat tests\\acceptance/e1.test.js"]) {
    assert.match(run(r, "Bash", { command: cmd }).err, /hidden-paths/, cmd);
  }
  assert.equal(run(r, "Glob", { pattern: "tests\\acceptance\\*.js" }).code, 2);
  const dots = repo({ paths_hidden: [], paths_off_limits: ["..cache/**"] });
  assert.match(run(dots, "Write", { file_path: "..cache/x" }).err, /\.\.cache\/x is off limits/);
  assert.equal(run(dots, "Write", { file_path: "../outside/x" }).code, 0, "a parent path is not in the repo");
});

test("on Windows and macOS hidden and off-limits paths match in any case", () => {
  const r = repo();
  const folds = process.platform === "win32" || process.platform === "darwin";
  for (const [tool, input] of [
    ["Read", { file_path: "Tests/Acceptance/e1.test.js" }],
    ["Write", { file_path: ".GIT/config" }],
    ["Bash", { command: "cat TESTS/acceptance/e1.test.js" }],
  ]) {
    assert.equal(run(r, tool, input).code, folds ? 2 : 0, `${tool} ${JSON.stringify(input)}`);
  }
});

test("a config that does not parse blocks with a clear message", () => {
  const r = repo("{not json");
  const out = run(r, "Read", { file_path: "src/a.js" });
  assert.equal(out.code, 2);
  assert.match(out.err, /config/);
});

test("a config that does not parse can still be read, and nothing else opens up", () => {
  const r = repo("{not json");
  for (const file_path of [".cstack/config.json", path.join(r, ".cstack/config.json"), "src/../.cstack/config.json"]) {
    assert.equal(run(r, "Read", { file_path }).code, 0, file_path);
  }
  for (const [tool, input] of [
    ["Edit", { file_path: ".cstack/config.json" }],
    ["Write", { file_path: ".cstack/config.json" }],
    ["Read", { file_path: "tests/acceptance/e1.test.js" }],
    ["Read", { file_path: ".cstack/config.json.bak" }],
    ["Grep", { pattern: "x", path: ".cstack/config.json" }],
    ["Bash", { command: "ls" }],
  ]) {
    const out = run(r, tool, input);
    assert.equal(out.code, 2, `${tool} ${JSON.stringify(input)}`);
    assert.match(out.err, /does not parse/);
  }
});

test("an agent is told a person must fix a config that does not parse", () => {
  const out = run(repo("{not json"), "Bash", { command: "ls" });
  assert.match(out.err, /a person must fix/i);
  assert.match(out.err, /Read/);
});

function runAs(root, agent_id, tool_input) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input, cwd: root, ...(agent_id ? { agent_id } : {}) }),
    env: { ...process.env, CSTACK_ROLE: "", CSTACK_RUN: "", CSTACK_UNIT: "", CSTACK_COORDINATOR: "", CSTACK_HEADLESS: "" },
    encoding: "utf8",
  });
  return { code: r.status, err: r.stderr };
}

test("a subagent may not start a background command, because it dies when the subagent finishes", () => {
  const r = repo();
  const out = runAs(r, "a1", { command: "node gates/run-tests.mjs .", run_in_background: true });
  assert.equal(out.code, 2);
  assert.match(out.err, /no-subagent-background/);
  assert.match(out.err, /foreground/);
});

test("a subagent may run in the foreground, and the main session may run in the background", () => {
  const r = repo();
  assert.equal(runAs(r, "a1", { command: "node gates/run-tests.mjs ." }).code, 0);
  assert.equal(runAs(r, "a1", { command: "node gates/run-tests.mjs .", run_in_background: false }).code, 0);
  assert.equal(runAs(r, null, { command: "node gates/run-tests.mjs .", run_in_background: true }).code, 0);
});

test("a headless session cstack launched must run its subagents in the foreground, because -p ends with the turn", () => {
  const r = repo();
  const spawn = { subagent_type: "cstack:cstack-worker", description: "T2", prompt: "GOAL ..." };
  const headless = { CSTACK_HEADLESS: "1" };
  for (const env of [{ ...headless, CSTACK_UNIT: "U2", CSTACK_RUN: "prog" }, { ...headless, CSTACK_COORDINATOR: "1" }, { ...headless, CSTACK_ROLE: "e2e-author" }]) {
    for (const [tool, input] of [
      ["Agent", spawn],
      ["Agent", { ...spawn, run_in_background: true }],
      ["Task", spawn],
    ]) {
      const out = run(r, tool, input, env);
      assert.equal(out.code, 2, `${tool} ${JSON.stringify(input)} ${JSON.stringify(env)}`);
      assert.match(out.err, /headless-foreground-agents.*run_in_background: false/);
    }
    assert.equal(run(r, "Agent", { ...spawn, run_in_background: false }, env).code, 0);
  }
  assert.equal(run(r, "Agent", spawn).code, 0, "an ordinary session keeps background agents");
  assert.equal(run(r, "Agent", spawn, { CSTACK_COORDINATOR: "1", CSTACK_RUN: "prog" }).code, 0, "an interactive coordinator (CSTACK_COORDINATOR=1 claude) keeps background agents");
  assert.equal(run(r, "Agent", spawn, { CSTACK_UNIT: "U2", CSTACK_ROLE: "e2e-author" }).code, 0, "role markers without the headless marker");
  assert.equal(run(r, "Agent", spawn, { CSTACK_HEADLESS: "0" }).code, 0, "only 1 means headless");
  const outside = mkdtempSync(path.join(tmpdir(), "cstack-guard-plain-"));
  assert.equal(run(outside, "Agent", spawn, headless).code, 2, "the headless marker alone makes a cstack context");
});

test("malformed hook input never blocks", () => {
  const r = spawnSync(process.execPath, [GUARD], { input: "not json", encoding: "utf8" });
  assert.equal(r.status, 0);
});

// Codex payloads: edits arrive as apply_patch with the patch text in tool_input.command.
const patch = (...lines) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

test("apply_patch: hidden, off-limits and config paths are blocked, ordinary edits pass", () => {
  const r = repo();
  const ok = run(r, "apply_patch", { command: patch(`*** Add File: ${path.join(r, "src/a.js")}`, "+x", `*** Update File: ${path.join(r, "src/b.js")}`, "@@", "-a", "+b") });
  assert.equal(ok.code, 0, ok.err);
  for (const [lines, rule] of [
    [[`*** Update File: ${path.join(r, "tests/acceptance/e1.test.js")}`, "@@", "-a", "+b"], /hidden-paths/],
    [["*** Add File: tests/acceptance/new.test.js", "+x"], /hidden-paths/],
    [[`*** Update File: ${path.join(r, "src/a.js")}`, `*** Move to: ${path.join(r, "tests/acceptance/a.js")}`], /hidden-paths/],
    [[`*** Delete File: ${path.join(r, ".github/workflows/ci.yml")}`], /off-limits/],
    [[`*** Update File: ${path.join(r, ".cstack/config.json")}`, "@@", "-a", "+b"], /off-limits/],
  ]) {
    const out = run(r, "apply_patch", { command: patch(...lines) });
    assert.equal(out.code, 2, lines.join(" | "));
    assert.match(out.err, rule);
  }
});

test("apply_patch: the e2e author writes only inside paths_hidden", () => {
  const r = repo();
  const env = { CSTACK_ROLE: "e2e-author" };
  assert.equal(run(r, "apply_patch", { command: patch("*** Add File: tests/acceptance/e1.test.js", "+x") }, env).code, 0);
  const out = run(r, "apply_patch", { command: patch("*** Add File: src/x.js", "+x") }, env);
  assert.equal(out.code, 2);
  assert.match(out.err, /may write only inside paths_hidden/);
});

test("apply_patch: outside a cstack context, or with an empty or array input, nothing is blocked", () => {
  const plain = mkdtempSync(path.join(tmpdir(), "cstack-guard-plain-"));
  assert.equal(run(plain, "apply_patch", { command: patch(`*** Add File: ${path.join(plain, ".git/x")}`, "+x") }).code, 0);
  const r = repo();
  assert.equal(run(r, "apply_patch", {}).code, 0);
  const arr = run(r, "apply_patch", { command: ["*** Begin Patch", "*** Add File: tests/acceptance/a.js", "*** End Patch"] });
  assert.equal(arr.code, 2);
});

test("under Codex the guard marks the session as seen, only in a cstack context", async () => {
  const { existsSync } = await import("node:fs");
  const seen = (id) => path.join(tmpdir(), "cstack-hook-seen", id);
  const id = `test-${process.pid}-${Date.now()}`;
  const r = repo();
  const send = (cwd, extra) =>
    spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, cwd, ...extra }), encoding: "utf8", env: { ...process.env, CSTACK_ROLE: "", CSTACK_RUN: "", CSTACK_UNIT: "", CSTACK_COORDINATOR: "" } });
  send(r, { session_id: `${id}-claude` });
  assert.equal(existsSync(seen(`${id}-claude`)), false, "Claude Code payloads have no turn_id");
  send(mkdtempSync(path.join(tmpdir(), "cstack-guard-plain-")), { session_id: `${id}-plain`, turn_id: "t" });
  assert.equal(existsSync(seen(`${id}-plain`)), false, "outside a cstack context");
  send(r, { session_id: "../evil", turn_id: "t" });
  assert.equal(existsSync(path.join(tmpdir(), "evil")), false);
  assert.equal(send(r, { session_id: id, turn_id: "t" }).status, 0);
  assert.equal(existsSync(seen(id)), true);
});

test("role-deny: a Codex session cstack launched gets its role's Bash deny rules; others do not", () => {
  const r = repo();
  const codex = (command, env) =>
    spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: r, turn_id: "t", session_id: `rd-${process.pid}` }), encoding: "utf8", env: { ...process.env, CSTACK_ROLE: "", CSTACK_RUN: "", CSTACK_UNIT: "", CSTACK_COORDINATOR: "", ...env } });
  const worker = { CSTACK_UNIT: "U1" };
  // permissions.mjs writes its plugin-script rules with POSIX paths, so on Windows they cannot match a drive path yet.
  const supervise = process.platform === "win32" ? [] : [`node ${path.resolve(GUARD, "../../../gates/supervise.mjs")} start --name a`];
  for (const cmd of ["sudo ls", "git status && git push --force origin x", "FOO=1 curl https://x", "codex exec hi", "claude -p hi", "rm -rf /", ...supervise]) {
    const out = codex(cmd, worker);
    assert.equal(out.status, 2, cmd);
    assert.match(out.stderr, /cstack role-deny: .* is denied to the worker role/);
  }
  for (const cmd of ["git push origin x", "gh pr view 3", "npm test", "ls -la"]) assert.equal(codex(cmd, worker).status, 0, cmd);
  // Only a person resolves a human gate: a worker and a headless coordinator are refused, whatever the form.
  const orch = path.resolve(GUARD, "../../../gates/orch.mjs");
  const resolve = process.platform === "win32" ? [] : [`node ${orch} --store /s gate resolve PROTO --answer approve`, `node ${orch} gate resolve H2 --answer approve`, `node --no-warnings ${orch} --store /s gate resolve PROTO --answer approve`, `FOO=1 ${orch} --store /s gate resolve PROTO --answer approve`, "node gates/orch.mjs --store /s gate resolve PROTO --answer approve", "node /home/x/other-cstack/gates/orch.mjs gate resolve PROTO --answer approve", "node ../cstack/gates/orch.mjs --store /s gate resolve PROTO --answer approve", "cd gates && node orch.mjs gate resolve PROTO --answer approve"];
  for (const env of [worker, { CSTACK_COORDINATOR: "1" }]) {
    for (const cmd of resolve) {
      const out = codex(cmd, env);
      assert.equal(out.status, 2, cmd);
      assert.match(out.stderr, /cstack role-deny: .*gate resolve.* is denied to the (worker|coordinator) role/);
    }
    if (resolve.length) assert.equal(codex(`node ${orch} --store /s gate park PROTO --question q --options approve|reject --default reject`, env).status, 0, "parking a gate stays allowed");
    for (const cmd of ['git commit -m "Hold units until a person runs gate resolve"', 'gh pr create --title t --body "the human runs gate resolve <id>"']) assert.equal(codex(cmd, env).status, 0, cmd);
  }
  if (resolve.length) {
    assert.equal(codex(`node ${orch} --store /s gate  resolve PROTO --answer approve`, worker).status, 2, "extra spaces are folded");
    // A config allow longer than the literal plugin-path deny does not override the absolute orch.mjs catch-all.
    const lr = repo({ permissions_allow: [`Bash(node ${orch} --store /s gate *)`] });
    const out = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: `node ${orch} --store /s gate resolve PROTO --answer approve` }, cwd: lr, turn_id: "t", session_id: `rd2-${process.pid}` }), encoding: "utf8", env: { ...process.env, CSTACK_ROLE: "", CSTACK_RUN: "", CSTACK_UNIT: "U1", CSTACK_COORDINATOR: "" } });
    assert.equal(out.status, 2, out.stderr);
    assert.match(out.stderr, /\(Bash\(\*[^)]*gate resolve/, "an absolute `*`-leading rule blocked it");
  }
  assert.equal(codex("systemd-run --user x", { CSTACK_COORDINATOR: "1" }).status, 0, "a coordinator may start sessions");
  assert.equal(codex("sudo ls", {}).status, 0, "no role marker: not a cstack-launched session");
  assert.equal(codex("sudo ls", { CSTACK_ROLE: "nobody" }).status, 0, "an unknown role has no deny list");
  const claude = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "sudo ls" }, cwd: r }), encoding: "utf8", env: { ...process.env, CSTACK_UNIT: "U1", CSTACK_ROLE: "" } });
  assert.equal(claude.status, 0, "Claude Code sessions have their allowlist instead");
});

test("CSTACK_GUARD_HIDE hides paths outside the repo from Bash and file tools", () => {
  const r = repo();
  const h = path.resolve(tmpdir(), "opt-cstack", "tests");
  const slashed = h.split(path.sep).join("/"); // how a Bash command on Windows often spells it
  const hide = { CSTACK_GUARD_HIDE: h };
  for (const [tool, input] of [
    ["Bash", { command: `cat ${slashed}/fixtures/f1/grader/g.test.js` }],
    ["Bash", { command: `type ${path.join(h, "fixtures", "g.test.js")}` }],
    ["Read", { file_path: path.join(h, "x") }],
    ["Read", { file_path: `${slashed}/x` }],
    ["Grep", { pattern: "G1", path: h }],
    ["apply_patch", { command: `*** Begin Patch\n*** Add File: ${slashed}/y\n+x\n*** End Patch` }],
  ]) {
    const out = run(r, tool, input, hide);
    assert.equal(out.code, 2, `${tool} ${JSON.stringify(input)}`);
    assert.match(out.err, /hidden from this run/);
  }
  assert.equal(run(r, "Read", { file_path: `${h}suite` }, hide).code, 0, "a sibling with the same prefix");
  assert.equal(run(r, "Read", { file_path: path.join(h, "x") }).code, 0, "unset: nothing extra hidden");
});

test("a hidden glob written with backslashes still blocks a command naming it", () => {
  const r = repo({ paths_hidden: ["tests\\acceptance/**"] });
  assert.equal(run(r, "Bash", { command: "cat tests\\acceptance/x" }).code, 2);
  assert.equal(run(r, "Bash", { command: "cat tests/acceptance/x" }).code, 2);
});

test("role-deny: an allow rule more specific than a broad deny wins", () => {
  const r = repo();
  const codex = (command, env) =>
    spawnSync("node", [GUARD], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: r, turn_id: "t", session_id: `rd2-${process.pid}` }), encoding: "utf8", env: { ...process.env, CSTACK_ROLE: "", CSTACK_RUN: "", CSTACK_UNIT: "", CSTACK_COORDINATOR: "", ...env } });
  assert.equal(codex("rm -rf /tmp/cstack-mutation/x", { CSTACK_ROLE: "e2e-author" }).status, 0, "the author's own scratch cleanup");
  assert.equal(codex("rm -rf /tmp/cstack-run-1", { CSTACK_UNIT: "U1" }).status, 0, "a worker's tmp cleanup");
  assert.equal(codex("rm -rf /etc", { CSTACK_UNIT: "U1" }).status, 2, "the broad deny still holds elsewhere");
  assert.equal(codex("rm -rf /", { CSTACK_UNIT: "U1" }).status, 2);
});

test("role-deny under Codex: a role-keyed permissions_allow rule reaches only its role", () => {
  const r = repo({ paths_hidden: [], permissions_allow: { "e2e-author": ["Bash(curl https://api.example.com *)"] } });
  const codex = (command, env) =>
    spawnSync("node", [GUARD], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: r, turn_id: "t", session_id: `rd4-${process.pid}` }), encoding: "utf8", env: { ...process.env, CSTACK_ROLE: "", CSTACK_RUN: "", CSTACK_UNIT: "", CSTACK_COORDINATOR: "", ...env } });
  const cmd = "curl https://api.example.com -s";
  assert.equal(codex(cmd, { CSTACK_ROLE: "e2e-author" }).status, 0, "the named role");
  assert.equal(codex(cmd, { CSTACK_UNIT: "U1" }).status, 2, "a worker still has curl denied");
  assert.equal(codex(cmd, { CSTACK_COORDINATOR: "1" }).status, 2, "so does the coordinator");
  assert.equal(codex("curl https://other.example.com", { CSTACK_ROLE: "e2e-author" }).status, 2, "only the named command");
});

test("no-admin-merge covers GitLab: glab mr merge, auto-merge and the merge endpoint", () => {
  const r = repo();
  for (const command of ["glab mr merge 3", "glab mr merge 3 --sha abc --auto-merge=false", "glab mr update 3 --auto-merge", "glab mr create --fill --auto-merge", "glab api -X PUT projects/1/merge_requests/3/merge", "glab api -X PUT projects%2Fg%2Fapp%2Fmerge_requests%2F3%2Fmerge"]) {
    const out = run(r, "Bash", { command });
    assert.equal(out.code, 2, command);
    assert.match(out.err, /no-admin-merge/);
  }
  for (const command of ["glab mr view 3", "glab mr update 3 --title x", "glab api projects/1/merge_requests/3"]) assert.equal(run(r, "Bash", { command }).code, 0, command);
});

test("no-admin-merge: a push or ref update of the base branch is a merge that skipped the gate", () => {
  const r = repo({ paths_hidden: [], base_branch: "main" });
  for (const command of ["git push origin main", "git push origin HEAD:main", "git push origin HEAD:refs/heads/main", "git -C /x push --force-with-lease origin feat:main", "cd /x && git push origin main", "git update-ref refs/heads/main abc"]) {
    const out = run(r, "Bash", { command });
    assert.equal(out.code, 2, command);
    assert.match(out.err, /moves the base branch main/);
  }
  for (const command of ["git push origin cstack/u1", "git push -u origin feat", "git push origin main-backup", "git update-ref refs/heads/feat abc", "git log main"]) assert.equal(run(r, "Bash", { command }).code, 0, command);
  const trunk = repo({ paths_hidden: [], base_branch: "trunk" });
  assert.equal(run(trunk, "Bash", { command: "git push origin trunk" }).code, 2);
  assert.equal(run(trunk, "Bash", { command: "git push origin main" }).code, 0);
  const plain = repo({ paths_hidden: [] });
  assert.equal(run(plain, "Bash", { command: "git push origin main" }).code, 2, "base_branch defaults to main");
});

test("role-deny under Codex: rm -rf anywhere under / stays refused, except the role's scratch", () => {
  const r = repo();
  const codex = (command) => spawnSync("node", [GUARD], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: r, turn_id: "t", session_id: `rd3-${process.pid}` }), encoding: "utf8", env: { ...process.env, CSTACK_ROLE: "", CSTACK_RUN: "", CSTACK_COORDINATOR: "", CSTACK_UNIT: "U1" } });
  for (const command of ["rm -rf /*", "rm -rf /tmp/other", "rm -rf /data"]) assert.equal(codex(command).status, 2, command);
  assert.equal(codex("rm -rf /tmp/cstack-x").status, 0);
});

test("role-deny: every role may save the final e2e report with run-e2e --out under Codex", () => {
  const r = repo();
  const gates = path.resolve(GUARD, "../../../gates");
  const command = `node ${gates}/run-e2e.mjs ${r} --sha abc --json --out ${r}/.cstack/runs/p/final-e2e-0123456789ab.json`;
  for (const env of [{ CSTACK_UNIT: "U1" }, { CSTACK_COORDINATOR: "1" }, { CSTACK_ROLE: "grader" }]) {
    const out = spawnSync("node", [GUARD], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: r, turn_id: "t", session_id: `rd5-${process.pid}` }), encoding: "utf8", env: { ...process.env, CSTACK_ROLE: "", CSTACK_RUN: "", CSTACK_COORDINATOR: "", CSTACK_UNIT: "", ...env } });
    assert.equal(out.status, 0, `${JSON.stringify(env)}: ${out.stderr}`);
  }
});

test("role-deny: a Codex coordinator may check the login, and start no session", () => {
  const r = repo();
  const codex = (command, env) => spawnSync("node", [GUARD], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: r, turn_id: "t", session_id: `rd4-${process.pid}` }), encoding: "utf8", env: { ...process.env, CSTACK_ROLE: "", CSTACK_RUN: "", CSTACK_COORDINATOR: "", CSTACK_UNIT: "", ...env } });
  assert.equal(codex("codex login status", { CSTACK_COORDINATOR: "1" }).status, 0);
  assert.equal(codex("codex exec hi", { CSTACK_COORDINATOR: "1" }).status, 2);
  assert.equal(codex("codex login", { CSTACK_COORDINATOR: "1" }).status, 2);
  assert.equal(codex("codex login status", { CSTACK_UNIT: "U1" }).status, 2, "a worker has no need of it");
});

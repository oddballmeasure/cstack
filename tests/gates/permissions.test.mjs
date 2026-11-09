import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { makeRepo, gate, path, ROOT } from "./helpers.mjs";
import { ROLES, NETWORK_COMMANDS, opensNetwork, permissionSettings, permissionsAllowErrors, worktreeRoot, deniedCalls } from "../../gates/lib/permissions.mjs";

// permissions.mjs builds its rules from POSIX paths. On Windows a drive path needs its own rule form, not built yet.
const WIN_PERMS = { skip: process.platform === "win32" && "permissions.mjs builds rules from POSIX paths; Windows needs its own rule form" };
const HOME = "/home/u";
const opts = (config = {}, extra = {}) => ({
  pluginRoot: "/opt/cstack",
  repoRoot: "/src/app",
  home: HOME,
  config: { repo: "o/app", test_command: ["npm", "test"], paths_hidden: ["tests/acceptance/**"], ...config },
  ...extra,
});
const perms = (role, config, extra) => permissionSettings(role, opts(config, extra)).permissions;
const WT = "//home/u/.local/state/cstack/worktrees/o-app";

test("every role runs in dontAsk with bypass disabled and the shared deny list", WIN_PERMS, () => {
  assert.deepEqual(ROLES, ["worker", "coordinator", "e2e-author", "grader"]);
  for (const role of ROLES) {
    const p = perms(role, {}, { worktree: "/wt/e2e" });
    assert.equal(p.defaultMode, "dontAsk", role);
    assert.equal(p.disableBypassPermissionsMode, "disable", role);
    for (const rule of ["Bash(curl *)", "Bash(ssh *)", "Bash(sudo *)", "Bash(claude *)", "Bash(gh pr merge *)", "Bash(git push --force *)", "WebFetch", "Read(~/.ssh/**)", "Edit(//src/app/.cstack/config.json)"]) {
      assert.ok(p.deny.includes(rule), `${role} denies ${rule}`);
    }
    assert.ok(!p.allow.some((r) => /dangerously|bypass/i.test(r)), role);
    assert.equal(new Set(p.allow).size, p.allow.length, `${role} has no duplicate rules`);
    assert.ok(p.allow.includes("Read(//opt/cstack/**)") && p.allow.includes("Edit(//src/app/.cstack/runs/**)"), role);
  }
});

test("every role may save the final e2e report with run-e2e --out, and no rule denies it", WIN_PERMS, () => {
  const command = "node /opt/cstack/gates/run-e2e.mjs /src/app --sha abc --json --out /src/app/.cstack/runs/p/final-e2e-0123456789ab.json";
  const matches = (rule) => rule.startsWith("Bash(") && new RegExp(`^${rule.slice(5, -1).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`).test(command);
  for (const role of ROLES) {
    const p = perms(role, {}, { worktree: "/wt/e2e" });
    assert.ok(p.allow.some(matches), `${role} allows ${command}`);
    assert.ok(!p.deny.some(matches), `${role} denies nothing in ${command}`);
  }
});

test("no headless role may resolve a human gate, in any command form; parking and listing stay allowed", WIN_PERMS, () => {
  // Claude Code's own matching: a deny beats every allow, `*` matches anything, and leading assignments are skipped.
  const matches = (rule, cmd) => new RegExp(`^${rule.slice(5, -1).split("*").map((t) => t.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(cmd);
  const resolve = [
    "node /opt/cstack/gates/orch.mjs --store /s gate resolve PROTO --answer approve",
    "node /opt/cstack/gates/orch.mjs gate resolve H2 --answer approve",
    "node --no-warnings /opt/cstack/gates/orch.mjs --run r gate resolve PROTO --answer approve",
    "/opt/cstack/gates/orch.mjs --store /s gate resolve PROTO --answer approve",
    "node gates/orch.mjs --store /s gate resolve PROTO --answer approve",
    "node ./gates/orch.mjs gate resolve PROTO --answer approve",
    "node /home/x/other-cstack/gates/orch.mjs --store /s gate resolve PROTO --answer approve",
    "node ../cstack/gates/orch.mjs gate resolve PROTO --answer approve",
    "node orch.mjs gate resolve PROTO --answer approve",
    "node orch.mjs --store /s gate resolve PROTO --answer approve",
    "node /opt/cstack/gates/orch.mjs gate --json resolve PROTO --answer approve",
    "node /opt/cstack/gates/orch.mjs --store /s gate --force resolve PROTO --answer approve",
    "node orch.mjs gate --store /s resolve H2 --answer approve",
  ];
  for (const role of ROLES) {
    const deny = perms(role, {}, { worktree: "/wt/e2e" }).deny.filter((r) => r.includes("orch.mjs") && r.includes("resolve"));
    for (const cmd of resolve) assert.ok(deny.some((r) => matches(r, cmd)), `${role} refuses ${cmd}`);
    for (const cmd of ['git commit -m "Hold units until a person runs gate resolve"', 'gh pr create --body "run gate resolve <id> --answer approve"', "node /opt/cstack/gates/orch.mjs --store /s gate list", "node /opt/cstack/gates/orch.mjs --store /s gate park PROTO --question q --options approve|reject --default reject"]) {
      assert.ok(!deny.some((r) => matches(r, cmd)), `${role} may run ${cmd}`);
    }
  }
});

test("no headless role may remove a standing order, in any command form; adding and showing stay allowed", WIN_PERMS, () => {
  const matches = (rule, cmd) => new RegExp(`^${rule.slice(5, -1).split("*").map((t) => t.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(cmd);
  const remove = [
    "node /opt/cstack/gates/orch.mjs --store /s standing remove 1",
    "node /opt/cstack/gates/orch.mjs standing remove 2",
    "node --no-warnings /opt/cstack/gates/orch.mjs --run r standing remove 1",
    "/opt/cstack/gates/orch.mjs --store /s standing remove 1",
    "node gates/orch.mjs --store /s standing remove 1",
    "node ./gates/orch.mjs standing remove 1",
    "node ../cstack/gates/orch.mjs standing remove 1",
    "node orch.mjs standing remove 1",
    "node /opt/cstack/gates/orch.mjs standing --json remove 1",
    "node /opt/cstack/gates/orch.mjs --store /s standing --force remove 1",
    "node orch.mjs standing --store /s remove 1",
  ];
  for (const role of ROLES) {
    const deny = perms(role, {}, { worktree: "/wt/e2e" }).deny.filter((r) => r.includes("orch.mjs") && r.includes("remove"));
    for (const cmd of remove) assert.ok(deny.some((r) => matches(r, cmd)), `${role} refuses ${cmd}`);
    for (const cmd of ["node /opt/cstack/gates/orch.mjs --store /s standing show", 'node /opt/cstack/gates/orch.mjs --store /s standing add "STOP: paused"', 'git commit -m "Tell the human to run standing remove"']) {
      assert.ok(!deny.some((r) => matches(r, cmd)), `${role} may run ${cmd}`);
    }
  }
});

test("no headless role may edit a store's gates.md or preferences.md as a file", WIN_PERMS, () => {
  // Gitignore-style globs, as Claude Code reads Edit rules: `**/` is any number of directories, `*` stays in one.
  const glob = (g) => g.split("**/").map((part) => part.split("*").map((t) => t.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join("(?:.*/)?");
  const matches = (rule, file) => new RegExp(`^${glob(rule.slice(5, -1)).replace(/\[\^\/\]\*\[\^\/\]\*$/, ".*")}$`).test(file);
  const files = ["//src/app/.cstack/runs/r1/gates.md", "//src/app/.cstack/runs/issue-7/preferences.md", "//tmp/cstack-store-x/gates.md", "//tmp/cstack-run/r1/preferences.md"];
  for (const role of ROLES) {
    const p = perms(role, {}, { worktree: "/wt/e2e" });
    const deny = p.deny.filter((r) => r.startsWith("Edit("));
    for (const f of files) {
      assert.ok(deny.some((r) => matches(r, f)), `${role} may not edit ${f}`);
      assert.ok(p.allow.some((r) => r.startsWith("Edit(") && matches(r, f)), `the deny, not a missing allow, refuses ${f} for ${role}`);
    }
    for (const f of ["//src/app/.cstack/runs/r1/units.tsv", "//src/app/.cstack/runs/r1/decisions.tsv", "//tmp/cstack-store-x/inbox/1.json"]) {
      assert.ok(!deny.some((r) => matches(r, f)), `${role} may edit ${f}`);
    }
  }
});

test("worker edits only the repo's worktrees and the run store, and runs the configured commands", WIN_PERMS, () => {
  const p = perms("worker");
  assert.ok(p.allow.includes(`Edit(${WT}/**)`));
  assert.ok(p.allow.includes("Edit(//src/app/.cstack/profile.json)"));
  assert.ok(!p.allow.some((r) => r === "Edit(//src/app/**)"), "the main checkout is not writable");
  for (const rule of ["Bash(git *)", "Bash(gh *)", "Bash(glab *)", "Bash(node *)", "Bash(npm test)", "Bash(npm test *)", "Bash(npm install *)", "Bash(npx playwright *)", "Bash(sh /opt/cstack/skills/*)", "Agent", "Monitor"]) {
    assert.ok(p.allow.includes(rule), rule);
  }
  assert.ok(p.deny.includes("Bash(systemd-run *)"), "a worker launches no detached session");
  for (const rule of ["Bash(glab mr merge *)", "Bash(glab auth *)", "Read(~/.config/glab-cli/**)", "Bash(rm -rf /)", "Bash(rm -rf /etc*)", "Bash(rm -rf /home*)"]) assert.ok(p.deny.includes(rule), rule);
  // Claude Code reads the * as a wildcard and a deny beats an allow, so this rule would refuse /tmp/cstack-* cleanup.
  assert.ok(!p.deny.includes("Bash(rm -rf /*)"));
  assert.ok(p.allow.includes("Bash(rm -rf /tmp/cstack-*)"));
  for (const rule of ["Bash(printenv CSTACK_*)", "Bash(command -v *)"]) assert.ok(p.allow.includes(rule), rule);
  assert.ok(!p.allow.includes("Bash(printenv *)"), "other variables may hold secrets");
  assert.ok(!p.deny.some((r) => r.startsWith("Bash(rm -rf /tmp")));
  for (const c of ["start", "stop", "daemon-run"]) assert.ok(p.deny.includes(`Bash(node /opt/cstack/gates/supervise.mjs ${c} *)`), c);
  assert.ok(p.allow.includes("Bash(CSTACK_ROLE=grader node *)"), "verifiers run the suite as the grader");
  assert.ok(!p.allow.some((r) => r.startsWith("Bash(systemctl --user stop")));
});

test("every role gets the repo's unit worktrees as a working directory, so shell commands there are not refused", WIN_PERMS, () => {
  const root = "/home/u/.local/state/cstack/worktrees/o-app";
  for (const role of ROLES) {
    const extra = role === "e2e-author" ? { worktree: "/wt/e2e" } : {};
    const dirs = permissionSettings(role, opts({}, extra)).permissions.additionalDirectories;
    assert.deepEqual(dirs, role === "e2e-author" ? [root, "/wt/e2e"] : [root], role);
  }
});

test("coordinator adds the e2e author launch and stopping cstack units, and may run systemd-run", () => {
  const p = perms("coordinator");
  assert.ok(p.allow.includes("Bash(systemd-run --user --collect --quiet --unit=cstack-e2e-*)"));
  assert.ok(p.allow.includes("Bash(systemctl --user stop cstack-*)"));
  assert.ok(p.allow.includes("Bash(codex login status)"));
  assert.ok(!p.deny.includes("Bash(systemd-run *)"));
  assert.ok(!p.deny.some((r) => r.includes("supervise.mjs")), "the coordinator starts and stops sessions");
  for (const rule of perms("worker").allow) assert.ok(p.allow.includes(rule), `coordinator keeps ${rule}`);
});

test("e2e-author edits only inside paths_hidden of its worktree, and needs the worktree", WIN_PERMS, () => {
  const p = perms("e2e-author", { paths_hidden: ["tests/acceptance/**", "./e2e/**"] }, { worktree: "/wt/e2e" });
  assert.ok(p.allow.includes("Edit(//wt/e2e/tests/acceptance/**)"));
  assert.ok(p.allow.includes("Edit(//wt/e2e/e2e/**)"));
  assert.ok(p.allow.includes("Read(//wt/e2e/**)"));
  for (const rule of ["Bash(CSTACK_ROLE=e2e-author git *)", "Bash(CSTACK_ROLE=e2e-author npm test)", "Bash(CSTACK_ROLE=e2e-author cat *)", "Bash(CSTACK_ROLE=grader node *)"]) assert.ok(p.allow.includes(rule), rule);
  assert.ok(!p.allow.some((r) => r.startsWith("Bash(CSTACK_ROLE=e2e-author Edit")), "only Bash rules are prefixed");
  assert.ok(!p.allow.some((r) => r.startsWith(`Edit(${WT}`)), "no edits elsewhere in the worktrees");
  assert.ok(!p.allow.includes("Edit(//wt/e2e/**)"));
  assert.deepEqual(perms("e2e-author", { paths_hidden: "nope" }, { worktree: "/wt/e2e" }).allow.filter((r) => r.startsWith("Edit(//wt/")), []);
  assert.throws(() => perms("e2e-author"), /needs its worktree/);
});

test("grader reads, runs gates and the suite, and writes only to the store", WIN_PERMS, () => {
  const p = perms("grader", { e2e_command: ["./scripts/e2e.sh"] });
  assert.ok(p.allow.includes("Bash(node /opt/cstack/*)"));
  assert.ok(p.allow.includes("Bash(./scripts/e2e.sh *)"));
  assert.ok(p.allow.includes("Bash(gh pr checks *)"));
  assert.ok(p.allow.includes("Bash(CSTACK_ROLE=grader ./scripts/e2e.sh *)") && p.allow.includes("Bash(CSTACK_ROLE=grader node /opt/cstack/*)"));
  for (const rule of ["Bash(git *)", "Bash(gh *)", "Bash(glab *)", "Bash(node *)", "Agent", `Edit(${WT}/**)`]) assert.ok(!p.allow.includes(rule), rule);
  // It reads the forge through gates/forge.mjs, but its write verbs are denied.
  for (const v of ["change create", "issue comment", "thread reply", "labels ensure"]) assert.ok(p.deny.includes(`Bash(node /opt/cstack/gates/forge.mjs ${v} *)`), v);
  assert.ok(!perms("worker").deny.some((r) => r.includes("forge.mjs")));
});

test("repo commands: setup and e2e commands, other package managers, non-JS tools, and config extras", () => {
  const p = perms("worker", { setup_command: ["pnpm", "install"], test_command: ["pnpm", "test"], e2e_command: null, permissions_allow: ["Bash(make lint)"] });
  for (const rule of ["Bash(pnpm install)", "Bash(pnpm install *)", "Bash(pnpm run *)", "Bash(pnpm ci *)", "Bash(make lint)", "Bash(npx playwright *)"]) {
    assert.ok(p.allow.includes(rule), rule);
  }
  assert.ok(!p.allow.includes("Bash(npm install *)"));
  const py = perms("worker", { test_command: ["uv", "run", "pytest", "-q"], permissions_allow: "nope" });
  assert.ok(py.allow.includes("Bash(uv run pytest -q)") && py.allow.includes("Bash(uv run pytest -q *)"));
  assert.ok(!py.allow.includes("Bash(npx playwright *)"), "no JS package manager, no playwright");
  assert.ok(!perms("worker", { test_command: [] }).allow.some((r) => r.startsWith("Bash(npm")));
});

test("permissions_allow as a list reaches the worker, coordinator and e2e-author; as an object, only the named role", WIN_PERMS, () => {
  const all = (role, allow) => perms(role, { permissions_allow: allow }, { worktree: "/wt/e2e" }).allow;
  for (const role of ["worker", "coordinator", "e2e-author"]) assert.ok(all(role, ["Bash(make lint)"]).includes("Bash(make lint)"), role);
  assert.ok(!all("grader", ["Bash(make lint)"]).includes("Bash(make lint)"), "the list form never reached the grader");
  const keyed = { "e2e-author": ["Bash(agent-browser *)"], grader: ["Bash(make report)"] };
  assert.ok(all("e2e-author", keyed).includes("Bash(agent-browser *)"));
  assert.ok(all("e2e-author", keyed).includes("Bash(CSTACK_ROLE=e2e-author agent-browser *)"), "behind the author's role prefix too");
  for (const role of ["worker", "coordinator", "grader"]) assert.ok(!all(role, keyed).some((r) => r.includes("agent-browser")), role);
  assert.ok(all("grader", keyed).includes("Bash(make report)") && all("grader", keyed).includes("Bash(CSTACK_ROLE=grader make report)"));
  assert.ok(!all("worker", keyed).includes("Bash(make report)"));
  assert.ok(!all("worker", { worker: "nope" }).includes("nope"), "a malformed list adds nothing");
});

test("permissionsAllowErrors accepts a rule list or a role-keyed object, and names unknown roles", () => {
  assert.deepEqual(permissionsAllowErrors({}), []);
  assert.deepEqual(permissionsAllowErrors({ permissions_allow: null }), []);
  assert.deepEqual(permissionsAllowErrors({ permissions_allow: ["Bash(make lint)", "Monitor"] }), []);
  assert.deepEqual(permissionsAllowErrors({ permissions_allow: { worker: [], "e2e-author": ["Bash(agent-browser *)"], grader: ["Read"] } }), []);
  for (const bad of ["Bash(make lint)", ["make lint"], [3], ["Bash()"], 3]) {
    assert.match(permissionsAllowErrors({ permissions_allow: bad }).join(), /must be a list of permission rules .*or an object of such lists keyed by role/, JSON.stringify(bad));
  }
  assert.deepEqual(permissionsAllowErrors({ permissions_allow: { e2e_author: ["Bash(x)"], all: [], worker: ["x y"] } }), [
    "permissions_allow has unknown role e2e_author; roles are worker, coordinator, e2e-author, grader",
    "permissions_allow has unknown role all; roles are worker, coordinator, e2e-author, grader",
    "permissions_allow.worker must be a list of permission rules such as Bash(make check)",
  ]);
});

test("opensNetwork flags rules for network tools, directly or through a package runner", () => {
  for (const r of ["Bash(curl *)", "Bash(wget https://x)", "Bash(agent-browser *)", "Bash(npx playwright *)", "Bash(pnpm exec playwright test)", "Bash(gh api *)", "Bash(glab api projects)", "Bash(CSTACK_ROLE=e2e-author agent-browser open x)", "Bash(ssh)", "WebFetch", "WebSearch"]) {
    assert.ok(opensNetwork(r), r);
  }
  for (const r of ["Bash(make lint)", "Bash(gh pr view *)", "Bash(curling *)", "Bash", "Monitor", "Read(//x/**)", "Bash(npx tsc)"]) assert.ok(!opensNetwork(r), r);
  assert.ok(NETWORK_COMMANDS.includes("agent-browser") && NETWORK_COMMANDS.includes("gh api"));
});

test("unknown roles are refused, and worktreeRoot follows the skills' layout", WIN_PERMS, () => {
  assert.throws(() => perms("admin"), /unknown role admin/);
  assert.equal(worktreeRoot("/home/u", "o/app"), "/home/u/.local/state/cstack/worktrees/o-app");
});

test("deniedCalls lists each refused call from the result event", () => {
  assert.deepEqual(deniedCalls([]), []);
  assert.deepEqual(deniedCalls([{ type: "result" }]), []);
  const events = [
    null,
    { type: "result", permission_denials: [{ tool_name: "Bash", tool_input: { command: "curl  -s\nhttps://x" } }] },
    {
      type: "result",
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "curl -s https://x" } },
        { tool_name: "Edit", tool_input: { file_path: "/etc/hosts" } },
        { tool_name: "NotebookEdit", tool_input: { notebook_path: "/n.ipynb" } },
        { tool_name: "Grep", tool_input: { path: "/root" } },
        { tool_name: "WebFetch", tool_input: { url: "https://x" } },
        { tool_name: "Agent", tool_input: { prompt: "p" } },
        { tool_input: null },
        null,
      ],
    },
  ];
  assert.deepEqual(deniedCalls(events), [
    "Bash: curl -s https://x",
    "Edit: /etc/hosts",
    "NotebookEdit: /n.ipynb",
    "Grep: /root",
    "WebFetch: https://x",
    'Agent: {"prompt":"p"}',
    "?: {}",
    "?: {}",
  ]);
});

test("run-settings --permissions prints or writes a role's settings", WIN_PERMS, () => {
  const r = makeRepo();
  const out = gate("run-settings.mjs", ["--permissions", "worker", "--repo-dir", r.root]);
  assert.equal(out.code, 0, out.err);
  const s = JSON.parse(out.out);
  assert.equal(s.permissions.defaultMode, "dontAsk");
  assert.ok(s.permissions.allow.includes(`Read(/${ROOT}/**)`), "the plugin root defaults to this checkout");
  assert.ok(s.permissions.allow.includes(`Edit(/${worktreeRoot(os.homedir(), "o/r")}/**)`));
  assert.ok(s.permissions.allow.includes("Bash(sh ./scripts/test.sh)"));

  const file = path.join(r.base, "out/e2e.json");
  const w = gate("run-settings.mjs", ["--permissions", "e2e-author", "--repo-dir", r.root, "--worktree", path.join(r.base, "wt"), "--plugin-dir", "/opt/cstack", "--out", file]);
  assert.equal(w.code, 0, w.err);
  assert.equal(w.out.trim(), file);
  const e2e = JSON.parse(readFileSync(file, "utf8")).permissions;
  assert.ok(e2e.allow.includes(`Edit(/${path.join(r.base, "wt")}/tests/acceptance/**)`));
  assert.ok(e2e.allow.includes("Bash(node /opt/cstack/*)"));

  const cwd = gate("run-settings.mjs", ["--permissions", "grader"], { cwd: r.root });
  assert.equal(cwd.code, 0, cwd.err);
});

test("run-settings --permissions usage errors exit 2", () => {
  const r = makeRepo();
  assert.match(gate("run-settings.mjs", ["--permissions", "root", "--repo-dir", r.root]).err, /--permissions takes one of worker, coordinator, e2e-author, grader/);
  assert.match(gate("run-settings.mjs", ["--permissions", "e2e-author", "--repo-dir", r.root]).err, /needs --worktree/);
  assert.equal(gate("run-settings.mjs", ["--permissions", "worker", "extra"]).code, 2);
  assert.equal(gate("run-settings.mjs", []).code, 2, "neither --store nor --permissions");
  const typo = makeRepo({ permissions_allow: { e2e_author: ["Bash(agent-browser *)"] } });
  const refused = gate("run-settings.mjs", ["--permissions", "worker", "--repo-dir", typo.root]);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /permissions_allow has unknown role e2e_author; roles are worker, coordinator, e2e-author, grader/);
  assert.equal(existsSync(path.join(r.root, ".cstack/permissions")), false);
});

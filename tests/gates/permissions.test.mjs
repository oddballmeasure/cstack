import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { makeRepo, gate, path, ROOT } from "./helpers.mjs";
import { ROLES, permissionSettings, worktreeRoot, deniedCalls } from "../../gates/lib/permissions.mjs";

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

test("every role runs in dontAsk with bypass disabled and the shared deny list", () => {
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

test("worker edits only the repo's worktrees and the run store, and runs the configured commands", () => {
  const p = perms("worker");
  assert.ok(p.allow.includes(`Edit(${WT}/**)`));
  assert.ok(p.allow.includes("Edit(//src/app/.cstack/profile.json)"));
  assert.ok(!p.allow.some((r) => r === "Edit(//src/app/**)"), "the main checkout is not writable");
  for (const rule of ["Bash(git *)", "Bash(gh *)", "Bash(node *)", "Bash(npm test)", "Bash(npm test *)", "Bash(npm install *)", "Bash(npx playwright *)", "Bash(sh /opt/cstack/skills/*)", "Agent", "Monitor"]) {
    assert.ok(p.allow.includes(rule), rule);
  }
  assert.ok(p.deny.includes("Bash(systemd-run *)"), "a worker launches no detached session");
  for (const c of ["start", "stop", "daemon-run"]) assert.ok(p.deny.includes(`Bash(node /opt/cstack/gates/supervise.mjs ${c} *)`), c);
  assert.ok(p.allow.includes("Bash(CSTACK_ROLE=grader node *)"), "verifiers run the suite as the grader");
  assert.ok(!p.allow.some((r) => r.startsWith("Bash(systemctl --user stop")));
});

test("coordinator adds the e2e author launch and stopping cstack units, and may run systemd-run", () => {
  const p = perms("coordinator");
  assert.ok(p.allow.includes("Bash(systemd-run --user --collect --quiet --unit=cstack-e2e-*)"));
  assert.ok(p.allow.includes("Bash(systemctl --user stop cstack-*)"));
  assert.ok(!p.deny.includes("Bash(systemd-run *)"));
  assert.ok(!p.deny.some((r) => r.includes("supervise.mjs")), "the coordinator starts and stops sessions");
  for (const rule of perms("worker").allow) assert.ok(p.allow.includes(rule), `coordinator keeps ${rule}`);
});

test("e2e-author edits only inside paths_hidden of its worktree, and needs the worktree", () => {
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

test("grader reads, runs gates and the suite, and writes only to the store", () => {
  const p = perms("grader", { e2e_command: ["./scripts/e2e.sh"] });
  assert.ok(p.allow.includes("Bash(node /opt/cstack/*)"));
  assert.ok(p.allow.includes("Bash(./scripts/e2e.sh *)"));
  assert.ok(p.allow.includes("Bash(gh pr checks *)"));
  assert.ok(p.allow.includes("Bash(CSTACK_ROLE=grader ./scripts/e2e.sh *)") && p.allow.includes("Bash(CSTACK_ROLE=grader node /opt/cstack/*)"));
  for (const rule of ["Bash(git *)", "Bash(gh *)", "Bash(node *)", "Agent", `Edit(${WT}/**)`]) assert.ok(!p.allow.includes(rule), rule);
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

test("unknown roles are refused, and worktreeRoot follows the skills' layout", () => {
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

test("run-settings --permissions prints or writes a role's settings", () => {
  const r = makeRepo();
  const out = gate("run-settings.mjs", ["--permissions", "worker", "--repo-dir", r.root]);
  assert.equal(out.code, 0, out.err);
  const s = JSON.parse(out.out);
  assert.equal(s.permissions.defaultMode, "dontAsk");
  assert.ok(s.permissions.allow.includes(`Read(/${ROOT}/**)`), "the plugin root defaults to this checkout");
  assert.ok(s.permissions.allow.includes(`Edit(/${worktreeRoot(os.homedir(), "o/r")}/**)`));
  assert.ok(s.permissions.allow.includes("Bash(./scripts/test.sh)"));

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
  assert.equal(existsSync(path.join(r.root, ".cstack/permissions")), false);
});

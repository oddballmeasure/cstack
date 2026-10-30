// Permission settings for the headless Claude Code sessions cstack launches (ADR-009).
// No cstack session skips permissions. Each one runs with `--permission-mode dontAsk` and a generated
// `--settings` file whose permissions.allow names exactly what that role runs. dontAsk denies every
// other call at once, without a prompt, so a session never hangs on one. The guard hook stays the
// second layer: it still blocks hidden-suite reads, config writes, direct merges and the rest.
// Roles:
//   worker       a unit worker (gates/worker.mjs), and the subagents it spawns: edits in this repo's
//                worktrees, git, gh, node, the repo's configured commands
//   coordinator  orchestrate, resume-run, program --resume and the daemon: everything a worker may do
//                (Level A runs units in-session), plus starting the e2e author and stopping cstack units
//   e2e-author   writes the hidden suite: edits only inside paths_hidden of its worktree
//   grader       reads, runs the gates and the suite, writes only to the run store
// Path rules use `//` (absolute): in a --settings file a single leading slash anchors at the file's dir.
import path from "node:path";

// Deleting a system root. Not `rm -rf /*`: Claude Code reads that * as a wildcard, and a deny beats every allow, so
// it would also refuse the allowed /tmp/cstack-* scratch cleanup and stop a run at the e2e step (measured, 2.1.308).
const SYSTEM_ROOTS = ["/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/media", "/mnt", "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/usr", "/var", "/Applications", "/Library", "/System", "/Users", "/Volumes", "/private"];

export const ROLES = ["worker", "coordinator", "e2e-author", "grader"];
const JS_PMS = new Set(["npm", "pnpm", "yarn", "bun"]);

const abs = (p) => `/${path.resolve(p)}`;
// An allow rule does not match past an unknown leading assignment, so a command the skills prefix with a
// role (`CSTACK_ROLE=e2e-author git ...`) needs its own rule. Deny rules match past any assignment.
const prefixed = (rules, assignment) => rules.filter((r) => r.startsWith("Bash(")).map((r) => `Bash(${assignment} ${r.slice(5)}`);

// Repo name owner/name -> the worktree directory every skill uses for this repo.
export function worktreeRoot(home, repo) {
  return path.join(home, ".local", "state", "cstack", "worktrees", String(repo).replace("/", "-"));
}

// The repo's own commands from config, each allowed as written (plus trailing arguments). A JS package
// manager also gets install, ci, run and test, which implementers need to add a dependency or run a script.
function repoCommands(config) {
  const out = [];
  const pms = new Set();
  for (const key of ["setup_command", "test_command", "e2e_command"]) {
    const argv = config[key];
    if (!Array.isArray(argv) || argv.length === 0) continue;
    const cmd = argv.join(" ");
    out.push(`Bash(${cmd})`, `Bash(${cmd} *)`);
    if (JS_PMS.has(argv[0])) pms.add(argv[0]);
  }
  for (const pm of pms) for (const sub of ["install", "ci", "run", "test"]) out.push(`Bash(${pm} ${sub} *)`);
  if (pms.size) out.push("Bash(npx playwright *)");
  return out;
}

// Read-only git (log, show, diff, status, rev-parse) is already allowed by Claude Code in every mode.
const READ_ONLY_GH = ["Bash(gh pr view *)", "Bash(gh pr checks *)", "Bash(gh pr diff *)", "Bash(gh issue view *)", "Bash(gh run view *)"];

export function permissionSettings(role, { pluginRoot, repoRoot, home, config = {}, worktree = null }) {
  if (!ROLES.includes(role)) throw new Error(`unknown role ${role}; expected ${ROLES.join(", ")}`);
  if (role === "e2e-author" && !worktree) throw new Error("the e2e-author role needs its worktree");
  const wtRoot = worktreeRoot(home, config.repo);
  const runs = path.join(repoRoot, ".cstack", "runs");
  const plugin = path.resolve(pluginRoot);

  const reads = [`Read(${abs(plugin)}/**)`, `Read(${abs(repoRoot)}/**)`, `Read(${abs(wtRoot)}/**)`, "Read(//tmp/**)", "Read(~/.claude/projects/**)"];
  const tools = ["Agent", "Skill", "Monitor", "TaskStop", "TodoWrite", "ToolSearch"];
  const store = [`Edit(${abs(runs)}/**)`, "Edit(//tmp/cstack-*)", "Edit(//tmp/cstack-*/**)"];
  const scripts = [`Bash(node ${plugin}/*)`, `Bash(sh ${plugin}/skills/*)`, `Bash(bash ${plugin}/skills/*)`, `Bash(${plugin}/skills/*)`];
  const shell = ["Bash(printenv CSTACK_*)", "Bash(command -v *)", "Bash(jq *)", "Bash(column *)", "Bash(sort *)", "Bash(printf *)", "Bash(date *)", "Bash(sleep *)", "Bash(mkdir *)", "Bash(touch *)"];
  const build = [
    "Bash(git *)", "Bash(gh *)", "Bash(glab *)", "Bash(node *)", "Bash(cp *)", "Bash(mv *)", "Bash(chmod +x *)", "Bash(rm -f *)",
    "Bash(rm -rf /tmp/cstack-*)", ...repoCommands(config), ...(Array.isArray(config.permissions_allow) ? config.permissions_allow : []),
  ];

  let allow;
  if (role === "grader") {
    allow = [...reads, "Monitor", "TodoWrite", "ToolSearch", ...store, ...scripts, ...shell, ...READ_ONLY_GH, ...repoCommands(config)];
    allow.push(...prefixed(allow, "CSTACK_ROLE=grader"));
  } else if (role === "e2e-author") {
    const hidden = Array.isArray(config.paths_hidden) ? config.paths_hidden : [];
    const wt = path.resolve(worktree);
    allow = [
      ...reads, `Read(${abs(wt)}/**)`, ...tools, ...store, "Edit(//tmp/cstack-mutation/**)",
      ...hidden.map((g) => `Edit(${abs(wt)}/${g.replace(/^\.?\//, "")})`),
      ...scripts, ...shell, ...build, "Bash(rm -rf /tmp/cstack-mutation/*)",
    ];
    // The author prefixes every command with its role; its red check runs the suite as the grader.
    // Claude Code's built-in read-only commands need no rule, except behind that prefix.
    const readOnly = ["ls", "cat", "head", "tail", "grep", "wc", "diff", "pwd", "echo", "test"].map((c) => `Bash(${c} *)`);
    allow.push(...prefixed([...allow, ...readOnly], "CSTACK_ROLE=e2e-author"), "Bash(CSTACK_ROLE=grader node *)");
  } else {
    allow = [...reads, ...tools, ...store, `Edit(${abs(wtRoot)}/**)`, `Edit(${abs(repoRoot)}/.cstack/profile.json)`, ...scripts, ...shell, ...build];
    if (role === "coordinator") {
      // The ChatGPT login check before launching a Codex session. Every role denies `codex *`; the guard lets this
      // longer, exact allow rule through.
      allow.push("Bash(codex login status)", "Bash(systemd-run --user --collect --quiet --unit=cstack-e2e-*)", "Bash(systemctl --user is-active *)", "Bash(systemctl --user show *)", "Bash(systemctl --user stop cstack-*)", "Bash(journalctl --user *)");
    } else {
      allow.push("Bash(systemctl --user is-active *)", "Bash(systemctl --user show *)", "Bash(journalctl --user *)");
    }
    // Verifiers and the program's final check run the hidden suite as `CSTACK_ROLE=grader node <root>/gates/run-e2e.mjs`.
    allow.push("Bash(CSTACK_ROLE=grader node *)");
  }

  const deny = [
    // Credentials and the user's own configuration.
    "Read(~/.ssh/**)", "Read(~/.aws/**)", "Read(~/.gnupg/**)", "Read(~/.config/gh/**)", "Read(~/.config/glab-cli/**)", "Read(~/.netrc)", "Read(~/.claude/.credentials.json)",
    "Edit(~/.claude/**)", "Edit(~/.config/**)", "Edit(~/.bashrc)", "Edit(~/.zshrc)", "Edit(~/.profile)", "Edit(~/.local/bin/**)",
    // The config decides autonomy and hidden paths; a person edits it (the guard also blocks this).
    `Edit(${abs(repoRoot)}/.cstack/config.json)`,
    // Privilege, remote shells, downloads and network tools. cstack's own ssh deploy runs as a gate subprocess.
    "Bash(sudo *)", "Bash(su *)", "Bash(ssh *)", "Bash(scp *)", "Bash(rsync *)", "Bash(curl *)", "Bash(wget *)", "Bash(nc *)",
    "WebFetch", "WebSearch",
    // Irreversible or account-level GitHub and git actions. Merges go through the merge gate's own process.
    "Bash(gh pr merge *)", "Bash(gh repo delete *)", "Bash(gh repo edit *)", "Bash(gh secret *)", "Bash(gh auth *)",
    "Bash(gh ssh-key *)", "Bash(gh gpg-key *)", "Bash(gh release *)", "Bash(gh api -X DELETE *)", "Bash(gh api --method DELETE *)",
    "Bash(glab mr merge *)", "Bash(glab repo delete *)", "Bash(glab repo edit *)", "Bash(glab auth *)", "Bash(glab variable *)",
    "Bash(glab ssh-key *)", "Bash(glab release *)", "Bash(glab api -X DELETE *)", "Bash(glab api --method DELETE *)",
    "Bash(git push --force *)", "Bash(git push -f *)", "Bash(git push --mirror *)", "Bash(git push --delete *)",
    "Bash(npm publish *)", "Bash(rm -rf /)", ...SYSTEM_ROOTS.map((d) => `Bash(rm -rf ${d}*)`), "Bash(rm -rf ~*)", "Bash(crontab *)",
    // A session may not start another Claude Code or Codex session, or change its own permissions.
    "Bash(claude *)", "Bash(codex *)", "Bash(systemctl --user enable *)", "Bash(loginctl *)",
  ];
  // The grader reads the forge but never writes to it: no forge.mjs verb that changes a change, issue or label.
  if (role === "grader") {
    const writes = ["change create", "change edit", "change ready", "change comment", "checks rerun", "thread reply", "thread resolve", "issue create", "issue edit", "issue comment", "labels ensure"];
    deny.push(...writes.map((v) => `Bash(node ${plugin}/gates/forge.mjs ${v} *)`));
  }
  // Only a coordinator starts or stops detached sessions, through systemd-run or the host supervisor (ADR-011).
  if (role !== "coordinator") {
    deny.push("Bash(systemd-run *)", ...["start", "stop", "daemon-run"].map((c) => `Bash(node ${plugin}/gates/supervise.mjs ${c} *)`));
  }

  return {
    permissions: {
      defaultMode: "dontAsk",
      disableBypassPermissionsMode: "disable",
      allow: [...new Set(allow)],
      deny,
    },
  };
}

// The tool calls a finished `claude -p --output-format stream-json` session was refused, one line each.
export function deniedCalls(events) {
  const result = events.findLast((e) => e?.type === "result");
  const list = Array.isArray(result?.permission_denials) ? result.permission_denials : [];
  return list.map((d) => {
    const input = d?.tool_input || {};
    const what = input.command ?? input.file_path ?? input.notebook_path ?? input.path ?? input.url ?? JSON.stringify(input);
    return `${d?.tool_name || "?"}: ${String(what).replace(/\s+/g, " ").slice(0, 200)}`;
  });
}

#!/usr/bin/env node
// cstack PreToolUse guard. One entry point, seven rules:
//   hidden-paths      no tool may target paths_hidden unless CSTACK_ROLE is e2e-author or grader
//   off-limits        no file write to paths_off_limits, .git/, or vendor dirs
//   no-sleep-loops    no sleep/poll loops in Bash; wait with Monitor + a watcher script
//   no-admin-merge    no direct `gh pr merge`, `glab mr merge`, auto-merge, or merge API call; only the merge gate merges
//   no-autonomy-raise no Bash command sets CSTACK_PROGRAM_AUTONOMY; only a human launch does
//   no-deploy-approval no Bash command runs gates/deploy.mjs with --approved; a person runs that command
//   no-eval-publish   every `claude plugin eval` carries --no-publish; the report would leave the machine
//   role-deny         in a Codex session cstack launched, the role's Bash deny rules from gates/lib/permissions.mjs,
//                     because Codex has no per-session allowlist (ADR-012)
// Exit 0 allows. Exit 2 blocks; stderr is shown to the model.
// Every rule applies only in a cstack context: the session's cwd, or a path the tool call targets, is
// inside a repo whose root has .cstack/config.json, or the session carries a marker that cstack's own
// launches set (CSTACK_ROLE, CSTACK_RUN, CSTACK_UNIT, CSTACK_COORDINATOR). Anywhere else the guard
// exits 0 at once, so a user-scope install does not change Claude's behaviour in unrelated projects.
// A marker without a config means Bash rules only (no path rules).
// Codex sends the same payload. Its shell tool arrives as Bash, and its edits arrive as apply_patch with the
// patch text in tool_input.command; the guard reads the file paths from the patch headers (ADR-010).
// This is defence in depth. Hidden suites also need filesystem isolation (ADR-001).
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { permissionSettings } from "../../gates/lib/permissions.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const VENDOR = ["node_modules/**", "vendor/**", ".venv/**"];
// The config decides autonomy and hidden paths, so no session may rewrite it through a file tool.
// setup-cstack writes it with Bash (jq), which a human reviews before committing.
const ALWAYS_OFF = [".cstack/config.json"];
const PRIVILEGED_ROLES = new Set(["e2e-author", "grader"]);
// Set by gates/worker.mjs (workers and coordinators), the daemon unit, run-e2e.mjs and the e2e author launch.
const MARKERS = ["CSTACK_ROLE", "CSTACK_RUN", "CSTACK_UNIT", "CSTACK_COORDINATOR"];
// Windows and macOS file systems ignore case by default, so TESTS/Acceptance names tests/acceptance there.
const fold = process.platform === "win32" || process.platform === "darwin" ? (s) => s.toLowerCase() : (s) => s;

function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, ".cstack", "config.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Directories a Bash command points at with `cd <dir>` or `-C <dir>` (git -C, make -C).
function bashDirs(cmd) {
  return [...cmd.matchAll(/(?:^|[\s;&|(])(?:cd|-C)\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)].map((m) => m[1].replace(/^["']|["']$/g, "").replace(/^~(?=[\\/]|$)/, homedir()));
}

// Files a Codex apply_patch touches: the Add, Update and Delete headers, and the Move to target of a rename.
function patchPaths(patch) {
  const text = Array.isArray(patch) ? patch.join("\n") : String(patch ?? "");
  return [...text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm)].map((m) => m[1]);
}

// The cstack repo this call works in: from the cwd first, then from the paths the call targets.
function contextRoot(cwd, targets) {
  for (const t of [cwd, ...targets]) {
    if (typeof t !== "string" || !t) continue;
    const root = findRoot(path.resolve(cwd, t));
    if (root) return root;
  }
  return null;
}

function loadConfig(root) {
  if (!root) return null;
  try {
    return JSON.parse(readFileSync(path.join(root, ".cstack", "config.json"), "utf8"));
  } catch (err) {
    return { _error: String(err) };
  }
}

// Static prefix of a glob: the part before the first wildcard segment.
function globPrefix(glob) {
  const out = [];
  for (const seg of glob.split("/")) {
    if (/[*?[{]/.test(seg)) break;
    out.push(seg);
  }
  return out.join("/");
}

function matches(rel, globs) {
  for (const g of globs) {
    if (path.matchesGlob(fold(rel), fold(g))) return g;
    // "dir/**" also covers the directory itself.
    if (g.endsWith("/**") && fold(rel) === fold(g.slice(0, -3))) return g;
  }
  return null;
}

function relTo(root, cwd, p) {
  if (!p || typeof p !== "string") return null;
  const abs = path.resolve(cwd, p);
  const rel = path.relative(root, abs);
  // Outside the root: a parent (..), or another drive on Windows (an absolute rel). A file named ..x is inside.
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

// Literal path fragments that name a hidden area, for text checks on Bash commands and Glob patterns.
function hiddenNeedles(globs) {
  return globs.map(globPrefix).filter((p) => p.length > 0);
}
// Whether text names a needle, also when it spells the path with Windows backslashes.
const names = (text, needle) => fold(text.replaceAll("\\", "/")).includes(fold(needle.replaceAll("\\", "/")));

// Codex skips plugin hooks it has not trusted, without a warning (ADR-010). So in a cstack context the guard
// leaves <tmpdir>/cstack-hook-seen/<session_id> for each Codex session (a payload with turn_id). doctor checks
// it under Codex: no file for its own session means the guard is not running there.
function markSeen(input) {
  if (typeof input.turn_id !== "string" || !/^[\w-]+$/.test(String(input.session_id || ""))) return;
  try {
    const dir = path.join(tmpdir(), "cstack-hook-seen");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, input.session_id), "");
  } catch {} // a marker that cannot be written makes doctor fail; it must never block the call
}

function block(rule, msg) {
  process.stderr.write(`cstack ${rule}: ${msg}\n`);
  process.exit(2);
}

function checkBash(cmd) {
  const flat = cmd.replace(/\\\n/g, " ");
  if (/\b(while|until)\b[\s\S]*\bsleep\b/.test(flat) || /\bfor\b[\s\S]*\bdo\b[\s\S]*\bsleep\b/.test(flat)) {
    block("no-sleep-loops", "polling loops are not allowed. Start a watcher script under the Monitor tool instead.");
  }
  const m = flat.match(/\bsleep\s+(\d+)/);
  if (m && Number(m[1]) >= 10) {
    block("no-sleep-loops", `sleep ${m[1]} is not allowed. Wait with the Monitor tool on a watcher script.`);
  }
  if (/\bgh\s+pr\s+merge\b/.test(flat)) {
    block("no-admin-merge", "direct `gh pr merge` is not allowed. Merge only through the cstack merge gate.");
  }
  if (/\bgh\s+api\b[^|;&]*\/pulls\/\d+\/merge\b/.test(flat)) {
    block("no-admin-merge", "merging through the API is not allowed. Merge only through the cstack merge gate.");
  }
  // GitLab (ADR-013): the CLI merge, setting auto-merge on an MR, and the merge endpoint through the API.
  if (/\bglab\s+mr\s+merge\b/.test(flat) || /\bglab\s+mr\s+(?:update|create)\b[^|;&]*--auto-merge\b/.test(flat)) {
    block("no-admin-merge", "direct `glab mr merge` or auto-merge is not allowed. Merge only through the cstack merge gate.");
  }
  if (/\bglab\s+api\b[^|;&]*merge_requests(?:\/|%2F)\d+(?:\/|%2F)merge\b/i.test(flat)) {
    block("no-admin-merge", "merging through the API is not allowed. Merge only through the cstack merge gate.");
  }
  // Only the human who launches a run may give it CSTACK_PROGRAM_AUTONOMY=send (ADR-006). Reading it is fine.
  if (/\bCSTACK_PROGRAM_AUTONOMY\s*=|\b(export|read|declare|typeset|local|set-environment)\b[^;&|\n]*\bCSTACK_PROGRAM_AUTONOMY\b/.test(flat)) {
    block("no-autonomy-raise", "a session may not set CSTACK_PROGRAM_AUTONOMY. Only the human who launches the run sets it.");
  }
  // A deploy is a hard stop (mode skill rule 7): the approved run is the human's own command, unless config deploy.auto.
  if (/\bdeploy\.mjs\b[^;&|\n]*--approved\b/.test(flat)) {
    block("no-deploy-approval", "only a person may approve a deploy. Give them the exact deploy.mjs --approved command to run in their terminal.");
  }
  // claude plugin eval publishes its HTML report to claude.ai by default (ADR-005). cstack repos are private.
  if (/\bclaude\s+plugins?\s+eval\b/.test(flat) && !/--no-publish\b|--help\b/.test(flat)) {
    block("no-eval-publish", "claude plugin eval must carry --no-publish. Add it and run again.");
  }
}

// The cstack role of this session, from the markers gates/worker.mjs and the e2e launch set.
function sessionRole() {
  if (process.env.CSTACK_ROLE) return process.env.CSTACK_ROLE;
  if (process.env.CSTACK_COORDINATOR === "1") return "coordinator";
  return process.env.CSTACK_UNIT ? "worker" : null;
}

// A Claude Code Bash rule as a regex over one simple command: a trailing " *" also matches the bare command.
function ruleRegex(rule) {
  const esc = (t) => t.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  if (rule.endsWith(" *")) return new RegExp(`^${rule.slice(0, -2).split("*").map(esc).join(".*")}(?:\\s[\\s\\S]*)?$`);
  return new RegExp(`^${rule.split("*").map(esc).join(".*")}$`);
}

// Codex sessions run without Claude Code's per-session allowlist, so apply the role's Bash deny list here.
// A broad deny such as `rm -rf /*` must not refuse what the role's allowlist names more precisely
// (`rm -rf /tmp/cstack-*`): a deny hit stands unless an allow rule with a longer literal prefix also matches.
function checkRoleDeny(cmd, role, root, cwd, cfg) {
  let perms;
  try {
    perms = permissionSettings(role, { pluginRoot: PLUGIN_ROOT, repoRoot: root || cwd, home: homedir(), config: cfg || {}, worktree: cwd }).permissions;
  } catch {
    return; // an unknown role has no deny list
  }
  const compile = (rules) => rules.filter((r) => r.startsWith("Bash(")).map((r) => [r, ruleRegex(r.slice(5, -1)), r.slice(5, -1).split("*")[0].length]);
  const denies = compile(perms.deny);
  const allows = compile(perms.allow);
  for (const part of cmd.split(/&&|\|\||[;|\n]/)) {
    const simple = part.trim().replace(/^(?:\w+=\S*\s+)+/, "");
    const hit = denies.find(([, re]) => re.test(simple));
    if (hit && !allows.some(([, re, len]) => len > hit[2] && re.test(simple))) block("role-deny", `\`${simple}\` is denied to the ${role} role (${hit[0]}).`);
  }
}

// CSTACK_GUARD_HIDE lists absolute paths outside the repo that a launched run must not touch, for example the
// cstack checkout that holds a fixture's held-out grader (tests/fixtures/run-fixture.mjs). Codex reads through
// Bash, and Claude Code's Read allowlist does not apply to it, so the guard checks commands and file targets.
function checkHide(tool, ti, patched, cwd) {
  const hide = (process.env.CSTACK_GUARD_HIDE || "").split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
  if (!hide.length) return;
  const targets = tool === "Bash" ? [] : (patched ?? [ti.file_path, ti.notebook_path, ti.path]).filter((t) => typeof t === "string");
  for (const h of hide) {
    if (tool === "Bash" && typeof ti.command === "string" && names(ti.command, h.replaceAll("\\", "/"))) block("hidden-paths", `command names a path hidden from this run (${h}).`);
    for (const t of targets) {
      const abs = path.resolve(cwd, t);
      if (fold(abs) === fold(h) || fold(abs).startsWith(fold(h + path.sep))) block("hidden-paths", `${abs} is hidden from this run.`);
    }
  }
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0); // not our input shape; never break the session on a parse error
  }
  const tool = input.tool_name || "";
  const ti = input.tool_input || {};
  const cwd = input.cwd || process.cwd();

  const bash = tool === "Bash" && typeof ti.command === "string";
  const patched = tool === "apply_patch" ? patchPaths(ti.command ?? ti.input) : null;
  const targets = bash ? bashDirs(ti.command) : patched ?? [ti.file_path, ti.notebook_path, ti.path];
  const root = contextRoot(cwd, targets);
  const marked = MARKERS.some((k) => process.env[k]);
  if (!root && !marked) process.exit(0); // not a cstack context: change nothing
  markSeen(input);

  if (bash) checkBash(ti.command);
  checkHide(tool, ti, patched, cwd);

  const cfg = loadConfig(root);
  const role = sessionRole();
  if (bash && role && typeof input.turn_id === "string" && !cfg?._error) checkRoleDeny(ti.command, role, root, cwd, cfg);
  if (!cfg) process.exit(0);
  if (cfg._error) block("config", `.cstack/config.json does not parse: ${cfg._error}`);

  const hidden = Array.isArray(cfg.paths_hidden) ? cfg.paths_hidden : [];
  const offLimits = [...(Array.isArray(cfg.paths_off_limits) ? cfg.paths_off_limits : []), ".git/**", ...VENDOR, ...ALWAYS_OFF];
  const privileged = PRIVILEGED_ROLES.has(process.env.CSTACK_ROLE || "");

  // Path fields per tool. Agent and Skill prompts are free text and are never matched (ADR-001 finding 1).
  const fields = {
    Read: [ti.file_path],
    Edit: [ti.file_path],
    MultiEdit: [ti.file_path],
    Write: [ti.file_path],
    NotebookEdit: [ti.notebook_path],
    Grep: [ti.path],
    Glob: [ti.path],
    apply_patch: patched,
  }[tool];

  if (fields && !privileged) {
    for (const f of fields) {
      const rel = relTo(root, cwd, f);
      const g = rel !== null ? matches(rel, hidden) : null;
      if (g) block("hidden-paths", `${rel} is inside a hidden path (${g}). Run the suite with run-e2e instead.`);
    }
    const pattern = tool === "Glob" ? ti.pattern : tool === "Grep" ? ti.glob : null;
    if (typeof pattern === "string") {
      for (const n of hiddenNeedles(hidden)) {
        if (names(pattern, n)) block("hidden-paths", `pattern names a hidden path (${n}).`);
      }
    }
  }

  if (tool === "Bash" && typeof ti.command === "string" && !privileged) {
    for (const n of hiddenNeedles(hidden)) {
      if (names(ti.command, n)) block("hidden-paths", `command names a hidden path (${n}). Run the suite with run-e2e instead. To write a file whose text mentions it, use the edit tool (Write or Edit; apply_patch in Codex), not a shell command.`);
    }
  }

  const writes = ["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(tool) ? [ti.file_path || ti.notebook_path] : patched ?? [];
  for (const w of writes) {
    const rel = relTo(root, cwd, w);
    const g = rel !== null ? matches(rel, offLimits) : null;
    if (g) block("off-limits", `${rel} is off limits (${g}).`);
    if (rel !== null && privileged && process.env.CSTACK_ROLE === "e2e-author" && !matches(rel, hidden)) {
      block("off-limits", `the e2e author may write only inside paths_hidden; ${rel} is outside.`);
    }
  }

  process.exit(0);
}

main();

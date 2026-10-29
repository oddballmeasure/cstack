#!/usr/bin/env node
// cstack PreToolUse guard. One entry point, seven rules:
//   hidden-paths      no tool may target paths_hidden unless CSTACK_ROLE is e2e-author or grader
//   off-limits        no file write to paths_off_limits, .git/, or vendor dirs
//   no-sleep-loops    no sleep/poll loops in Bash; wait with Monitor + a watcher script
//   no-admin-merge    no direct `gh pr merge` or merge API call; only the merge gate merges
//   no-autonomy-raise no Bash command sets CSTACK_PROGRAM_AUTONOMY; only a human launch does
//   no-deploy-approval no Bash command runs gates/deploy.mjs with --approved; a person runs that command
//   no-eval-publish   every `claude plugin eval` carries --no-publish; the report would leave the machine
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
import { tmpdir } from "node:os";
import path from "node:path";

const VENDOR = ["node_modules/**", "vendor/**", ".venv/**"];
// The config decides autonomy and hidden paths, so no session may rewrite it through a file tool.
// setup-cstack writes it with Bash (jq), which a human reviews before committing.
const ALWAYS_OFF = [".cstack/config.json"];
const PRIVILEGED_ROLES = new Set(["e2e-author", "grader"]);
// Set by gates/worker.mjs (workers and coordinators), the daemon unit, run-e2e.mjs and the e2e author launch.
const MARKERS = ["CSTACK_ROLE", "CSTACK_RUN", "CSTACK_UNIT", "CSTACK_COORDINATOR"];

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
  return [...cmd.matchAll(/(?:^|[\s;&|(])(?:cd|-C)\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)].map((m) => m[1].replace(/^["']|["']$/g, "").replace(/^~(?=\/|$)/, process.env.HOME || "~"));
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
    if (path.matchesGlob(rel, g)) return g;
    // "dir/**" also covers the directory itself.
    if (g.endsWith("/**") && rel === g.slice(0, -3)) return g;
  }
  return null;
}

function relTo(root, cwd, p) {
  if (!p || typeof p !== "string") return null;
  const abs = path.resolve(cwd, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

// Literal path fragments that name a hidden area, for text checks on Bash commands and Glob patterns.
function hiddenNeedles(globs) {
  return globs.map(globPrefix).filter((p) => p.length > 0);
}

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

  const cfg = loadConfig(root);
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
        if (pattern.includes(n)) block("hidden-paths", `pattern names a hidden path (${n}).`);
      }
    }
  }

  if (tool === "Bash" && typeof ti.command === "string" && !privileged) {
    for (const n of hiddenNeedles(hidden)) {
      if (ti.command.includes(n)) block("hidden-paths", `command names a hidden path (${n}). Run the suite with run-e2e instead.`);
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

#!/usr/bin/env node
// cstack PreToolUse guard. One entry point, four rules:
//   hidden-paths   no tool may target paths_hidden unless CSTACK_ROLE is e2e-author or grader
//   off-limits     no file write to paths_off_limits, .git/, or vendor dirs
//   no-sleep-loops no sleep/poll loops in Bash; wait with Monitor + a watcher script
//   no-admin-merge no direct `gh pr merge` or merge API call; only the merge gate merges
// Exit 0 allows. Exit 2 blocks; stderr is shown to the model.
// No config in the repo means no path rules (the Bash rules still apply).
// This is defence in depth. Hidden suites also need filesystem isolation (ADR-001).
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const VENDOR = ["node_modules/**", "vendor/**", ".venv/**"];
const PRIVILEGED_ROLES = new Set(["e2e-author", "grader"]);

function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, ".cstack", "config.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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
    const prefix = globPrefix(g);
    if (prefix && (rel === prefix || rel.startsWith(prefix + "/"))) return g;
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

  if (tool === "Bash" && typeof ti.command === "string") checkBash(ti.command);

  const root = findRoot(cwd);
  const cfg = loadConfig(root);
  if (!cfg) process.exit(0);
  if (cfg._error) block("config", `.cstack/config.json does not parse: ${cfg._error}`);

  const hidden = Array.isArray(cfg.paths_hidden) ? cfg.paths_hidden : [];
  const offLimits = [...(Array.isArray(cfg.paths_off_limits) ? cfg.paths_off_limits : []), ".git/**", ...VENDOR];
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

  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(tool)) {
    const rel = relTo(root, cwd, ti.file_path || ti.notebook_path);
    const g = rel !== null ? matches(rel, offLimits) : null;
    if (g) block("off-limits", `${rel} is off limits (${g}).`);
    if (rel !== null && privileged && process.env.CSTACK_ROLE === "e2e-author" && !matches(rel, hidden)) {
      block("off-limits", `the e2e author may write only inside paths_hidden; ${rel} is outside.`);
    }
  }

  process.exit(0);
}

main();

#!/usr/bin/env node
// cstack doctor: read-only health check of a target repo.
// Usage: node doctor.mjs [--offline] [repo-dir]
// Prints one line per check: PASS|WARN|FAIL <check>: <detail>. Exit 1 if any FAIL.
// --offline skips every check that calls GitHub.
import { readFileSync, existsSync, statSync, accessSync, mkdirSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, which } from "../../../gates/lib/common.mjs";

const argv = process.argv.slice(2);
const offline = argv[0] === "--offline";
if (offline) argv.shift();
const dir = argv[0] || ".";
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
let fails = 0;

const pass = (check, detail) => console.log(`PASS ${check}: ${detail}`);
const warn = (check, detail) => console.log(`WARN ${check}: ${detail}`);
const fail = (check, detail) => {
  console.log(`FAIL ${check}: ${detail}`);
  fails++;
};
const done = () => {
  console.log(fails ? `doctor: ${fails} failed` : "doctor: ok");
  process.exit(fails ? 1 : 0);
};

// Tools
for (const t of ["git", "jq", "node"]) {
  const p = which(t);
  if (p) pass(`tool ${t}`, p);
  else fail(`tool ${t}`, "not on PATH");
}
// The node on PATH runs the hooks (hooks.json), which may differ from the node running doctor.
const pathNode = which("node") ? run("node", ["-p", "process.versions.node"]).stdout.trim() : "";
const major = Number((pathNode || process.versions.node).split(".")[0]);
if (major >= 22) pass("node version", `v${major}`);
else fail("node version", `v${major} is below 22 (hooks need path.matchesGlob)`);

// Repo
const top = run("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
if (top.code !== 0) {
  fail("git repo", `${dir} is not inside a git repository`);
  done();
}
const root = path.resolve(top.stdout.trim());
pass("git repo", root);

const cfgPath = path.join(root, ".cstack", "config.json");
if (!existsSync(cfgPath)) {
  fail("config", ".cstack/config.json not found (run the setup-cstack skill)");
  done();
}
let cfg;
try {
  cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
} catch {
  fail("config", ".cstack/config.json does not parse");
  done();
}
pass("config", "parses");

// Schema. Each check returns an error string, or nothing when the field is valid.
const type = (v) => (v === null || v === undefined ? "null" : Array.isArray(v) ? "array" : typeof v);
const isObj = (v) => type(v) === "object";
const num = (v) => type(v) === "number";
const int = (v, lo, hi) => num(v) && Number.isInteger(v) && v >= lo && v <= hi;
const rate = (v) => num(v) && v >= 0 && v <= 1;
const nonEmptyArray = (v) => Array.isArray(v) && v.length > 0;
const unknown = (obj, known, prefix) =>
  Object.keys(obj)
    .filter((k) => !known.includes(k))
    .sort()
    .map((k) => `unknown key ${prefix}${k}`);

function schemaErrors(c) {
  if (!isObj(c)) return ["config must be a JSON object"];
  const errs = [];
  const need = (cond, msg) => cond || errs.push(msg);
  need(c.version === 1, "version must be 1");
  // GitLab paths may nest groups (group/sub/project); GitHub's are owner/name.
  const nested = c.forge === "gitlab";
  need(type(c.repo) === "string" && (nested ? /^[^/]+(\/[^/]+)+$/ : /^[^/]+\/[^/]+$/).test(c.repo) && c.repo !== "owner/name", nested ? "repo must be the project path, group/project" : "repo must be owner/name");
  need(c.forge == null || ["github", "gitlab", "local"].includes(c.forge), "forge must be github, gitlab or local");
  need(c.forge_host == null || (type(c.forge_host) === "string" && /^[a-z0-9.-]+(:\d+)?$/i.test(c.forge_host)), "forge_host must be a host name, like gitlab.example.com");
  need(c.review_bots == null || (Array.isArray(c.review_bots) && c.review_bots.every((b) => type(b) === "string" && b.length > 0)), "review_bots must be an array of bot logins");
  need(type(c.base_branch) === "string" && c.base_branch.length > 0, "base_branch must be a non-empty string");
  need(nonEmptyArray(c.test_command) && c.test_command.every((x) => type(x) === "string"), "test_command must be a non-empty array of strings");
  need(c.setup_command == null || nonEmptyArray(c.setup_command), "setup_command must be null or a non-empty array");
  need(c.e2e_command == null || nonEmptyArray(c.e2e_command), "e2e_command must be null or a non-empty array");
  need(Array.isArray(c.required_checks), "required_checks must be an array");
  need(Array.isArray(c.paths_off_limits), "paths_off_limits must be an array");
  need(Array.isArray(c.paths_hidden), "paths_hidden must be an array");
  need(
    c.permissions_allow == null || (Array.isArray(c.permissions_allow) && c.permissions_allow.every((r) => type(r) === "string" && /^[A-Za-z]+(\(.+\))?$/.test(r))),
    "permissions_allow must be an array of permission rules such as Bash(make check)",
  );
  need(type(c.label_prefix) === "string" && /^[a-z][a-z0-9-]*$/.test(c.label_prefix), "label_prefix must be lowercase letters, digits or dashes");
  need(c.autonomy === "stop" || c.autonomy === "send", "autonomy must be stop or send");
  need(num(c.parallel) && c.parallel >= 1 && c.parallel <= 8, "parallel must be 1 to 8");
  need(isObj(c.models), "models must be an object");
  const models = isObj(c.models) ? c.models : {};
  for (const r of ["code", "judge", "review", "gather"]) {
    need(["opus", "sonnet", "haiku", "fable", "inherit"].includes(models[r]), `models.${r} must be opus, sonnet, haiku, fable or inherit`);
  }
  const limits = isObj(c.limits) ? c.limits : {};
  for (const k of ["coder_attempts", "verify_rounds", "ci_repair_rounds", "base_sync_rounds", "review_rounds", "test_timeout_seconds", "ci_timeout_seconds"]) {
    need(num(limits[k]) && limits[k] >= 1, `limits.${k} must be a number >= 1`);
  }
  need(c.retry_after_hours == null || (num(c.retry_after_hours) && c.retry_after_hours >= 24), "retry_after_hours must be null or a number >= 24");

  const s = c.scout;
  if (s != null && !isObj(s)) errs.push("scout must be an object or null");
  else if (s != null) {
    need(s.autonomy == null || s.autonomy === "propose" || s.autonomy === "auto", "scout.autonomy must be propose or auto");
    need(
      s.categories == null || (nonEmptyArray(s.categories) && s.categories.every((x) => ["bug", "regression", "docs", "enhancement", "feature"].includes(x))),
      "scout.categories must be a non-empty list of bug, regression, docs, enhancement, feature",
    );
    need(s.areas_per_pass == null || int(s.areas_per_pass, 1, 6), "scout.areas_per_pass must be an integer 1 to 6");
    need(s.cooldown_days == null || (num(s.cooldown_days) && s.cooldown_days >= 0), "scout.cooldown_days must be a number >= 0");
    need(s.max_proposals_per_pass == null || int(s.max_proposals_per_pass, 1, 10), "scout.max_proposals_per_pass must be an integer 1 to 10");
    need(s.max_files == null || int(s.max_files, 1, 10), "scout.max_files must be an integer 1 to 10");
    need(s.repro == null || type(s.repro) === "boolean", "scout.repro must be true or false");
    need(s.auto_min_decided == null || int(s.auto_min_decided, 1, 100000), "scout.auto_min_decided must be an integer >= 1");
    need(s.auto_min_approval == null || rate(s.auto_min_approval), "scout.auto_min_approval must be 0 to 1");
    need(s.auto_min_done == null || rate(s.auto_min_done), "scout.auto_min_done must be 0 to 1");
    const known = ["autonomy", "categories", "areas_per_pass", "cooldown_days", "max_proposals_per_pass", "max_files", "repro", "auto_min_decided", "auto_min_approval", "auto_min_done"];
    errs.push(...unknown(s, known, "scout."));
  }

  const d = c.deploy;
  if (d != null && !isObj(d)) errs.push("deploy must be an object or null");
  else if (d != null) {
    need(d.transport === "local" || d.transport === "ssh", "deploy.transport must be local or ssh");
    need(d.transport !== "local" || (type(d.local_directory) === "string" && d.local_directory.length > 0), "deploy.local_directory is required for transport local");
    need(d.local_directory == null || type(d.local_directory) === "string", "deploy.local_directory must be a string");
    need(d.auto == null || type(d.auto) === "boolean", "deploy.auto must be true or false");
    errs.push(...unknown(d, ["transport", "local_directory", "auto"], "deploy."));
  }

  // Harness and host keys (Codex and the host supervisor). Each is optional.
  need(c.harness == null || ["auto", "claude", "codex"].includes(c.harness), "harness must be auto, claude or codex");
  const mc = c.models_codex;
  if (mc != null && !isObj(mc)) errs.push("models_codex must be an object or null");
  else if (mc != null) {
    for (const r of ["code", "judge", "review", "gather"]) {
      need(mc[r] == null || (type(mc[r]) === "string" && mc[r].length > 0), `models_codex.${r} must be a non-empty string`);
    }
    errs.push(...unknown(mc, ["code", "judge", "review", "gather"], "models_codex."));
  }
  need(c.codex_sandbox == null || ["read-only", "workspace-write", "danger-full-access"].includes(c.codex_sandbox), "codex_sandbox must be read-only, workspace-write or danger-full-access");
  const h = c.host;
  if (h != null && !isObj(h)) errs.push("host must be an object or null");
  else if (h != null) {
    need(h.supervisor == null || ["auto", "systemd", "launchd", "taskscheduler", "detached"].includes(h.supervisor), "host.supervisor must be auto, systemd, launchd, taskscheduler or detached");
    errs.push(...unknown(h, ["supervisor"], "host."));
  }

  const known = ["version", "repo", "base_branch", "setup_command", "test_command", "e2e_command", "required_checks", "paths_off_limits", "paths_hidden", "permissions_allow", "label_prefix", "autonomy", "parallel", "models", "limits", "retry_after_hours", "scout", "deploy", "harness", "models_codex", "codex_sandbox", "host", "forge", "forge_host", "review_bots"];
  errs.push(...unknown(c, known, ""));
  return errs;
}
const errors = schemaErrors(cfg);
for (const e of errors) fail("config schema", e);
if (!errors.length) pass("config schema", "all keys valid");

// Commands resolve. A repo-relative path (contains /) must be an executable file under the repo root.
const executable = (p) => {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
function checkCmd(label, argv) {
  const exe = Array.isArray(argv) && argv[0] != null && argv[0] !== false ? String(argv[0]) : "";
  if (!exe) return;
  const isPath = exe.includes("/") || (process.platform === "win32" && exe.includes("\\"));
  if (isPath) {
    if (executable(path.resolve(root, exe)) || executable(exe)) pass(label, exe);
    else fail(label, `${exe} is not an executable file`);
  } else if (which(exe)) pass(label, `${exe} on PATH`);
  else fail(label, `${exe} not on PATH`);
}
if (isObj(cfg)) {
  checkCmd("test_command", cfg.test_command);
  checkCmd("setup_command", cfg.setup_command);
  checkCmd("e2e_command", cfg.e2e_command);
}

// Run store
const ignored = (p) => run("git", ["-C", root, "check-ignore", "-q", p]).code === 0;
if (ignored(".cstack/runs/x") && ignored(".cstack/profile.json")) pass("gitignore", "local cstack state is ignored");
else warn("gitignore", ".cstack/runs/ or .cstack/profile.json is not ignored (setup adds .cstack/* and !.cstack/config.json)");
const runs = path.join(root, ".cstack", "runs");
try {
  mkdirSync(runs, { recursive: true });
  accessSync(runs, constants.W_OK);
  pass("run store", ".cstack/runs is writable");
} catch {
  fail("run store", ".cstack/runs is not writable");
}

// Hooks: the guard blocks a known-bad call
const guard = path.join(pluginRoot, "hooks", "scripts", "guard.mjs");
if (existsSync(guard)) {
  // The guard acts only in a cstack context; the CSTACK_RUN marker gives the probe one from any cwd.
  const probe = run(process.execPath, [guard], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr merge 1" }, cwd: path.parse(process.cwd()).root }),
    env: { ...process.env, CSTACK_RUN: "doctor-self-test" },
  });
  if (probe.code === 0) fail("hooks", "guard did not block a direct merge");
  else pass("hooks", "guard self-test blocks a direct merge");
} else {
  fail("hooks", `guard not found at ${guard}`);
}
// Codex runs plugin hooks only once they are trusted, and skips them silently otherwise (ADR-010). The guard
// leaves a mark for each Codex session it sees in a cstack context, including the call that started this script.
const codex = process.env.CODEX_SESSION_ID;
if (codex) {
  if (existsSync(path.join(tmpdir(), "cstack-hook-seen", codex))) pass("hooks (codex)", "the guard runs in this Codex session");
  else fail("hooks (codex)", "the guard did not run in this Codex session: trust cstack's hooks once in /hooks, then run doctor again");
}

// The forge: GitHub unless config `forge` names another (gates/lib/forge.mjs).
const forge = isObj(cfg) && typeof cfg.forge === "string" ? cfg.forge : "github";
const cli = { github: "gh", gitlab: "glab" }[forge] ?? null;
if (cli && !offline) {
  if (!which(cli)) fail(`tool ${cli}`, "not on PATH");
  else if (run(cli, ["auth", "status"]).code === 0) pass(`${cli} auth`, "logged in");
  else fail(`${cli} auth`, `not logged in (run ${cli} auth login)`);
}
// pr-wait and the merge gate need `gh pr checks --json` and the baseRefOid field; Ubuntu's gh 2.45 has
// neither (cstack#32). Ask gh itself, offline, rather than compare version numbers.
if (forge === "github" && which("gh")) {
  const view = run("gh", ["pr", "view", "--json"]);
  const checks = run("gh", ["pr", "checks", "--help"]);
  if (/baseRefOid/.test(view.stdout + view.stderr) && /--json/.test(checks.stdout + checks.stderr)) pass("gh features", "pr checks --json, baseRefOid");
  else fail("gh features", "this gh lacks `pr checks --json` or the baseRefOid field; install a current gh from https://cli.github.com");
}

if (!offline && cli) {
  const { repo, base_branch: base, label_prefix: prefix, forge_host: host } = isObj(cfg) ? cfg : {};
  let labels;
  if (forge === "github") {
    if (run("gh", ["repo", "view", repo, "--json", "name"]).code === 0) pass("github repo", repo);
    else fail("github repo", `cannot view ${repo}`);
    if (run("gh", ["api", `repos/${repo}/branches/${base}`]).code === 0) pass("base branch", `${base} exists on ${repo}`);
    else fail("base branch", `${base} not found on ${repo}`);
    const list = run("gh", ["label", "list", "--repo", repo, "--limit", "500", "--json", "name", "--jq", ".[].name"]);
    labels = new Set(list.code === 0 ? list.stdout.split(/\r?\n/) : []);
  } else {
    const api = (p) => run("glab", ["api", ...(host ? ["--hostname", host] : []), p]);
    const project = `projects/${encodeURIComponent(String(repo))}`;
    if (api(project).code === 0) pass("gitlab project", repo);
    else fail("gitlab project", `cannot view ${repo}`);
    if (api(`${project}/repository/branches/${encodeURIComponent(String(base))}`).code === 0) pass("base branch", `${base} exists on ${repo}`);
    else fail("base branch", `${base} not found on ${repo}`);
    const list = api(`${project}/labels?per_page=100`);
    labels = new Set(list.code === 0 ? JSON.parse(list.stdout).map((l) => l.name) : []);
  }
  const missing = ["ready", "in-progress", "done", "error", "needs-human", "investigate", "proposed"].map((l) => `${prefix}:${l}`).filter((l) => !labels.has(l));
  if (!missing.length) pass("labels", `all ${prefix}:* labels exist`);
  else fail("labels", `missing: ${missing.join(" ")} (run the setup-cstack skill)`);
  if (!((isObj(cfg) ? cfg.required_checks : null) ?? []).length) warn("required checks", "none configured; the merge gate will not wait for CI");
}

done();

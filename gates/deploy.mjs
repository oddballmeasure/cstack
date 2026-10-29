#!/usr/bin/env node
// Gate: run a merged revision's committed deployment once, then poll health until healthy or timed out.
// Adapted from Cardinal src/cardinal/deploy/{committed,hosts,service}.py (oddballmeasure/cardinal, same owner).
// Usage: deploy.mjs <sha> [--repo-dir <d>] [--plan] [--approved] [--json]
//
// Inputs come from the commit, never from a working tree: deploy.sh and deploy.json at the root or both
// under deploy/. The commit must be on origin/<base_branch>. deploy.json:
//   {"host", "user", "port"?: 22, "working_directory", "deploy_timeout_seconds",
//    "health": {"command", "expected_stdout", "timeout_seconds", "interval_seconds"}}
// config `deploy`: {"transport": "local"|"ssh", "local_directory"?: <dir, local only>, "auto"?: false}.
//   local: `bash -se` with the script on stdin, in local_directory, with DEPLOY_HOST set.
//   ssh:   ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -p <port> <user>@<host>
//          "cd <working_directory> && DEPLOY_HOST=<host> bash -se", script on stdin.
// Health runs `bash -c <command>` the same way; healthy means exit 0 and stdout equal to expected_stdout
// (trimmed). A zero script exit alone is not success.
// --plan validates and prints what would run. Running needs --approved (a person said yes in this session)
// unless config deploy.auto is true. Each revision deploys at most once: <repo>/.cstack/deploys/<sha>.json
// is written before the script runs and holds the result after. A later call reports it and runs nothing.
// Exit 0 healthy (or --plan valid), 1 refused, script_failed, health_timeout or interrupted, 2 usage error.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Gate, main, parseArgs, UsageError, loadConfig, run, git, gitOut } from "./lib/common.mjs";

const TAIL = 4000;
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const positive = (v) => typeof v === "number" && v > 0;

function committed(root, sha) {
  const present = new Set(gitOut(root, ["ls-tree", "-r", "--name-only", sha]).split("\n"));
  const rootPair = ["deploy.sh", "deploy.json"];
  const nested = ["deploy/deploy.sh", "deploy/deploy.json"];
  const any = (pair) => pair.some((f) => present.has(f));
  const all = (pair) => pair.every((f) => present.has(f));
  if (any(rootPair) && any(nested)) return { problem: "ambiguous deploy layout: files at both the root and deploy/" };
  const pair = all(rootPair) ? rootPair : all(nested) ? nested : null;
  if (!pair) return { problem: "no co-located deploy.sh and deploy.json at the root or under deploy/" };
  const show = (f) => gitOut(root, ["show", `${sha}:${f}`]);
  let config;
  try {
    config = JSON.parse(show(pair[1]));
  } catch (err) {
    return { problem: `${pair[1]} does not parse: ${err.message}` };
  }
  return { scriptPath: pair[0], script: `${show(pair[0])}\n`, config };
}

function deployProblem(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return "deploy.json must be an object";
  if (!/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(c.host ?? "")) return "host must be a host name or address";
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(c.user ?? "")) return "user must be a user name";
  if (c.port !== undefined && !(Number.isInteger(c.port) && c.port >= 1 && c.port <= 65535)) return "port must be 1-65535";
  if (typeof c.working_directory !== "string" || !c.working_directory) return "working_directory must be a non-empty string";
  if (!positive(c.deploy_timeout_seconds)) return "deploy_timeout_seconds must be a number above 0";
  const h = c.health ?? {};
  if (typeof h.command !== "string" || !h.command.trim()) return "health.command must be a non-empty string";
  if (typeof h.expected_stdout !== "string" || !h.expected_stdout.trim()) return "health.expected_stdout must contain non-whitespace text";
  if (!positive(h.timeout_seconds) || !positive(h.interval_seconds)) return "health.timeout_seconds and health.interval_seconds must be numbers above 0";
  return null;
}

function evidence(r) {
  return {
    exit_code: r.timedOut ? 124 : r.code,
    stdout: r.stdout.slice(-TAIL),
    stderr: `${r.stderr}${r.timedOut ? "\ncommand timed out" : ""}`.slice(-TAIL),
  };
}

// Where the deployment runs. Host and commands are pinned by the commit and the config.
function hostFor(settings, c) {
  if (settings.transport === "ssh") {
    const base = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-p", String(c.port ?? 22), `${c.user}@${c.host}`];
    const prefix = `cd ${quote(c.working_directory)} && DEPLOY_HOST=${quote(c.host)} `;
    const ssh = (remote, input, seconds) => evidence(run("ssh", [...base, remote], { input, timeout: Math.ceil(seconds * 1000) }));
    return {
      where: `${c.user}@${c.host}:${c.working_directory}`,
      execute: (script) => ssh(`${prefix}bash -se`, script, c.deploy_timeout_seconds),
      check: (seconds) => ssh(`${prefix}bash -c ${quote(c.health.command)}`, "", seconds),
    };
  }
  const dir = settings.local_directory.replace(/^~(?=$|\/)/, homedir());
  const local = (argv, input, seconds) => {
    mkdirSync(dir, { recursive: true });
    return evidence(run("bash", argv, { input, cwd: dir, timeout: Math.ceil(seconds * 1000), env: { ...process.env, DEPLOY_HOST: c.host } }));
  };
  return {
    where: `local ${dir}`,
    execute: (script) => local(["-se"], script, c.deploy_timeout_seconds),
    check: (seconds) => local(["-c", c.health.command], "", seconds),
  };
}

async function poll(host, h) {
  const start = Date.now();
  const observations = [];
  for (;;) {
    // Each poll gets what is left of the health timeout, but never under a second, so the last poll is not cut short.
    const ev = host.check(Math.max(1, h.timeout_seconds - (Date.now() - start) / 1000));
    const healthy = ev.exit_code === 0 && ev.stdout.trim() === h.expected_stdout.trim();
    observations.push({ ...ev, healthy });
    // Stop when healthy, or when the next poll would start past the health timeout.
    if (healthy || (Date.now() - start) / 1000 + h.interval_seconds > h.timeout_seconds) return observations;
    await new Promise((res) => setTimeout(res, h.interval_seconds * 1000));
  }
}

await main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json", "plan", "approved"], options: ["repo-dir"] });
  const [rev] = args._;
  if (args._.length !== 1) throw new UsageError("usage: deploy.mjs <sha> [--repo-dir d] [--plan] [--approved] [--json]");
  const { root, config } = loadConfig(args["repo-dir"] || process.cwd());
  const settings = config.deploy;
  if (!settings || typeof settings !== "object") throw new UsageError("config has no deploy object; deployment is off for this repo");
  if (settings.transport === "local" && !settings.local_directory) throw new UsageError("deploy.transport local needs deploy.local_directory");
  const resolved = git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  if (resolved.code !== 0) throw new UsageError(`${rev} is not a commit in ${root}`);
  const sha = resolved.stdout.trim();
  const gate = new Gate("deploy", { json: args.json });
  const finish = (extra = {}) => gate.finish({ revision: sha, ...extra });

  const onBase = git(root, ["merge-base", "--is-ancestor", sha, `origin/${config.base_branch}`]).code === 0;
  if (!gate.check(onBase, "merged", `${sha.slice(0, 12)} is on origin/${config.base_branch}`, `${sha.slice(0, 12)} is not on origin/${config.base_branch}; deploy only merged revisions`)) return finish();
  const found = committed(root, sha);
  const problem = found.problem ?? deployProblem(found.config);
  if (!gate.check(!problem, "deploy files", `${found.scriptPath} and its deploy.json at ${sha.slice(0, 12)}`, problem)) return finish();
  const c = found.config;
  const host = hostFor(settings, c);
  const scriptSha = createHash("sha256").update(found.script).digest("hex");
  gate.pass("target", `${host.where}, health \`${c.health.command}\` expecting ${JSON.stringify(c.health.expected_stdout.trim())}`);
  if (args.plan) return finish({ status: "plan", script_path: found.scriptPath, script_sha256: scriptSha });

  if (!gate.check(settings.auto === true || args.approved, "approval", settings.auto === true ? "config deploy.auto is true" : "a person approved this deploy", "a person must approve this deploy first (config deploy.auto is not true)")) return finish();
  const file = path.join(root, ".cstack", "deploys", `${sha}.json`);
  if (existsSync(file)) {
    const prior = JSON.parse(readFileSync(file, "utf8"));
    const interrupted = prior.status === "running";
    const detail = interrupted ? `an earlier deploy of ${sha.slice(0, 12)} started ${prior.started} and never finished; check the host, then remove ${file} to deploy again` : `already deployed: ${prior.status}; this revision runs once`;
    gate.check(prior.status === "healthy", "once", detail, detail);
    return finish({ status: prior.status, result: file });
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ revision: sha, status: "running", started: new Date().toISOString() })}\n`);
  const script = host.execute(found.script);
  const observations = script.exit_code === 0 ? await poll(host, c.health) : [];
  const healthy = observations.some((o) => o.healthy);
  const status = script.exit_code !== 0 ? "script_failed" : healthy ? "healthy" : "health_timeout";
  const result = { revision: sha, host: c.host, script_path: found.scriptPath, script_sha256: scriptSha, status, script, health_observations: observations, deployed_revision: healthy ? sha : null };
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  gate.check(script.exit_code === 0, "script", `exit 0`, `exit ${script.exit_code}: ${(script.stderr || script.stdout).trim().split("\n").at(-1)}`);
  if (script.exit_code === 0) gate.check(healthy, "health", `healthy after ${observations.length} polls`, `not healthy after ${observations.length} polls in ${c.health.timeout_seconds}s; last stdout ${JSON.stringify(observations.at(-1).stdout.trim())}`);
  return finish({ status, result: file });
});

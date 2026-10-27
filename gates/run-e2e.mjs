#!/usr/bin/env node
// Run the hidden e2e suite against a commit and report only lane ids and one-line reasons.
// Usage: run-e2e.mjs <worktree-dir> [--sha <commit>] [--lanes E1.1,E2.1] [--raw] [--json]
// It clones the repo into a temporary grader checkout (full, not sparse) at the commit,
// runs config setup_command then e2e_command with CSTACK_ROLE=grader and CI=1, and parses TAP.
// Test names must start with the lane id (for example "E1.2 rejects an empty title").
// --raw prints the full suite output and is allowed only when CSTACK_ROLE=grader.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Gate, main, parseArgs, UsageError, loadConfig, run, gitOut, globPrefix } from "./lib/common.mjs";

// Parse TAP: lane id -> {ok, reason}. A lane reported more than once fails if any report fails.
function parseTap(text) {
  const lanes = new Map();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(not )?ok \d+ - (E\d+\.\d+)\b/);
    if (!m) continue;
    const ok = !m[1];
    let reason = "";
    if (!ok) {
      for (let j = i + 1; j < lines.length && j < i + 40; j++) {
        if (/^\s*(not )?ok \d+ /.test(lines[j])) break;
        const r = lines[j].match(/^\s*(?:message|error):\s*['"|>-]*\s*(.*?)['"]?\s*$/);
        if (!r) continue;
        // Block scalars (error: |-) carry the text on the next line.
        reason = r[1] || String(lines[j + 1]).trim();
        break;
      }
    }
    const prev = lanes.get(m[2]);
    if (!prev || (prev.ok && !ok)) lanes.set(m[2], { ok, reason });
  }
  return lanes;
}

// One line, no paths into the suite, bounded length.
function clean(reason, hiddenPrefixes) {
  let r = reason.replace(/\s+/g, " ").trim();
  for (const p of hiddenPrefixes) r = r.split(p).join("<hidden>");
  return r.length > 200 ? r.slice(0, 197) + "..." : r || "failed (no message)";
}

await main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json", "raw"], options: ["sha", "lanes"] });
  const [wt] = args._;
  if (!wt) throw new UsageError("usage: run-e2e.mjs <worktree-dir> [--sha <commit>] [--lanes E1.1,E2.1] [--raw] [--json]");
  if (args.raw && process.env.CSTACK_ROLE !== "grader") throw new UsageError("--raw is only allowed for CSTACK_ROLE=grader");
  const { config } = loadConfig(wt);
  if (!Array.isArray(config.e2e_command) || !config.e2e_command.length) throw new UsageError("config e2e_command is not set");
  const sha = gitOut(wt, ["rev-parse", args.sha || "HEAD"]);
  const commonDir = path.resolve(wt, gitOut(wt, ["rev-parse", "--git-common-dir"]));
  const hidden = config.paths_hidden.map(globPrefix).filter(Boolean);
  const timeout = config.limits.test_timeout_seconds * 1000;
  const env = { ...process.env, CSTACK_ROLE: "grader", CI: "1" };

  const gate = new Gate("run-e2e", { json: args.json });
  const dir = mkdtempSync(path.join(tmpdir(), "cstack-grader-"));
  try {
    const clone = run("git", ["clone", "--quiet", "--shared", "--no-checkout", commonDir, dir]);
    // A local --shared clone of an existing repo cannot fail short of a broken disk.
    /* node:coverage disable */
    if (clone.code !== 0) throw new UsageError(`grader clone failed: ${clone.stderr.trim()}`);
    /* node:coverage enable */
    gitOut(dir, ["-c", "advice.detachedHead=false", "checkout", "--quiet", sha]);

    if (Array.isArray(config.setup_command) && config.setup_command.length) {
      const s = run(config.setup_command[0], config.setup_command.slice(1), { cwd: dir, env, timeout });
      if (s.code !== 0) {
        gate.fail("setup", `setup_command exited ${s.code}`);
        return gate.finish({ sha });
      }
    }
    const r = run(config.e2e_command[0], config.e2e_command.slice(1), { cwd: dir, env, timeout });
    if (args.raw) process.stderr.write(r.stdout + r.stderr);
    const lanes = parseTap(r.stdout);
    const wanted = args.lanes ? args.lanes.split(",").map((s) => s.trim()).filter(Boolean) : [...lanes.keys()].sort();

    if (r.timedOut) gate.fail("suite", `timed out after ${timeout / 1000}s`);
    if (!lanes.size) gate.fail("suite", `no lane results in TAP output (exit ${r.code}); test names must start with a lane id`);
    for (const id of wanted) {
      const l = lanes.get(id);
      if (!l) gate.fail(id, "lane not reported by the suite");
      else if (l.ok) gate.pass(id, "pass");
      else gate.fail(id, clean(l.reason, hidden));
    }
    return gate.finish({ sha, lanes: Object.fromEntries([...lanes].map(([k, v]) => [k, v.ok ? "pass" : "fail"])) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

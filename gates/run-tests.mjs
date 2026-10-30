#!/usr/bin/env node
// Run config test_command in a worktree, for workers and verifiers (cstack#44). The role allowlist matches the bare
// command only, and a subagent's shell starts in the repo root, so `cd <worktree> && npm test` is refused; every role
// may run the plugin's scripts. It reads and writes no result cache: a run on uncommitted edits proves nothing about
// a commit, and only check-commit and check-verdict decide. Extra arguments after `--` go to the test command.
// Usage: run-tests.mjs <worktree> [--lines 40] [--json] [-- <test args>]
// Exit 0 when the tests pass, 1 when they fail or time out, 2 on usage errors.
import path from "node:path";
import { Gate, main, parseArgs, UsageError, loadConfig, run } from "./lib/common.mjs";

await main(async (argv) => {
  const dash = argv.indexOf("--");
  const own = dash < 0 ? argv : argv.slice(0, dash);
  const extra = dash < 0 ? [] : argv.slice(dash + 1);
  const args = parseArgs(own, { flags: ["json"], options: ["lines"] });
  const lines = Number(args.lines ?? 40);
  if (args._.length !== 1 || !Number.isInteger(lines) || lines < 1) throw new UsageError("usage: run-tests.mjs <worktree> [--lines n] [--json] [-- <test args>]");
  const wt = path.resolve(args._[0]);
  const { config } = loadConfig(wt);
  if (!Array.isArray(config.test_command) || !config.test_command.length) throw new UsageError("config test_command is not set");
  const gate = new Gate("run-tests", { json: args.json });
  const [cmd, ...rest] = config.test_command;
  const r = run(cmd, [...rest, ...extra], { cwd: wt, env: { ...process.env, CI: "1" }, timeout: (config.limits?.test_timeout_seconds ?? 600) * 1000 });
  const tail = `${r.stdout}${r.stderr}`.trim().split("\n").slice(-lines).join("\n");
  const ok = r.code === 0 && !r.timedOut;
  gate.check(ok, "tests", `${config.test_command.join(" ")} passed\n${tail}`, `${r.timedOut ? "timed out" : `exit ${r.code}`}\n${tail}`);
  return gate.finish({ ok, code: r.code, timed_out: Boolean(r.timedOut), tail });
});

#!/usr/bin/env node
// Create an implementer worktree that does not contain the hidden e2e suite.
// Usage: isolate.mjs <repo-dir> <branch> <worktree-dir> [--base <ref>] [--json]
// The branch is created from --base unless it already exists. Without --base it starts at
// origin/<base_branch> after a fetch, or at the local base_branch when there is no origin remote.
// The output names the start ref and commit.
// The worktree gets a per-worktree sparse checkout that excludes every paths_hidden prefix,
// so the suite is not on disk for implementers. The guard hook is the second layer.
import { existsSync } from "node:fs";
import path from "node:path";
import { Gate, main, parseArgs, UsageError, loadConfig, git, gitOut, globPrefix } from "./lib/common.mjs";

await main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json"], options: ["base"] });
  const [repoDir, branch, wtDir] = args._;
  if (!repoDir || !branch || !wtDir) throw new UsageError("usage: isolate.mjs <repo-dir> <branch> <worktree-dir> [--base <ref>]");
  const { root, config } = loadConfig(repoDir);
  const gate = new Gate("isolate", { json: args.json });
  const target = path.resolve(wtDir);
  if (existsSync(target)) throw new UsageError(`${target} already exists`);

  const prefixes = config.paths_hidden.map(globPrefix);
  if (prefixes.some((p) => !p)) throw new UsageError("every paths_hidden glob needs a literal directory prefix (for example tests/acceptance/**)");

  const exists = git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;
  const start = exists ? branch : args.base || startRef(root, config.base_branch);
  const add = exists
    ? git(root, ["worktree", "add", "--quiet", target, branch])
    : git(root, ["worktree", "add", "--quiet", "-b", branch, target, start]);
  if (add.code !== 0) throw new UsageError(`git worktree add failed: ${add.stderr.trim()}`);
  const sha = gitOut(target, ["rev-parse", "HEAD"]);
  gate.pass("worktree", `${target} on ${branch}${exists ? " (existing branch)" : ""} from ${start} at ${sha.slice(0, 12)}`);

  if (prefixes.length) {
    const patterns = ["/*", ...prefixes.map((p) => `!/${p}/`)];
    gitOut(target, ["sparse-checkout", "set", "--no-cone", ...patterns]);
    const leaked = prefixes.filter((p) => existsSync(path.join(target, p)));
    gate.check(leaked.length === 0, "hidden paths absent", prefixes.join(", "), `still on disk: ${leaked.join(", ")}`);
  } else {
    gate.pass("hidden paths absent", "no paths_hidden configured");
  }
  return gate.finish({ worktree: target, branch, start, sha });
});

// A local base branch can lag its remote (an unpulled checkout), so prefer the fetched remote copy.
function startRef(root, base) {
  if (!git(root, ["remote"]).stdout.split("\n").includes("origin")) return base;
  const fetch = git(root, ["fetch", "--quiet", "origin", base]);
  if (fetch.code !== 0) throw new UsageError(`git fetch origin ${base} failed: ${fetch.stderr.trim()}`);
  return `origin/${base}`;
}

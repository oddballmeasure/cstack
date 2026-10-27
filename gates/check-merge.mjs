#!/usr/bin/env node
// The only path to merge (tstack merge gate + Cardinal merge rules).
// Usage: check-merge.mjs <pr> --unit <id> [--repo-dir <dir>] [--store <dir>] [--merge] [--json]
// Checks: PR open and not draft; ledger approval for the exact head SHA; required checks green on that SHA;
// no change requests; GitHub merge state not DIRTY/BEHIND/BLOCKED/UNKNOWN; base has not moved under the PR's files.
// --merge merges only when every check passes AND config autonomy is "send". It runs
// `gh pr merge --merge --match-head-commit <sha>` as a subprocess (the guard hook blocks the model from doing that).
// A merge command that reports an error still counts when GitHub shows the PR merged at the verified head.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Gate, main, parseArgs, UsageError, loadConfig, run, git } from "./lib/common.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PR_FIELDS = "number,state,isDraft,headRefOid,baseRefName,baseRefOid,mergeStateStatus,reviewDecision,mergeCommit,files";
const OK_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

function gh(args, cwd) {
  return run("gh", args, { cwd });
}

function prView(pr, repo, cwd) {
  const r = gh(["pr", "view", String(pr), "--repo", repo, "--json", PR_FIELDS], cwd);
  if (r.code !== 0) throw new UsageError(`gh pr view ${pr} failed: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

await main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json", "merge"], options: ["unit", "repo-dir", "store"] });
  const [pr] = args._;
  if (!pr || !/^\d+$/.test(pr) || !args.unit) throw new UsageError("usage: check-merge.mjs <pr> --unit <id> [--repo-dir <dir>] [--store <dir>] [--merge]");
  const repoDir = args["repo-dir"] || process.cwd();
  const { config } = loadConfig(repoDir);
  const repo = config.repo;
  const gate = new Gate("check-merge", { json: args.json });

  const p = prView(pr, repo, repoDir);
  const sha = p.headRefOid;
  gate.check(p.state === "OPEN" && !p.isDraft, "pr state", `open at ${sha.slice(0, 12)}`, `state ${p.state}${p.isDraft ? " (draft)" : ""}`);

  const storeArgs = args.store ? ["--store", args.store] : [];
  const ledger = run(process.execPath, [path.join(HERE, "orch.mjs"), ...storeArgs, "ledger", "check", args.unit, sha], { cwd: repoDir });
  gate.check(ledger.code === 0, "ledger", `approval recorded for ${args.unit} at ${sha.slice(0, 12)}`, `no approval for ${args.unit} at ${sha.slice(0, 12)}; verify this head first`);

  const required = config.required_checks;
  if (required.length) {
    const r = gh(["api", `repos/${repo}/commits/${sha}/check-runs?per_page=100`, "--jq", ".check_runs"], repoDir);
    if (r.code !== 0) gate.fail("required checks", `cannot read check runs: ${r.stderr.trim()}`);
    else {
      // Newest run per name wins.
      const latest = new Map();
      for (const c of JSON.parse(r.stdout)) {
        const prev = latest.get(c.name);
        if (!prev || String(c.started_at) > String(prev.started_at)) latest.set(c.name, c);
      }
      for (const name of required) {
        const c = latest.get(name);
        gate.check(
          !!c && c.status === "completed" && OK_CONCLUSIONS.has(c.conclusion),
          `check ${name}`,
          c?.conclusion,
          !c ? "not reported on this SHA" : c.status !== "completed" ? `still ${c.status}` : `concluded ${c.conclusion}`,
        );
      }
    }
  } else {
    gate.pass("required checks", "none configured");
  }

  gate.check(p.reviewDecision !== "CHANGES_REQUESTED", "reviews", p.reviewDecision || "no decision required", "changes requested");
  gate.check(!["DIRTY", "BEHIND", "BLOCKED", "UNKNOWN"].includes(p.mergeStateStatus), "merge state", p.mergeStateStatus, `${p.mergeStateStatus}${p.mergeStateStatus === "UNKNOWN" ? " (GitHub still computing; retry)" : ""}`);

  // Base moved since the PR was based: refuse if the new base commits touch the PR's files.
  const fetch = git(repoDir, ["fetch", "--quiet", "origin", p.baseRefName]);
  if (fetch.code !== 0) gate.fail("base", `git fetch failed: ${fetch.stderr.trim()}`);
  else {
    const tip = git(repoDir, ["rev-parse", `origin/${p.baseRefName}`]).stdout.trim();
    if (tip && tip !== p.baseRefOid) {
      const moved = git(repoDir, ["diff", "--name-only", `${p.baseRefOid}..${tip}`]).stdout.split("\n").filter(Boolean);
      const prFiles = new Set(p.files.map((f) => f.path));
      const overlap = moved.filter((f) => prFiles.has(f));
      gate.check(!overlap.length, "base", `base moved without touching PR files`, `base moved and touched: ${overlap.join(", ")}; sync the branch and verify again`);
    } else {
      gate.pass("base", "PR is on the current base");
    }
  }

  let merged = null;
  if (args.merge && gate.approved) {
    if (config.autonomy !== "send") {
      gate.fail("autonomy", "autonomy is stop; the PR is merge-ready and a human merges it");
    } else {
      const m = gh(["pr", "merge", String(pr), "--repo", repo, "--merge", "--match-head-commit", sha], repoDir);
      const after = prView(pr, repo, repoDir);
      const ok = after.state === "MERGED" && after.headRefOid === sha && after.mergeCommit?.oid;
      if (ok) {
        merged = after.mergeCommit.oid;
        gate.pass("merge", `merged at ${sha.slice(0, 12)} as ${merged.slice(0, 12)}${m.code !== 0 ? " (merge command reported an error, GitHub shows it merged)" : ""}`);
      } else {
        gate.fail("merge", `merge failed: ${m.stderr.trim() || after.state}`);
      }
    }
  }

  return gate.finish({ pr: Number(pr), sha, merge_sha: merged });
});

#!/usr/bin/env node
// The only path to merge (tstack merge gate + Cardinal merge rules).
// Usage: check-merge.mjs <pr> --unit <id> [--repo-dir <dir>] [--store <dir>] [--merge] [--json]
// Checks: PR open and not draft; ledger approval for the exact head SHA; a review-loop APPROVE round at that
// head (not for docs-only diffs, nor for unit E2E when it touches only paths_hidden and the config); required checks green on that SHA;
// no change requests; GitHub merge state not DIRTY/BEHIND/BLOCKED/UNKNOWN; base has not moved under the PR's files.
// --merge merges only when every check passes AND the run's effective autonomy is "send": config autonomy,
// overridden by <store>/run.json, which may only lower it unless this session has
// CSTACK_PROGRAM_AUTONOMY=send (gates/lib/run.mjs). It runs
// the forge's merge at exactly that SHA with a merge commit (`gh pr merge --merge --match-head-commit <sha>` on GitHub)
// as a subprocess (the guard hook blocks the model from doing that). A merge command that reports an error still
// counts when the forge shows the change merged at the verified head.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { Gate, main, parseArgs, UsageError, loadConfig, run, git, matchesAny } from "./lib/common.mjs";
import { isDoc } from "./lib/repo.mjs";
import { effectiveAutonomy } from "./lib/run.mjs";
import { openForge } from "./lib/forge.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

await main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json", "merge"], options: ["unit", "repo-dir", "store"] });
  const [pr] = args._;
  if (!pr || !/^\d+$/.test(pr) || !args.unit) throw new UsageError("usage: check-merge.mjs <pr> --unit <id> [--repo-dir <dir>] [--store <dir>] [--merge]");
  const repoDir = args["repo-dir"] || process.cwd();
  const { config } = loadConfig(repoDir);
  const forge = openForge(config, { cwd: repoDir });
  const gate = new Gate("check-merge", { json: args.json });

  const p = forge.change(pr);
  const sha = p.head;
  gate.check(p.state === "open" && !p.draft, "pr state", `open at ${sha.slice(0, 12)}`, `state ${p.state.toUpperCase()}${p.draft ? " (draft)" : ""}`);

  const storeArgs = args.store ? ["--store", args.store] : [];
  const ledger = run(process.execPath, [path.join(HERE, "orch.mjs"), ...storeArgs, "ledger", "check", args.unit, sha], { cwd: repoDir });
  gate.check(ledger.code === 0, "ledger", `approval recorded for ${args.unit} at ${sha.slice(0, 12)}`, `no approval for ${args.unit} at ${sha.slice(0, 12)}; verify this head first`);

  // Review loop (unit stage 10b): a diff that touches more than docs needs an APPROVE round at this exact
  // head and no open blocker or should finding. The files come from cstack:review-loop.
  const store = args.store || path.join(repoDir, ".cstack", "runs", process.env.CSTACK_RUN || "");
  // PR #0 (unit E2E) holds only the hidden suite and the config line that runs it. A reviewer may not
  // read paths_hidden, so check-e2e, the red check and the mutation spot-check judge it instead.
  const code = p.files.filter((f) => !isDoc(f));
  const suiteOnly = args.unit === "E2E" && code.every((f) => f === ".cstack/config.json" || matchesAny(f, config.paths_hidden));
  if (!code.length) {
    gate.pass("review", "docs-only change; no review round needed");
  } else if (suiteOnly) {
    gate.pass("review", "hidden e2e suite change; judged by check-e2e, not a reviewer");
  } else {
    const rows = (name) => {
      const file = path.join(store, name);
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
    };
    const approved = rows(`review-${args.unit}-rounds.tsv`).some((r) => r[1] === sha && r[3] === "APPROVE");
    const open = rows(`review-${args.unit}.tsv`).filter((r) => ["blocker", "should"].includes(r[2]) && r[5] === "open").map((r) => r[0]);
    gate.check(
      approved && !open.length,
      "review",
      `review-loop approved ${sha.slice(0, 12)}`,
      !approved ? `no review-loop APPROVE round at ${sha.slice(0, 12)}; run cstack:review-loop on this head` : `open review findings: ${open.join(", ")}`,
    );
  }

  const required = config.required_checks;
  if (required.length) {
    let checks = null;
    try {
      checks = forge.checks(sha);
    } catch (err) {
      gate.fail("required checks", `cannot read check runs: ${err.message}`);
    }
    if (checks) {
      // Newest run per name wins.
      const latest = new Map(checks.map((c) => [c.name, c]));
      for (const name of required) {
        const c = latest.get(name);
        gate.check(
          !!c && (c.state === "pass" || c.state === "skipped"),
          `check ${name}`,
          c?.conclusion,
          !c ? "not reported on this SHA" : c.status !== "completed" ? `still ${c.status}` : `concluded ${c.conclusion}`,
        );
      }
    }
  } else {
    gate.pass("required checks", "none configured");
  }

  gate.check(p.review !== "changes", "reviews", p.reviewRaw || "no decision required", "changes requested");
  gate.check(p.merge === "clean", "merge state", p.mergeRaw, `${p.mergeRaw}${p.merge === "unknown" ? ` (${forge.name} still computing; retry)` : ""}`);

  // Base moved since the PR was based: refuse if the new base commits touch the PR's files.
  const fetch = git(repoDir, ["fetch", "--quiet", "origin", p.base]);
  if (fetch.code !== 0) gate.fail("base", `git fetch failed: ${fetch.stderr.trim()}`);
  else {
    const tip = git(repoDir, ["rev-parse", `origin/${p.base}`]).stdout.trim();
    if (tip && tip !== p.baseSha) {
      const moved = git(repoDir, ["diff", "--name-only", `${p.baseSha}..${tip}`]).stdout.split("\n").filter(Boolean);
      const prFiles = new Set(p.files);
      const overlap = moved.filter((f) => prFiles.has(f));
      gate.check(!overlap.length, "base", `base moved without touching PR files`, `base moved and touched: ${overlap.join(", ")}; sync the branch and verify again`);
    } else {
      gate.pass("base", "PR is on the current base");
    }
  }

  let merged = null;
  if (args.merge && gate.approved) {
    const autonomy = effectiveAutonomy(config, store);
    if (autonomy.level !== "send") {
      gate.fail("autonomy", `autonomy is stop (${autonomy.source}${autonomy.note ? `; ${autonomy.note}` : ""}); the PR is merge-ready and a human merges it`);
    } else {
      gate.pass("autonomy", `send (${autonomy.source})`);
      const m = forge.merge(pr, sha);
      const after = forge.change(pr);
      const ok = after.state === "merged" && after.head === sha && after.mergeSha;
      if (ok) {
        merged = after.mergeSha;
        gate.pass("merge", `merged at ${sha.slice(0, 12)} as ${merged.slice(0, 12)}${!m.ok ? ` (merge command reported an error, ${forge.name} shows it merged)` : ""}`);
      } else {
        gate.fail("merge", `merge failed: ${m.error || after.state.toUpperCase()}`);
      }
    }
  }

  return gate.finish({ pr: Number(pr), sha, merge_sha: merged });
});

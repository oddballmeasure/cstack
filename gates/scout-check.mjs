#!/usr/bin/env node
// Gate: code checks on the scout's model output, before anyone spends attention on it.
// Adapted from Cardinal src/cardinal/scout/checks.py and roles/scout_{planner,repro}.py (oddballmeasure/cardinal, same owner).
// Usage:
//   scout-check.mjs plan <plan.json> [--repo-dir <d>] [--json]
//       {"areas": [{"name", "paths": [...], "focus"}]}: 3-6 areas, each path holds a tracked file agents may
//       see and is not the whole repo, and one area covers documentation when the repo tracks any.
//   scout-check.mjs proposals <file.json> [--repo-dir <d>] [--out <kept.json>] [--json]
//       {"proposals": [...]} or [...]: shape, enabled category, docs-only for docs, at most scout.max_files
//       tracked files that are not off limits or hidden, an exact value in every acceptance criterion, and
//       every evidence quote found in its file within 10 lines of the cited range (the range is corrected).
//       --out writes the kept proposals, each with its fingerprint and corrected evidence.
//   scout-check.mjs repro <worktree> --test-name <name> --out <diff> [--json]
//       The repro agent's uncommitted change: only test files, the test command green on the base commit,
//       red with the change, and the test name visible in that output. Writes the change as a diff.
//       status ok, refuted (the test passes: the bug did not reproduce), or invalid.
// Exit 0 approved, 1 rejected, 2 usage error.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Gate, main, parseArgs, UsageError, loadConfig, run, git, gitOut } from "./lib/common.mjs";
import { isTest, runTests } from "./lib/repo.mjs";
import { docsOnly, fingerprint, proposalProblem, scoutSettings, trackedFiles } from "./lib/scout.mjs";

const USAGE = "usage: scout-check.mjs plan|proposals <file> [--repo-dir d] [--out f] | repro <worktree> --test-name <n> --out <diff> [--json]";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new UsageError(`${file}: ${err.message}`);
  }
}

const covers = (area, file) => file === area || file.startsWith(`${area}/`);

function plan(gate, root, config, file) {
  const doc = readJson(file);
  const areas = Array.isArray(doc?.areas) ? doc.areas : [];
  gate.check(areas.length >= 3 && areas.length <= 6, "areas", `${areas.length} areas`, `${areas.length} areas; a plan has 3-6`);
  const tracked = [...trackedFiles(root, config)];
  for (const [i, a] of areas.entries()) {
    const named = typeof a?.name === "string" && a.name.trim() !== "";
    const name = named ? a.name : `#${i + 1}`;
    const paths = Array.isArray(a?.paths) ? a.paths.map((p) => String(p).replace(/^\/+|\/+$/g, "")) : [];
    let problem = null;
    if (!named || typeof a.focus !== "string" || !a.focus.trim()) problem = "needs a name and a focus";
    else if (paths.length < 1 || paths.length > 8) problem = "needs 1-8 paths";
    else if (paths.some((p) => p === "" || p === ".")) problem = "names the whole repository";
    else {
      const empty = paths.find((p) => !tracked.some((f) => covers(p, f)));
      if (empty !== undefined) problem = `names ${empty}, which holds no tracked file agents may see`;
    }
    gate.check(!problem, `area ${name}`, paths.join(", "), problem);
  }
  const docs = tracked.filter((f) => docsOnly([f]));
  const docArea = areas.find((a) => Array.isArray(a?.paths) && a.paths.some((p) => docs.some((f) => covers(String(p).replace(/^\/+|\/+$/g, ""), f))));
  if (!docs.length) gate.pass("docs area", "the repo tracks no documentation");
  else gate.check(Boolean(docArea), "docs area", `${docArea?.name} covers documentation`, "no area covers the documentation; pair the docs with the code they describe");
  return gate.finish();
}

function proposals(gate, root, config, file, out) {
  const doc = readJson(file);
  const list = Array.isArray(doc) ? doc : doc?.proposals;
  if (!Array.isArray(list)) throw new UsageError(`${file}: expected an array or {"proposals": [...]}`);
  const settings = scoutSettings(config);
  const tracked = trackedFiles(root, config);
  const seen = new Set();
  const kept = [];
  for (const [i, p] of list.entries()) {
    let problem = proposalProblem(root, p, tracked, config, settings);
    const key = problem ? null : fingerprint(p);
    if (key && seen.has(key)) problem = "proposed twice in this pass";
    if (problem) {
      gate.fail(`proposal ${i + 1}`, `${p?.title ?? "untitled"}: ${problem}`);
      continue;
    }
    seen.add(key);
    kept.push({ ...p, fingerprint: key });
    const moved = p.evidence.filter((e) => e.corrected_from).length;
    gate.pass(`proposal ${i + 1}`, `${p.title} (${key}${moved ? `, ${moved} evidence ranges corrected` : ""})`);
  }
  if (out) writeFileSync(out, `${JSON.stringify({ proposals: kept }, null, 2)}\n`);
  return gate.finish({ kept: kept.length, dropped: list.length - kept.length });
}

function repro(gate, wt, config, name, out) {
  gitOut(wt, ["add", "-A"]);
  const changed = gitOut(wt, ["diff", "--cached", "--name-only", "HEAD"]).split("\n").filter(Boolean);
  const others = changed.filter((f) => !isTest(f));
  const done = (status, ok, detail) => {
    gate.check(ok, "repro", detail, detail);
    return gate.finish({ status });
  };
  if (!changed.length) return done("invalid", false, "the repro wrote no test");
  if (others.length) return done("invalid", false, `the repro changed files that are not tests: ${others.join(", ")}`);
  gate.pass("tests only", changed.join(", "));
  const base = mkdtempSync(path.join(tmpdir(), "cstack-repro-base-"));
  gitOut(wt, ["worktree", "add", "--quiet", "--detach", base, "HEAD"]);
  let green;
  try {
    green = runTests(base, config).ok;
  } finally {
    git(wt, ["worktree", "remove", "--force", base]);
  }
  if (!green) return done("invalid", false, "the test command fails on the base branch, so no new test can show the bug");
  gate.pass("base green", "the test command passes on the base commit");
  const [cmd, ...args] = config.test_command;
  const r = run(cmd, args, { cwd: wt, env: { ...process.env, CI: "1" }, timeout: config.limits.test_timeout_seconds * 1000 });
  if (r.code === 0 && !r.timedOut) return done("refuted", false, `${name} passes on the base branch: the bug did not reproduce`);
  if (r.timedOut || !`${r.stdout}${r.stderr}`.includes(name)) return done("invalid", false, `the suite failed, but not visibly on ${name}`);
  writeFileSync(out, gitOut(wt, ["diff", "--cached", "HEAD"]) + "\n");
  return done("ok", true, `${name} fails on the base branch; diff in ${out}`);
}

await main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json"], options: ["repo-dir", "out", "test-name"] });
  const [command, target] = args._;
  if (args._.length !== 2 || !["plan", "proposals", "repro"].includes(command)) throw new UsageError(USAGE);
  if (command === "repro" && (!args["test-name"] || !args.out)) throw new UsageError(USAGE);
  const gate = new Gate(`scout-check ${command}`, { json: args.json });
  if (command === "repro") {
    const wt = path.resolve(target);
    return repro(gate, wt, loadConfig(wt).config, args["test-name"], path.resolve(args.out));
  }
  const { root, config } = loadConfig(args["repo-dir"] || process.cwd());
  if (command === "plan") return plan(gate, root, config, path.resolve(target));
  return proposals(gate, root, config, path.resolve(target), args.out && path.resolve(args.out));
});

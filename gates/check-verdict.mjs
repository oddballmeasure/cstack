#!/usr/bin/env node
// Gate on a verifier's assessment. The model argues; this decides (Cardinal verifier rules).
// Usage: check-verdict.mjs <worktree> --verdict <file.json> --base <ref> --requirements R1,R2 [--lanes E1.1,E2.1] [--json]
// verdict.json: {"unit":"U1","head_sha":"<sha>","requirements":[{"id":"R1","delivered":true,"evidence":"..."}],"findings":["..."]}
// Approved only when every check passes. The skill records the result in the ledger keyed by (unit, sha).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Gate, main, parseArgs, UsageError, loadConfig, gitOut, run } from "./lib/common.mjs";
import { changedFiles, pathViolations, runTests, isTest, isDoc } from "./lib/repo.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const list = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);

await main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json"], options: ["verdict", "base", "requirements", "lanes"] });
  const [wt] = args._;
  if (!wt || !args.verdict || !args.base || !args.requirements) {
    throw new UsageError("usage: check-verdict.mjs <worktree> --verdict <file> --base <ref> --requirements R1,R2 [--lanes E1.1]");
  }
  let v;
  try {
    v = JSON.parse(readFileSync(args.verdict, "utf8"));
  } catch (err) {
    throw new UsageError(`verdict ${args.verdict} does not parse: ${err.message}`);
  }
  const { config } = loadConfig(wt);
  const gate = new Gate("check-verdict", { json: args.json });
  const head = gitOut(wt, ["rev-parse", "HEAD"]);

  gate.check(v.head_sha === head, "head", `verdict names HEAD ${head.slice(0, 12)}`, `verdict names ${v.head_sha || "nothing"}, HEAD is ${head}`);

  const wanted = list(args.requirements);
  const given = new Map((Array.isArray(v.requirements) ? v.requirements : []).map((r) => [r.id, r]));
  for (const id of wanted) {
    const r = given.get(id);
    gate.check(
      !!r && r.delivered === true && typeof r.evidence === "string" && r.evidence.trim().length > 0,
      `requirement ${id}`,
      "delivered with evidence",
      !r ? "not assessed" : r.delivered !== true ? "not delivered" : "no evidence given",
    );
  }
  const unknown = [...given.keys()].filter((id) => !wanted.includes(id));
  gate.check(!unknown.length, "requirement ids", "all known", `unknown requirements: ${unknown.join(", ")}`);

  const modelFindings = Array.isArray(v.findings) ? v.findings.filter((f) => String(f).trim()) : [];
  gate.check(!modelFindings.length, "verifier findings", "none", modelFindings.join("; "));

  const files = changedFiles(wt, args.base);
  const code = files.filter((f) => !isTest(f) && !isDoc(f));
  const tests = files.filter(isTest);
  gate.check(!code.length || tests.length > 0, "tests changed", code.length ? `${tests.length} test files changed` : "docs or tests only", `code changed (${code.join(", ")}) with no test change`);

  const bad = pathViolations(files, config);
  gate.check(!bad.length, "paths", "no hidden or off-limits paths changed", bad.join("; "));

  const t = runTests(wt, config);
  gate.check(t.ok, "tests at head", `test_command passed${t.cached ? " (cached)" : ""}`, `test_command ${t.timedOut ? "timed out" : `exited ${t.code}`}:\n${t.tail}`);

  const lanes = list(args.lanes);
  if (lanes.length) {
    const r = run(process.execPath, [path.join(HERE, "run-e2e.mjs"), wt, "--lanes", lanes.join(","), "--json"]);
    let report;
    try {
      report = JSON.parse(r.stdout);
    } catch {
      report = null;
    }
    if (!report) gate.fail("e2e", `run-e2e failed: ${r.stderr.trim().split("\n").pop()}`);
    else for (const f of report.findings) gate.fail(`e2e ${f.check}`, f.detail);
    if (report && report.approved) gate.pass("e2e", `${lanes.length} lanes pass`);
  }

  return gate.finish({ unit: v.unit, head });
});

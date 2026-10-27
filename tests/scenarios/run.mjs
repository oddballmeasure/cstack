#!/usr/bin/env node
// L3 scenario runner. Runs one scenario against the private testbed with a real headless Claude Code session.
// Usage: node tests/scenarios/run.mjs <scenario> [--keep]
// A scenario is tests/scenarios/<name>/scenario.mjs exporting:
//   setup(ctx)   prepare the testbed (issues, branches, store) and return { prompt, issue? }
//   expect(ctx)  assertions after the session; throw on failure
//   timeoutMinutes (default 60)
// ctx: { name, testbed (a fresh clone), cstack, repo, outDir, sh, gh, git, issue, result }
//   teardown(ctx) optional, runs after expect
// Each run writes tests/scenarios/results/<name>-<ts>/{session.jsonl, stderr.log, verdict.json}.
// Needs: ~/cstack-testbed clone, gh auth, claude CLI on subscription. Not run in CI.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSTACK = path.resolve(HERE, "../..");
const REPO = "oddballmeasure/cstack-testbed";

const name = process.argv[2];
if (!name || !existsSync(path.join(HERE, name, "scenario.mjs"))) {
  console.error("usage: run.mjs <scenario>");
  process.exit(2);
}
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(HERE, "results", `${name}-${ts}`);
mkdirSync(outDir, { recursive: true });
// Each scenario works in its own fresh clone, so scenarios can run in parallel.
const TESTBED = path.join(outDir, "testbed");

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
  return r.stdout.trim();
}
const git = (...a) => sh("git", ["-C", TESTBED, ...a]);
const gh = (...a) => sh("gh", [...a, "--repo", REPO]);

const ctx = { name, testbed: TESTBED, cstack: CSTACK, repo: REPO, outDir, sh, gh, git };
const mod = await import(path.join(HERE, name, "scenario.mjs"));

sh("gh", ["repo", "clone", REPO, TESTBED, "--", "-q"]);
git("config", "user.name", "cstack-scenario");
git("config", "user.email", "cstack@users.noreply.github.com");

const { prompt, issue } = await mod.setup(ctx);
ctx.issue = issue;
ctx.result = { exit: 0, seconds: 0, events: [], final: "" };
if (prompt) await session(prompt);

async function session(prompt) {
writeFileSync(path.join(outDir, "prompt.txt"), prompt);

// Run the session detached under systemd so a long run survives this process (ADR-001).
const script = path.join(outDir, "session.sh");
writeFileSync(
  script,
  `#!/bin/sh
cd ${JSON.stringify(TESTBED)}
exec env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN PATH=${JSON.stringify(path.dirname(process.execPath) + ":" + process.env.HOME + "/.local/bin:/usr/local/bin:/usr/bin:/bin")} \\
  claude -p --output-format stream-json --verbose --strict-mcp-config --plugin-dir ${JSON.stringify(CSTACK)} --dangerously-skip-permissions \\
  "$(cat ${JSON.stringify(path.join(outDir, "prompt.txt"))})" > ${JSON.stringify(path.join(outDir, "session.jsonl"))} 2> ${JSON.stringify(path.join(outDir, "stderr.log"))}
`,
  { mode: 0o755 },
);
const unit = `cstack-scenario-${name}-${process.pid}`;
const minutes = mod.timeoutMinutes || 60;
const started = Date.now();
const run = spawnSync("systemd-run", ["--user", "--wait", "--collect", "--quiet", `--unit=${unit}`, `--property=RuntimeMaxSec=${minutes * 60}`, script], { encoding: "utf8" });
const seconds = Math.round((Date.now() - started) / 1000);

const lines = existsSync(path.join(outDir, "session.jsonl")) ? readFileSync(path.join(outDir, "session.jsonl"), "utf8").split("\n").filter(Boolean) : [];
const events = lines.map((l) => {
  try {
    return JSON.parse(l);
  } catch {
    return {};
  }
});
const init = events.find((e) => e.type === "system" && e.subtype === "init") || {};
const results = events.filter((e) => e.type === "result");
ctx.result = { exit: run.status, seconds, apiKeySource: init.apiKeySource, final: results.at(-1)?.result || "", events };
}

let verdict;
const seconds = ctx.result.seconds;
try {
  if (ctx.result.apiKeySource && ctx.result.apiKeySource !== "none") throw new Error(`session billed through ${init.apiKeySource}; scenarios must run on the subscription`);
  await mod.expect(ctx);
  verdict = { scenario: name, pass: true, seconds };
} catch (err) {
  verdict = { scenario: name, pass: false, seconds, error: String(err.stack || err) };
}
if (mod.teardown) await mod.teardown(ctx);
writeFileSync(path.join(outDir, "verdict.json"), JSON.stringify(verdict, null, 2));
console.log(`${verdict.pass ? "PASS" : "FAIL"} ${name} (${seconds}s) ${outDir}`);
if (!verdict.pass) console.log(verdict.error);
process.exit(verdict.pass ? 0 : 1);

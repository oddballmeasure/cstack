#!/usr/bin/env node
// CI's gate coverage bar: the coverage:gates command from package.json, judged so that a one-off gap cannot fail it.
// About 240 gate branches are taken by a single child process, so losing one child's coverage shows up as a
// branch with no uncovered line, and a rerun passes. A real gap repeats, so a gap fails the bar only when a second
// run has it too. A failing test is never retried. Every gap is named from the run that had it.
// Usage: node tests/lint/coverage-bar.mjs
import { readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Lines inside /* node:coverage disable */ ... /* node:coverage enable */ do not count toward the bar.
function disabledLines(source) {
  const off = new Set();
  let on = true;
  source.split("\n").forEach((text, i) => {
    if (text.includes("node:coverage disable")) on = false;
    if (!on) off.add(i + 1);
    if (text.includes("node:coverage enable")) on = true;
  });
  return off;
}

// Every branch an lcov report did not take, as <file>:<line> block <b> branch <n>.
export function missesFromLcov(lcov, root = ROOT, readSource = (file) => readFileSync(path.join(root, file), "utf8")) {
  const disabled = new Map();
  let file = "";
  const misses = new Set();
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) file = path.relative(root, path.resolve(root, line.slice(3))).split(path.sep).join("/");
    const m = line.match(/^BRDA:(\d+),(\d+),(\d+),(-|0)$/);
    if (!m) continue;
    if (!disabled.has(file)) disabled.set(file, disabledLines(readSource(file)));
    if (!disabled.get(file).has(Number(m[1]))) misses.add(`${file}:${m[1]} block ${m[2]} branch ${m[3]}`);
  }
  return [...misses].sort();
}

// runOnce() gives { code, failedTests, misses }. Returns the exit code; say prints.
export function judge(runOnce, say = console.log) {
  const first = runOnce();
  if (first.code === 0) return 0;
  if (first.failedTests > 0) return say(`${first.failedTests} test(s) failed; the bar is not retried.`), first.code;
  say(`Coverage bar failed. Uncovered in this run:\n${first.misses.join("\n") || "(no branch named: a line gap)"}\nRunning once more: a real gap repeats.`);
  const second = runOnce();
  if (second.code === 0) return say(`::warning::Gate coverage lost in one run only: ${first.misses.join(", ") || "a line"}`), 0;
  if (second.failedTests === 0) say(`Uncovered in the second run:\n${second.misses.join("\n") || "(no branch named: a line gap)"}`);
  return second.code;
}

function runCoverage() {
  const script = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts["coverage:gates"];
  const args = script.split(/\s+/).slice(1).map((a) => a.replaceAll('"', ""));
  const lcov = path.join(tmpdir(), `cstack-coverage-${process.pid}.lcov`);
  const r = spawnSync(process.execPath, ["--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=lcov", `--test-reporter-destination=${lcov}`, ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "inherit"] });
  process.stdout.write(r.stdout);
  const failedTests = Number(r.stdout.match(/^ℹ fail (\d+)$/m)?.[1] ?? 0);
  const misses = missesFromLcov(readFileSync(lcov, "utf8"));
  rmSync(lcov, { force: true });
  return { code: r.status ?? 1, failedTests, misses };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(judge(runCoverage));

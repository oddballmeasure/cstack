// Repo-state helpers shared by check-commit and check-verdict.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { run, gitOut, matchesAny } from "./common.mjs";

export function changedFiles(wt, base) {
  const out = gitOut(wt, ["diff", "--name-only", `${base}...HEAD`]);
  return out ? out.split("\n") : [];
}

const TEST_RE = [/(^|\/)(tests?|__tests__|spec|specs)\//, /\.(test|spec)\.[^/]+$/, /_test\.[^/]+$/, /(^|\/)test_[^/]+\.py$/];
const DOC_RE = [/\.(md|mdx|txt|rst|adoc)$/i, /^docs\//, /(^|\/)(LICENSE|NOTICE|CHANGELOG)[^/]*$/];

export const isTest = (f) => TEST_RE.some((r) => r.test(f));
export const isDoc = (f) => DOC_RE.some((r) => r.test(f));

// Files that break the hidden or off-limits rules.
export function pathViolations(files, config) {
  const out = [];
  for (const f of files) {
    const h = matchesAny(f, config.paths_hidden);
    if (h) out.push(`${f} is hidden (${h})`);
    const o = matchesAny(f, [...config.paths_off_limits, ".git/**", ".cstack/config.json"]);
    if (o) out.push(`${f} is off limits (${o})`);
  }
  return out;
}

// Test results keyed by tree hash, so an identical tree is not tested twice (Cardinal fingerprint reuse).
function cacheFile(wt, tree) {
  const common = path.resolve(wt, gitOut(wt, ["rev-parse", "--git-common-dir"]));
  return path.join(common, "cstack-test-cache", `${tree}.json`);
}

export function runTests(wt, config, { useCache = true } = {}) {
  const tree = gitOut(wt, ["rev-parse", "HEAD^{tree}"]);
  const file = cacheFile(wt, tree);
  // Only a pass is reused. A failure is always re-run, so a flaky red never sticks.
  if (useCache && existsSync(file)) {
    const prev = JSON.parse(readFileSync(file, "utf8"));
    if (prev.ok) return { ...prev, cached: true };
  }
  const [cmd, ...args] = config.test_command;
  const timeout = config.limits.test_timeout_seconds * 1000;
  const r = run(cmd, args, { cwd: wt, env: { ...process.env, CI: "1" }, timeout });
  const tail = (r.stdout + r.stderr).trim().split("\n").slice(-20).join("\n");
  const result = { tree, ok: r.code === 0 && !r.timedOut, code: r.code, timedOut: !!r.timedOut, tail };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(result));
  return { ...result, cached: false };
}

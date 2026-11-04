// Repo-state helpers shared by check-commit, check-verdict and check-merge.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { run, gitOut, matchesAny } from "./common.mjs";

// Renames split into a delete and an add, so a file moved out of src/ still shows its old path. -z: paths come
// NUL-separated and unquoted, so a name with a tab, newline or non-ASCII byte is listed as it is.
export function changedFiles(wt, base) {
  return gitOut(wt, ["diff", "-z", "--name-only", "--no-renames", `${base}...HEAD`], { trim: false }).split("\0").filter(Boolean);
}

const TEST_RE = [/(^|\/)(tests?|__tests__|spec|specs|e2e)\//, /\.(test|spec|e2e)\.[^/]+$/, /_test\.[^/]+$/, /(^|\/)test_[^/]+\.py$/];
const DOC_RE = [/\.(md|mdx|txt|rst|adoc)$/i, /^docs\//, /(^|\/)(LICENSE|NOTICE|CHANGELOG)[^/]*$/];

export const isTest = (f) => TEST_RE.some((r) => r.test(f));
export const isDoc = (f) => DOC_RE.some((r) => r.test(f));

// The doc test for the docs-only exemptions (check-merge's review round, check-verdict's tests-changed check):
// config docs_paths (globs) when it is a list, else isDoc. [] means no file is a doc. A repo whose markdown is
// product (skills, prompts, a content site) sets docs_paths so those files need a review and a test.
export const docTest = (config) => (Array.isArray(config.docs_paths) ? (f) => !!matchesAny(f, config.docs_paths) : isDoc);

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

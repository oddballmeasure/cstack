import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LINT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "lint.mjs");

function fixture(skills) {
  const root = mkdtempSync(path.join(tmpdir(), "cstack-lint-"));
  mkdirSync(path.join(root, ".claude-plugin"));
  writeFileSync(path.join(root, ".claude-plugin/plugin.json"), "{}");
  writeFileSync(path.join(root, ".claude-plugin/marketplace.json"), "{}");
  for (const [name, text] of Object.entries(skills)) {
    mkdirSync(path.join(root, "skills", name), { recursive: true });
    writeFileSync(path.join(root, "skills", name, "SKILL.md"), text);
  }
  return root;
}

const ok = (name, body = "Body.") => `---\nname: ${name}\ndescription: Use when testing.\n---\n\n${body}\n`;
const lint = (root) => spawnSync("node", [LINT, root], { encoding: "utf8" });

test("a clean tree passes", () => {
  const r = lint(fixture({ a: ok("a", "See cstack:b."), b: ok("b") }));
  assert.equal(r.status, 0, r.stdout);
});

test("each rule fails on a violation", () => {
  const cases = [
    [{ a: ok("x") }, /does not match directory/],
    [{ a: "no frontmatter" }, /missing frontmatter/],
    [{ a: `---\nname: a\ndescription: ${"x".repeat(1025)}\n---\n` }, /max 1024/],
    [{ a: `---\nname: a\ndescription: d\nicon: crown\n---\n` }, /key 'icon'/],
    [{ a: ok("a", "Uses cstack:missing.") }, /unknown skill cstack:missing/],
    [{ a: ok("a", "[x](references/nope.md)") }, /broken link/],
    [{ a: ok("a", "one — two") }, /em dash/],
    [{ a: ok("a", "Ask with AskQuestion.") }, /banned term/],
  ];
  for (const [skills, re] of cases) {
    const r = lint(fixture(skills));
    assert.equal(r.status, 1, `expected failure for ${re}`);
    assert.match(r.stdout, re);
  }
});

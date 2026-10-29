import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LINT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "lint.mjs");

const MANIFEST = { name: "p", version: "1.0.0", description: "d", license: "MIT" };

function fixture(skills) {
  const root = mkdtempSync(path.join(tmpdir(), "cstack-lint-"));
  mkdirSync(path.join(root, ".claude-plugin"));
  mkdirSync(path.join(root, ".codex-plugin"));
  writeFileSync(path.join(root, ".claude-plugin/plugin.json"), JSON.stringify(MANIFEST));
  writeFileSync(path.join(root, ".claude-plugin/marketplace.json"), "{}");
  writeFileSync(path.join(root, ".codex-plugin/plugin.json"), JSON.stringify({ ...MANIFEST, skills: "./skills/", hooks: "./hooks/hooks.json" }));
  for (const [name, text] of Object.entries(skills)) {
    mkdirSync(path.join(root, "skills", name), { recursive: true });
    writeFileSync(path.join(root, "skills", name, "SKILL.md"), text);
  }
  return root;
}

const ok = (name, body = "Body.") => `---\nname: ${name}\ndescription: Use when testing.\n---\n\n${body}\n`;
const lint = (root) => spawnSync(process.execPath, [LINT, root], { encoding: "utf8" });

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

const userOnly = (name) => `---\nname: ${name}\ndescription: Use when testing.\ndisable-model-invocation: true\n---\n\nBody.\n`;
const implicitOff = "policy:\n  allow_implicit_invocation: false\n";

test("user-only skills and Codex openai.yaml must agree", () => {
  const good = fixture({ a: userOnly("a") });
  mkdirSync(path.join(good, "skills/a/agents"));
  writeFileSync(path.join(good, "skills/a/agents/openai.yaml"), implicitOff);
  assert.equal(lint(good).status, 0, lint(good).stdout);

  const missing = lint(fixture({ a: userOnly("a") }));
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /needs agents\/openai.yaml/);

  const stray = fixture({ a: ok("a") });
  mkdirSync(path.join(stray, "skills/a/agents"));
  writeFileSync(path.join(stray, "skills/a/agents/openai.yaml"), implicitOff);
  assert.match(lint(stray).stdout, /lacks disable-model-invocation/);
});

test("the Codex manifest must match the Claude manifest", () => {
  const root = fixture({ a: ok("a") });
  writeFileSync(path.join(root, ".codex-plugin/plugin.json"), JSON.stringify({ ...MANIFEST, version: "9.9.9", skills: "skills", hooks: "h.json", interface: { logo: "./nope.png" } }));
  const r = lint(root);
  assert.equal(r.status, 1);
  for (const re of [/version '9.9.9' differs/, /skills must be/, /hooks must be/, /interface.logo file missing/]) assert.match(r.stdout, re);

  const broken = fixture({ a: ok("a") });
  writeFileSync(path.join(broken, ".codex-plugin/plugin.json"), "{");
  assert.match(lint(broken).stdout, /\.codex-plugin\/plugin.json: does not parse/);
});

test("every Claude Code term a skill uses needs a row in the Codex notes", () => {
  const root = fixture({ cstack: ok("cstack"), a: ok("a", "Wait with the `Monitor` tool, then `update_plan`.") });
  mkdirSync(path.join(root, "skills/cstack/references"));
  const r = lint(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Claude Code term `Monitor` has no row/);
  writeFileSync(path.join(root, "skills/cstack/references/codex-notes.md"), "| `Monitor` | run the watcher in the foreground |\n");
  assert.equal(lint(root).status, 0, lint(root).stdout);
});

test("a shipped shell script must be executable, except on Windows, which has no execute bit", () => {
  const root = fixture({ a: ok("a") });
  mkdirSync(path.join(root, "skills/a/scripts"));
  writeFileSync(path.join(root, "skills/a/scripts/run.sh"), "#!/bin/sh\n", { mode: 0o644 });
  const r = lint(root);
  if (process.platform === "win32") assert.equal(r.status, 0, r.stdout);
  else assert.match(r.stdout, /run\.sh: script is not executable/);
});

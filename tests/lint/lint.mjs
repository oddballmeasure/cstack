#!/usr/bin/env node
// L0 structure lint. Rules are listed in docs/conventions.md (marked [lint]).
// Usage: node tests/lint/lint.mjs [repo-root]. Prints file: message lines and exits 1 on any problem.
import { readFileSync, readdirSync, statSync, existsSync, accessSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."));
const problems = [];
const report = (file, msg) => problems.push(`${(path.relative(ROOT, file) || file).split(path.sep).join("/")}: ${msg}`);

const ALLOWED_SKILL_KEYS = new Set(["name", "description", "disable-model-invocation", "argument-hint", "allowed-tools", "model", "paths", "user-invocable"]);
const ALLOWED_AGENT_KEYS = new Set(["name", "description", "tools", "model", "color"]);
const BANNED = [
  [/poteto/i, "Cursor-only name 'poteto'"],
  [/pstack:/, "pstack: skill prefix"],
  [/\bAskQuestion\b/, "Cursor tool AskQuestion (use AskUserQuestion)"],
  [/\bgeneralPurpose\b/, "Cursor subagent type generalPurpose (use general-purpose)"],
  [/readonly:\s*true/, "Cursor readonly flag (use Explore)"],
  [/\.cursor\//, "Cursor path .cursor/"],
  [/cursor-team-kit/, "cursor-team-kit plugin"],
  [/\bbugbot\b/i, "Bugbot"],
  [/\bcloud agents?\b/i, "Cursor cloud agents"],
  [/\/setup-pstack/, "setup-pstack command"],
  [/\bgrok\b/i, "Grok model"],
];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// Minimal frontmatter parser: top-level `key: value` lines between --- fences.
// Folded (>-, |) values are joined. Enough for SKILL.md and agent files.
function frontmatter(file, text) {
  if (!text.startsWith("---\n")) {
    report(file, "missing frontmatter");
    return null;
  }
  const end = text.indexOf("\n---", 4);
  if (end < 0) {
    report(file, "frontmatter not closed");
    return null;
  }
  const fm = {};
  let key = null;
  for (const line of text.slice(4, end).split("\n")) {
    const m = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (m) {
      key = m[1];
      let v = m[2].trim();
      if (v === ">-" || v === ">" || v === "|" || v === "|-") v = "";
      fm[key] = v.replace(/^["']|["']$/g, "");
    } else if (key && /^\s+/.test(line)) {
      fm[key] = (fm[key] ? fm[key] + " " : "") + line.trim();
    }
  }
  return { fm, body: text.slice(end + 4) };
}

const skillsDir = path.join(ROOT, "skills");
const skillNames = new Set(existsSync(skillsDir) ? readdirSync(skillsDir).filter((d) => statSync(path.join(skillsDir, d)).isDirectory()) : []);

// Skills
for (const name of skillNames) {
  const file = path.join(skillsDir, name, "SKILL.md");
  if (!existsSync(file)) {
    report(path.join(skillsDir, name), "skill directory has no SKILL.md");
    continue;
  }
  for (const sub of readdirSync(path.join(skillsDir, name))) {
    if (statSync(path.join(skillsDir, name, sub)).isDirectory() && !["references", "scripts", "templates", "agents"].includes(sub)) {
      report(path.join(skillsDir, name, sub), "skills are flat: only references/, scripts/, templates/ and agents/ may sit beside SKILL.md");
    }
  }
  const parsed = frontmatter(file, readFileSync(file, "utf8"));
  if (!parsed) continue;
  const { fm } = parsed;
  // Codex ignores disable-model-invocation; agents/openai.yaml carries the same rule for it.
  const yaml = path.join(skillsDir, name, "agents", "openai.yaml");
  const userOnly = fm["disable-model-invocation"] === "true";
  const implicitOff = existsSync(yaml) && /^\s*allow_implicit_invocation:\s*false\s*$/m.test(readFileSync(yaml, "utf8"));
  if (userOnly && !implicitOff) report(file, "user-only skill needs agents/openai.yaml with policy.allow_implicit_invocation: false (Codex)");
  if (!userOnly && implicitOff) report(yaml, "allow_implicit_invocation: false but SKILL.md lacks disable-model-invocation: true");
  if (fm.name !== name) report(file, `frontmatter name '${fm.name}' does not match directory '${name}'`);
  if (!fm.description) report(file, "description is empty");
  else if (fm.description.length > 1024) report(file, `description is ${fm.description.length} chars (max 1024)`);
  for (const k of Object.keys(fm)) if (!ALLOWED_SKILL_KEYS.has(k)) report(file, `frontmatter key '${k}' is not allowed`);
}

// Agents
for (const file of walk(path.join(ROOT, "agents")).filter((f) => f.endsWith(".md"))) {
  const parsed = frontmatter(file, readFileSync(file, "utf8"));
  if (!parsed) continue;
  const base = path.basename(file, ".md");
  if (parsed.fm.name !== base) report(file, `agent name '${parsed.fm.name}' does not match file '${base}'`);
  if (!parsed.fm.description) report(file, "agent description is empty");
  for (const k of Object.keys(parsed.fm)) if (!ALLOWED_AGENT_KEYS.has(k)) report(file, `agent frontmatter key '${k}' is not allowed`);
}

// Content rules over every markdown file in skills/ and agents/
const mdFiles = [...walk(skillsDir), ...walk(path.join(ROOT, "agents"))].filter((f) => f.endsWith(".md"));
for (const file of mdFiles) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const at = `line ${i + 1}`;
    if (line.includes("—")) report(file, `${at}: em dash (U+2014)`);
    // Attribution comments name their upstream source, which may use banned names.
    if (!line.trimStart().startsWith("<!-- Adapted from")) {
      for (const [re, what] of BANNED) if (re.test(line)) report(file, `${at}: banned term: ${what}`);
    }
    for (const m of line.matchAll(/\bcstack:([a-z0-9][a-z0-9-]*)/g)) {
      if (!skillNames.has(m[1])) report(file, `${at}: reference to unknown skill cstack:${m[1]}`);
    }
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split("#")[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      if (!existsSync(path.resolve(path.dirname(file), target))) report(file, `${at}: broken link ${m[1]}`);
    }
  });
}

// Harness map: skills name Claude Code tools; skills/cstack/references/codex-notes.md maps each one to Codex.
// Every Claude Code term a skill or agent puts in backticks needs a `| \`term\` |` row there.
const CLAUDE_TERMS = ["Agent", "Skill", "AskUserQuestion", "TodoWrite", "Monitor", "TaskStop", "Read", "Grep", "Glob", "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "Explore", "general-purpose", "subagent_type", "isolation", "run_in_background", "SendMessage", "WebFetch", "WebSearch", "EnterPlanMode", "ExitPlanMode"];
const codexNotes = path.join(skillsDir, "cstack", "references", "codex-notes.md");
if (existsSync(path.join(skillsDir, "cstack"))) {
  const mapped = existsSync(codexNotes) ? new Set([...readFileSync(codexNotes, "utf8").matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1])) : new Set();
  const unmapped = new Map();
  for (const file of mdFiles.filter((f) => !f.endsWith("claude-code-notes.md") && f !== codexNotes)) {
    for (const m of readFileSync(file, "utf8").matchAll(/`([A-Za-z_-]+)`/g)) {
      if (CLAUDE_TERMS.includes(m[1]) && !mapped.has(m[1]) && !unmapped.has(m[1])) unmapped.set(m[1], file);
    }
  }
  for (const [term, file] of unmapped) report(file, `Claude Code term \`${term}\` has no row in skills/cstack/references/codex-notes.md`);
}

// Plugin manifests: Claude Code reads .claude-plugin/, Codex reads .codex-plugin/ first.
const manifests = {};
for (const rel of [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ".codex-plugin/plugin.json"]) {
  const file = path.join(ROOT, rel);
  try {
    manifests[rel] = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    report(file, `does not parse: ${err.message}`);
  }
}
const claudeManifest = manifests[".claude-plugin/plugin.json"];
const codexManifest = manifests[".codex-plugin/plugin.json"];
if (claudeManifest && codexManifest) {
  const codexFile = path.join(ROOT, ".codex-plugin/plugin.json");
  for (const k of ["name", "version", "description", "license"]) {
    if (codexManifest[k] !== claudeManifest[k]) report(codexFile, `${k} '${codexManifest[k]}' differs from .claude-plugin/plugin.json '${claudeManifest[k]}'`);
  }
  if (codexManifest.skills !== "./skills/") report(codexFile, "skills must be ./skills/");
  if (codexManifest.hooks !== "./hooks/hooks.json") report(codexFile, "hooks must be ./hooks/hooks.json");
  for (const k of ["logo", "composerIcon"]) {
    const p = codexManifest.interface?.[k];
    if (p && !existsSync(path.join(ROOT, p))) report(codexFile, `interface.${k} file missing: ${p}`);
  }
}

// Hooks: JSON parses, every referenced plugin script exists
const hooksFile = path.join(ROOT, "hooks", "hooks.json");
if (existsSync(hooksFile)) {
  try {
    const hooks = JSON.parse(readFileSync(hooksFile, "utf8")).hooks || {};
    for (const groups of Object.values(hooks)) {
      for (const g of groups) {
        for (const h of g.hooks || []) {
          for (const m of String(h.command || "").matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"'\s]+)/g)) {
            const target = path.join(ROOT, m[1]);
            if (!existsSync(target)) report(hooksFile, `hook script missing: ${m[1]}`);
          }
        }
      }
    }
  } catch (err) {
    report(hooksFile, `does not parse: ${err.message}`);
  }
}

// Shipped shell scripts are executable. Windows has no execute bit, so the check runs elsewhere only.
for (const file of [...walk(skillsDir), ...walk(path.join(ROOT, "hooks"))].filter((f) => f.endsWith(".sh") && process.platform !== "win32")) {
  try {
    accessSync(file, constants.X_OK);
  } catch {
    report(file, "script is not executable");
  }
}

for (const p of problems) console.log(p);
console.log(`${skillNames.size} skills, ${problems.length} problems`);
process.exit(problems.length ? 1 : 0);

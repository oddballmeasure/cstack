// Shared helpers for scenario setup and expectations.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export function createIssue(ctx, title, body) {
  const url = ctx.gh("issue", "create", "--title", title, "--body", body, "--label", "cstack:ready");
  return Number(url.split("/").pop());
}

export function unitPrompt(issue, extra = "") {
  return `/cstack:unit ${issue}\n\nThis is an unattended scenario run: no human will answer questions. Take documented defaults instead of asking.${extra ? "\n\n" + extra : ""}`;
}

export function prFor(ctx, issue) {
  const list = JSON.parse(ctx.gh("pr", "list", "--state", "all", "--search", `Closes #${issue} in:body`, "--json", "number,state,headRefName,headRefOid,body,mergeCommit"));
  return list[0] || null;
}

export function branchLog(ctx, branch) {
  ctx.git("fetch", "-q", "origin", branch);
  return ctx.git("log", "--format=%H%x00%s%x00%(trailers:only,unfold)%x1e", `origin/main..origin/${branch}`);
}

export function tickets(ctx, branch) {
  return [...branchLog(ctx, branch).matchAll(/Cstack-Ticket: (\S+)/g)].map((m) => m[1]);
}

export function ledgerApproved(ctx, issue, sha) {
  const store = path.join(ctx.testbed, ".cstack/runs", `issue-${issue}`);
  const r = ctx.sh("node", [path.join(ctx.cstack, "gates/orch.mjs"), "--store", store, "ledger", "check", "U1", sha], { allowFail: true });
  return r.includes("approved") || r.includes("verified");
}

export function checkConclusion(ctx, sha, name = "ci") {
  const runs = JSON.parse(ctx.sh("gh", ["api", `repos/${ctx.repo}/commits/${sha}/check-runs`, "--jq", ".check_runs"]));
  const latest = runs.filter((r) => r.name === name).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
  return latest ? latest.conclusion : null;
}

export function labels(ctx, issue) {
  return JSON.parse(ctx.gh("issue", "view", String(issue), "--json", "labels")).labels.map((l) => l.name);
}

// Tool calls made anywhere in the session (main thread and subagents), and tool results that a hook blocked.
export function toolUses(ctx) {
  const out = [];
  for (const e of ctx.result.events) {
    for (const c of e.message?.content || []) if (c.type === "tool_use") out.push({ name: c.name, input: c.input });
  }
  return out;
}

export function hookBlocks(ctx, rule) {
  const hits = [];
  for (const e of ctx.result.events) {
    for (const c of e.message?.content || []) {
      if (c.type === "tool_result") {
        const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
        if (text.includes(`cstack ${rule}`)) hits.push(text.slice(0, 200));
      }
    }
  }
  return hits;
}

export function storeFile(ctx, issue, rel) {
  const p = path.join(ctx.testbed, ".cstack/runs", `issue-${issue}`, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export { assert };

export const slug = (title) => title.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 40);

// Pre-seed a unit mid-flight: branch with commits, run store with U1 and an intake file.
export function seedUnit(ctx, { issue, title, intake, commits }) {
  const { writeFileSync, mkdirSync } = fs;
  const branch = `cstack/${issue}-${slug(title)}`;
  ctx.git("checkout", "-q", "-b", branch, "origin/main");
  for (const c of commits) {
    for (const [rel, text] of Object.entries(c.files)) {
      const p = path.join(ctx.testbed, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
    ctx.git("add", "-A");
    ctx.git("commit", "-q", "-m", `${c.message}\n\nCstack-Unit: U1\nCstack-Ticket: ${c.ticket}\nRefs: #${issue}`);
  }
  ctx.git("checkout", "-q", "main");
  const store = path.join(ctx.testbed, ".cstack/runs", `issue-${issue}`);
  const orch = (...a) => ctx.sh("node", [path.join(ctx.cstack, "gates/orch.mjs"), "--store", store, ...a]);
  orch("init");
  orch("unit", "add", "U1", "--track", "issue", "--issue", String(issue), "--state", "ready");
  orch("unit", "set", "U1", "--state", "in-progress", "--branch", branch);
  writeFileSync(path.join(store, "intake-U1.json"), JSON.stringify({ issue, ...intake }, null, 2));
  return { branch, store };
}


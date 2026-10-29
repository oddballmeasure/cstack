// The agent harness a headless cstack session runs in: Claude Code (`claude -p`) or Codex (`codex exec`).
// Picked by CSTACK_HARNESS, else config `harness`, else the harness this process runs under (Codex sets
// CODEX_THREAD_ID in its shell commands, ADR-010), else claude.
// Codex sessions differ from Claude Code ones in four ways (ADR-012):
//   - no --plugin-dir: Codex runs the plugin installed with `codex plugin add`, and its hooks must be trusted;
//   - no per-session allowlist: the guard applies the role's deny rules to cstack-launched Codex sessions;
//   - billing is checked before launch with `codex login status`, which must say ChatGPT;
//   - prompts call skills as $cstack:<name>, not /cstack:<name>.
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, UsageError } from "./common.mjs";

export const HARNESSES = ["claude", "codex"];
// Model roles under Codex when config models_codex leaves one out. They differ by role where it matters:
// the judge and the reviewer are not the coding model.
export const CODEX_MODELS = { code: "gpt-6.1-sol", judge: "gpt-6-astra", review: "gpt-6-astra", gather: "gpt-6-luna" };

export function pickHarness(config = {}, env = process.env) {
  const chosen = env.CSTACK_HARNESS || config.harness || "auto";
  if (chosen === "auto") return env.CODEX_THREAD_ID ? "codex" : "claude";
  if (!HARNESSES.includes(chosen)) throw new UsageError(`unknown harness '${chosen}' (use claude, codex or auto)`);
  return chosen;
}

export function codexModel(config, role) {
  const m = config.models_codex?.[role] ?? CODEX_MODELS[role];
  return m === "inherit" ? null : m;
}

// Variables a session must not inherit, so it bills the subscription and nothing else.
export const BILLING_VARS = { claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"], codex: ["OPENAI_API_KEY", "CODEX_API_KEY"] };

export const skillPrompt = (harness, prompt) => (harness === "codex" ? prompt.replace(/^\/cstack:/, "$cstack:") : prompt);

// Sandbox flags for a Codex session working in dir. workspace-write keeps .git read-only and allows writes only
// under the working root, but cstack sessions commit, make worktrees under ~/.local/state/cstack and use the temp
// dir, so those become writable roots, with any extra ones (the e2e author's run store), and network stays on for
// git and gh (measured, ADR-012). The git root is the common git dir, so a worktree's session can commit too.
// The state dir must exist before the sandbox can bind it.
export function codexSandboxArgs(sandbox, dir, extra = []) {
  if (sandbox !== "workspace-write") return ["-s", sandbox];
  const state = path.join(os.homedir(), ".local", "state", "cstack");
  mkdirSync(state, { recursive: true });
  // A worktree's own git dir (.git/worktrees/<name>) stays read-only unless it is named too (measured).
  const git = run("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir", "--absolute-git-dir"]);
  const gitDirs = git.code === 0 ? [...new Set(git.stdout.trim().split("\n"))] : [path.join(dir, ".git")];
  const roots = [...gitDirs, state, os.tmpdir(), ...extra.map((p) => path.resolve(p))];
  return ["-s", sandbox, "-c", "sandbox_workspace_write.network_access=true", "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`];
}

// A sandboxed Codex session cannot start a session outside its sandbox: the systemd user bus is out of reach,
// and a nested codex cannot write ~/.codex (measured, ADR-012). Coordinators start the e2e author and workers,
// so they run with danger-full-access; every session they start gets the configured sandbox through systemd.
export const COORDINATOR_SANDBOX = "danger-full-access";

// The Codex session command. Config codex_sandbox (or CSTACK_CODEX_SANDBOX) picks the sandbox. stdin must be
// closed by the caller.
export function codexArgv({ prompt, cwd, model = null, sandbox = "workspace-write" }) {
  return ["codex", "exec", "--json", "-C", cwd, ...codexSandboxArgs(sandbox, cwd), ...(model ? ["-m", model] : []), skillPrompt("codex", prompt)];
}

// Codex has no apiKeySource event, so check the login before launch: an API-key login would bill per token.
export function codexBillingProblem() {
  const r = run("codex", ["login", "status"]);
  const text = `${r.stdout}${r.stderr}`.trim();
  if (r.code !== 0) return `codex login status failed: ${text || `exit ${r.code}`}`;
  if (!/ChatGPT/i.test(text)) return `codex is not logged in with ChatGPT (${text}); workers must run on the subscription`;
  return null;
}

// Text a Codex session left about why it stopped: error items, failed turns, and the last agent message.
export function codexText(events) {
  const out = [];
  for (const e of events) {
    if (e?.type === "error" && e.message) out.push(e.message);
    if (e?.type === "turn.failed") out.push(e.error?.message ?? "turn failed");
    if (e?.type === "item.completed" && e.item?.type === "error" && e.item.message) out.push(e.item.message);
  }
  const last = events.findLast((e) => e?.type === "item.completed" && e.item?.type === "agent_message");
  if (last) out.push(last.item.text ?? "");
  return out.join("\n");
}

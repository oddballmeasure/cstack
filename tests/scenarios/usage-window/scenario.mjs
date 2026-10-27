// Scenario 9: a Level B worker hits the subscription usage window. Deterministic: a fake `claude` on the
// worker's PATH prints the usage-limit message and exits 1. The worker is launched for real under
// systemd-run (--wait). Expect a `usage_limit` inbox entry, the unit back in `ready` with a not-before
// time at the parsed reset (3pm New York), `worker next` deferring it, and no API key in the worker's env.
import { assert, orchCli, storeOf, workerCli } from "../lib.mjs";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const timeoutMinutes = 5;
const RUN = "usage-window";

export function setup(ctx) {
  const bin = path.join(ctx.outDir, "fakebin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    path.join(bin, "claude"),
    `#!/bin/sh
env > ${JSON.stringify(path.join(ctx.outDir, "claude-env.txt"))}
printf '%s\\n' '{"type":"system","subtype":"init","apiKeySource":"none"}'
echo "Claude usage limit reached. Your limit will reset at 3pm (America/New_York)" >&2
exit 1
`,
  );
  chmodSync(path.join(bin, "claude"), 0o755);
  const store = storeOf(ctx, RUN);
  const orch = orchCli(ctx, store);
  orch("init");
  orch("unit", "add", "U1", "--track", "core", "--state", "ready");
  const pathForWorker = [bin, path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  ctx.launch = workerCli(ctx, ["launch", "--store", store, "--unit", "U1", "--plugin-dir", ctx.cstack, "--wait"], { CSTACK_WORKER_PATH: pathForWorker });
  ctx.store = store;
  return { prompt: null };
}

export function expect(ctx) {
  const orch = orchCli(ctx, ctx.store);
  assert.match(ctx.launch, /finished cstack-cstack-testbed-usage-window-U1/);
  const entries = orch("inbox", "drain").split("\n").map((l) => l.split("\t"));
  const entry = entries.find((e) => e[1] === "worker" && e[2] === "U1");
  assert.ok(entry, `a worker entry for U1: ${JSON.stringify(entries)}`);
  assert.equal(entry[3], "usage_limit");
  assert.match(readFileSync(entry[4], "utf8"), /^usage_limit resets_at=/);
  assert.equal(orch("unit", "get", "U1").split("\t")[2], "ready", "the unit is re-queued");
  const until = new Date(readFileSync(path.join(ctx.store, "workers/U1.not-before"), "utf8").trim());
  const nyHour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(until);
  assert.equal(nyHour, "15", `not-before at the 3pm New York reset: ${until.toISOString()}`);
  assert.ok(until > new Date(), "the reset is in the future");
  const next = JSON.parse(workerCli(ctx, ["next", "--store", ctx.store, "--json"]));
  assert.deepEqual(next.launch, [], "nothing launches before the reset");
  assert.deepEqual(next.defer.map((d) => d.id), ["U1"]);
  const envFile = path.join(ctx.outDir, "claude-env.txt");
  assert.ok(existsSync(envFile), "the fake claude ran");
  const env = readFileSync(envFile, "utf8");
  assert.doesNotMatch(env, /^ANTHROPIC_API_KEY=/m, "no API key reaches the worker");
  assert.doesNotMatch(env, /^ANTHROPIC_AUTH_TOKEN=/m);
  assert.match(env, /^CSTACK_RUN=usage-window$/m);
}

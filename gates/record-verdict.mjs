#!/usr/bin/env node
// Record a verifier's verdict, so a read-only verifier can save it under the role allowlist (cstack#41).
// The verifier has no Write tool, and a shell redirect (`cat > file`) is refused in dontAsk mode, but every role may
// run the plugin's own scripts. This gate checks the verdict's shape and writes it to the one path check-verdict reads.
// Usage: record-verdict.mjs --store <dir> --unit <id> --sha <full sha> --by <judge model> --verdict '<json>' [--json]
// Without --verdict it reads the JSON from stdin. Use --verdict from a session: Claude Code's permission matcher refuses a
// heredoc even on an allowed script, but accepts a quoted argument (measured, 2.1.308).
// Writes <store>/verdict-<unit>-<sha12>.json with `by` and `recorded_at` added. It never overwrites a recorded verdict:
// a new verdict needs a new head. Exit 0 recorded, 1 refused (shape, head mismatch, already recorded), 2 usage.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Gate, main, parseArgs, UsageError } from "./lib/common.mjs";

await main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json"], options: ["store", "unit", "sha", "by", "verdict"] });
  if (args._.length || !args.store || !args.unit || !/^[0-9a-f]{40}$/.test(String(args.sha)) || !args.by) {
    throw new UsageError("usage: record-verdict.mjs --store <dir> --unit <id> --sha <40-hex sha> --by <model> --verdict <json>");
  }
  const gate = new Gate("record-verdict", { json: args.json });
  const file = path.join(path.resolve(args.store), `verdict-${args.unit}-${args.sha.slice(0, 12)}.json`);
  let v = null;
  try {
    v = JSON.parse(args.verdict ?? readFileSync(0, "utf8"));
  } catch (err) {
    gate.fail("json", `the verdict does not parse: ${err.message}`);
  }
  if (v !== null) {
    const ok = v && typeof v === "object" && !Array.isArray(v);
    gate.check(ok && v.unit === args.unit, "unit", `unit ${args.unit}`, `verdict names unit ${ok ? v.unit : "nothing"}, not ${args.unit}`);
    gate.check(ok && v.head_sha === args.sha, "head", `head ${args.sha.slice(0, 12)}`, `verdict names head ${ok ? v.head_sha : "nothing"}, not ${args.sha}`);
    gate.check(ok && Array.isArray(v.requirements) && v.requirements.length > 0, "requirements", "assessed", "requirements must be a non-empty array");
    gate.check(ok && Array.isArray(v.findings), "findings", "listed", "findings must be an array (empty when nothing blocks)");
    gate.check(!existsSync(file), "new", "not recorded before", `${file} already holds a verdict for this head; a new verdict needs a new head`);
  }
  if (gate.approved) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ ...v, by: args.by, recorded_at: new Date().toISOString() }, null, 2)}\n`);
    gate.pass("recorded", file);
  }
  return gate.finish({ file });
});

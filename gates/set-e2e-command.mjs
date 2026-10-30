#!/usr/bin/env node
// Set e2e_command in a worktree's .cstack/config.json, the one config change a run makes itself (cstack:e2e-plan).
// The allowlist refuses a redirect into the worktree, and the guard locks the config against file tools, so a session
// cannot edit it directly. This gate changes that one key and nothing else, so autonomy and hidden paths stay locked.
// Usage: set-e2e-command.mjs <worktree> --command-file <file with a JSON array of strings> [--json]
// Exit 0 set (or already set to that value), 1 refused, 2 usage errors.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Gate, main, parseArgs, UsageError } from "./lib/common.mjs";

await main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json"], options: ["command-file"] });
  if (args._.length !== 1 || !args["command-file"]) throw new UsageError("usage: set-e2e-command.mjs <worktree> --command-file <file> [--json]");
  const gate = new Gate("set-e2e-command", { json: args.json });
  const file = path.join(path.resolve(args._[0]), ".cstack", "config.json");
  let command = null;
  try {
    command = JSON.parse(readFileSync(args["command-file"], "utf8"));
  } catch (err) {
    gate.fail("command", `${args["command-file"]} does not parse: ${err.message}`);
  }
  if (command !== null) {
    const ok = Array.isArray(command) && command.length > 0 && command.every((x) => typeof x === "string" && x.length > 0);
    gate.check(ok, "command", command.join?.(" "), "the command must be a non-empty JSON array of strings");
    gate.check(existsSync(file), "config", file, `${file} does not exist`);
  }
  if (gate.approved) {
    const config = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, `${JSON.stringify({ ...config, e2e_command: command }, null, 2)}\n`);
    gate.pass("set", `e2e_command in ${file}`);
  }
  return gate.finish({ file, e2e_command: command });
});

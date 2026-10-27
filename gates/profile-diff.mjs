#!/usr/bin/env node
// Compare the repo's tracked files with its profile, so only new and changed files get re-described.
// Usage: profile-diff.mjs <repo> [--write-hashes] [--json]
// Profile: <repo root>/.cstack/profile.json (local, not committed):
//   {version: 1, files: {"<path>": {sha256, summary, capabilities: [], status: "active|legacy|support"}}}
// Each profilable file is new (no entry), changed (entry sha256 differs), removed (entry, no file) or same.
// Profilable: tracked (git ls-files), not under a vendor directory, not in config paths_hidden.
// Hash: sha256 of the bytes. A symlink hashes its target text, a submodule its path (Cardinal profiler).
// A tracked file deleted from the working tree is not profilable.
// --write-hashes (alias --write): drop removed entries and fill sha256 on entries that have none.
//   The profile-repo skill writes re-described entries without sha256, so a changed file it skipped stays changed.
// Every file that is not same is a finding. "approved" means the profile covers every tracked file.
// Exit 0 either way (it is a report). Exit 2 on a bad profile or bad usage.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Gate, main, parseArgs, UsageError, loadConfig, gitOut, matchesAny } from "./lib/common.mjs";

const VENDOR = new Set(["node_modules", "vendor", "third_party", "bower_components", ".yarn"]);
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function fileHash(root, rel) {
  const p = path.join(root, rel);
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (!st) return null;
  const h = createHash("sha256");
  if (st.isSymbolicLink()) h.update("link:" + readlinkSync(p));
  else if (st.isDirectory()) h.update("dir:" + rel);
  else h.update(readFileSync(p));
  return h.digest("hex");
}

function readProfile(file) {
  if (!existsSync(file)) return { version: 1, files: {} };
  let d;
  try {
    d = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new UsageError(`${file} does not parse: ${err.message}`);
  }
  if (!isObject(d) || d.version !== 1 || !isObject(d.files)) throw new UsageError(`${file} must be {version: 1, files: {...}}`);
  const bad = Object.keys(d.files).filter((k) => !isObject(d.files[k]));
  if (bad.length) throw new UsageError(`${file}: entries must be objects: ${bad.join(", ")}`);
  return d;
}

await main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json", "write-hashes", "write"] });
  const [repo] = args._;
  if (!repo) throw new UsageError("usage: profile-diff.mjs <repo> [--write-hashes] [--json]");
  const { root, config } = loadConfig(repo);
  const file = path.join(root, ".cstack", "profile.json");
  const profile = readProfile(file);

  const hashes = new Map();
  for (const rel of gitOut(root, ["ls-files", "-z"]).split("\0").filter(Boolean)) {
    if (rel.split("/").some((seg) => VENDOR.has(seg)) || matchesAny(rel, config.paths_hidden)) continue;
    const h = fileHash(root, rel);
    if (h) hashes.set(rel, h);
  }

  if (args["write-hashes"] || args.write) {
    const files = {};
    for (const rel of Object.keys(profile.files).filter((k) => hashes.has(k)).sort()) {
      files[rel] = { ...profile.files[rel], sha256: profile.files[rel].sha256 || hashes.get(rel) };
    }
    profile.files = files;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(profile, null, 2) + "\n");
  }

  const lists = { new: [], changed: [], removed: [] };
  let same = 0;
  for (const [rel, h] of hashes) {
    const entry = profile.files[rel];
    if (!entry) lists.new.push(rel);
    else if (entry.sha256 !== h) lists.changed.push(rel);
    else same++;
  }
  lists.removed = Object.keys(profile.files).filter((k) => !hashes.has(k)).sort();

  const gate = new Gate("profile-diff", { json: args.json });
  gate.pass("same", `${same} of ${hashes.size} profilable files unchanged`);
  for (const [status, paths] of Object.entries(lists)) for (const rel of paths) gate.fail(status, rel);
  gate.finish({ profile: file, ...lists, same });
  return 0;
});

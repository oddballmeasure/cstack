---
name: profile-repo
description: "Use when a cstack unit or plan needs the repo profile (stage 2), or the profile at .cstack/profile.json is missing or stale. Describes each tracked file (summary, capabilities, active/legacy/support) so planning can find the code that owns a behaviour. Re-describes only new and changed files, in batches of 5 per read-only explorer."
---

# Profile repo

The profile tells later stages which file owns which behaviour. `cstack:intake` picks `target_files` from it. Hashes come from a script, never from a model.

This skill follows Cardinal's profiler (oddballmeasure/cardinal, `roles/profiler.py`): bounded batches, one entry per path, and re-profiling only of files whose content changed.

## The profile

The file is `<repo root>/.cstack/profile.json`. It is local state. Do not commit it. The repo's `.gitignore` must cover it. Setup owns that line. If `git check-ignore -q .cstack/profile.json` fails, say so in your report and change nothing.

```json
{
  "version": 1,
  "files": {
    "src/store.mjs": {
      "sha256": "<hex>",
      "summary": "Note store: loads, appends and lists notes in notes.json.",
      "capabilities": ["list notes", "add note", "notes.json persistence"],
      "status": "active"
    }
  }
}
```

- `summary`: one or two specific sentences grounded in the file's content. Name what it owns, not what kind of file it is.
- `capabilities`: searchable phrases for the behaviours, endpoints, commands, flags and UI elements the file owns.
- `status`: `active` for live code. `legacy` only when nothing imports or calls it. `support` for tests, docs, configuration, fixtures and data.

Profilable files are the tracked files (`git ls-files`), minus vendor directories and config `paths_hidden`. `gates/profile-diff.mjs` owns that list.

## Procedure

`<root>` is the plugin root (two directories up from this skill's base directory). `<repo>` is the repo root, absolute.

1. Read the [cstack mode skill](../cstack/SKILL.md). Read config `models.gather` and `paths_hidden` with `jq`.
2. Run `node <root>/gates/profile-diff.mjs <repo> --json`. If `approved` is true, the profile is current. Stop and reuse it.
3. Take the stale list: `new` plus `changed`, in that order. Split it into batches of 5 paths. Do nothing yet about `removed`. Step 6 drops those entries.
4. Spawn one explorer per batch. Use the plugin agent `cstack-explorer` (with the plugin prefix, see the Claude Code notes in the mode skill) when the `Agent` tool lists it. Else use `Explore`. Set `model` to `models.gather` (omit it for `inherit`). Send up to 8 spawns in one message. Build each brief from [the profiler prompt](references/profiler-prompt.md).
5. Check each reply. It must be a JSON array with exactly one entry per listed path, no other paths, a non-empty `summary`, a `capabilities` array, and a valid `status`. On a bad reply, send that batch once more to a fresh explorer. Add the rejected reply's problem paths and the reason to its brief. A second bad reply for the same batch is failure `invalid_output`.
6. Merge the entries into the profile **without** a `sha256` key. Replace each whole entry, so an old hash cannot survive. For example, with the replies in `/tmp/chunk.json` as one array:
   ```sh
   p=<repo>/.cstack/profile.json
   [ -f "$p" ] || echo '{"version":1,"files":{}}' >"$p"
   jq --slurpfile c /tmp/chunk.json '.files += ($c[0] | map({key: .path, value: (del(.path, .sha256))}) | from_entries)' "$p" >"$p.tmp" && mv "$p.tmp" "$p"
   ```
7. Run `node <root>/gates/profile-diff.mjs <repo> --write-hashes --json`. It drops removed entries and hashes the entries you just wrote. Hashes already present stay as they are, so a changed file you skipped stays `changed`.
8. Read `approved`. True means the stage-2 gate passed. If it is false, a file changed while you profiled it, or a batch was lost. Repeat from step 2 once for the remaining stale files. A second false is failure `setup`.

Do not edit any repo file other than the profile. Run `git status --porcelain` after the explorers return. A change to a tracked file is a finding. Report it.

## Report

Give the counts from the last profile-diff run (new, changed, removed, same), the number of batches, any retried batch, and the ignore warning if it applies.

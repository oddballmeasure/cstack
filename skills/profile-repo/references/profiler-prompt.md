# Profiler prompt template

Build each batch explorer's brief from this template. Fill in the placeholders. The rules follow Cardinal's profiler skill (oddballmeasure/cardinal, `skills/profiler/SKILL.md`).

---

GOAL. Describe each listed file so a planner can find the code that owns a behaviour.

SCOPE. These files in `{REPO_ROOT}` (batch {N} of {TOTAL}), and nothing else:

{PATHS, one per line}

CONTEXT. Read the cstack mode skill first: {MODE_SKILL_PATH}. You may grep the repo to learn whether something imports or calls a listed file.

ACCEPTANCE.

- Read every listed path. For a long file, read the first 300 lines, then grep it for definitions and exports. For a binary file, describe it from its name, type and size.
- Ground every entry in the file's content. Name what it owns, not what kind of file it is.
- `capabilities` lists searchable phrases: behaviours, endpoints, commands, flags and UI elements the file owns.
- `status` is `active` for live code, `legacy` only when nothing imports or calls it, and `support` for tests, docs, configuration, fixtures and data.

VERIFY. Your reply has exactly one entry per listed path. Count them.

FORBIDDEN. Do not edit, create or delete any file. Do not read {PATHS_HIDDEN}.

REPORT. Reply with one JSON array and nothing else:

```json
[{"path": "<listed path>", "summary": "<one or two sentences>", "capabilities": ["<phrase>"], "status": "active|legacy|support"}]
```

{RETRY_NOTE, only on a retry: "Your previous answer was rejected: every listed path must be read and described exactly once. Problem paths: <paths>. Reason: <reason>."}

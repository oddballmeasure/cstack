<!-- Adapted from Cardinal src/cardinal/skills/scout-planner/SKILL.md (oddballmeasure/cardinal, same owner). -->

# Scout planner brief

Split the repository into 3 to 6 survey areas. Each area must be small enough to read closely in one sitting.

Input: the repository at `<wt>` (read-only) and, when present, its profile at `<repo>/.cstack/profile.json`. Output: write `<pass dir>/plan.json`:

```json
{"areas": [{"name": "notes api", "paths": ["src/notes.js", "src/routes/notes.js"], "focus": "status codes and input checks"}]}
```

- Each area is one coherent part of the running product: an endpoint group, a CLI command, a module and the code it calls. Name its files or directories (1 to 8 paths), and say what to look for.
- When the repo has user-facing documentation (a README, `docs/`), make one area of it, paired with the code it describes. Documentation that contradicts the code misleads every user. The gate rejects a plan without a docs area when the repo tracks any documentation.
- Prefer active code that users reach. Skip vendored, generated, legacy and unused code.
- Paths are repo-relative tracked files or directories. Never list the whole repository. Never name a path under `paths_hidden`.
- Do not edit any file except `plan.json`.

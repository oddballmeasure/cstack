<!-- Adapted from Cardinal src/cardinal/skills/scout/SKILL.md (oddballmeasure/cardinal, same owner). -->

# Scout survey brief

Survey one area of the repository and propose small, verified issues a coding agent can resolve.

Input: the area (name, paths, focus), `<pass dir>/rejections.json` (proposals a person rejected, with reasons), `<pass dir>/issues.json` (existing issues), the enabled categories and `max_files`, and the repository at `<wt>` (read-only). Output: write `<pass dir>/area-<i>.json` as `{"proposals": [...]}` with at most 5 proposals. An empty list is a good answer when nothing qualifies.

## What qualifies

- Small: one behaviour, at most `max_files` files, testable with the repository's own suites (documentation fixes excepted).
- One category, from the enabled list only:
  - `bug`: the code does something wrong you can point at.
  - `regression`: a bug that a closed issue in `issues.json` already fixed or described, whose behaviour you can still see in the code. Cite the closed issue in `problem`.
  - `docs`: documentation that contradicts the code. The fix changes only documentation files.
  - `enhancement`: behaviour that works but could be clearly better in one small, uncontroversial way, such as an error message that hides the actual value. Nothing in the code is wrong yet.
  - `feature`: a missing behaviour the code clearly half-supports.
  If it could be either, prefer `bug` over `enhancement` and `enhancement` over `feature`.
- No config, environment, infrastructure, CI, dependency or migration changes.
- Avoid billing, authentication, security logic and legal text.
- A product decision (what the product should do, where reasonable people differ) is not a bug. Do not dress it up as one. The reviewer flags those for a person.
- Documentation that contradicts the code is `docs`: a wrong endpoint, field name, status or command. Say which side is wrong. When the code is the wrong side, it is a `bug`.
- Not already an open issue in `issues.json`, and not like anything in `rejections.json`. Read each rejection reason. It says what this repository's owner does not want.

## Verify, then write

Read the code path end to end before you claim anything. Every claim must be true of the code at `<wt>`, not of what similar code usually does.

- `category`: one of the above.
- `title`: the observable behaviour, 8 to 100 characters, for example "GET /notes?tag= returns 500 instead of 400 for an empty tag".
- `problem`: what happens today, with exact status codes, messages, counts or labels (40 characters or more).
- `evidence`: 1 to 5 items of `path`, `line_start`, `line_end` and a `quote` copied exactly from those lines (8 characters or more, at most 40 lines). The gate drops any proposal whose quote is not in the file.
- `expected`: the behaviour that should replace it.
- `acceptance`: 1 to 6 criteria. Each names an exact value: a number (status, exit code, count) or a quoted literal (`"message"`, a backticked field or label). The gate drops vague criteria.
- `files`: the existing files a fix would change. Never under `paths_off_limits` or `paths_hidden`.

Do not edit any file except your output file.

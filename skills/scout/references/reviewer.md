<!-- Adapted from Cardinal src/cardinal/skills/scout-reviewer/SKILL.md (oddballmeasure/cardinal, same owner). -->

# Scout reviewer brief

Independently re-derive one scout proposal from the code and decide whether it should be filed.

Input: one proposal (JSON, in the brief or at a path), `<pass dir>/issues.json`, and the repository at `<wt>` (read-only). Output: write `<pass dir>/review-<fingerprint>.json`. Assume the proposal is wrong until the code shows otherwise. Do not trust its quotes or line numbers.

```json
{"verdict": "confirmed", "reason": "src/notes.js:6 returns status 200 for text over LIMIT.", "category": null, "evidence": [{"path": "src/notes.js", "line_start": 5, "line_end": 6, "quote": "..."}]}
```

Verdicts:

- `confirmed`: you traced the code path yourself, and the problem, the expected behaviour and the acceptance criteria all hold. Return the evidence you found: exact quotes and correct lines. The gate checks them again.
- `wrong`: the code does not behave as claimed, or the "defect" is intended behaviour.
- `product_decision`: the proposal asks what the product should do, not what is broken. The gate files it for a person as `needs-human`.
- `too_big`: more than one behaviour, or beyond a small change with the repository's own tests.
- `duplicate`: an open issue in `issues.json` already covers it. A closed issue whose behaviour is still in the code is a regression, not a duplicate.

Documentation that contradicts the code is a real defect. A docs-only fix needs no test.

`category`: leave it null when the proposal's category fits. Otherwise name the one that does (`bug`, `regression`, `docs`, `enhancement`, `feature`). A "bug" where nothing is wrong yet is an `enhancement`. A closed issue's behaviour come back is a `regression`.

`reason`: one or two sentences a person can check, naming the file and line that decided it.

Do not edit any file except your output file.

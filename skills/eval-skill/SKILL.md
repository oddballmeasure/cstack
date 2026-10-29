---
name: eval-skill
description: "Measure whether a skill change makes agents behave better. Frame the variant and a 3 to 6 criterion rubric, write blinded cases under evals/ with hidden graders, run the baseline and the variant with claude plugin eval (always --no-publish), verify the skill fired from the run traces, read every output, and recommend whether to ship the variant. Spends real usage. Use for /cstack:eval-skill."
disable-model-invocation: true
argument-hint: "<skill> [<baseline ref> <variant ref> | --with-without]"
---

<!-- Adapted from pstack skills/poteto-mode/playbooks/eval.md @ 519d36a (MIT, Lauren Tan). -->

# Eval a skill

You own the experiment design. Frame it, blind it, run it, then synthesize.

Read the [cstack mode skill](../cstack/SKILL.md) first, and [Explain the Number](../cstack/references/principles/explain-the-number.md). Read [ADR-005](../../docs/adr/ADR-005-review-evals.md) for a worked example. Look at [one case's prompt](../../evals/review-loop-off-by-one/prompt.md) and the `graders/` beside it for the shape of a case.

## Hard rule: `--no-publish`

Every `claude plugin eval` command carries `--no-publish`. By default the tool publishes its HTML report to claude.ai, and the report holds the prompts, outputs and grader verdicts. Never run a command without the flag. If you find one in a script or a note, fix it before you run it. The guard hook blocks any `claude plugin eval` without it (rule `no-eval-publish`).

Run only plugins and case files you trust. Leave `--scaffold`, `--allow-real-servers` and `--mocks off` out unless you wrote the case and the human agreed.

## Blinding

- The candidate sees `prompt.md`'s body and any files the case plants. None of these say `eval`, `test`, `judge`, `experiment`, `rubric`, `score`, `compare`, `benchmark`, `candidate` or `arena`. A case about a test runner may name tests, because a real user would.
- The prompt reads like a real user request. State the goal, not the meta.
- No cues that ask for the chain. Do not ask the candidate to list the skills, principles or files it used. Grade that from the trace and from the output's shape.
- Name case directories as a user might name the task, for example `review-loop-off-by-one`.
- Graders are hidden from the candidate. Only the judge sees them.

## 1. Frame

State the variant under test and the behaviour that counts as success. Write the rubric: 3 to 6 concrete criteria. Each criterion becomes one grader file. Keep the rubric out of the prompt.

Pick the arms:

- **Two revisions of a skill.** Baseline and variant refs of the plugin.
- **Plugin against no plugin.** One target with `--ablation with-without`. The tool adds a no-plugin arm and reports the delta.

## 2. Write the cases

Write 2 or more cases per skill under `evals/<case>/`:

- `prompt.md`: frontmatter `max_turns`, `timeout_seconds`, `allowed_tools`, then the organic request. Prefer offline cases. Say "do not reach the network" in the request when the skill would otherwise call GitHub.
- `graders/<criterion>.md`: frontmatter `type` (`llm` or `regex`), `weight`, and `focus: trace` when the check reads tool calls instead of the final message. A regex grader takes `pattern`, `match` (`contains` or `not_contains`) and optional `flags`.

Make a mechanical check (an exact footer, a forbidden string) a regex grader. It is stricter and cheaper than an LLM judge. Make "the skill fired" a `focus: trace` grader that looks for the `Skill` call or the `Read` of its `SKILL.md`.

## 3. Run both arms

Two revisions: put each in its own worktree with identical case files.

```bash
git -C <plugin> worktree add /tmp/<skill>-base <baseline ref>
git -C <plugin> worktree add /tmp/<skill>-variant <variant ref>
# copy the same evals/ into both, then confirm: diff -r /tmp/<skill>-base/evals /tmp/<skill>-variant/evals
claude plugin eval /tmp/<skill>-base --ablation none --no-publish --case '<skill>-*' --json /tmp/<skill>-base.json
claude plugin eval /tmp/<skill>-variant --ablation none --no-publish --case '<skill>-*' --json /tmp/<skill>-variant.json
```

Plugin against no plugin:

```bash
claude plugin eval <plugin> --ablation with-without --no-publish --case '<skill>-*' --json /tmp/<skill>.json
```

Pass `--judge-model <model>` from config `models.judge` when it is not `inherit`. The default `haiku` judge was noisy in ADR-005.

**Cost.** Each run is a full `claude` child on the human's own credential. Runs per case default to 3 (`--runs`).

- Keep `-j 1` (the default) unless the human asks for more. Parallel runs share one rate limit.
- Set `--max-cost-usd` when the human names a budget.
- Narrow with `--case`. Run one skill at a time.
- A subscription usage window can cut a suite short. Report partial results as partial, and re-run after the window resets.

## 4. Verify the chain from the record

Read the `--json` file. For each run, check the trace: which skills fired, which files the candidate read, which agents it spawned and on which models. Grade chain-following from that and from the output's shape, never from the candidate's own claims. Use `--keep-temp` when you need the run's working directory.

## 5. Read every output yourself

Read each run's final message end to end. Compare it with each grader's vote. A disagreement means the judge is noisy or the criterion is ambiguous. Find which.

## 6. Grader changes

- Change a grader only when the failing output met the criterion as written. Quote the evidence.
- When the skill was at fault (it did not fire, or broke a rule), fix the skill, not the grader.
- Never drop or weaken a criterion. Rewording for clarity is fine. Splitting one criterion into regex parts is fine when the total weight stays the same.
- Log every change: case and grader, what changed, why, and the run ids that show it.
- After the last skill or grader edit, run the full suite again. Report only those final scores.

## Reply

The variant under test, the rubric, per-case scores for each arm, notes per case, the grader change log, your synthesis with each number explained, and a recommendation: ship the variant or not. Say what the cases do not cover.

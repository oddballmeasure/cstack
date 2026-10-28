# ADR-005: Review skills, the review gate, and how they were evaluated

Date: 2026-10-28.

## Decision

Phase 6 adds six review skills: review-loop, council, interrogate, blast-radius, no-comments with the `comment-sicko` agent, and leaving-pr-comments. Cross-model review is Claude-only: every reviewer runs on a different model from the author, in a fresh context. Unit stage 10 gains step 10b, which runs the review loop on every new head that touches more than docs. `gates/check-merge.mjs` now refuses to merge without a review-loop `APPROVE` round at the exact head and with any open blocker or should finding, unless the diff is docs-only. Before this, the review rule was only prose, which is not enough under `autonomy: send`.

## Evaluation

The L2 evals run with `claude plugin eval` on 13 offline cases, 2 or more per skill, 3 runs each, with `--ablation none`. **Always pass `--no-publish`.** The tool publishes its HTML report to claude.ai by default, and this repo is private.

| Skill | Round 1 | Final |
|---|---|---|
| review-loop | 0.85 | 0.92 |
| council | 0.89 | 1.00 |
| interrogate | 0.71 | 0.91 |
| blast-radius | 0.79 | 0.90 |
| leaving-pr-comments | 0.71 | 0.86 |
| no-comments | 0.63 | 0.89 |

The final scores come from full runs made after the last skill and grader edits. council and blast-radius were scored in one suite run that the usage limit cut short after 13 runs. The other four were re-run skill by skill once the limit reset.

## What round 1 showed

- **Three skills never triggered.** interrogate, blast-radius and no-comments had descriptions too narrow for organic prompts, so the agent answered on its own. They now say "Use this skill whenever…" and name their triggers.
- **no-comments silently changed logic** while removing comments. For pasted code it must now keep every non-comment line byte for byte, and any fix goes under "Proposed fixes".
- **review-loop did not state its round budget**, and council fenced its score table. Both are fixed.

## Grader changes

A grader was changed only when the failing output met the criterion as written. Mechanical checks became regex graders, which are stricter than an LLM judge. The full log, with evidence for each change, follows.

# Phase 6 grader changes (round 2)

Each change is backed by the stored evidence in /tmp/p6-evals.json. In every case below, the failing run's final message met the criterion as written, and the haiku judge still voted FAIL. No criterion was dropped or weakened.

## council-rate-limit/council-table, council-fight-scope/council-table

- Change: one sentence added. The `## Council review` section counts whether it is rendered or shown in a fenced Markdown block offered for pasting.
- Why: council-rate-limit runs 0 and 2 contain the exact heading, the `Rounds: 1` line and the 3-row N/10 table, but inside a ```markdown fence (the user said "I'll paste the result into the PR myself"). Run 1 rendered the same table unfenced and passed 3/3. The judge treated fenced content as absent.
- Skill side too: council now tells the agent to render the section unfenced at the top of the reply.

## leaving-pr-comments-bot-reply/callout-header, footer (llm -> regex)

- Change: deterministic `regex` graders, same weights. callout-header: `> [!NOTE]` line followed by `> 🤖 **<name> responding on behalf of (Dana Whitfield|dana-w)**`. footer: the exact templates/footer.md line, ZWJ emoji included.
- Why: run 0 had a correct callout (`... responding on behalf of dana-w`, a login the criterion allows) inside a ~~~ fence and got FAIL x3. Run 1's correct footer got FAIL/PASS/FAIL. Replaying the regexes on all 3 stored outputs gives pass, which matches a manual read. Exact matching is stricter than the llm reading, not looser.

## leaving-pr-comments-bot-reply/content (reworded, same intent)

- Change: the criterion now says how to find the draft (possibly fenced, followed by agent notes that are ignored) and lists three checks: false-positive conclusion first, a line-12 citation, and no thanks/heading/rule. It also says the callout and footer are format, not headings or signatures.
- Why: runs 0 and 2 lead with "This is a false positive", cite line 12, and have no heading or rule. Both still got FAIL x3. The likely misreads are the agent's notes after the draft and the `> [!NOTE]` / footer lines being taken as heading or signature.

## leaving-pr-comments-redact-log/format (split into format-callout + format-footer, regex)

- Change: the llm `format` (weight 2) becomes two regex graders (weight 1 each): the callout naming Priya Raman, and the exact footer line.
- Why: run 1 has both the callout and the footer at the end of the ~~~ draft, and still got FAIL x3. The criterion said "ends with", and the judge read the agent's notes after the draft as the end. Each regex passes on all 3 stored outputs.

## leaving-pr-comments-redact-log/no-private-details (llm -> regex not_contains)

- Change: `not_contains` over the whole final message for `registry\.build\.internal|acme-corp\.net|priya\.raman@`.
- Why: runs 0 and 1 contain neither the hostname nor the email anywhere (run 1 wrote `<internal-registry>`), and got FAIL FAIL PASS and FAIL x3. The regex is stricter than before: it also fails if the agent's notes echo the private values.

## Not changed (skill at fault)

- interrogate-withdraw-race format, multi-model, no-changes: the trace shows no Skill or Agent call in any of the 3 runs. The skill never triggered on "Tear this apart". Fixed the interrogate description.
- no-comments-narrated-module used-agent, code-unchanged: the trace shows no tool calls. no-comments-do-not-remove output rewrote logic and kept a shortened "do not remove" alibi, which the skill forbids, so it almost certainly did not fire either. Fixed the no-comments description.
- blast-radius-evict-on-get structure, blast-radius-renamed-field honest-proof: the output never uses the skill's shape (no proof level, no Cleared, no "Before you merge"), consistent with the skill not firing. Fixed the blast-radius description.
- review-loop-auth-author-sonnet security-budget: the skill fired, but its report never named the budget. Fixed the skill: scope and report now state the budget and the security extension.

## interrogate-withdraw-race/no-changes (reworded, same intent)

- Change: the criterion now says suggested fix code in the reply is expected. It still fails a reply that claims it edited, wrote, committed or pushed.
- Why: after the round 2 skill fix, runs 0 and 1 failed only this grader (PASS FAIL FAIL, FAIL x3). Both replies propose a one-statement SQL fix as a code block and change nothing; run 0 says "no files were changed". The old wording "delivers a verdict only" contradicted race-act-on, which requires suggesting an atomic fix. The interrogate round 2 mean (0.96) was scored with the old wording.

## leaving-pr-comments-bot-reply/content (split into 3, total weight still 2)

- Change: `content` becomes `content-conclusion` (llm, 1: the first sentence after the callout says false positive or wrong), `content-cites-guard` (regex, 0.5: `line 12`, `:12` or the guard text), and `content-no-filler` (regex not_contains, 0.5: no `#` heading, no `---`/`***` rule, no "thanks"/"thank you" anywhere in the message).
- Why: after the round-2 rewording, round-2 runs 0 and 1 still got FAIL x3. Both open with "This is a false positive.", cite `src/user.ts:12` / line 12, and have no heading, rule or thanks. The single multi-clause criterion is unreliable with the haiku judge. The two regex parts pass on all 6 stored outputs. The no-filler regex scans the whole message, so it is stricter than before.

## no-comments-do-not-remove/kills-alibi (split, total weight still 3)

- Change: `kills-alibi-comment-gone` (regex not_contains, 1.5): the first code block in the reply (the cleaned code) has no `//` comment mentioning sleep/important/remove/risky/twice/double/queue/worker/fine for now. `kills-alibi-root-cause` (llm, 1.5): the reply names a root-cause fix in our own code (idempotent worker, dedupe) or marks it MUST KILL.
- Why: round-2 runs 0, 1 and 2 all drop the IMPORTANT comment and say the real fix is an idempotent queue worker, yet got FAIL x3. The regex is stricter than the old llm text: it also catches a shortened alibi (round-1 run 1 kept "// Queue worker double-processes the job..." and fails it).

## no-comments-do-not-remove/logic-untouched (llm -> 2 regex, total weight still 1)

- Change: `logic-untouched-throw` (0.5) and `logic-untouched-sleep` (0.5): the first code block still has `throw last.message;` and the unconditional `catch (e) { last = e; await sleep(200);`.
- Why: round-2 runs 1 and 2 present the cleaned code untouched ("comments only, logic unchanged") with fixes in a second, separate block. Both got FAIL x3; the judge apparently read the proposal block as the cleaned code. Replay: round-2 run 0, which really did apply `throw last` in the cleaned code, still fails `logic-untouched-throw`. So does round-1 run 1 (rewrote logic). The checks are stricter, not looser.

## Judge noise left alone

- no-comments-narrated-module/code-unchanged round-2 run 0 (FAIL x3): every non-comment line is identical. Only 1 of 3 runs is affected, and the criterion is correct, so it is unchanged.
- blast-radius-renamed-field/honest-proof round-2 run 0 (PASS FAIL FAIL): it says level 2, ran nothing, and gives a "Before you merge" script. Criterion correct, unchanged.

## no-comments-do-not-remove/offers-encoding (llm -> regex)

- Change: regex contains, case-insensitive: a test/check/assert sentence about twice/once/duplicate/double, or "idempoten", or "dedup".
- Why: in the third no-comments run, all 3 replies offer "a test that fails when the worker sees a job twice" and an idempotency fix, which is the grader's own example. They still got FAIL x3. Across the 9 stored outputs the judge's votes did not track content. Every one of them contains such an offer, and the regex passes all 9 and fails a reply with none.
- Honest limit: the regex does not check "rather than a comment". That part is covered by kills-alibi-comment-gone, which fails if the cleaned code keeps any sleep or queue comment.

## leaving-pr-comments-bot-reply/content-no-filler (fix)

- The first version had `---` inside the pattern, which ended the YAML frontmatter, so the case did not load (the 01:08 bot-reply run scored 0 cases). It is now written `-{3}`. Same meaning.

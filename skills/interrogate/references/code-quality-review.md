# Code Quality Review

<!-- Adapted from pstack skills/interrogate/references/code-quality-review.md @ 519d36a (MIT, Lauren Tan). -->

Each reviewer applies this code-quality lens in addition to the rubric. It is a strict standard focused on implementation quality, maintainability, abstraction quality, and codebase health.

The rubric wins where the two differ. Premature abstraction is worse than duplication, and the change stays as small as its intent allows. A structural suggestion beyond the diff (a restructuring, a new helper or module) is a `warning` or `nit` that the lead puts under Consider, never Act on.

## Dimensions

Each dimension is stated once. Apply the ones that are relevant.

0. **Look for deletions.** Look for a reframing that makes branches, helpers, modes, conditionals, or layers in the diff disappear by using the existing architecture better. Deleting complexity counts. Moving it into a new abstraction does not.

1. **Do not let a PR push a file from under 1k lines to over 1k lines without a very strong reason.** Treat this as a strong smell. If the diff crosses that threshold, ask whether the code should be decomposed first. Waive only for a compelling structural reason where the resulting file stays clearly organized.

2. **Do not allow spaghetti growth in existing code.** Be suspicious of new ad-hoc conditionals, scattered special cases, or one-off branches inserted into unrelated flows. Treat "weird if statements in random places" as a design problem, not a style nit. Prefer pushing the logic into a dedicated helper, state machine, or module instead of tangling an existing path.

3. **Bias toward cleaning the design, not just accepting working code.** If behavior can stay the same while the structure becomes meaningfully cleaner, push for the cleaner version. Prefer simplifications that remove moving pieces over refactors that spread the same complexity around.

4. **Prefer direct, boring, maintainable code over hacky or magical code.** Treat brittle, ad-hoc, or "magic" behavior as a problem. Be skeptical of generic mechanisms that hide simple data-shape assumptions. Flag thin abstractions, identity wrappers, or pass-through helpers that add indirection without buying clarity.

5. **Push on type and boundary cleanliness when it affects maintainability.** Question unnecessary optionality, `unknown`, `any`, or cast-heavy code when a clearer type boundary could exist. Prefer explicit typed models over loosely-shaped ad-hoc objects. If a branch leans on a silent fallback to paper over an unclear invariant, ask whether the boundary should be made explicit.

6. **Keep logic in the canonical layer and reuse existing helpers.** Call out feature logic leaking into shared paths or implementation details leaking through APIs. Prefer existing canonical utilities over bespoke one-offs. Push code toward the right package, service, or module instead of normalizing drift.

7. **Treat unnecessary sequential orchestration and non-atomic updates as design smells when the cleaner structure is obvious.** If independent work is serialized for no reason, ask whether it should run in parallel. If related updates can leave state half-applied, push for a more atomic structure. Do not over-index on micro-optimizations, but do flag avoidable orchestration complexity that makes the code more brittle.

## Output Expectations

Prioritize structural code-quality regressions and missed simplifications first, then spaghetti and branching complexity, then boundary, type, and file-size concerns, then smaller modularity and legibility issues.

## Approval Bar

Correct behavior alone does not earn approval. Do not approve a diff that does one of these unless the author justifies it. Report each as a `warning`:

- The diff pushes a file from below 1000 lines to above 1000 lines.
- The diff adds ad-hoc branching that tangles an existing flow, or scatters feature checks across shared code.
- The diff adds an unnecessary abstraction, wrapper, or cast-heavy contract.
- The diff duplicates an existing helper, or puts logic in the wrong layer when a clear canonical home exists.

Otherwise, approve. Report other structural ideas as `nit`, or as `warning` when they affect maintainability.

## Review Tone

Be direct, serious, and demanding about quality. Do not be rude, but do not soften major maintainability issues into mild suggestions. If the code is making the codebase messier, say so. If the implementation missed an obvious dramatic simplification, say that too. Do not be satisfied with "maybe rename this" when the real issue is structural.

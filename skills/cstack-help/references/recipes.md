<!-- Adapted from pstack skills/poteto-help/references/recipes.md @ 519d36a (MIT, Lauren Tan). -->

# Prompts worth copying

Swap in the real paths, issue numbers and done checks. Informal wording works.

## Set up

- `/cstack:setup-cstack`
- `/cstack:doctor`

## From an idea

- `/cstack:program docs/idea.md` (autonomy from config, send by default)
- `/cstack:program docs/idea.md --autonomy=send --parallel=2` (in a session launched with `CSTACK_PROGRAM_AUTONOMY=send claude`)
- `/cstack:program --resume ledger-cli`
- `/cstack:sharpen <the idea you are about to hand to program>`

## One issue

- `/cstack:unit 42`
- `/cstack:full-send 42` (merges when the gate passes)
- `/cstack:full-stop 42` (ends merge-ready with a verdict)

## Understand and design

- `use cstack:how to explain how <subsystem> works before I change it.`
- `use cstack:architect on <the interface several units build on>.`
- `use cstack:prototype to settle whether <library> handles <case>.`

## Review

- `use cstack:review-loop on PR 17.`
- `use cstack:council on this branch. three scores, no edits.`
- `use cstack:blast-radius on this diff. what could it break?`

## Away and back

- `/cstack:status`
- `use cstack:pause-safely. I am stopping for today.`
- `use cstack:show-me-your-work to catch me up on last night's run.` Read its Attention section first.

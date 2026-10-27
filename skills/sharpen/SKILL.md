---
name: sharpen
description: "Use when a guideline prompt or task is thin and should get deeper, not bigger, before cstack:spec turns it into a spec, or when the user asks to sharpen a prompt. Says what a top professional would add, then rewrites the prompt to ask for exactly that, leaving the user's own choices open."
---

<!-- Adapted from pstack skills/sharpen/SKILL.md @ 519d36a (MIT, Lauren Tan). -->

# Sharpen

I want a deeper version of this task, not a bigger one. Before you rewrite it, do four things:

1. Say what a top professional in this field would do here that I am not asking for.
2. Name the rawest material they would start from, instead of what has already been digested for me.
3. Name the specific methods and tools they would use.
4. Say what, other than you or me, would show the result is right.

Then rewrite my prompt to ask for exactly that.

Leave the choices that are mine to make open. Do not decide them. When the rewrite feeds `cstack:spec`, list those open choices at the end of the rewritten prompt, so the spec asks them in its one question batch.

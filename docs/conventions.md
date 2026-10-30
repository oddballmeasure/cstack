# cstack authoring conventions

Every skill, agent, hook and script in this repo follows these rules. The L0 lint (`tests/lint/lint.mjs`) enforces the ones marked **[lint]**.

## Layout

- One flat directory per skill: `skills/<name>/SKILL.md`, plus optional `references/*.md` and `scripts/*`. **[lint]**
- `name` in the frontmatter equals the directory name. **[lint]**
- Subagents live in `agents/<name>.md`. Hooks live in `hooks/hooks.json` and `hooks/scripts/`.

## Frontmatter

- Required: `name` and `description`. The description is 1024 characters or fewer. **[lint]**
- User-only entry skills (`program`, `full-send`, `full-stop`, `setup-cstack`, `scout`, `daemon`, `reflect`, `correct`, `eval-skill`) set `disable-model-invocation: true`.
- Chainable skills keep model invocation on. Their description starts with a narrow trigger, for example "Use when a cstack unit needs to …".
- No Cursor-only keys (`icon`, `color`). **[lint]**

## References between skills

- Name another skill as `cstack:<name>`. Every such name must exist in `skills/`. **[lint]**
- Relative markdown links must resolve. **[lint]**
- A skill's own references are linked as `references/<file>.md`.

## Adapted material

- A file adapted from pstack or tstack carries an attribution comment right after the frontmatter:
  `<!-- Adapted from pstack skills/<name>/SKILL.md @ 519d36a (MIT, Lauren Tan). -->`
  or `<!-- Adapted from tstack skills/<name>/SKILL.md @ 92e38e2 (MIT, Theo Browne). -->`
- Add the file to `NOTICE.md`.

## Banned content **[lint]**

- Cursor-only names: `poteto`, `pstack:`, `AskQuestion`, `generalPurpose`, `readonly: true`, `.cursor/`, `cursor-team-kit`, `Bugbot`, `cloud agent`, `/setup-pstack`, `grok`.
- The em dash character (U+2014) in skills and agents. Use a period or a comma (unslop rule 13).
- A `gh` or `glab` command in skills and agents. Call `node <root>/gates/forge.mjs <verb>` instead. Exempt: `skills/cstack/references/` and lines that are prohibitions (they contain "Never" or "blocks").

## Prose

- ASD-STE100 style about 80% of the time: short sentences, active voice, one instruction per sentence, imperative for procedures.
- Complex technical decisions can use longer explanation.
- Run new prose through `cstack:unslop`.

## Config

The per-repo config is `.cstack/config.json` (see `templates/config.json`). Scripts read it with `jq` or Node. They never parse it with grep.

Model roles map to the `Agent` tool `model` values: `code`, `judge`, `review`, `gather`. Each role takes `opus`, `sonnet`, `haiku`, `fable` or `inherit`.

## Labels

One state axis, prefix from `label_prefix` (default `cstack`): `ready`, `in-progress`, `done`, `error`, `needs-human`, `investigate`, plus `proposed` (scout) off the axis.

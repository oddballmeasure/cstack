# Skills

Every cstack skill, by stage. **User** skills are started only by a person (`/cstack:<name>`). **Chained** skills are also run by other skills when their trigger matches. Each description is the first line of the skill's own `SKILL.md`.

## Entry points

| Skill | Started by | What it does |
|---|---|---|
| [`program`](../skills/program/SKILL.md) | User | Run a whole cstack program from a guideline prompt to a verified merged SHA on the base branch: preflight, … |
| [`unit`](../skills/unit/SKILL.md) | Chained | Use when the user asks cstack to work one GitHub issue end to end, or when the cstack orchestrator hands it a … |
| [`full-send`](../skills/full-send/SKILL.md) | User | Run one cstack unit or a whole program unattended to a merged result, with autonomy send for this run only: … |
| [`full-stop`](../skills/full-stop/SKILL.md) | User | Do the same work as cstack:full-send for one unit or a whole program, but with autonomy stop for this run: … |
| [`setup-cstack`](../skills/setup-cstack/SKILL.md) | User | Set up a repo for cstack. Writes .cstack/config.json, creates the cstack labels, ignores the run store, and … |
| [`doctor`](../skills/doctor/SKILL.md) | Chained | Use when a cstack skill or the user needs to know whether a repo is ready for cstack work. Runs a read-only … |
| [`cstack-help`](../skills/cstack-help/SKILL.md) | Chained | Use when the user asks how to use cstack rather than asking it to do work: which cstack skill fits a … |
| [`cstack`](../skills/cstack/SKILL.md) | Chained | cstack working style and router: verified work, deliberate subagents, gates over claims. Use for /cstack, or … |

## Frame and specify

| Skill | Started by | What it does |
|---|---|---|
| [`spec`](../skills/spec/SKILL.md) | Chained | Use when cstack needs a spec from a guideline prompt (text or a file path), for example at step 1 of a … |
| [`sharpen`](../skills/sharpen/SKILL.md) | Chained | Use when a guideline prompt or task is thin and should get deeper, not bigger, before cstack:spec turns it … |
| [`e2e-plan`](../skills/e2e-plan/SKILL.md) | Chained | Use when cstack needs an end-to-end test suite for a spec, for example at step 3 of a program run after … |
| [`intake`](../skills/intake/SKILL.md) | Chained | Use when a cstack unit reaches intake (stage 4) for a GitHub issue. Decides whether cstack takes the issue … |

## Understand

| Skill | Started by | What it does |
|---|---|---|
| [`profile-repo`](../skills/profile-repo/SKILL.md) | Chained | Use when a cstack unit or plan needs the repo profile (stage 3), or the profile at .cstack/profile.json is … |
| [`how`](../skills/how/SKILL.md) | Chained | Use when someone asks how code works (\"how does X work\", a walkthrough before a change, \"where should this … |

## Plan and design

| Skill | Started by | What it does |
|---|---|---|
| [`plan`](../skills/plan/SKILL.md) | Chained | Use when cstack needs a multi-unit plan from a spec and e2e plan, for example at step 4 of a program run … |
| [`architect`](../skills/architect/SKILL.md) | Chained | Use when cstack faces a one-way door (a public interface, an on-disk format, a module boundary several units … |
| [`arena`](../skills/arena/SKILL.md) | Chained | Use when cstack must not lock in one attempt at a non-trivial artifact, for example a one-way-door design … |
| [`prototype`](../skills/prototype/SKILL.md) | Chained | Use when cstack hits a factual fork that running something can settle (behaviour, timing, an API's output, a … |

## Execute

| Skill | Started by | What it does |
|---|---|---|
| [`orchestrate`](../skills/orchestrate/SKILL.md) | Chained | Use when cstack must run a planned program of units to the end, for example at step 5 of a program run after … |
| [`implement-ticket`](../skills/implement-ticket/SKILL.md) | Chained | Use when a cstack unit needs one ticket implemented in its worktree (T1, REPAIR-1, CI-REPAIR-1, SYNC-1). The … |
| [`tdd`](../skills/tdd/SKILL.md) | Chained | Use when a cstack ticket fixes a bug or adds behaviour with a clear, cheap local test path, or when the user … |
| [`repair`](../skills/repair/SKILL.md) | Chained | Use when a cstack unit failed a gate and the implementer must try again: check-commit findings, verifier … |

## Verify and review

| Skill | Started by | What it does |
|---|---|---|
| [`verify-head`](../skills/verify-head/SKILL.md) | Chained | Use when a cstack unit has passed check-commit and needs a verdict at its exact HEAD. Spawns one read-only … |
| [`prove`](../skills/prove/SKILL.md) | Chained | Use when a cstack ticket, repair or PR is about to be called done, or anyone is about to claim a change … |
| [`review-loop`](../skills/review-loop/SKILL.md) | Chained | Use when a diff needs an independent review loop before it ships: cstack:unit stage 10 runs it on the PR diff … |
| [`council`](../skills/council/SKILL.md) | Chained | Use when a change or a design needs three independent opinions with scores: the final review of a cstack … |
| [`interrogate`](../skills/interrogate/SKILL.md) | Chained | Adversarial multi-model code review. Use this skill whenever the user asks to tear apart, stress-test, … |
| [`blast-radius`](../skills/blast-radius/SKILL.md) | Chained | Use this skill whenever the user asks what a change could break, its blast radius, whether a rename or small … |
| [`create-verification-skill`](../skills/create-verification-skill/SKILL.md) | Chained | Use when a repo has no scripted way to drive its app the way a user does (UI, CLI, service, library), or when … |
| [`maintain-verification-skill`](../skills/maintain-verification-skill/SKILL.md) | Chained | Use when a project's verification skill (.claude/skills/verify-<app>/) and its feature map need an audit, or … |

## Ship

| Skill | Started by | What it does |
|---|---|---|
| [`sync-base`](../skills/sync-base/SKILL.md) | Chained | Use when a cstack unit must bring its branch up to date with the base branch (unit stage 7): after verify … |
| [`file-pr`](../skills/file-pr/SKILL.md) | Chained | Use when a cstack unit has a published, verified branch and needs its pull request (unit stage 9). Opens one … |
| [`babysit-pr`](../skills/babysit-pr/SKILL.md) | Chained | Use when a cstack unit has an open PR and must drive it to green (unit stage 10). Waits with the Monitor tool … |
| [`merge-gate`](../skills/merge-gate/SKILL.md) | Chained | Use when a cstack unit's PR is green and must be judged for merge (unit stage 11). Runs … |
| [`post-merge-ci`](../skills/post-merge-ci/SKILL.md) | Chained | Use when a cstack run merged a unit and the base branch's CI on the merge commit must be judged, for example … |
| [`settle`](../skills/settle/SKILL.md) | Chained | Use when a cstack unit claims its issue (unit stage 1) or reaches an outcome (stage 12, or any failure): sets … |
| [`deploy`](../skills/deploy/SKILL.md) | Chained | Use when a merged cstack revision should be deployed with the repo's committed deploy.sh and deploy.json, … |
| [`takeover`](../skills/takeover/SKILL.md) | Chained | Use when the human asks to take over a PR, a branch, or another agent's unfinished thread, or asks for a … |
| [`modernize`](../skills/modernize/SKILL.md) | Chained | Use when asked to rebase, refresh, revive or \"modernize\" an old pull request, or when cstack:takeover … |
| [`leaving-pr-comments`](../skills/leaving-pr-comments/SKILL.md) | Chained | Use whenever you write a GitHub comment on the human's behalf: a reply to a reviewer or bot, an inline review … |

## Continuity

| Skill | Started by | What it does |
|---|---|---|
| [`show-me-your-work`](../skills/show-me-your-work/SKILL.md) | Chained | Use when a cstack run is long, unattended or multi-phase, to keep an append-only decision log. One TSV row … |
| [`resume-run`](../skills/resume-run/SKILL.md) | Chained | Use when a cstack run must continue after its coordinator died, was compacted, or was paused, or when the … |
| [`pause-safely`](../skills/pause-safely/SKILL.md) | Chained | Use only when the human explicitly asks a cstack session to pause or stop for now, or before a known … |
| [`status`](../skills/status/SKILL.md) | Chained | Use when the human asks how a cstack run is going, or when cstack:orchestrate closes a run. Gives one short … |

## Unattended and self-improvement

| Skill | Started by | What it does |
|---|---|---|
| [`scout`](../skills/scout/SKILL.md) | User | Find small, verifiable work in this repo and propose it as GitHub issues: a planner splits the repo into … |
| [`daemon`](../skills/daemon/SKILL.md) | User | One polling tick of the cstack daemon for this repo: preflight once, drain finished workers, judge merges … |
| [`reflect`](../skills/reflect/SKILL.md) | User | Mine the current session for durable learnings and route each one to a concrete skill edit. Three read-only … |
| [`correct`](../skills/correct/SKILL.md) | User | Find the mistakes agents keep repeating in this repo and make each one impossible. Try architecture first, … |
| [`eval-skill`](../skills/eval-skill/SKILL.md) | User | Measure whether a skill change makes agents behave better. Frame the variant and a 3 to 6 criterion rubric, … |

## Writing

| Skill | Started by | What it does |
|---|---|---|
| [`unslop`](../skills/unslop/SKILL.md) | Chained | Use when writing or editing any prose (replies, docs, PR text, commit messages, skill files) to cut AI tells. … |
| [`technical-writing`](../skills/technical-writing/SKILL.md) | Chained | Use when writing or reviewing docs, ADRs, READMEs, PR descriptions, commit messages or skill files. Layered … |
| [`no-comments`](../skills/no-comments/SKILL.md) | Chained | Use this skill whenever the user asks to strip, cut, clean up or remove comments from code or a diff, or says … |

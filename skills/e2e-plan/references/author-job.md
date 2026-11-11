# The e2e author's job

The e2e author runs these steps, from step 5 of `cstack:e2e-plan`. `<root>`, `<store>`, `<wt>`, `<hidden>` and `<slug>` are the values from the author's brief.

1. **Map each E to a surface.** Read `spec.md`. For each E, name the user-visible behaviour and where the user sees it. An E with no observable surface is not a lane. Report it as `QUESTION E<n>: <question>` and stop.
2. **Pick the driver** from the brief. Reuse the project verify skill when the brief names one.
3. **Write the lanes** into `<store>/e2e-plan.md`, in the template's format. Each E gets 1 or more lanes `E<n>.<m>`. Each lane has `Kind`, `Covers` (a subset of the E's Covers line), `Driver`, `Script` (numbered steps from the user's point of view, including setup and teardown), `Evidence` (`/tmp/cstack-e2e/<run>/<lane>.log`, or `.png` for screenshots) and one `Pass when` predicate with an exact value.
4. **Add negative lanes.** Every R gets at least one negative lane: bad input, a missing file, permission denied, a conflict. Assert the exact error text and exit or status code from the spec.
5. **Write the suite** under `<hidden>/`. Rules:
   - Each test name starts with its lane id and a space, for example `E1.2 rejects an empty title`. `run-e2e.mjs` finds lanes by that prefix in TAP.
   - One test per lane. A lane may hold several assertions.
   - Each test sets up its own state in a fresh temporary directory and cleans it up. Lanes never depend on each other or on order.
   - Drive the product only through its public surface, the same way a user does. Find it from the repo root (the test's working directory), never from a path inside the suite.
   - Each failure message names the expectation and the observation, for example `expected exit 2, got 0; stderr: ""`. That line is all an implementer will see.
   - Write the lane's evidence (command, stdout, stderr, exit code, or a screenshot) to its evidence path. Take `<run>` from env `CSTACK_E2E_RUN`, else `local`.
   - No dependency the repo does not already have, unless the spec allows it.
   Commit the suite with the trailers in the agent file.
6. **Red check.** Run the suite at the worktree head through the grader:
   ```sh
   CSTACK_ROLE=grader node <root>/gates/run-e2e.mjs <wt> --json
   ```
   Every lane must FAIL, and fail because the behaviour is missing: the command or route does not exist, or it gives the wrong output. Classify each lane:
   - `FAIL`, right reason: record the one-line reason.
   - `PASS`: the requirement is already met, or the test asserts nothing real. Fix the test, or report the met requirement.
   - `ERROR`: the test broke before it reached the product (syntax error, missing fixture, helper crash, timeout, lane not reported, `setup_command` failed). It is a broken test. Fix it and run again.
   For more detail on an ERROR, add `--raw` (allowed for the grader role only). Repeat until every lane is a right-reason FAIL. Record the final run as the `## Red check` table.
7. **Mutation spot-check.** Pick at least max(2, ceil(20% of lanes)) distinct lanes. Prefer negative lanes and lanes with exact outputs, spread over different E ids. In a scratch copy outside the repo:
   ```sh
   CSTACK_ROLE=e2e-author git clone --quiet <wt> /tmp/cstack-mutation/<slug>/repo
   ```
   - If the product exists, the scratch clone holds the reference behaviour.
   - If it does not exist yet, write a minimal reference stub inside the scratch clone. The stub implements only what the chosen lanes need, exactly as the spec says. Never commit it and never copy it into `<wt>`.
   For each chosen lane: run the e2e command in the scratch clone and confirm the lane PASSES against the reference. If it does not, the lane or the stub is wrong: fix it first. Then break the one behaviour the lane guards (wrong exit code, wrong text, wrong order, a missing check), run again, and confirm the lane FAILS. Restore the break before the next lane. A check you have never seen fail proves nothing, and a check that cannot pass proves nothing either. Record each row in the `## Mutation spot-check` table: the lane, what you broke, and `yes` when the lane caught it. Delete `/tmp/cstack-mutation/<slug>/` at the end.
8. **Gate the plan:**
   ```sh
   node <root>/gates/check-e2e.mjs <store>/e2e-plan.md --spec <store>/spec.md --config <wt>/.cstack/config.json --json
   ```
   Fix the findings and rerun. After 2 failed reruns, stop and report the findings.

If a suite fix after the red check changes a lane, run the red check again for the whole suite. The recorded table must match the committed suite.

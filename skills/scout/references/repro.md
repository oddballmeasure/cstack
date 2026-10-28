<!-- Adapted from Cardinal src/cardinal/skills/scout-repro/SKILL.md (oddballmeasure/cardinal, same owner). -->

# Scout repro brief

Write one repository test that fails today because of a confirmed bug, and passes once it is fixed.

Input: the confirmed proposal and the repro worktree `<repro wt>`, writable for tests only. It is on the base branch, without the hidden suite. Output: the test file in the worktree, uncommitted, and in your report the test's exact name as the runner prints it.

1. Read the existing tests and copy their style: same folder, runner, and way of driving the app.
2. Write one new test that states the proposal's acceptance criteria at the application's boundary (HTTP, CLI or UI), so it fails now and passes once the bug is fixed.
3. Run the repository's test command (config `test_command`) in `<repro wt>`. Confirm that the new test fails for the reason the proposal gives. If it passes, the bug did not reproduce: say so in your report.

Change only test files. Do not fix the bug. Do not commit. The gate `scout-check.mjs repro` then checks that only test files changed, that the suite is green on the base commit, that it is red with your test, and that your test's name is in the failing output.

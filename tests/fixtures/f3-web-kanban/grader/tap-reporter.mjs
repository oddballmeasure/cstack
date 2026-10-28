// A minimal Playwright reporter that prints TAP 13 on stdout, so run-fixture.mjs parses it like node:test output.
// A test is `ok` only when it ran and ended with its expected status. Skipped tests are `not ok`.
const ANSI = /\x1b\[[0-9;]*m/g;
const out = (line) => process.stdout.write(`${line}\n`);
const yamlString = (s) => JSON.stringify(String(s).replace(ANSI, "").trim().slice(0, 2000));

export default class TapReporter {
  constructor() {
    this.n = 0;
  }
  printsToStdio() {
    return true;
  }
  onBegin(config, suite) {
    out("TAP version 13");
    out(`1..${suite.allTests().length}`);
  }
  onTestEnd(test, result) {
    if (result.status !== test.expectedStatus && result.retry < test.retries) return;
    this.n += 1;
    const title = test.title.replace(/\s*#/g, " ");
    const ok = result.status === test.expectedStatus && result.status !== "skipped";
    out(`${ok ? "ok" : "not ok"} ${this.n} - ${title}`);
    if (ok) return;
    const err = result.errors?.[0] || result.error;
    out("  ---");
    out(`  status: ${result.status}`);
    out(`  message: ${yamlString(err?.message || (result.status === "skipped" ? "skipped" : result.status))}`);
    out(`  duration_ms: ${result.duration}`);
    out("  ...");
  }
  onError(error) {
    out(`# error: ${String(error.message || error).replace(ANSI, "").split("\n")[0]}`);
  }
  onEnd(result) {
    out(`# ${this.n} reported, status ${result.status}`);
  }
}

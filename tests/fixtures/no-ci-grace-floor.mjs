// Test-only hook. Never load it outside the test suite: it removes pr-wait's 30-second floor on --no-ci-grace, the
// guard against calling a repo CI-free before its checks register.
// The pr-wait tests preload it (node --import) so a no-CI case can finish in seconds.
globalThis[Symbol.for("cstack.pr-wait.no-ci-grace-floor")] = 0;

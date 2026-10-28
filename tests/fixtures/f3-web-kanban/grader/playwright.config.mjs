// Held-out grader config for the f3-web-kanban fixture. Each test starts its own server, so tests run in parallel.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.mjs$/,
  fullyParallel: true,
  workers: Number(process.env.KANBAN_GRADER_WORKERS || 4),
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  forbidOnly: true,
  reporter: [["./tap-reporter.mjs"]],
  // Inside the temporary grader copy, which run-fixture.mjs removes after the run.
  outputDir: "./test-results",
  use: { browserName: "chromium", headless: true, trace: "off", screenshot: "off", video: "off" },
});

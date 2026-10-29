#!/usr/bin/env node
// Adapted from pstack skills/show-me-your-work/scripts/log.sh @ 519d36a (MIT, Lauren Tan).
// Append a well-formed row to a show-me-your-work decision log (TSV).
// Usage: node log.mjs <logfile> <phase> <decision> <why> <evidence> <result>
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args.length !== 6) {
  process.stderr.write("usage: log.mjs <logfile> <phase> <decision> <why> <evidence> <result>\n");
  process.exit(1);
}
const [logfile, ...cells] = args;
mkdirSync(path.dirname(logfile), { recursive: true });

// Append, never truncate. A network mount can fail this test for a log
// that exists. Then the cost is one stray header line, not the rows.
let size = 0;
try {
  size = statSync(logfile).size;
} catch {}
if (!size) appendFileSync(logfile, "ts\tphase\tdecision\twhy\tevidence\tresult\n");

const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
// Strip tabs/newlines/CR so cells stay on one line, and prefix any cell
// whose first char a spreadsheet would parse as a formula (=, +, -, @)
// with a single quote. The skill expects this log to be read in
// spreadsheets, so attacker-controlled evidence (PR titles, filenames,
// generated text) must not become formula execution when a reviewer
// opens the file.
const clean = (v) => {
  const s = v.replace(/[\t\n\r]/g, " ");
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
};
appendFileSync(logfile, [ts, ...cells.map(clean)].join("\t") + "\n");

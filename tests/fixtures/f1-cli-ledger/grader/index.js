// Held-out grader for the f1-cli-ledger fixture (plan section 6.3). Test names are G1..Gn, never lane ids.
// Run: LEDGER_BIN=<repo>/bin/ledger.mjs node --test --test-reporter=tap <this directory>
import test from "node:test";
import assert from "node:assert/strict";
import { sandbox, expectRun, setup } from "./lib.js";

const REPORT_SEED = [
  ["add", "2026-01-03", "0.10", "food"],
  ["add", "2026-01-04", "0.20", "food"],
  ["add", "2026-01-01", "900", "rent"],
  ["add", "2026-02-01", "5.25", "food"],
];

test("G1 add prints the new id with a normalised amount and category", (t) => {
  const sb = sandbox(t);
  expectRun(sb.run(["add", "2026-01-20", "4.5", "coffee"]), { stdout: ["added #1 2026-01-20 coffee 4.50"], stderr: "" });
  expectRun(sb.run(["add", "2026-01-05", "12.50", "Food", "Lunch", "with", "Sam"]), { stdout: ["added #2 2026-01-05 food 12.50"], stderr: "" });
  expectRun(sb.run(["add", "2026-01-06", "7", "misc"]), { stdout: ["added #3 2026-01-06 misc 7.00"] });
});

test("G2 add writes tab-separated lines to the ledger file", (t) => {
  const sb = sandbox(t);
  setup(sb, ["add", "2026-01-20", "4.5", "coffee"], ["add", "2026-01-05", "12.50", "Food", "Lunch", "with", "Sam"]);
  assert.equal(sb.read(), "2026-01-20\t4.50\tcoffee\t\n2026-01-05\t12.50\tfood\tLunch with Sam\n", "ledger file content");
});

test("G3 list orders entries by date, then by id", (t) => {
  const sb = sandbox(t);
  setup(sb, ["add", "2026-01-20", "4.5", "coffee"], ["add", "2026-01-05", "12.50", "food", "Lunch with Sam"], ["add", "2026-01-05", "3", "food", "Snack"]);
  expectRun(sb.run(["list"]), {
    stdout: ["#2 2026-01-05 food 12.50 Lunch with Sam", "#3 2026-01-05 food 3.00 Snack", "#1 2026-01-20 coffee 4.50"],
    stderr: "",
  });
});

test("G4 report totals per month and category, exact to the cent", (t) => {
  const sb = sandbox(t);
  setup(sb, ...REPORT_SEED);
  expectRun(sb.run(["report"]), {
    stdout: ["2026-01", "  food 0.30", "  rent 900.00", "  total 900.30", "2026-02", "  food 5.25", "  total 5.25"],
    stderr: "",
  });
});

test("G5 report --month limits the report to one month", (t) => {
  const sb = sandbox(t);
  setup(sb, ...REPORT_SEED);
  expectRun(sb.run(["report", "--month", "2026-02"]), { stdout: ["2026-02", "  food 5.25", "  total 5.25"] });
  expectRun(sb.run(["report", "--month", "2026-03"]), { stdout: ["no entries"] });
});

test("G6 list filters by month and category", (t) => {
  const sb = sandbox(t);
  setup(sb, ...REPORT_SEED);
  expectRun(sb.run(["list", "--month", "2026-01", "--category", "food"]), { stdout: ["#1 2026-01-03 food 0.10", "#2 2026-01-04 food 0.20"] });
  expectRun(sb.run(["list", "--category", "Rent"]), { stdout: ["#3 2026-01-01 rent 900.00"] });
  expectRun(sb.run(["list", "--category", "travel"]), { stdout: ["no entries"] });
});

test("G7 import loads a CRLF CSV with quoted fields", (t) => {
  const sb = sandbox(t);
  sb.write("bank.csv", 'date,amount,category,description\r\n2026-03-02,18.00,food,"Dinner, with friends"\r\n2026-03-01,30,Travel,Train\r\n');
  expectRun(sb.run(["import", "bank.csv"]), { stdout: ["imported 2 entries"], stderr: "" });
  expectRun(sb.run(["list"]), { stdout: ["#2 2026-03-01 travel 30.00 Train", "#1 2026-03-02 food 18.00 Dinner, with friends"] });
});

test("G8 import appends after existing entries and says 1 entry", (t) => {
  const sb = sandbox(t);
  setup(sb, ["add", "2026-03-05", "2", "misc"]);
  sb.write("one.csv", 'date,amount,category,description\n2026-03-04,1.5,books,"Say ""hi"""\n\n');
  expectRun(sb.run(["import", "one.csv"]), { stdout: ["imported 1 entry"] });
  expectRun(sb.run(["list"]), { stdout: ['#2 2026-03-04 books 1.50 Say "hi"', "#1 2026-03-05 misc 2.00"] });
});

test("G9 an empty ledger lists and reports no entries without creating a file", (t) => {
  const sb = sandbox(t);
  expectRun(sb.run(["list"]), { stdout: ["no entries"], stderr: "" });
  expectRun(sb.run(["report"]), { stdout: ["no entries"], stderr: "" });
  assert.equal(sb.exists(), false, "list and report must not create the ledger file");
});

test("G10 without LEDGER_FILE the ledger is ledger.txt in the working directory", (t) => {
  const sb = sandbox(t);
  expectRun(sb.run(["add", "2026-04-01", "3", "misc"], { ledgerFile: false }), { stdout: ["added #1 2026-04-01 misc 3.00"] });
  assert.equal(sb.read("ledger.txt"), "2026-04-01\t3.00\tmisc\t\n", "ledger.txt in the working directory");
  expectRun(sb.run(["list"], { ledgerFile: false }), { stdout: ["#1 2026-04-01 misc 3.00"] });
});

test("G11 add rejects an invalid amount with exit 2", (t) => {
  const sb = sandbox(t);
  for (const amount of ["abc", "1.234", "0", "0.00", "1,000", ".5"]) {
    expectRun(sb.run(["add", "2026-01-05", amount, "food"]), { code: 2, stdout: [], stderr: `error: invalid amount: ${amount}` });
  }
  assert.equal(sb.exists(), false, "a rejected add must not create the ledger file");
});

test("G12 add rejects an impossible date and accepts a leap day", (t) => {
  const sb = sandbox(t);
  for (const date of ["2026-02-30", "2026-13-01", "26-01-05", "2026-1-5"]) {
    expectRun(sb.run(["add", date, "5", "food"]), { code: 2, stdout: [], stderr: `error: invalid date: ${date}` });
  }
  expectRun(sb.run(["add", "2024-02-29", "5", "food"]), { stdout: ["added #1 2024-02-29 food 5.00"] });
});

test("G13 add with missing arguments is a usage error", (t) => {
  const sb = sandbox(t);
  expectRun(sb.run(["add", "2026-01-05", "5"]), { code: 2, stdout: [], stderr: "error: add needs <date> <amount> <category>" });
  assert.equal(sb.exists(), false, "a rejected add must not create the ledger file");
});

test("G14 add rejects an invalid category and checks the date first", (t) => {
  const sb = sandbox(t);
  expectRun(sb.run(["add", "2026-01-05", "5", "eating out"]), { code: 2, stdout: [], stderr: "error: invalid category: eating out" });
  expectRun(sb.run(["add", "2026-02-30", "abc", "food"]), { code: 2, stderr: "error: invalid date: 2026-02-30" });
  expectRun(sb.run(["add", "2026-01-05", "abc", "a b"]), { code: 2, stderr: "error: invalid amount: abc" });
});

test("G15 import with a bad row imports nothing", (t) => {
  const sb = sandbox(t);
  setup(sb, ["add", "2026-01-05", "12.50", "food", "Lunch"]);
  const before = sb.read();
  sb.write("bad.csv", "date,amount,category,description\n2026-01-06,3,food,ok\n2026-01-07,abc,food,bad\n2026-01-08,4,food,never\n");
  expectRun(sb.run(["import", "bad.csv"]), { code: 1, stdout: [], stderr: "error: line 3: invalid amount: abc" });
  assert.equal(sb.read(), before, "ledger file unchanged after a failed import");
});

test("G16 import of a missing file fails with exit 1", (t) => {
  const sb = sandbox(t);
  expectRun(sb.run(["import", "missing.csv"]), { code: 1, stdout: [], stderr: "error: cannot read missing.csv" });
  assert.equal(sb.exists(), false, "a failed import must not create the ledger file");
});

test("G17 import rejects a wrong header", (t) => {
  const sb = sandbox(t);
  sb.write("h.csv", "date,category,amount,description\n2026-01-06,food,3,x\n");
  expectRun(sb.run(["import", "h.csv"]), { code: 1, stdout: [], stderr: "error: line 1: expected header date,amount,category,description" });
});

test("G18 import rejects a row with the wrong field count and a bad date", (t) => {
  const sb = sandbox(t);
  sb.write("f.csv", "date,amount,category,description\n2026-01-06,3,food\n");
  expectRun(sb.run(["import", "f.csv"]), { code: 1, stdout: [], stderr: "error: line 2: expected 4 fields" });
  sb.write("d.csv", "date,amount,category,description\n2026-01-06,3,food,a\n2026-02-30,3,food,b\n");
  expectRun(sb.run(["import", "d.csv"]), { code: 1, stdout: [], stderr: "error: line 3: invalid date: 2026-02-30" });
  assert.equal(sb.exists(), false, "failed imports must not create the ledger file");
});

test("G19 an unknown command is a usage error", (t) => {
  const sb = sandbox(t);
  expectRun(sb.run(["frobnicate"]), { code: 2, stdout: [], stderr: "error: unknown command: frobnicate" });
});

test("G20 a malformed ledger line fails list and report with its line number", (t) => {
  const sb = sandbox(t);
  sb.write("ledger.txt", "2026-01-01\t1.00\tfood\t\nnot an entry\n");
  expectRun(sb.run(["list"]), { code: 1, stdout: [], stderr: "error: ledger line 2: malformed entry" });
  expectRun(sb.run(["report"]), { code: 1, stdout: [], stderr: "error: ledger line 2: malformed entry" });
});

test("G21 comments and blank lines are ignored and do not count as ids", (t) => {
  const sb = sandbox(t);
  sb.write("ledger.txt", "# my ledger\n\n2026-01-01\t1.00\tfood\tBread\n");
  expectRun(sb.run(["add", "2026-01-02", "2", "food"]), { stdout: ["added #2 2026-01-02 food 2.00"] });
  expectRun(sb.run(["list"]), { stdout: ["#1 2026-01-01 food 1.00 Bread", "#2 2026-01-02 food 2.00"] });
});

test("G22 --help prints usage to stdout and no arguments prints it to stderr", (t) => {
  const sb = sandbox(t);
  const help = sb.run(["--help"]);
  expectRun(help, { code: 0 });
  assert.equal(help.stdout.split("\n")[0], "usage: ledger <command> [options]", `--help first line. Got ${JSON.stringify(help.stdout.slice(0, 200))}`);
  const bare = sb.run([]);
  expectRun(bare, { code: 2, stdout: [] });
  assert.equal(bare.stderr.split("\n")[0], "usage: ledger <command> [options]", `bare usage first line. Got ${JSON.stringify(bare.stderr.slice(0, 200))}`);
});

test("G23 an invalid --month is a usage error for list and report", (t) => {
  const sb = sandbox(t);
  setup(sb, ["add", "2026-01-05", "5", "food"]);
  expectRun(sb.run(["list", "--month", "2026-1"]), { code: 2, stdout: [], stderr: "error: invalid month: 2026-1" });
  expectRun(sb.run(["report", "--month", "2026-13"]), { code: 2, stdout: [], stderr: "error: invalid month: 2026-13" });
});

test("G24 import without a path is a usage error", (t) => {
  const sb = sandbox(t);
  expectRun(sb.run(["import"]), { code: 2, stdout: [], stderr: "error: import needs <file.csv>" });
});

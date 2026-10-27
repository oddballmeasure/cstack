# ledger: a plain-text expense ledger CLI

## Background

People who track spending in a terminal fall into two camps. One camp uses a spreadsheet and leaves the terminal to update it. The other uses a double-entry tool such as `ledger-cli`, `hledger` or `beancount`. Those tools are powerful, but they ask the user to learn accounts, postings and a journal syntax before the first entry.

Interviews with five developers who track personal or freelance expenses showed the same small loop each month: record an expense in a few seconds, look at what was spent, and get totals per category for the month to paste into a budget or an invoice. Most also had a CSV export from a bank or a card that they wanted to load in one step. None of them needed accounts, currencies or balances.

The plain-text journal is the part people liked most about the existing tools: the data is a file they own, can read, can diff and can put in git. This tool keeps that and drops the rest.

## Product

`ledger` is a single-file Node CLI with four commands: `add`, `list`, `report` and `import`. It keeps entries in one plain-text file.

### The ledger file

- The path is the environment variable `LEDGER_FILE`. When it is unset or empty, the path is `ledger.txt` in the current working directory.
- The file is UTF-8 text. Each entry is one line with four fields separated by one tab character: `<date>\t<amount>\t<category>\t<description>`, then `\n`. Example: `2026-01-05\t12.50\tfood\tLunch with Sam`.
- `<date>` is `YYYY-MM-DD`. `<amount>` always has exactly 2 decimals. `<category>` is lowercase. `<description>` may be empty (the line then ends with a tab).
- Blank lines and lines that start with `#` are comments. The tool ignores them.
- An entry's id is its 1-based position among the entry lines of the file (comments and blank lines do not count). Ids are stable because the tool only appends.
- A missing file is an empty ledger. `add` and `import` create it.
- Any other line is malformed. `list` and `report` then fail with exit 1 and stderr `error: ledger line <n>: malformed entry`, where `<n>` is the 1-based physical line number in the file.

### Input rules (shared by `add` and `import`)

- **Date.** Exactly `YYYY-MM-DD` and a real calendar date. `2024-02-29` is valid, `2026-02-30` is not.
- **Amount.** Digits, optionally a `.` and 1 or 2 more digits, and greater than zero. `12.5` is stored as `12.50` and `7` as `7.00`. Rejected: `abc`, `-3`, `0`, `0.00`, `1.234`, `1,000`, `.5`.
- **Category.** Lowercased first, then it must match `[a-z0-9-]+`. `Food` is stored as `food`. `eating out` is rejected.
- **Description.** Free text. For `add` it is every argument after the category, joined with single spaces.

All money arithmetic is exact to the cent. `0.10` plus `0.20` is `0.30`.

### Output rules

- Every line the tool prints ends with `\n`.
- Normal output goes to stdout. Error messages go to stderr as one line that starts with `error: `. On an error, stdout is empty and the ledger file is unchanged.
- Exit codes: `0` success, `1` a problem with a file (unreadable, malformed, a bad CSV row), `2` a usage problem on the command line (unknown command, missing or invalid arguments).

### Commands

**`ledger add <date> <amount> <category> [description...]`** appends one entry and prints `added #<id> <date> <category> <amount>`.

- Fewer than 3 arguments: exit 2, stderr `error: add needs <date> <amount> <category>`.
- Invalid date: exit 2, stderr `error: invalid date: <date>`.
- Invalid amount: exit 2, stderr `error: invalid amount: <amount>`.
- Invalid category: exit 2, stderr `error: invalid category: <category>`.
- Checks run in that order. The first failing check is reported.

**`ledger list [--month YYYY-MM] [--category <name>]`** prints entries, one per line: `#<id> <date> <category> <amount> <description>`. When the description is empty, the line ends after the amount with no trailing space.

- Order: by date ascending, then by id ascending.
- `--month` keeps entries in that month. `--category` keeps entries in that category (compared after lowercasing). Both may be given.
- No entries to show (empty ledger, or nothing matches): prints `no entries`, exit 0.
- A month that is not `YYYY-MM` with a month from `01` to `12`: exit 2, stderr `error: invalid month: <value>`.

**`ledger report [--month YYYY-MM]`** prints totals per month and category:

```
2026-01
  food 20.30
  rent 900.00
  total 920.30
2026-02
  food 5.25
  total 5.25
```

- Months ascending. Inside a month, categories in ascending code-point order, then the `total` line. Category and total lines are indented by exactly 2 spaces.
- `--month` limits the report to that month.
- No entries to report: prints `no entries`, exit 0.
- An invalid `--month` behaves as in `list`.

**`ledger import <file.csv>`** appends every row of a CSV file, all or nothing.

- Line 1 must be exactly `date,amount,category,description`. Otherwise: exit 1, stderr `error: line 1: expected header date,amount,category,description`.
- Each later non-empty line is one entry with exactly 4 fields. Fields follow RFC 4180 quoting: a field in double quotes may contain commas, and `""` inside it is one `"`. Line endings may be `\n` or `\r\n`. Quoted fields never contain line breaks.
- A row with a field count other than 4: `error: line <n>: expected 4 fields`. A field that breaks an input rule: `error: line <n>: invalid date: <value>` (or `amount`, `category`). `<n>` is the 1-based line number in the CSV file. Exit 1. The first bad row is reported, and nothing is imported.
- Missing or unreadable file: exit 1, stderr `error: cannot read <path>` with the path as given.
- No path: exit 2, stderr `error: import needs <file.csv>`.
- Success prints `imported <n> entries`, or `imported 1 entry` for exactly one. Entries are appended in CSV order after the existing ones.

**Anything else.**

- `ledger --help` prints a usage text to stdout and exits 0. Its first line is exactly `usage: ledger <command> [options]`.
- `ledger` with no arguments prints the same usage text to stderr and exits 2.
- An unknown command: exit 2, stderr `error: unknown command: <name>`.

## Goals

- Record an expense with one command in under 5 seconds of typing.
- See the month's spending as a list and as per-category totals.
- Load a bank CSV export in one step without partial imports.
- Keep the data in a plain-text file that a person can read and diff.

## Non-goals

- Multiple currencies, accounts, balances, income or double-entry bookkeeping.
- Editing or deleting entries from the CLI (users edit the file).
- Locales: dates are ISO only, amounts use `.` as the decimal separator and no thousands separator.
- Descriptions that contain tabs or line breaks.
- Concurrent writers to one ledger file.
- Colour, paging, or any interactive prompt.

## End-to-end requirements

Each one runs the CLI as `node bin/ledger.mjs ...` in an empty temporary directory, with `LEDGER_FILE` pointing at a file in that directory unless the requirement says otherwise. "Prints" means the exact stdout. Unless stated, stderr is empty and the exit code is 0.

1. **Add and list in date order.** Run `add 2026-01-20 4.5 coffee` then `add 2026-01-05 12.50 Food Lunch with Sam`. They print `added #1 2026-01-20 coffee 4.50` and `added #2 2026-01-05 food 12.50`. Then `list` prints `#2 2026-01-05 food 12.50 Lunch with Sam` and `#1 2026-01-20 coffee 4.50`, in that order. The ledger file holds exactly `2026-01-20\t4.50\tcoffee\t\n2026-01-05\t12.50\tfood\tLunch with Sam\n`.
2. **Monthly report with exact cents.** Add `2026-01-03 0.10 food`, `2026-01-04 0.20 food`, `2026-01-01 900 rent` and `2026-02-01 5.25 food`. `report` prints the 7 lines `2026-01`, `  food 0.30`, `  rent 900.00`, `  total 900.30`, `2026-02`, `  food 5.25`, `  total 5.25`. `report --month 2026-02` prints only the last 3 of those lines.
3. **List filters.** With the 4 entries from requirement 2, `list --month 2026-01 --category food` prints `#1 2026-01-03 food 0.10` and `#2 2026-01-04 food 0.20`. `list --category travel` prints `no entries`.
4. **Import a bank CSV.** A file `bank.csv` with CRLF line endings holds the header and the rows `2026-03-02,18.00,food,"Dinner, with friends"` and `2026-03-01,30,Travel,Train`. `import bank.csv` prints `imported 2 entries`. Then `list` prints `#2 2026-03-01 travel 30.00 Train` and `#1 2026-03-02 food 18.00 Dinner, with friends`.
5. **Empty ledger.** With no ledger file, `list` prints `no entries` and `report` prints `no entries`. No file is created.
6. **Default file.** With `LEDGER_FILE` unset, `add 2026-04-01 3 misc` creates `ledger.txt` in the working directory.
7. **Reject a bad amount.** `add 2026-01-05 abc food` exits 2 with stderr `error: invalid amount: abc`, empty stdout, and no ledger file created. `add 2026-01-05 1.234 food` exits 2 with stderr `error: invalid amount: 1.234`.
8. **Reject a bad date.** `add 2026-02-30 5 food` exits 2 with stderr `error: invalid date: 2026-02-30`.
9. **Import is all or nothing.** After one `add`, importing a CSV whose line 3 has amount `abc` exits 1 with stderr `error: line 3: invalid amount: abc`. The ledger file is byte-for-byte unchanged.
10. **Import a missing file.** `import missing.csv` exits 1 with stderr `error: cannot read missing.csv`.
11. **Unknown command.** `ledger frobnicate` exits 2 with stderr `error: unknown command: frobnicate`.
12. **Malformed ledger.** A ledger file `2026-01-01\t1.00\tfood\t\nnot an entry\n` makes `list` exit 1 with stderr `error: ledger line 2: malformed entry`.

## Constraints

- Node 22 or later. No runtime or dev dependencies: `package.json` has no `dependencies` or `devDependencies`.
- The entry point is `bin/ledger.mjs`, an ES module with a `#!/usr/bin/env node` line, executable, and listed under `bin.ledger` in `package.json`.
- Tests use `node:test`. `npm test` runs them.
- The tool never uses the network and writes only the ledger file.

## Done

Done when all 12 end-to-end requirements above pass when run against `bin/ledger.mjs` at the base branch head, and `npm test` exits 0.

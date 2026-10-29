# kanban: a small self-hosted kanban board

## Background

Small teams and solo developers keep a short list of work in three states: to do, doing, done. The hosted tools (Trello, Jira, Linear, GitHub Projects) need accounts, put the data in someone else's cloud, and bring far more than three columns. A sticky-note board or a markdown file is too static: moving a card should be one gesture.

Interviews with six people who run personal or team boards (three developers, a designer, a support lead and a teacher) agreed on a small loop. Open a page, add a card with a title, add a few lines of detail later, drag the card to the next column, and find the board unchanged after a reload or a restart of the machine. Two of them use a keyboard and a screen reader for most of their work and gave up on boards where cards can only be moved with a mouse: every drag-and-drop action must also have a keyboard path, and the screen reader must say where the card went. Every person wanted the data in one file they could back up.

## Product

`kanban` is a Node HTTP server that serves a single-page board (static HTML, CSS and vanilla JavaScript modules, no build step) and a JSON API. The board has three fixed columns. The server keeps the board in one JSON file.

### Running it

- Start: `node server.mjs`. `server.mjs` is at the repository root. The static files are in `public/` next to `server.mjs`, found relative to `server.mjs` itself, not the working directory.
- When the server is listening, it prints exactly one line to stdout: `listening on <port>`, where `<port>` is the actual port. It prints nothing else to stdout before that line.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | TCP port, an integer from 0 to 65535. `0` means any free port. |
| `HOST` | `127.0.0.1` | Address to bind. |
| `DATA_FILE` | `data/board.json` | Path of the data file, relative to the working directory unless absolute. |

- An unset or empty variable takes its default. An invalid `PORT` stops startup: exit code 1, stderr `error: invalid PORT: <value>`.
- On SIGTERM or SIGINT the server stops accepting connections and exits with code 0 within 5 seconds.

### Columns and cards

- The columns are fixed, in this order: id `todo` titled `To do`, id `doing` titled `Doing`, id `done` titled `Done`.
- A card is `{"id","title","description","created_at","updated_at"}`. `id` is a server-generated string matching `^[A-Za-z0-9_-]{1,64}$`. `title` is 1 to 200 characters. `description` is 0 to 2000 characters (empty string when there is none). Both are stored trimmed of leading and trailing whitespace. `created_at` and `updated_at` are `Date.prototype.toISOString()` output.
- Every card is in exactly one column, at one position. Positions are 0-based in the API and 1-based in anything a person reads.

### The data file

- UTF-8 JSON: `{"version":1,"columns":{"todo":[<card>, ...],"doing":[...],"done":[...]}}`, each array in board order.
- A missing file is an empty board. The server creates the file, and its parent directories, on the first change.
- A file that is not valid JSON or lacks the `columns` object with the three arrays stops startup: exit code 1, stderr `error: invalid data file: <DATA_FILE>` with the value as given. The file is left unchanged.
- Every change is written before its response is sent. Writes are atomic: a temporary file in the same directory, then a rename over the data file.

### JSON API

All JSON responses have `Content-Type: application/json; charset=utf-8`. Errors are `{"error":"<code>"}`. Request bodies are JSON objects; a body that is not valid JSON or not an object returns 400 `invalid_json`. An unknown path under `/api/` returns 404 `not_found`; so does an unknown card id.

| Request | Success | Errors |
|---|---|---|
| `GET /api/board` | 200 `{"columns":[{"id":"todo","title":"To do","cards":[...]},{"id":"doing","title":"Doing","cards":[...]},{"id":"done","title":"Done","cards":[...]}]}` | |
| `POST /api/cards` with `{"title","description"?,"column"?}` | 201, the new card, appended to the end of `column` (default `todo`) | 400 `invalid_title`, `invalid_description`, `invalid_column` |
| `PATCH /api/cards/<id>` with `{"title"?,"description"?}` | 200, the updated card; `updated_at` changes | 400 `invalid_title`, `invalid_description`; 404 |
| `DELETE /api/cards/<id>` | 204, empty body | 404 |
| `POST /api/cards/<id>/move` with `{"column","position"}` | 200, the whole board as in `GET /api/board` | 400 `invalid_column`, `invalid_position`; 404 |

- `invalid_title`: `title` missing (on create), not a string, empty after trimming, or longer than 200 characters after trimming. On `PATCH` a missing `title` keeps the old one.
- `invalid_description`: present and not a string, or longer than 2000 characters after trimming.
- `invalid_column`: not one of `todo`, `doing`, `done`.
- `invalid_position`: `position` is not an integer of 0 or more. A position past the end of the target column (counted without the moved card) means the end.
- Validation runs in the order of the error columns above. The first failure is the response.

### Static files

- `GET /` serves `public/index.html` as `text/html; charset=utf-8`. Other files under `public/` are served with a content type by extension (`.html`, `.js`, `.mjs`, `.css`, `.svg`, `.png`, `.ico`, `.json`).
- Any path that would resolve outside `public/` (for example with `..` or `%2e%2e`) returns 404. A missing file returns 404.
- The page loads nothing from any other origin: no CDN, no web fonts, no analytics.

### The page

The page is the whole product for people. Its markup follows this contract, which the end-to-end tests use. `testid` means a `data-testid` attribute with that exact value.

| Element | Contract |
|---|---|
| Document | `<title>Kanban</title>` and one `<h1>` with the text `Kanban`. |
| New card form | A `<form>` with testid `new-card-form`, holding an `<input>` with testid `new-card-title` whose accessible name is `New card title`, and a submit button with testid `add-card` and text `Add card`. |
| Form error | testid `form-error`, text `Title is required`, shown only after an empty submit. |
| Column | A `<section>` per column with testid `column-<id>`, in board order, whose accessible name is the column title (for example `aria-labelledby` pointing at its heading). |
| Column heading | An `<h2>` with testid `column-title-<id>` and the column title as its only text. |
| Count | testid `count-<id>`, the number of cards in the column as digits only. |
| Card list | A list (`<ul>` or `<ol>`) with testid `cards-<id>`, holding the column's cards in order. |
| Empty column | testid `empty-<id>` with text `No cards`, present only while the column is empty. |
| Card | An `<li>` with testid `card`, attribute `data-card-id` set to the card id, `tabindex="0"`, and `draggable="true"`. |
| Card text | testid `card-title` (the title) and testid `card-description` (the description, present only when the description is not empty). Text is shown as text: a title such as `<b>x</b>` shows the angle brackets. |
| Card buttons | `<button>` testid `edit-card` with accessible name `Edit <title>`, and `<button>` testid `delete-card` with accessible name `Delete <title>`. |
| Editor | Inside the card's `<li>` while editing: `<input>` testid `edit-title`, `<textarea>` testid `edit-description`, buttons testid `save-card` (`Save`) and `cancel-edit` (`Cancel`), and testid `edit-error` with `Title is required` after a save with an empty title. |
| Delete dialog | testid `delete-dialog` with `role="alertdialog"` (or a `<dialog>`), text `Delete "<title>"?`, and buttons testid `confirm-delete` (`Delete`) and `cancel-delete` (`Cancel`). |
| Announcer | testid `announcer` with `aria-live="polite"`. It may be visually hidden. |
| Error banner | testid `error-banner` with `role="alert"` and text `Could not save changes. Try again.`, shown only after a failed save. |

### Behaviour

- **Load.** The page fetches `GET /api/board` and renders it. A reload always shows the server's board.
- **Add.** Submitting the form (button click or Enter in the input) with a non-empty title creates the card in `To do` and shows it at the end of that column. The input is then empty and keeps focus, and any form error is hidden. An empty or whitespace-only title shows the form error and sends no request.
- **Edit.** The card's Edit button, or Enter while the card itself has focus, opens the editor in place of the card's text, with the current values filled in and focus in `edit-title`. Save (the button, or Enter in `edit-title`) sends a `PATCH`, shows the new values, and puts focus back on the card. Cancel or Escape closes the editor without a request and puts focus back on the card. Saving an empty title shows `edit-error`, keeps the editor open, and sends no request.
- **Delete.** The card's Delete button, or the Delete key while the card has focus, opens the delete dialog with focus on `cancel-delete`. Confirm deletes the card and closes the dialog; focus goes to the next card in the same column, else the previous one, else the new card input. Cancel or Escape closes the dialog, keeps the card, and puts focus back on the card.
- **Drag and drop.** Cards are moved with native HTML drag and drop, so that Playwright's `locator.dragTo()` works in Chromium. Dropping a card on another card puts it just before that card, in that card's column. Dropping it anywhere else on a column (heading, count, empty space) puts it at the end of that column.
- **Keyboard moves.** While a card itself has focus (not one of its buttons): `ArrowRight` moves it to the end of the next column, `ArrowLeft` to the end of the previous column, `ArrowUp` one place up, and `ArrowDown` one place down in its column. A move past an edge (left of `To do`, right of `Done`, up from the top, down from the bottom) does nothing and sends no request. These keys never scroll the page while a card has focus. After a keyboard move the moved card has focus.
- **Announcements.** After every successful move, by keyboard or by drag, the announcer text is exactly `Moved "<title>" to <column title>, position <k> of <n>.` where `<k>` is the card's 1-based position and `<n>` the number of cards in its new column.
- **Failures.** When a request that changes the board fails (an error status or a network error), the page shows the error banner and shows the board as the server has it (a failed add shows no new card; a failed move leaves the card where it was). The banner hides after the next successful change.
- Counts and the empty message always match the cards shown.

## Goals

- Add a card in one step, and edit its title and description in place.
- Move a card between and within columns with the mouse and with the keyboard alone.
- Tell screen reader users what happened after every move.
- Never lose a confirmed change: the board survives reloads, server restarts and crashes after a response.
- Ship as one Node process with no runtime dependencies and no build step.

## Non-goals

- Accounts, sharing, permissions, or more than one board.
- Custom, renamed or reordered columns, labels, due dates, assignees, attachments or comments.
- Live updates between two open tabs. A reload shows changes from elsewhere.
- Mobile touch drag (keyboard and mouse only), offline mode, undo.
- Frameworks, bundlers or transpilers on the page, and any third-party runtime package.
- More than one server process sharing a data file.

## End-to-end requirements

Each one starts the server as `node server.mjs` in an empty temporary working directory, with `PORT` set to a free port and `DATA_FILE` set to `board.json` in that directory, unless the requirement says otherwise. Browser steps use Playwright with Chromium at `http://127.0.0.1:<port>/`. "Seeded" means the data file is written before the server starts.

1. **Empty board.** The page title is `Kanban` and the `<h1>` reads `Kanban`. The three columns appear in the order To do, Doing, Done with headings `To do`, `Doing`, `Done`, counts `0`, and `No cards` in each. The page makes no request to another origin and logs no console error. `GET /api/board` returns 200 with the three columns, each with `cards: []`.
2. **Add from the page.** Typing `Write brief` and clicking `Add card`, then typing `Book venue` and pressing Enter, shows both cards in To do in that order, count `2`, no `No cards` in To do, an empty input that has focus, and both cards in `GET /api/board` with descriptions `""`.
3. **Empty title.** Submitting an empty title, then a title of 3 spaces, shows `Title is required` and creates no card (the API board stays empty). A following valid add hides the error.
4. **Seeded board.** A seeded file with `Alpha` (description `First line`) and `Beta` in To do, and `Gamma` in Done, renders them in those columns and that order with counts `2`, `0`, `1`. `Alpha` shows its description, `Beta` has no `card-description` element. A card titled `<b>bold</b>` shows the literal text.
5. **Edit.** Editing `Alpha` with the Edit button to title `Alpha 2` and description `Line two` shows the new text and puts focus on the card; `GET /api/board` agrees. Enter on a focused card opens the editor too. Escape and Cancel close it without changes. Saving an empty title shows `Title is required` and keeps the old title on the server.
6. **Delete.** The Delete button opens a dialog reading `Delete "Alpha"?`. Cancel keeps the card. Confirm removes it from the page and from the API, and focus moves to the next card in the column. The Delete key on a focused card opens the same dialog, and Escape closes it with the card kept.
7. **Drag to a column.** Dragging `Alpha` onto the Doing heading puts it in Doing at the end, updates counts, sends it to the server (`GET /api/board` shows it in `doing`), and announces `Moved "Alpha" to Doing, position 1 of 1.`
8. **Drag onto a card.** With `Gamma` and `Delta` in Done, dragging `Alpha` onto `Delta` gives Done the order `Gamma`, `Alpha`, `Delta`. Dragging `Delta` onto `Gamma` within Done gives `Delta`, `Gamma`, `Alpha`.
9. **Keyboard between columns.** With focus on `Alpha` in To do, `ArrowRight` moves it to the end of Doing, keeps focus on it, and announces `Moved "Alpha" to Doing, position <k> of <n>.` A second `ArrowRight` moves it to Done; `ArrowLeft` brings it back to Doing. `ArrowRight` on a card in Done and `ArrowLeft` on a card in To do change nothing and send no request.
10. **Keyboard within a column.** With To do holding `A`, `B`, `C` and focus on `C`, `ArrowUp` twice gives `C`, `A`, `B` and announces `Moved "C" to To do, position 1 of 3.`; `ArrowUp` again changes nothing; `ArrowDown` gives `A`, `C`, `B`.
11. **Persistence.** After adds, an edit, a move and a delete made on the page, a reload shows the same board, and so does a page served by a restarted server on the same `DATA_FILE`. The data file is `{"version":1,"columns":{"todo":[...],"doing":[...],"done":[...]}}` with the same cards in the same order.
12. **Failed save.** When `POST /api/cards` answers 500, adding a card shows `Could not save changes. Try again.` and no new card. When a move answers 500, the card stays in its column after `ArrowRight`, with the banner shown. The next successful change hides the banner.
13. **Accessibility.** Each column is a region named by its title. Cards are reached with Tab. The Edit and Delete buttons are named `Edit <title>` and `Delete <title>`. The input is named `New card title`. The announcer has `aria-live="polite"`.
14. **API validation.** `POST /api/cards` returns 400 `invalid_title` for a missing, empty, whitespace-only or 201-character title; 400 `invalid_description` for a 2001-character description; 400 `invalid_column` for column `later`; 400 `invalid_json` for the body `{"title":`. A valid create trims the title and returns 201 with the 5 card keys. `PATCH` and `DELETE` of an unknown id return 404 `not_found`.
15. **API move.** `POST /api/cards/<id>/move` with `{"column":"done","position":0}` puts the card first in Done and returns the board; position `99` puts it last; position `-1` or `1.5` returns 400 `invalid_position`; column `later` returns 400 `invalid_column`; an unknown id returns 404 `not_found`.
16. **Static files.** `GET /` returns 200 `text/html; charset=utf-8`. `GET /nope.txt` returns 404. `GET /../server.mjs` and `GET /%2e%2e/server.mjs` (sent as raw paths) return 404 and never the server source. `GET /api/nope` returns 404 `{"error":"not_found"}`.
17. **Startup and shutdown.** A data file holding `[` makes startup exit 1 with stderr `error: invalid data file: <DATA_FILE>`. `PORT=abc` exits 1 with stderr `error: invalid PORT: abc`. SIGTERM exits with code 0 within 5 seconds. With `DATA_FILE` unset, the first change writes `data/board.json` in the working directory.

## Constraints

- Node 22 or later. No runtime dependencies: `package.json` has no `dependencies`. The only dev dependency is `@playwright/test` at exactly `1.63.0`, already in `package.json` and `package-lock.json`; its Chromium build is installed on the build machine. Config `setup_command` runs `npm ci && npx playwright install chromium`.
- `server.mjs` at the repository root, an ES module using only the Node standard library. `npm start` runs it.
- The page is plain HTML, CSS and ES modules under `public/`, served as written. No build step, no framework, nothing fetched from another origin.
- Tests: `npm test` exits 0 and runs the project's own tests. Tests start real servers on free ports (`PORT=0`), never a fixed port.
- The server makes no outbound network requests and writes only the data file and its temporary files.

## Done

Done when all 17 end-to-end requirements above pass against `server.mjs` at the base branch head in Chromium, and `npm test` exits 0.

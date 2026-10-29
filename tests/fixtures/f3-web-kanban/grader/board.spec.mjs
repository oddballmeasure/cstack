// Held-out grader for the f3-web-kanban fixture (plan section 6.3). Test names are G1..Gn, never lane ids.
// Run: KANBAN_ENTRY=<repo>/server.mjs npx playwright test --config playwright.config.mjs (from a copy of this directory with npm ci done).
import { existsSync } from "node:fs";
import path from "node:path";
import { test, expect, seedBoard, cardByTitle, cardById, columnTitles, openBoard, moveRequests, describeRes, sleep } from "./lib.mjs";

const COLS = ["todo", "doing", "done"];
const EMPTY = { todo: [], doing: [], done: [] };
const BANNER = "Could not save changes. Try again.";

function expectJson(r, status, body) {
  expect(r.status, describeRes(r)).toBe(status);
  expect(String(r.headers["content-type"]), describeRes(r)).toMatch(/^application\/json; charset=utf-8$/i);
  if (body !== undefined) expect(r.json, describeRes(r)).toEqual(body);
}

async function expectBoard(page, want) {
  for (const col of COLS) {
    await expect(columnTitles(page, col), `cards in ${col}`).toHaveText(want[col] || []);
    await expect(page.getByTestId(`count-${col}`), `count in ${col}`).toHaveText(String((want[col] || []).length));
    if ((want[col] || []).length) await expect(page.getByTestId(`empty-${col}`)).toHaveCount(0);
    else await expect(page.getByTestId(`empty-${col}`)).toHaveText("No cards");
  }
}

const idOf = (data, title) => {
  for (const col of COLS) for (const c of data.columns[col]) if (c.title === title) return c.id;
  throw new Error(`no seeded card ${title}`);
};

test("G1 the empty board renders three columns, loads only same-origin resources and logs no errors", async ({ page, launch }) => {
  const app = await launch();
  const log = await openBoard(page, app);
  await expect(page).toHaveTitle("Kanban");
  await expect(page.locator("h1")).toHaveText("Kanban");
  await expect(page.locator('section[data-testid^="column-"]')).toHaveCount(3);
  const order = await page.locator('section[data-testid^="column-"]').evaluateAll((els) => els.map((e) => e.dataset.testid));
  expect(order).toEqual(["column-todo", "column-doing", "column-done"]);
  await expect(page.getByTestId("column-title-todo")).toHaveText("To do");
  await expect(page.getByTestId("column-title-doing")).toHaveText("Doing");
  await expect(page.getByTestId("column-title-done")).toHaveText("Done");
  await expectBoard(page, EMPTY);
  await expect(page.getByTestId("form-error")).toBeHidden();
  await expect(page.getByTestId("error-banner")).toBeHidden();
  await page.waitForLoadState("networkidle");
  expect(log.requests.filter((r) => new URL(r.url).origin !== app.origin), "requests to other origins").toEqual([]);
  expect(log.errors, "console errors").toEqual([]);
  const r = await app.req("GET", "/api/board");
  expectJson(r, 200, {
    columns: [
      { id: "todo", title: "To do", cards: [] },
      { id: "doing", title: "Doing", cards: [] },
      { id: "done", title: "Done", cards: [] },
    ],
  });
});

test("G2 adding cards from the page with the button and with Enter", async ({ page, launch }) => {
  const app = await launch();
  await openBoard(page, app);
  const input = page.getByTestId("new-card-title");
  await input.fill("Write brief");
  await page.getByTestId("add-card").click();
  await expect(columnTitles(page, "todo")).toHaveText(["Write brief"]);
  await expect(input).toHaveValue("");
  await input.fill("Book venue");
  await input.press("Enter");
  await expectBoard(page, { todo: ["Write brief", "Book venue"] });
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(page.getByTestId("add-card")).toHaveText("Add card");
  const board = await app.board();
  expect(board.columns[0].cards.map((c) => [c.title, c.description])).toEqual([
    ["Write brief", ""],
    ["Book venue", ""],
  ]);
});

test("G3 an empty or blank title shows Title is required and creates nothing", async ({ page, launch }) => {
  const app = await launch();
  const log = await openBoard(page, app);
  await page.getByTestId("add-card").click();
  await expect(page.getByTestId("form-error")).toHaveText("Title is required");
  await page.getByTestId("new-card-title").fill("   ");
  await page.getByTestId("new-card-title").press("Enter");
  await expect(page.getByTestId("form-error")).toHaveText("Title is required");
  await sleep(200);
  expect(log.requests.filter((r) => r.method === "POST"), "POST requests").toEqual([]);
  expect(await app.titles()).toEqual(EMPTY);
  await expectBoard(page, EMPTY);
  await page.getByTestId("new-card-title").fill("Valid");
  await page.getByTestId("add-card").click();
  await expect(columnTitles(page, "todo")).toHaveText(["Valid"]);
  await expect(page.getByTestId("form-error")).toBeHidden();
});

test("G4 a seeded board renders in order, with descriptions only when present and titles as text", async ({ page, launch }) => {
  const seed = seedBoard({ todo: [{ title: "Alpha", description: "First line" }, "Beta"], done: ["Gamma", "<b>bold</b>"] });
  const app = await launch({ seed });
  await openBoard(page, app);
  await expectBoard(page, { todo: ["Alpha", "Beta"], done: ["Gamma", "<b>bold</b>"] });
  await expect(cardByTitle(page, "Alpha").getByTestId("card-description")).toHaveText("First line");
  await expect(cardByTitle(page, "Beta").getByTestId("card-description")).toHaveCount(0);
  await expect(cardById(page, idOf(seed, "Alpha"))).toHaveCount(1);
  await expect(cardById(page, idOf(seed, "<b>bold</b>")).locator("b")).toHaveCount(0);
  for (const c of await page.getByTestId("card").all()) {
    await expect(c).toHaveAttribute("tabindex", "0");
    await expect(c).toHaveAttribute("draggable", "true");
    expect(await c.evaluate((e) => e.tagName)).toBe("LI");
  }
});

test("G5 editing a card with the Edit button saves title and description", async ({ page, launch }) => {
  const seed = seedBoard({ todo: [{ title: "Alpha", description: "First line" }, "Beta"] });
  const app = await launch({ seed });
  await openBoard(page, app);
  const id = idOf(seed, "Alpha");
  await page.getByRole("button", { name: "Edit Alpha", exact: true }).click();
  const card = cardById(page, id);
  await expect(card.getByTestId("edit-title")).toHaveValue("Alpha");
  await expect(card.getByTestId("edit-description")).toHaveValue("First line");
  await expect(card.getByTestId("edit-title")).toBeFocused();
  await card.getByTestId("edit-title").fill("Alpha 2");
  await card.getByTestId("edit-description").fill("Line two");
  await card.getByTestId("save-card").click();
  await expect(card.getByTestId("card-title")).toHaveText("Alpha 2");
  await expect(card.getByTestId("card-description")).toHaveText("Line two");
  await expect(card).toBeFocused();
  const saved = (await app.board()).columns[0].cards[0];
  expect([saved.id, saved.title, saved.description]).toEqual([id, "Alpha 2", "Line two"]);
  expect(saved.updated_at).not.toBe(seed.columns.todo[0].updated_at);
  await expect(columnTitles(page, "todo")).toHaveText(["Alpha 2", "Beta"]);
});

test("G6 Enter on a focused card opens the editor; Escape and Cancel close it without a request", async ({ page, launch }) => {
  const seed = seedBoard({ todo: [{ title: "Alpha", description: "First line" }] });
  const app = await launch({ seed });
  const log = await openBoard(page, app);
  const id = idOf(seed, "Alpha");
  const card = cardById(page, id);
  await card.focus();
  await page.keyboard.press("Enter");
  await expect(card.getByTestId("edit-title")).toBeFocused();
  await card.getByTestId("edit-title").fill("Changed");
  await page.keyboard.press("Escape");
  await expect(card.getByTestId("edit-title")).toHaveCount(0);
  await expect(card.getByTestId("card-title")).toHaveText("Alpha");
  await expect(card).toBeFocused();
  await card.getByTestId("edit-card").click();
  await card.getByTestId("edit-description").fill("Changed too");
  await card.getByTestId("cancel-edit").click();
  await expect(card.getByTestId("card-description")).toHaveText("First line");
  await expect(card).toBeFocused();
  await card.press("Enter");
  await card.getByTestId("edit-title").fill("Via enter");
  await card.getByTestId("edit-title").press("Enter");
  await expect(card.getByTestId("card-title")).toHaveText("Via enter");
  expect(log.requests.filter((r) => r.method === "PATCH").length, "PATCH requests").toBe(1);
  expect((await app.titles()).todo).toEqual(["Via enter"]);
});

test("G7 saving an empty title shows the edit error and keeps the old title", async ({ page, launch }) => {
  const seed = seedBoard({ todo: ["Alpha"] });
  const app = await launch({ seed });
  await openBoard(page, app);
  const card = cardById(page, idOf(seed, "Alpha"));
  await card.getByTestId("edit-card").click();
  await card.getByTestId("edit-title").fill("   ");
  await card.getByTestId("save-card").click();
  await expect(card.getByTestId("edit-error")).toHaveText("Title is required");
  await expect(card.getByTestId("edit-title")).toBeVisible();
  expect((await app.titles()).todo).toEqual(["Alpha"]);
});

test("G8 deleting with the dialog: Cancel keeps the card, Delete removes it and focuses the next card", async ({ page, launch }) => {
  const seed = seedBoard({ todo: ["Alpha", "Beta"] });
  const app = await launch({ seed });
  await openBoard(page, app);
  await page.getByRole("button", { name: "Delete Alpha", exact: true }).click();
  const dialog = page.getByTestId("delete-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Delete "Alpha"?');
  await expect(page.getByTestId("cancel-delete")).toBeFocused();
  await page.getByTestId("cancel-delete").click();
  await expect(dialog).toBeHidden();
  await expect(cardById(page, idOf(seed, "Alpha"))).toBeFocused();
  await expectBoard(page, { todo: ["Alpha", "Beta"] });
  await page.getByRole("button", { name: "Delete Alpha", exact: true }).click();
  await page.getByTestId("confirm-delete").click();
  await expect(dialog).toBeHidden();
  await expectBoard(page, { todo: ["Beta"] });
  await expect(cardById(page, idOf(seed, "Beta"))).toBeFocused();
  expect(await app.titles()).toEqual({ todo: ["Beta"], doing: [], done: [] });
});

test("G9 the Delete key opens the dialog, Escape closes it, and deleting the last card focuses the input", async ({ page, launch }) => {
  const seed = seedBoard({ doing: ["Solo"] });
  const app = await launch({ seed });
  await openBoard(page, app);
  const card = cardById(page, idOf(seed, "Solo"));
  await card.focus();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("delete-dialog")).toBeVisible();
  await expect(page.getByTestId("delete-dialog")).toContainText('Delete "Solo"?');
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("delete-dialog")).toBeHidden();
  await expect(card).toBeFocused();
  expect((await app.titles()).doing).toEqual(["Solo"]);
  await page.keyboard.press("Delete");
  await page.getByTestId("confirm-delete").click();
  await expectBoard(page, EMPTY);
  await expect(page.getByTestId("new-card-title")).toBeFocused();
  expect(await app.titles()).toEqual(EMPTY);
});

test("G10 dragging a card onto a column heading moves it to the end of that column", async ({ page, launch }) => {
  const seed = seedBoard({ todo: ["Alpha", "Beta"], doing: ["Xray"] });
  const app = await launch({ seed });
  await openBoard(page, app);
  await cardByTitle(page, "Alpha").dragTo(page.getByTestId("column-title-doing"));
  await expectBoard(page, { todo: ["Beta"], doing: ["Xray", "Alpha"] });
  await expect(page.getByTestId("announcer")).toHaveText('Moved "Alpha" to Doing, position 2 of 2.');
  expect(await app.titles()).toEqual({ todo: ["Beta"], doing: ["Xray", "Alpha"], done: [] });
});

test("G11 dragging a card onto another card puts it just before that card", async ({ page, launch }) => {
  const seed = seedBoard({ todo: ["Alpha"], done: ["Gamma", "Delta"] });
  const app = await launch({ seed });
  await openBoard(page, app);
  await cardByTitle(page, "Alpha").dragTo(cardByTitle(page, "Delta"));
  await expectBoard(page, { done: ["Gamma", "Alpha", "Delta"] });
  await expect(page.getByTestId("announcer")).toHaveText('Moved "Alpha" to Done, position 2 of 3.');
  await cardByTitle(page, "Delta").dragTo(cardByTitle(page, "Gamma"));
  await expectBoard(page, { done: ["Delta", "Gamma", "Alpha"] });
  await expect(page.getByTestId("announcer")).toHaveText('Moved "Delta" to Done, position 1 of 3.');
  expect(await app.titles()).toEqual({ todo: [], doing: [], done: ["Delta", "Gamma", "Alpha"] });
});

test("G12 dragging the only card into an empty column updates both empty messages", async ({ page, launch }) => {
  const seed = seedBoard({ done: ["Gamma"] });
  const app = await launch({ seed });
  await openBoard(page, app);
  await cardByTitle(page, "Gamma").dragTo(page.getByTestId("empty-doing"));
  await expectBoard(page, { doing: ["Gamma"] });
  await expect(page.getByTestId("announcer")).toHaveText('Moved "Gamma" to Doing, position 1 of 1.');
  expect(await app.titles()).toEqual({ todo: [], doing: ["Gamma"], done: [] });
});

test("G13 ArrowRight and ArrowLeft move a focused card between columns and keep focus", async ({ page, launch }) => {
  const seed = seedBoard({ todo: ["Alpha", "Beta"], doing: ["Xray"] });
  const app = await launch({ seed });
  await openBoard(page, app);
  const card = cardById(page, idOf(seed, "Alpha"));
  await card.focus();
  await page.keyboard.press("ArrowRight");
  await expectBoard(page, { todo: ["Beta"], doing: ["Xray", "Alpha"] });
  await expect(page.getByTestId("announcer")).toHaveText('Moved "Alpha" to Doing, position 2 of 2.');
  await expect(card).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expectBoard(page, { todo: ["Beta"], doing: ["Xray"], done: ["Alpha"] });
  await expect(page.getByTestId("announcer")).toHaveText('Moved "Alpha" to Done, position 1 of 1.');
  await expect(card).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expectBoard(page, { todo: ["Beta"], doing: ["Xray", "Alpha"] });
  await expect(page.getByTestId("announcer")).toHaveText('Moved "Alpha" to Doing, position 2 of 2.');
  await expect(card).toBeFocused();
  expect(await app.titles()).toEqual({ todo: ["Beta"], doing: ["Xray", "Alpha"], done: [] });
});

test("G14 keyboard moves past an edge do nothing and send no request", async ({ page, launch }) => {
  const seed = seedBoard({ todo: ["Alpha"], done: ["Zulu"] });
  const app = await launch({ seed });
  const log = await openBoard(page, app);
  const alpha = cardById(page, idOf(seed, "Alpha"));
  await alpha.focus();
  for (const key of ["ArrowLeft", "ArrowUp", "ArrowDown"]) await page.keyboard.press(key);
  const zulu = cardById(page, idOf(seed, "Zulu"));
  await zulu.focus();
  await page.keyboard.press("ArrowRight");
  await sleep(300);
  expect(moveRequests(log), "move requests").toEqual([]);
  await expectBoard(page, { todo: ["Alpha"], done: ["Zulu"] });
  await expect(zulu).toBeFocused();
  expect(await app.titles()).toEqual({ todo: ["Alpha"], doing: [], done: ["Zulu"] });
});

test("G15 ArrowUp and ArrowDown reorder a card within its column", async ({ page, launch }) => {
  const seed = seedBoard({ todo: ["A", "B", "C"] });
  const app = await launch({ seed });
  await openBoard(page, app);
  const c = cardById(page, idOf(seed, "C"));
  await c.focus();
  await page.keyboard.press("ArrowUp");
  await expect(columnTitles(page, "todo")).toHaveText(["A", "C", "B"]);
  await expect(c).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(columnTitles(page, "todo")).toHaveText(["C", "A", "B"]);
  await expect(page.getByTestId("announcer")).toHaveText('Moved "C" to To do, position 1 of 3.');
  await expect(c).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await sleep(200);
  await expect(columnTitles(page, "todo")).toHaveText(["C", "A", "B"]);
  await page.keyboard.press("ArrowDown");
  await expect(columnTitles(page, "todo")).toHaveText(["A", "C", "B"]);
  await expect(page.getByTestId("announcer")).toHaveText('Moved "C" to To do, position 2 of 3.');
  await expect(c).toBeFocused();
  expect((await app.titles()).todo).toEqual(["A", "C", "B"]);
});

test("G16 changes made on the page survive a reload and a server restart", async ({ page, launch }) => {
  let app = await launch();
  await openBoard(page, app);
  const input = page.getByTestId("new-card-title");
  for (const t of ["One", "Two", "Three"]) {
    await input.fill(t);
    await input.press("Enter");
    await expect(columnTitles(page, "todo").last()).toHaveText(t);
  }
  await cardByTitle(page, "Two").getByTestId("edit-card").click();
  await page.getByTestId("edit-title").fill("Two edited");
  await page.getByTestId("edit-description").fill("Notes");
  await page.getByTestId("save-card").click();
  await expect(columnTitles(page, "todo")).toHaveText(["One", "Two edited", "Three"]);
  await cardByTitle(page, "One").focus();
  await page.keyboard.press("ArrowRight");
  await expect(columnTitles(page, "doing")).toHaveText(["One"]);
  await cardByTitle(page, "Three").getByTestId("delete-card").click();
  await page.getByTestId("confirm-delete").click();
  const want = { todo: ["Two edited"], doing: ["One"] };
  await expectBoard(page, want);
  await page.reload();
  await expectBoard(page, want);
  await expect(cardByTitle(page, "Two edited").getByTestId("card-description")).toHaveText("Notes");
  app = await app.restart();
  await page.goto(app.url);
  await expectBoard(page, want);
  const data = app.readData();
  expect(data.version).toBe(1);
  expect(Object.keys(data.columns).sort()).toEqual(["doing", "done", "todo"]);
  expect(Object.fromEntries(COLS.map((c) => [c, data.columns[c].map((x) => x.title)]))).toEqual({ todo: ["Two edited"], doing: ["One"], done: [] });
  expect(data.columns.todo[0].description).toBe("Notes");
});

test("G17 a failed add shows the error banner and no new card; the next success hides it", async ({ page, launch }) => {
  const app = await launch();
  await openBoard(page, app);
  await page.route("**/api/cards", (route) =>
    route.request().method() === "POST" ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }) : route.continue(),
  );
  await page.getByTestId("new-card-title").fill("Fail me");
  await page.getByTestId("add-card").click();
  await expect(page.getByTestId("error-banner")).toBeVisible();
  await expect(page.getByTestId("error-banner")).toHaveText(BANNER);
  await expect(page.getByTestId("error-banner")).toHaveAttribute("role", "alert");
  await expectBoard(page, EMPTY);
  expect(await app.titles()).toEqual(EMPTY);
  await page.unroute("**/api/cards");
  await page.getByTestId("new-card-title").fill("Works");
  await page.getByTestId("add-card").click();
  await expect(columnTitles(page, "todo")).toHaveText(["Works"]);
  await expect(page.getByTestId("error-banner")).toBeHidden();
});

test("G18 a failed move leaves the card where it was and shows the banner", async ({ page, launch }) => {
  const seed = seedBoard({ todo: ["Alpha"] });
  const app = await launch({ seed });
  await openBoard(page, app);
  await page.route("**/api/cards/*/move", (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
  const card = cardById(page, idOf(seed, "Alpha"));
  await card.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("error-banner")).toHaveText(BANNER);
  await expectBoard(page, { todo: ["Alpha"] });
  expect(await app.titles()).toEqual({ todo: ["Alpha"], doing: [], done: [] });
  await page.unroute("**/api/cards/*/move");
  await card.focus();
  await page.keyboard.press("ArrowRight");
  await expectBoard(page, { doing: ["Alpha"] });
  await expect(page.getByTestId("error-banner")).toBeHidden();
});

test("G19 columns are named regions, cards are reachable with Tab, controls have accessible names", async ({ page, launch }) => {
  const seed = seedBoard({ todo: ["Alpha"], doing: ["Beta"] });
  const app = await launch({ seed });
  await openBoard(page, app);
  for (const [id, name] of [["todo", "To do"], ["doing", "Doing"], ["done", "Done"]]) {
    await expect(page.getByRole("region", { name, exact: true })).toHaveAttribute("data-testid", `column-${id}`);
  }
  await expect(page.getByRole("textbox", { name: "New card title", exact: true })).toHaveAttribute("data-testid", "new-card-title");
  await expect(page.getByRole("button", { name: "Edit Alpha", exact: true })).toHaveAttribute("data-testid", "edit-card");
  await expect(page.getByRole("button", { name: "Delete Beta", exact: true })).toHaveAttribute("data-testid", "delete-card");
  await expect(page.getByTestId("announcer")).toHaveAttribute("aria-live", "polite");
  await page.getByTestId("new-card-title").focus();
  let reached = null;
  for (let i = 0; i < 12 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => (document.activeElement?.dataset?.testid === "card" ? document.activeElement.dataset.cardId : null));
  }
  expect(reached, "a card is reached with Tab from the new card input").toBe(idOf(seed, "Alpha"));
});

test("G20 POST /api/cards validates and creates", async ({ launch }) => {
  const app = await launch();
  const bad = (code) => ({ error: code });
  expectJson(await app.req("POST", "/api/cards", {}), 400, bad("invalid_title"));
  expectJson(await app.req("POST", "/api/cards", { title: "" }), 400, bad("invalid_title"));
  expectJson(await app.req("POST", "/api/cards", { title: "   " }), 400, bad("invalid_title"));
  expectJson(await app.req("POST", "/api/cards", { title: 7 }), 400, bad("invalid_title"));
  expectJson(await app.req("POST", "/api/cards", { title: "x".repeat(201) }), 400, bad("invalid_title"));
  expectJson(await app.req("POST", "/api/cards", { title: "ok", description: "d".repeat(2001) }), 400, bad("invalid_description"));
  expectJson(await app.req("POST", "/api/cards", { title: "ok", column: "later" }), 400, bad("invalid_column"));
  expectJson(await app.req("POST", "/api/cards", '{"title":'), 400, bad("invalid_json"));
  expectJson(await app.req("POST", "/api/cards", "[1]"), 400, bad("invalid_json"));
  expect(await app.titles()).toEqual(EMPTY);
  const r = await app.req("POST", "/api/cards", { title: "  Trim me  ", description: " notes ", column: "doing" });
  expectJson(r, 201);
  expect(Object.keys(r.json).sort()).toEqual(["created_at", "description", "id", "title", "updated_at"]);
  expect(r.json.title).toBe("Trim me");
  expect(r.json.description).toBe("notes");
  expect(r.json.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  expect(r.json.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expectJson(await app.req("POST", "/api/cards", { title: "x".repeat(200) }), 201);
  expect(await app.titles()).toEqual({ todo: ["x".repeat(200)], doing: ["Trim me"], done: [] });
});

test("G21 PATCH and DELETE on cards, with 404 for unknown ids", async ({ launch }) => {
  const app = await launch();
  const a = await app.create("Alpha", "todo", "Old");
  const p = await app.req("PATCH", `/api/cards/${a.id}`, { description: "New" });
  expectJson(p, 200);
  expect([p.json.id, p.json.title, p.json.description]).toEqual([a.id, "Alpha", "New"]);
  expectJson(await app.req("PATCH", `/api/cards/${a.id}`, { title: " " }), 400, { error: "invalid_title" });
  expectJson(await app.req("PATCH", `/api/cards/${a.id}`, { description: "d".repeat(2001) }), 400, { error: "invalid_description" });
  expectJson(await app.req("PATCH", "/api/cards/nope", { title: "x" }), 404, { error: "not_found" });
  expectJson(await app.req("DELETE", "/api/cards/nope"), 404, { error: "not_found" });
  const d = await app.req("DELETE", `/api/cards/${a.id}`);
  expect(d.status, describeRes(d)).toBe(204);
  expect(d.text).toBe("");
  expectJson(await app.req("DELETE", `/api/cards/${a.id}`), 404, { error: "not_found" });
  expect(await app.titles()).toEqual(EMPTY);
});

test("G22 POST /api/cards/<id>/move places, clamps and validates", async ({ launch }) => {
  const app = await launch();
  const a = await app.create("Alpha");
  await app.create("Gamma", "done");
  await app.create("Delta", "done");
  const r = await app.req("POST", `/api/cards/${a.id}/move`, { column: "done", position: 0 });
  expectJson(r, 200);
  expect(r.json.columns.map((c) => [c.id, c.title, c.cards.map((x) => x.title)])).toEqual([
    ["todo", "To do", []],
    ["doing", "Doing", []],
    ["done", "Done", ["Alpha", "Gamma", "Delta"]],
  ]);
  expectJson(await app.req("POST", `/api/cards/${a.id}/move`, { column: "done", position: 99 }), 200);
  expect((await app.titles()).done).toEqual(["Gamma", "Delta", "Alpha"]);
  expectJson(await app.req("POST", `/api/cards/${a.id}/move`, { column: "done", position: -1 }), 400, { error: "invalid_position" });
  expectJson(await app.req("POST", `/api/cards/${a.id}/move`, { column: "done", position: 1.5 }), 400, { error: "invalid_position" });
  expectJson(await app.req("POST", `/api/cards/${a.id}/move`, { column: "later", position: 0 }), 400, { error: "invalid_column" });
  expectJson(await app.req("POST", "/api/cards/nope/move", { column: "todo", position: 0 }), 404, { error: "not_found" });
  expect(await app.titles()).toEqual({ todo: [], doing: [], done: ["Gamma", "Delta", "Alpha"] });
});

test("G23 static files are served from public/ only", async ({ launch }) => {
  const app = await launch();
  const root = await app.req("GET", "/");
  expect(root.status, describeRes(root)).toBe(200);
  expect(String(root.headers["content-type"])).toMatch(/^text\/html; charset=utf-8$/i);
  expect(root.text).toContain("<title>Kanban</title>");
  expect((await app.req("GET", "/nope.txt")).status).toBe(404);
  for (const p of ["/../server.mjs", "/%2e%2e/server.mjs", "/..%2fserver.mjs", "/public/../../server.mjs"]) {
    const r = await app.req("GET", p);
    expect(r.status, describeRes(r)).toBe(404);
    expect(r.text).not.toContain("listening on");
  }
  expectJson(await app.req("GET", "/api/nope"), 404, { error: "not_found" });
});

test("G24 startup errors, SIGTERM and the default data file", async ({ launch }) => {
  const bad = await launch({ seed: "[", expectExit: true });
  expect(bad.code, `stderr ${bad.stderr}`).toBe(1);
  expect(bad.stderr.trimEnd()).toBe(`error: invalid data file: ${bad.dataFile}`);
  const port = await launch({ env: { PORT: "abc" }, expectExit: true });
  expect(port.code, `stderr ${port.stderr}`).toBe(1);
  expect(port.stderr.trimEnd()).toBe("error: invalid PORT: abc");
  const app = await launch({ env: { DATA_FILE: null } });
  await app.create("Default file");
  expect(existsSync(path.join(app.dir, "data", "board.json")), "data/board.json written").toBe(true);
  const stopped = await app.stop("SIGTERM");
  expect(stopped.code, JSON.stringify(stopped)).toBe(0);
});

test("G25 the page shows the server's board on reload, including changes made elsewhere", async ({ page, launch }) => {
  const seed = seedBoard({ todo: ["Alpha"] });
  const app = await launch({ seed });
  await openBoard(page, app);
  await expectBoard(page, { todo: ["Alpha"] });
  await app.create("From API", "done", "Made elsewhere");
  await app.req("POST", `/api/cards/${idOf(seed, "Alpha")}/move`, { column: "doing", position: 0 });
  await page.reload();
  await expectBoard(page, { doing: ["Alpha"], done: ["From API"] });
  await expect(cardByTitle(page, "From API").getByTestId("card-description")).toHaveText("Made elsewhere");
});

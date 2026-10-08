import { expect, test, type Page } from "@playwright/test";
import { pdf } from "../pdf.ts";
import { ADA, BASE, GRACE, WITH_CONSOLE, asBrowser, closeStore, feedLines, named, platform, reads, signIn, stored } from "./fleet.ts";

/**
 * Documents, through the documents team's panel in the shell: a file kept, previewed, renamed, replaced, shared with a
 * link anyone may open, and the flow the platform runs on it, across three services, ending as a line on the
 * workspace's feed and a hit in the catalogue's search.
 */
test.afterAll(closeStore);

const panel = (page: Page) => page.locator("documents-panel");
const row = (page: Page, name: string) => panel(page).locator("li[data-id]", { has: page.locator("button.name", { hasText: name }) });
/** A row by its document, whatever it shows: while it is being renamed it has a form where its name was. */
const rowOf = (page: Page, id: string) => panel(page).locator(`li[data-id="${id}"]`);

async function keep(page: Page, name: string, mimeType: string, body: string | Uint8Array): Promise<string> {
  await panel(page).locator("label.picker input[type=file]").setInputFiles({ name, mimeType, buffer: Buffer.from(body) });
  await expect(row(page, name)).toHaveCount(1);
  return (await row(page, name).getAttribute("data-id"))!;
}

/** Where the service keeps a document's bytes, as the page reaches them: the service's `url` under its path. */
async function fileUrl(id: string): Promise<string> {
  const [found] = await stored<{ url: string }>("select url from documents where id = $1", [id]);
  return `/api/documents${found!.url}`;
}

async function documentRow(id: string) {
  return stored<{ name: string; version: number; content_type: string; size: string; owner_id: string; project_id: string }>(
    "select name, version, content_type, size, owner_id, project_id from documents where id = $1",
    [id],
  );
}

test("a file kept in the panel is listed, previewed as text, and stored as its owner's, and the feed says so", async ({ page }) => {
  const name = named("plan") + ".txt";
  await signIn(page, ADA);
  const id = await keep(page, name, "text/plain", "Wave two moves orders and returns.");

  await expect.poll(() => reads(row(page, name).locator(".sub"))).toMatch(/^34 B · Ada Lovelace · .+ · Open$/);
  // the address the service handed out for the bytes, under the service's path on the page's origin
  await expect(row(page, name).locator(".sub a")).toHaveAttribute("href", await fileUrl(id));
  // the owner is offered every action on it
  await expect(row(page, name).locator(".row-actions > *")).toHaveText(["Tags", "File in…", "New version", "Rename", "Share", "Delete"]);
  expect(await documentRow(id)).toEqual([{ name, version: 1, content_type: "text/plain", size: "34", owner_id: "u1", project_id: "p1" }]);

  await row(page, name).locator("button.name").click();
  await expect(row(page, name).locator(".tabs button")).toHaveText(["Preview", "Notes", "Sign-offs", "Revisions 1"]);
  await expect(row(page, name).locator("documents-preview pre")).toHaveText("Wave two moves orders and returns.");

  // the workspace's feed, served by another service, hears it with no reload
  await expect.poll(() => feedLines(page, name)).toEqual([...(WITH_CONSOLE ? [`Keel | made searchable | ${name} | catalogue`] : []), `Ada Lovelace | added a file | ${name} | documents`]);
  const added = await stored<{ source: string; kind: string; text: string; subject: string; detail: string | null; by_id: string }>("select source, kind, text, subject, detail, by_id from activity where id = $1", [`documents:${id}:1`]);
  expect(added).toEqual([{ source: "documents", kind: "document.added", text: `${name} (${id})`, subject: name, detail: null, by_id: "u1" }]);
});

test("a PDF previews in the browser's own viewer, from the same address the Open link goes to", async ({ page }) => {
  const name = named("brief") + ".pdf";
  const bytes = pdf("Rollout brief", ["Wave one is the pilot tenant."]);
  await signIn(page, ADA);
  const id = await keep(page, name, "application/pdf", bytes);
  const href = await fileUrl(id);
  const served = page.waitForResponse((r) => r.url() === `${BASE}${href}`);
  await row(page, name).locator("button.name").click();

  const frame = row(page, name).locator("documents-preview iframe");
  await expect(frame).toHaveAttribute("src", href);
  await expect(frame).toHaveAttribute("title", name);
  const res = await served;
  expect([res.status(), res.headers()["content-type"]]).toEqual([200, "application/pdf"]);
  // the bytes behind the frame are the file's own
  expect(Buffer.from(await (await page.request.get(`${BASE}${href}`)).body()).equals(Buffer.from(bytes))).toBe(true);
  // guard: the same address without a session is refused, so the frame showed what the session may read
  expect((await fetch(`${BASE}${href}`)).status).toBe(401);
});

test("a rename keeps the file and moves its version on; a new version is a second revision, and both are kept", async ({ page }) => {
  const name = named("draft") + ".txt";
  const renamed = named("final") + ".txt";
  await signIn(page, ADA);
  const id = await keep(page, name, "text/plain", "first draft");

  await row(page, name).getByRole("button", { name: "Rename" }).click();
  await rowOf(page, id).locator("input[name=name]").fill(renamed);
  await rowOf(page, id).locator("form.inline button[type=submit]").click();
  await expect(row(page, renamed)).toHaveCount(1);
  await expect(row(page, name)).toHaveCount(0);
  expect(await documentRow(id)).toEqual([{ name: renamed, version: 2, content_type: "text/plain", size: "11", owner_id: "u1", project_id: "p1" }]);

  await row(page, renamed).locator("label", { hasText: "New version" }).locator("input[type=file]").setInputFiles({ name: "x.txt", mimeType: "text/plain", buffer: Buffer.from("the second draft, longer") });
  await expect.poll(() => reads(row(page, renamed).locator(".sub"))).toMatch(/^24 B · v3 · Ada Lovelace · .+ · Open$/);
  await row(page, renamed).locator("button.name").click();
  await expect(row(page, renamed).locator("documents-preview pre")).toHaveText("the second draft, longer");
  await row(page, renamed).getByRole("tab", { name: /Revisions/ }).click();
  const revisions = row(page, renamed).locator("documents-history li");
  await expect(revisions.locator(".v")).toHaveText(["v3", "v1"]);
  await expect(revisions.locator(".who")).toHaveText(["Ada Lovelace", "Ada Lovelace"]);
  await expect(revisions.locator(".size")).toHaveText(["24 B", "11 B"]);
  // each revision opens its own bytes
  const hrefs = await revisions.locator("a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!));
  const bodies = await Promise.all(hrefs.map(async (h) => (await page.request.get(`${BASE}${h}`)).text()));
  expect(bodies).toEqual(["the second draft, longer", "first draft"]);
  expect(await stored("select version, size from revisions where document_id = $1 order by version", [id])).toEqual([
    { version: 1, size: "11" },
    { version: 3, size: "24" },
  ]);
  // the rename and the replacement are a line each, by the file's name now, and the platform indexed the new text
  await expect.poll(() => feedLines(page, renamed)).toEqual([
    ...(WITH_CONSOLE ? [`Keel | made searchable | ${renamed} | catalogue`] : []),
    `Ada Lovelace | replaced a file | ${renamed} | now version 3 | documents`,
    `Ada Lovelace | renamed a file | ${renamed} | documents`,
  ]);
});

test("a rename is told on the feed as a rename, not as a new version, and the catalogue finds it by its new name", async ({ page }) => {
  const name = named("memo") + ".txt";
  const renamed = named("memo final") + ".txt";
  await signIn(page, ADA);
  const id = await keep(page, name, "text/plain", "a memo");
  // indexed first, as a person renaming a file they kept a while ago finds it
  if (WITH_CONSOLE) await expect.poll(async () => (await feedLines(page, name))[0]).toBe(`Keel | made searchable | ${name} | catalogue`);
  await row(page, name).getByRole("button", { name: "Rename" }).click();
  await rowOf(page, id).locator("input[name=name]").fill(renamed);
  await rowOf(page, id).locator("form.inline button[type=submit]").click();
  await expect(row(page, renamed)).toHaveCount(1);
  await expect.poll(() => feedLines(page, renamed)).toEqual([`Ada Lovelace | renamed a file | ${renamed} | documents`]);
  // the catalogue heard it too: the file is found by its new name, and nothing was indexed again, the bytes the same
  await expect.poll(() => stored("select name, version from files where id = $1", [id])).toEqual(WITH_CONSOLE ? [{ name: renamed, version: 1 }] : []);
});

test("a share link opens the one file for someone signed out, and nothing else", async ({ page, browser }) => {
  const name = named("contract") + ".txt";
  const context = page.context();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page, ADA);
  const id = await keep(page, name, "text/plain", "Clause 3: the tenant may terminate with thirty days' notice.");

  await row(page, name).getByRole("button", { name: "Share" }).click();
  await expect(row(page, name).getByRole("button", { name: "Link copied" })).toHaveCount(1);
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(new RegExp(`^${BASE.replace(/[.:/]/g, "\\$&")}/\\?share=[^&]+$`));

  const stranger = await browser.newContext();
  try {
    const away = await stranger.newPage();
    await away.goto(link);
    expect(await stranger.cookies()).toEqual([]);
    await expect(away.locator(".shared .eyebrow")).toHaveText("Shared with you");
    await expect(away.locator(".shared h1")).toHaveText(name);
    await expect.poll(() => reads(away.locator(".shared .sub"))).toMatch(/^60 B · text\/plain · version 1 · Ada Lovelace · .+$/);
    await expect(away.locator(".shared documents-preview pre")).toHaveText("Clause 3: the tenant may terminate with thirty days' notice.");
    // nothing of the rest of the page: no rail, no sign-in
    await expect(away.locator(".rail, .gate")).toHaveCount(0);
    // the token reads that one document and no other: the project's list is refused to it
    const token = new URL(link).searchParams.get("share")!;
    const shared = await away.request.get(`${BASE}/api/documents/rayfold/shared?s=${encodeURIComponent("{ id name }")}`, { headers: { authorization: `Bearer ${token}`, accept: "application/rayfold-frames+json" } });
    expect(JSON.parse((await shared.text()).split("\n")[0]!).data).toEqual({ $type: "Document", id, name });
    const list = await away.request.get(`${BASE}/api/documents/rayfold/documents?a=${Buffer.from(JSON.stringify({ projectId: "p1" })).toString("base64url")}&s=${encodeURIComponent("{ items { id } }")}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/rayfold-frames+json" },
    });
    expect(JSON.parse((await list.text()).split("\n")[0]!).error.code).toBe("permission_denied");
  } finally {
    await stranger.close();
  }
});

test("a kept file becomes searchable through the platform's flow: extract and index in the catalogue, notify in the workspace", async ({ page }) => {
  test.skip(!WITH_CONSOLE, "needs a console for the flow to run on (run.mjs starts the stand-in one)");
  const name = named("Rollout notes") + ".txt";
  // a word only this file has, so the search finds it and nothing an earlier run kept
  const word = `ticket${Date.now().toString(36)}`;
  const text = `Invoicing stays behind until wave three, ${word}.`;
  await signIn(page, ADA);
  const id = await keep(page, name, "text/plain", text);

  // the last step's line, written by the workspace for the catalogue's work, credited to the product
  await expect.poll(() => feedLines(page, name)).toEqual([`Keel | made searchable | ${name} | catalogue`, `Ada Lovelace | added a file | ${name} | documents`]);

  // what the platform ran: one flow run keyed to the revision, each step done by the service that owns the work
  const runs = await platform().query<Array<{ id: string; key: string; state: string; done: number; skipped: number }>>("flowRuns", { name: "document-kept" }, { shape: "{ id key state done skipped }" });
  const run = runs.find((r) => r.key === `${id}:1`)!;
  expect(run).toMatchObject({ state: "done", done: 3, skipped: 0 });
  const jobs = await platform().query<Array<{ step: string; state: string; worker: string }>>("jobs", { flowRun: run.id }, { shape: "{ step state worker }" });
  expect(jobs.map((j) => [j.step, j.state, j.worker.split("-")[0]]).reverse()).toEqual([
    ["extract", "done", "catalogue"],
    ["index", "done", "catalogue"],
    ["notify", "done", "workspace"],
  ]);

  // Ada, who kept it, is told, and only she is
  const bell = page.locator("button.bell");
  await bell.click();
  const item = page.locator(".panel li.item", { hasText: name });
  await expect(item.locator(".kind")).toHaveText("Searchable now");
  await expect(item.locator(".text")).toHaveText(`${name} is searchable now`);
  await expect(item).toHaveClass(/unread/);
  await page.locator(".scrim").click();
  const told = await stored<{ recipient_id: string }>("select recipient_id from notifications where kind = 'document.indexed' and text = $1", [`${name} is searchable now`]);
  expect(told).toEqual([{ recipient_id: "u1" }]);

  // and the catalogue's search, as Grace on the catalogue page, finds the file by what it says
  await signIn(page, GRACE);
  await page.locator(".rail button.nav", { hasText: "Catalogue" }).click();
  await page.locator("main.single input[type=search]").fill(word);
  const files = page.locator("main.single .section", { has: page.locator("h2", { hasText: "Files" }) });
  await expect(files.locator("a.row h3")).toHaveText([name]);
  await expect(files.locator("a.row .main .line")).toHaveText([text]);
  await expect(files.locator("a.row")).toHaveAttribute("href", await fileUrl(id));
  await expect(page.locator("main.single .status")).toHaveText(`1 result for “${word}”, best match first`);
  expect(await stored("select name, text, version from files where id = $1", [id])).toEqual([{ name, text, version: 1 }]);
});

test("an empty file is not indexed, and the feed says there was nothing to index", async ({ page }) => {
  test.skip(!WITH_CONSOLE, "needs a console for the flow to run on (run.mjs starts the stand-in one)");
  const name = named("empty") + ".txt";
  await signIn(page, ADA);
  const id = await keep(page, name, "text/plain", "");
  await expect.poll(() => feedLines(page, name)).toEqual([`Keel | found nothing to index in | ${name} | catalogue`, `Ada Lovelace | added a file | ${name} | documents`]);
  expect(await stored("select 1 from files where id = $1", [id])).toEqual([]);
  const runs = await platform().query<Array<{ id: string; key: string; state: string; done: number; skipped: number }>>("flowRuns", { name: "document-kept" }, { shape: "{ id key state done skipped }" });
  expect(runs.find((r) => r.key === `${id}:1`)).toMatchObject({ state: "done", done: 2, skipped: 1 });
});


import { expect, test, type Page } from "@playwright/test";
import { ADA, GRACE, RUN, asSomeoneElse, closeStore, feedLines, named, signIn, stored } from "./fleet.ts";

/**
 * The workspace, through the workspace team's panels: issues opened, moved, discussed and pinned to a document that
 * lives in another service; a project chat two people hold at once; and the bell, which rings for the person an issue
 * is handed to and goes quiet when they have read it.
 */
test.afterAll(closeStore);

const issues = (page: Page) => page.locator("section.slot", { has: page.locator("h2", { hasText: "Issues" }) });
const issue = (page: Page, title: string) => issues(page).locator("li", { has: page.locator("button.title .text", { hasText: title }) });

async function open(page: Page, title: string): Promise<string> {
  await issues(page).locator("input[name=title]").fill(title);
  await issues(page).getByRole("button", { name: "Add" }).click();
  await expect(issue(page, title)).toHaveCount(1);
  const [row] = await stored<{ id: string }>("select id from issues where title = $1", [title]);
  return row!.id;
}

test("an issue is opened and moved along to done, and each step is on the feed and in the table", async ({ page }) => {
  const title = named("Sign the Northwind contract");
  await signIn(page, ADA);
  const id = await open(page, title);
  await expect(issue(page, title).locator(".moves button")).toHaveText(["In progress"]);
  expect(await stored("select state, project_id, version from issues where id = $1", [id])).toEqual([{ state: "open", project_id: "p1", version: 1 }]);

  await issue(page, title).getByRole("button", { name: "In progress" }).click();
  // forward one and back one, never a jump to the end
  await expect(issue(page, title).locator(".moves button")).toHaveText(["Done", "Open"]);
  await expect(issues(page).locator("p.group", { hasText: "In progress" }).locator(".n")).not.toHaveText("0");
  await issue(page, title).getByRole("button", { name: "Done" }).click();
  await expect(issue(page, title)).toHaveClass(/done/);
  await expect(issue(page, title).locator(".moves button")).toHaveText(["In progress"]);
  expect(await stored("select state, version from issues where id = $1", [id])).toEqual([{ state: "done", version: 3 }]);

  await expect.poll(() => feedLines(page, title)).toEqual([`Ada Lovelace | moved | ${title} | doing → done`, `Ada Lovelace | moved | ${title} | open → doing`, `Ada Lovelace | opened | ${title}`]);
});

test("an issue's thread takes a reply, and a document from the documents service can be pinned to it", async ({ page }) => {
  const title = named("Check the rollout plan");
  const file = named("rollout plan") + ".txt";
  await signIn(page, ADA);
  // the document, kept in the documents panel beside it
  await page.locator("documents-panel label.picker input[type=file]").setInputFiles({ name: file, mimeType: "text/plain", buffer: Buffer.from("three waves") });
  await expect(page.locator("documents-panel button.name", { hasText: file })).toHaveCount(1);
  const id = await open(page, title);

  await issue(page, title).locator("button.title").click();
  const detail = issue(page, title).locator(".detail");
  await expect(detail.locator("workspace-thread .none")).toHaveText("No comments yet.");
  await detail.locator("workspace-thread input[name=body]").fill("Wave two needs the EDI mapping first.");
  await detail.locator("workspace-thread").getByRole("button", { name: "Post" }).click();
  await expect(detail.locator("workspace-thread li .body")).toHaveText(["Wave two needs the EDI mapping first."]);
  await expect(detail.locator("workspace-thread li .meta strong")).toHaveText(["Ada Lovelace"]);

  await detail.getByRole("button", { name: "Attach a document" }).click();
  await detail.locator("select[aria-label='Document to attach']").selectOption({ label: file });
  await expect(detail.locator(".pins li a")).toHaveText([file]);
  const [doc] = await stored<{ id: string; url: string }>("select id, url from documents where name = $1", [file]);
  await expect(detail.locator(".pins li a")).toHaveAttribute("href", `/api/documents${doc!.url}`);
  expect(await stored("select document_id, name from attachments where issue_id = $1", [id])).toEqual([{ document_id: doc!.id, name: file }]);
  expect(await stored("select body, by_id from comments where issue_id = $1", [id])).toEqual([{ body: "Wave two needs the EDI mapping first.", by_id: "u1" }]);

  await expect.poll(() => feedLines(page, title)).toEqual([
    `Ada Lovelace | attached a file to | ${title} | ${file}`,
    `Ada Lovelace | commented on | ${title} | “Wave two needs the EDI mapping first.”`,
    `Ada Lovelace | opened | ${title}`,
  ]);
});

test("the project chat reaches a second person's screen as it is said, both ways", async ({ page, browser }) => {
  const mine = named("Ada says the cutover is Friday");
  const theirs = named("Grace says Friday works");
  await signIn(page, ADA);
  const grace = await asSomeoneElse(browser, GRACE);
  try {
    const chat = (p: Page) => p.locator("section.slot", { has: p.locator("h2", { hasText: "Chat" }) });
    for (const p of [page, grace.page]) await expect(chat(p).locator("header .pill")).toHaveText("stream open");

    await chat(page).locator("input[name=body]").fill(mine);
    await chat(page).getByRole("button", { name: "Send" }).click();
    // on Grace's screen, with no reload: the stream carried it
    await expect(chat(grace.page).locator("li.line", { hasText: mine }).locator(".meta strong")).toHaveText("Ada Lovelace");
    await expect(chat(page).locator("li.line", { hasText: mine })).toHaveClass(/mine/);
    await expect(chat(grace.page).locator("li.line", { hasText: mine })).not.toHaveClass(/mine/);

    await chat(grace.page).locator("input[name=body]").fill(theirs);
    await chat(grace.page).getByRole("button", { name: "Send" }).click();
    await expect(chat(page).locator("li.line", { hasText: theirs }).locator(".meta strong")).toHaveText("Grace Hopper");
    // in the order said, on both screens alike
    const order = (p: Page) => chat(p).locator("li.line .text").evaluateAll((ts, run) => ts.map((t) => t.textContent ?? "").filter((t) => t.endsWith(run)), RUN);
    await expect.poll(() => order(page)).toEqual([mine, theirs]);
    await expect.poll(() => order(grace.page)).toEqual([mine, theirs]);
    expect(await stored("select body, by_id from messages where body in ($1, $2) order by at", [mine, theirs])).toEqual([
      { body: mine, by_id: "u1" },
      { body: theirs, by_id: "u2" },
    ]);
  } finally {
    await grace.context.close();
  }
});

test("handing an issue to someone rings their bell live; reading marks it read for them and nobody else", async ({ page, browser }) => {
  const title = named("Book the cutover window");
  await signIn(page, ADA);
  const grace = await asSomeoneElse(browser, GRACE);
  try {
    const bell = grace.page.locator("button.bell");
    // what she had unread already, from earlier work on the fleet, as the service has it and as her bell shows it
    const [{ n: before }] = (await stored<{ n: number }>("select count(*)::int as n from notifications where recipient_id = 'u2' and read_at is null")) as [{ n: number }];
    if (before) await expect(bell.locator(".count")).toHaveText(String(before));
    else await expect(bell.locator(".count")).toHaveCount(0);
    const id = await open(page, title);
    await issue(page, title).locator("select[aria-label=Assignee]").selectOption({ label: "Grace Hopper" });
    await expect(issue(page, title).locator(".assignee .name")).toHaveText("Grace");

    // Grace's count moves without a reload, and a toast says why
    await expect(bell.locator(".count")).toHaveText(String(before + 1));
    await expect(grace.page.locator(".toasts .toast", { hasText: title }).locator(".kind")).toHaveText("Handed to you");
    await bell.click();
    const item = grace.page.locator(".panel li.item", { hasText: title });
    await expect(item.locator(".kind")).toHaveText("Handed to you");
    await expect(item.locator(".text")).toHaveText(`Ada Lovelace handed you ${title}`);
    await expect(item).toHaveClass(/unread/);
    // her People page and the issue agree: it is hers now
    expect(await stored("select assignee_id from issues where id = $1", [id])).toEqual([{ assignee_id: "u2" }]);

    await grace.page.getByRole("button", { name: "Mark all read" }).click();
    await expect(item).not.toHaveClass(/unread/);
    await expect(bell.locator(".count")).toHaveCount(0);
    const rows = await stored<{ recipient_id: string; read: boolean }>("select recipient_id, read_at is not null as read from notifications where issue_id = $1", [id]);
    expect(rows).toEqual([{ recipient_id: "u2", read: true }]);
    // guard: the hand-over told Grace, not the person who made it
    expect(await stored("select count(*)::int as n from notifications where issue_id = $1 and recipient_id = 'u1'", [id])).toEqual([{ n: 0 }]);
    await expect.poll(() => feedLines(page, title)).toEqual([`Ada Lovelace | handed over | ${title} | to Grace Hopper`, `Ada Lovelace | opened | ${title}`]);
  } finally {
    await grace.context.close();
  }
});

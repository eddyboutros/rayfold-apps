import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADA, BASE, GRACE, MODE, NOOR, TOMAS, WITH_JVM, asSomeoneElse, closeStore, feedLines, named, reads, signIn, stored, type Person } from "./fleet.ts";

/**
 * Sign-offs: asked for in the documents team's panel, kept by the Kotlin service, decided from the signoff CLI (Kotlin,
 * on the JVM client) or from the same panel by the person asked, and heard by the workspace over the relay as a line
 * on the feed and a note on the bell. Three runtimes, one cookie, one relay.
 */
test.skip(!WITH_JVM, "the approvals service is the Kotlin one, which this run left out (FLEET_NO_JVM)");
test.afterAll(closeStore);

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Where the CLI finds the approvals service: its own port in development, the gateway's path behind one. */
const APPROVALS = process.env["FLEET_APPROVALS_URL"] ?? (MODE === "dev" ? "http://localhost:4004" : `${BASE}/api/approvals`);

/** `npm run signoff -- <args>` as someone, run to its end: what it printed, and its exit code. */
function signoff(who: Person, ...args: string[]): { code: number | null; out: string } {
  const run = spawnSync(process.execPath, [join(root, "scripts", "signoff.mjs"), ...args], {
    cwd: root,
    env: { ...process.env, KEEL_USER: who.handle, KEEL_APPROVALS: APPROVALS },
    encoding: "utf8",
    timeout: 180_000,
  });
  return { code: run.status, out: `${run.stdout}${run.stderr}`.trim() };
}

const panel = (page: Page) => page.locator("documents-panel");
const row = (page: Page, name: string) => panel(page).locator("li[data-id]", { has: page.locator("button.name", { hasText: name }) });
const asked = (page: Page, name: string) => row(page, name).locator("documents-approvals li");

async function keepAndOpenSignOffs(page: Page, name: string): Promise<string> {
  await panel(page).locator("label.picker input[type=file]").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from("Clause 3: thirty days.") });
  await expect(row(page, name)).toHaveCount(1);
  const id = (await row(page, name).getAttribute("data-id"))!;
  await row(page, name).locator("button.name").click();
  await row(page, name).getByRole("tab", { name: "Sign-offs" }).click();
  return id;
}

async function ask(page: Page, name: string, approver: Person): Promise<string> {
  await row(page, name).locator("select[aria-label='Who signs off']").selectOption({ label: approver.name });
  await row(page, name).getByRole("button", { name: "Ask for sign-off on v1" }).click();
  await expect(asked(page, name).filter({ hasText: approver.name }).locator(".state")).toHaveText("Waiting");
  const [found] = await stored<{ id: string }>("select a.id from approvals a join documents d on d.id = a.document_id where d.name = $1 and a.approver_id = $2", [name, approver.id]);
  return found!.id;
}

test("a sign-off asked for in the panel is decided from the signoff CLI, and the panel, the feed and the bell hear it", async ({ page }) => {
  const name = named("Northwind MSA") + ".txt";
  await signIn(page, ADA);
  const documentId = await keepAndOpenSignOffs(page, name);
  await expect(row(page, name).locator("documents-approvals .none")).toHaveText("Nobody has been asked to sign this off.");
  // whoever is asking is not offered to themselves
  await expect(row(page, name).locator("select[aria-label='Who signs off'] option")).toHaveText(["Grace Hopper", "Noor Haddad", "Tomás Ferreira"]);

  const id = await ask(page, name, TOMAS);
  await expect.poll(() => reads(asked(page, name).locator(".who"))).toMatch(/^Ada Lovelace asked Tomás Ferreira· version 1 · .+$/);
  expect(await stored("select document_id, version, requester_id, approver_id, decision, stale from approvals where id = $1", [id])).toEqual([
    { document_id: documentId, version: 1, requester_id: "u1", approver_id: "u4", decision: "pending", stale: false },
  ]);
  // the workspace heard ApprovalRequested over the relay: a line on the feed, a note for Tomás
  await expect.poll(async () => (await feedLines(page, name)).filter((l) => l.includes("sign-off"))).toEqual([`Ada Lovelace | asked for a sign-off on | ${name} | from Tomás Ferreira | approvals`]);
  expect(await stored("select recipient_id, text from notifications where kind = 'approval.requested' and text like $1", [`%${name}`])).toEqual([
    { recipient_id: "u4", text: `Ada Lovelace asked you to sign off on ${name}` },
  ]);

  // Tomás, in a terminal
  const inbox = signoff(TOMAS, "inbox");
  expect(inbox.code, inbox.out).toBe(0);
  expect(inbox.out.split("\n")).toContain(`${id}  ${name} (v1), asked by Ada Lovelace`);
  // guard: it is his inbox, not everyone's
  const graces = signoff(GRACE, "inbox");
  expect(graces.out.split("\n")).not.toContain(`${id}  ${name} (v1), asked by Ada Lovelace`);

  const approve = signoff(TOMAS, "approve", id, "Clause 3 is fine.");
  expect([approve.code, approve.out]).toEqual([0, `approved: ${name} (v1)`]);

  // on Ada's screen, live
  await expect(asked(page, name).locator(".state")).toHaveText("Approved");
  await expect(asked(page, name).locator(".note")).toHaveText("“Clause 3 is fine.”");
  await expect(asked(page, name).locator(".acts button")).toHaveCount(0);
  expect(await stored("select decision, note from approvals where id = $1", [id])).toEqual([{ decision: "approved", note: "Clause 3 is fine." }]);
  await expect.poll(async () => (await feedLines(page, name)).filter((l) => l.includes("sign"))).toEqual([
    `Tomás Ferreira | signed off on | ${name} | approved, Clause 3 is fine. | approvals`,
    `Ada Lovelace | asked for a sign-off on | ${name} | from Tomás Ferreira | approvals`,
  ]);
  await page.locator("button.bell").click();
  const told = page.locator(".panel li.item", { hasText: name, has: page.locator(".kind", { hasText: "Sign-off decided" }) });
  await expect(told).toHaveCount(1);
  await expect(told.locator(".text")).toHaveText(`Tomás Ferreira approved ${name}: Clause 3 is fine.`);

  // a decision is made once: the CLI says so, and changes nothing
  const again = signoff(TOMAS, "decline", id, "changed my mind");
  expect([again.code, again.out]).toEqual([1, "Already approved: nothing changed."]);
  const notHis = signoff(GRACE, "approve", id);
  expect([notHis.code, notHis.out]).toEqual([1, "That one was not asked of you."]);
  expect(await stored("select decision, note from approvals where id = $1", [id])).toEqual([{ decision: "approved", note: "Clause 3 is fine." }]);
});

test("the person asked decides in the panel, the asker sees it live, and a newer version marks a waiting one stale", async ({ page, browser }) => {
  const name = named("Retention schedule") + ".txt";
  await signIn(page, ADA);
  await keepAndOpenSignOffs(page, name);
  const toGrace = await ask(page, name, GRACE);
  const toNoor = await ask(page, name, NOOR);

  const grace = await asSomeoneElse(browser, GRACE);
  try {
    await row(grace.page, name).locator("button.name").click();
    await row(grace.page, name).getByRole("tab", { name: "Sign-offs" }).click();
    const hers = asked(grace.page, name).filter({ hasText: "asked Grace Hopper" });
    // only the one asked of her offers her a decision; she is not the file's owner, so she cannot ask
    await expect(hers.locator(".acts button")).toHaveText(["Approve", "Decline"]);
    await expect(asked(grace.page, name).filter({ hasText: "asked Noor Haddad" }).locator(".acts button")).toHaveCount(0);
    await expect(row(grace.page, name).locator("documents-approvals form.ask")).toHaveCount(0);
    await hers.getByRole("button", { name: "Decline" }).click();
    await expect(hers.locator(".state")).toHaveText("Declined");
  } finally {
    await grace.context.close();
  }
  await expect(asked(page, name).filter({ hasText: "asked Grace Hopper" }).locator(".state")).toHaveText("Declined");
  expect(await stored("select decision from approvals where id = $1", [toGrace])).toEqual([{ decision: "declined" }]);

  // a new version kept in the documents service reaches the Kotlin one: the sign-off still waiting is now stale
  await row(page, name).locator("label", { hasText: "New version" }).locator("input[type=file]").setInputFiles({ name: "v2.txt", mimeType: "text/plain", buffer: Buffer.from("Clause 3: sixty days.") });
  const noors = asked(page, name).filter({ hasText: "asked Noor Haddad" });
  await expect(noors.locator(".stale")).toHaveText("A newer version has been kept since; this asks about version 1.");
  // guard: a decided one is not stale; it was about the version it was about
  await expect(asked(page, name).filter({ hasText: "asked Grace Hopper" }).locator(".stale")).toHaveCount(0);
  expect(await stored("select id, stale from approvals where id in ($1, $2) order by approver_id", [toGrace, toNoor])).toEqual([
    { id: toGrace, stale: false },
    { id: toNoor, stale: true },
  ]);
  // and the CLI says so too
  const noorsInbox = signoff(NOOR, "inbox");
  expect(noorsInbox.out.split("\n")).toContain(`${toNoor}  ${name} (v1), asked by Ada Lovelace - a newer version has been kept since`);
});

import { expect, test, type Page } from "@playwright/test";
import { BASE, GRACE, MODE, WITH_JVM, closeStore, signIn, stored } from "./fleet.ts";

/**
 * The explorer each service serves in development (`EXPLORER=1` from scripts/dev.mjs), opened through the shell's
 * own origin, so a request it sends carries the session of whoever is signed in. Nothing sets it in production, and
 * behind the gateway it is not there.
 */
test.afterAll(closeStore);

const SERVICES = ["documents", "workspace", "catalogue", "feedback"] as const;

/** Sends one batch from the explorer's editor and answers the frames it drew. */
async function send(page: Page, batch: object): Promise<unknown[]> {
  await page.locator("textarea#req").fill(JSON.stringify(batch));
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && /\/rayfold$/.test(new URL(r.url()).pathname));
  await page.locator("#send").click();
  await answered;
  await expect(page.locator("#out .frame").first()).toBeVisible();
  return page.locator("#out .frame pre").evaluateAll((pres) => pres.map((p) => JSON.parse(p.textContent ?? "null")));
}

test("each service's explorer lists its operations and sends as the person signed in", async ({ page }) => {
  test.skip(MODE !== "dev", "the explorer is a development tool: nothing sets EXPLORER behind the gateway");
  await signIn(page, GRACE);
  for (const service of SERVICES) {
    await page.goto(`${BASE}/api/${service}/rayfold/explorer`);
    await expect(page.locator("#title")).toHaveText(`Keel: ${service}`);
    await expect(page.locator("button.op").first()).toBeVisible();
  }

  await page.goto(`${BASE}/api/workspace/rayfold/explorer`);
  // the operations are the schema's, read from the manifest
  const ops = await page.locator("button.op").evaluateAll((bs) => bs.map((b) => b.childNodes[0]?.textContent?.trim()));
  expect(ops).toEqual(expect.arrayContaining(["issues", "createIssue", "say", "markRead", "activityFeed", "notified"]));
  const frames = await send(page, { ops: [{ id: 1, op: "me", shape: "{ id name }" }] });
  // the session cookie went with it: the workspace knows who is asking
  expect(frames).toEqual([{ id: 1, data: { $type: "Member", id: "u2", name: "Grace Hopper" }, meta: expect.any(Object), fin: true }]);

  // guard: the explorer's own validation is the server's; a wrong argument is refused there, not in the page
  const title = `explorer ${Date.now()}`;
  const refused = await send(page, { ops: [{ id: 1, op: "createIssue", args: { projectId: "p1", title: "" }, shape: "{ id }", key: `explorer-refused-${title}` }] });
  expect(refused).toEqual([{ id: 1, error: expect.objectContaining({ code: "invalid_argument", message: expect.stringContaining("title") }), fin: true }]);
  // and a dry run, the explorer's checkbox, answers without writing
  await page.locator("button.op", { hasText: "createIssue" }).click();
  await page.locator("input#simulate").check();
  const dry = await send(page, { ops: [{ id: 1, op: "createIssue", args: { projectId: "p1", title }, shape: "{ title state }", key: `explorer-dry-run-${title}` }] });
  expect(dry).toEqual([{ id: 1, ok: { $type: "Issue", title, state: "open" }, meta: expect.any(Object), patch: [], fin: true }]);
  expect(await stored("select count(*)::int as n from issues where title = $1", [title])).toEqual([{ n: 0 }]);
});

test("the Kotlin service serves the same explorer on its own port", async ({ page }) => {
  test.skip(MODE !== "dev" || !WITH_JVM, "the Kotlin service's explorer is on :4004 in development");
  await page.goto("http://localhost:4004/rayfold/explorer");
  await expect(page.locator("#title")).toHaveText("Approvals");
  await expect(page.locator("button.op", { hasText: "requestApproval" })).toHaveCount(1);
  const frames = await send(page, { ops: [{ id: 1, op: "members", shape: "{ id }" }] });
  // nobody is signed in on this origin: the rule says so, from the JVM runtime
  expect(frames).toEqual([{ id: 1, error: expect.objectContaining({ code: "unauthenticated" }), fin: true }]);
});

test("behind the gateway there is no explorer", async ({ page }) => {
  test.skip(MODE === "dev", "in development every service serves one");
  for (const service of SERVICES) {
    const res = await page.request.get(`${BASE}/api/${service}/rayfold/explorer`);
    // no page: the path reaches the Rayfold endpoint, which reads it as a query by URL of an op it does not have
    expect([service, res.status(), res.headers()["content-type"]]).toEqual([service, 400, "application/problem+json"]);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_argument");
  }
});

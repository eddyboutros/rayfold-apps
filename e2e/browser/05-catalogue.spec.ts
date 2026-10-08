import { expect, test, type Page } from "@playwright/test";
import { ADA, BASE, GRACE, MODE, NOOR, asSomeoneElse, closeStore, named, reads, signIn, stored } from "./fleet.ts";

/**
 * The catalogue: one search across products, people, articles and files; a product whose margin only the product team
 * sees; an article two people edit at once; and the help centre, the customers' React site, reading what is published
 * and asking "was this page helpful?", with the answer counted live on the article's page in Keel.
 */
test.afterAll(closeStore);

const main = (page: Page) => page.locator("main.single");

async function catalogue(page: Page): Promise<void> {
  await page.locator(".rail button.nav", { hasText: "Catalogue" }).click();
  await expect(main(page).locator("h1")).toHaveText("Catalogue");
}

/** Finds something by its name with the page's own search, and opens it. */
async function find(page: Page, kind: "button.card.product" | "button.row", name: string): Promise<void> {
  await catalogue(page);
  await main(page).locator("input[type=search]").fill(name);
  await main(page).locator(kind, { has: page.locator("h3", { hasText: name }) }).first().click();
}

async function article(page: Page, name: string): Promise<void> {
  await find(page, "button.row", name);
  await expect(main(page).locator("article > header h1")).toHaveText(name);
}

test("one search finds products, people and articles, each drawn its own way", async ({ page }) => {
  await signIn(page, ADA);
  await catalogue(page);
  await main(page).locator("input[type=search]").fill("engineer");
  await expect(main(page).locator(".status")).toHaveText("14 results for “engineer”, best match first");
  // gathered by kind in the page's order, best match first within each
  await expect(main(page).locator(".section h2")).toHaveText(["Products 3", "People 6", "Articles 5"]);
  await expect(main(page).locator(".products h3")).toHaveText(["Tax engine add-on", "Onboarding package", "Premium support"]);
  await expect(main(page).locator(".people h3")).toHaveText(["Hannah Weiss", "Ada Lovelace", "Grace Hopper", "Elena Petrova", "Mei Tanaka", "Priya Raman"]);
  await expect(main(page).locator(".articles h3")).toHaveText(["On-call handbook", "Post-mortem template", "Rollout playbook", "Tax rounding policy", "How we price a migration"]);
  // a person is a card with their department and where they are
  await expect(main(page).locator(".people button", { hasText: "Priya Raman" }).locator(".line.small").first()).toHaveText("Services · Amsterdam");

  // guard: a phrase nothing has
  await main(page).locator("input[type=search]").fill(`nothing-${Date.now()}`);
  await expect(main(page).locator(".empty strong")).toHaveText(/^Nothing matches “nothing-\d+”$/);
});

test("a product's margin is the product team's to see, and only theirs", async ({ page, browser }) => {
  await signIn(page, NOOR);
  await find(page, "button.card.product", "Returns module");
  await expect(main(page).locator("h1")).toHaveText("Returns module");
  const facts = (p: Page) => main(p).locator("dl.facts > div").evaluateAll((ds) => ds.map((d) => [d.querySelector("dt")?.textContent?.trim(), d.querySelector("dd")?.textContent?.replace(/\s+/g, " ").trim()]));
  const shown = [
    ["Category", "Modules"],
    ["SKU", "OD-RET"],
    ["Availability", "Orderable now; provisioned within two working days."],
  ];
  await expect.poll(() => facts(page)).toEqual([...shown, ["Margin", "65% · costs us €158"]]);

  const ada = await asSomeoneElse(browser, ADA);
  try {
    await find(ada.page, "button.card.product", "Returns module");
    await expect(main(ada.page).locator("h1")).toHaveText("Returns module");
    // the same product, the same page, no margin: the service never sent her the cost to work it out from
    await expect.poll(() => facts(ada.page)).toEqual([...shown, ["Margin", "Shown to the product team"]]);
    const asked = await ada.page.request.get(`${BASE}/api/catalogue/rayfold/product?a=${Buffer.from(JSON.stringify({ id: "pr-returns" })).toString("base64url")}&s=${encodeURIComponent("{ name cost }")}`, { headers: { accept: "application/rayfold-frames+json" } });
    const frame = JSON.parse((await asked.text()).split("\n")[0]!) as { data: unknown; errors: unknown };
    expect([frame.data, frame.errors]).toEqual([{ $type: "Product", name: "Returns module", cost: null }, [{ code: "permission_denied", message: "Not allowed to access Product.cost", path: "cost" }]]);
  } finally {
    await ada.context.close();
  }
});

test("two people edit one article at once: the first save wins, the second is refused and keeps what was typed", async ({ page, browser }) => {
  const NAME = "Expense policy";
  await signIn(page, ADA);
  const [{ version }] = (await stored<{ version: number }>("select version from articles where slug = 'expense-policy'")) as [{ version: number }];
  await article(page, NAME);
  const grace = await asSomeoneElse(browser, GRACE);
  try {
    await article(grace.page, NAME);
    for (const p of [page, grace.page]) await main(p).getByRole("button", { name: "Edit", exact: true }).click();

    // both type; Ada saves first
    const graces = named("Claims are filed within a month.");
    await main(grace.page).locator("input[name=summary]").fill(graces);
    const adas = named("Claims are filed within thirty days.");
    await main(page).locator("input[name=summary]").fill(adas);
    await main(page).getByRole("button", { name: "Save" }).click();
    await expect(main(page).locator("article > header h1")).toHaveText(NAME);
    await expect.poll(() => reads(main(page).locator(".byline"))).toContain(`version ${version + 1}`);
    // Ada's save reaches Grace's open page live, and leaves what Grace is typing alone
    await expect(main(grace.page).locator("input[name=summary]")).toHaveValue(graces);

    await main(grace.page).getByRole("button", { name: "Save" }).click();
    // refused, said so, and her form is still there with her words in it
    await expect(main(grace.page).locator("form.edit [role=alert]")).toHaveText(`Article:ar-expenses is at version ${version + 1}, not ${version}`);
    await expect(main(grace.page).locator("input[name=summary]")).toHaveValue(graces);
    expect(await stored("select version, summary, editor_id from articles where slug = 'expense-policy'")).toEqual([{ version: version + 1, summary: adas, editor_id: "u1" }]);
  } finally {
    await grace.context.close();
  }
});

test("an article published to the help centre is read there signed out, and a reader's answer moves the count on the team's page live", async ({ page, browser }) => {
  const NAME = "Post-mortem template";
  const SLUG = "post-mortem-template";
  await signIn(page, ADA);
  await article(page, NAME);
  const toggle = main(page).locator("header .actions button", { hasText: "help centre" });
  // from wherever an earlier run left it: off the help centre
  if ((await toggle.textContent())?.includes("Take off")) {
    await toggle.click();
    await expect(toggle).toHaveText("Publish to the help centre");
  }
  await toggle.click();
  await expect(toggle).toHaveText("Take off the help centre");
  await expect(main(page).locator(".byline a.public")).toHaveAttribute("href", `/help/${SLUG}`);
  await expect(main(page).locator(".readers h2")).toHaveText("What readers said");
  const [{ helped, missed }] = (await stored<{ helped: number; missed: number }>(
    "select count(*) filter (where helpful)::int as helped, count(*) filter (where not helpful)::int as missed from ratings where slug = $1",
    [SLUG],
  )) as [{ helped: number; missed: number }];

  // a customer, with no account, on the help centre: the same origin, its own team's site
  const customer = await browser.newContext();
  try {
    const help = await customer.newPage();
    await help.goto(`${BASE}/help/`);
    await expect(help.locator("h1")).toHaveText("How can we help?");
    await expect(help.locator(".pages strong")).toContainText([NAME]);
    await help.locator(".pages a", { hasText: NAME }).click();
    await expect(help).toHaveURL(`${BASE}/help/${SLUG}`);
    await expect(help.locator("article h1")).toHaveText(NAME);
    await expect(help).toHaveTitle(`${NAME} - Order desk help`);
    await expect(help.locator("#feedback-title")).toHaveText("Was this page helpful?");
    await help.getByRole("button", { name: "Yes" }).click();
    await expect(help.locator("#feedback-title")).toHaveText("Thanks. You said this page helped.");
    const total = helped + missed + 1;
    await expect(help.locator(".score")).toHaveText(`${helped + 1} of ${total} ${total === 1 ? "reader" : "readers"} found this page helpful.`);
    // the visitor is known by a cookie the feedback service set, and nothing else: no session
    const cookies = (await customer.cookies(BASE)).map((c) => c.name);
    expect(cookies).toEqual(["keel_visitor"]);
    const [visitor] = (await customer.cookies(BASE)).filter((c) => c.name === "keel_visitor");
    expect(await stored("select helpful, comment from ratings where slug = $1 and visitor_id = $2", [SLUG, visitor!.value])).toEqual([{ helpful: true, comment: null }]);

    // on Ada's page in Keel, without a reload
    const share = Math.round(((helped + 1) / total) * 100);
    await expect(main(page).locator(".readers .tally .pill")).toHaveText([`${helped + 1} helped`, `${missed} did not`]);
    await expect(main(page).locator(".readers .tally .muted")).toHaveText(`${share}% of ${total} ${total === 1 ? "reader" : "readers"} found it helpful`);

    // and a comment from the customer is listed for the team, live
    await help.getByRole("button", { name: "Say what helped" }).click();
    const said = named("The checklist was what we needed");
    await help.locator("textarea#feedback-comment").fill(said);
    await help.getByRole("button", { name: "Send" }).click();
    await expect(help.locator("#feedback-title")).toHaveText(`Thanks. You said this page helped. “${said}”`);
    await expect(main(page).locator(".readers .said li", { hasText: said }).locator(".pill")).toHaveText("Helped");

    // taken off: the team's page says so at once; the help centre stops showing it, at once in development and
    // within the shared cache's minute behind the gateway
    await toggle.click();
    await expect(toggle).toHaveText("Publish to the help centre");
    await expect(main(page).locator(".readers")).toHaveCount(0);
    if (MODE === "dev") {
      // a reader who has not been here: the page's own browser may keep what it read for the minute it is public
      const later = await customer.browser()!.newContext();
      const fresh = await later.newPage();
      await fresh.goto(`${BASE}/help/${SLUG}`);
      await expect(fresh.locator(".empty strong")).toHaveText("There is no guide here.");
      await later.close();
    } else {
      const res = await help.request.get(`${BASE}/api/help/rayfold/helpPage?a=${Buffer.from(JSON.stringify({ slug: SLUG })).toString("base64url")}&s=${encodeURIComponent("{ slug name summary tags body publishedAt }")}`);
      expect(res.headers()["x-cache-status"]).toMatch(/^(HIT|STALE|UPDATING|REVALIDATED|EXPIRED|MISS)$/);
    }
  } finally {
    await customer.close();
  }
});

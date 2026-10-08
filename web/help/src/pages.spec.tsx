import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { RayfoldProvider } from "@rayfold/react";
import { catalogueClient, feedbackClient } from "./clients";
import { HelpArticle, HelpIndex } from "./pages";
import { all, button, gateway, one, reads, settle, text, type TestService } from "./testing/rayfold";
import { catalogue, feedback, type Faults, type PageRow, type RatingRow } from "./testing/services";

const PUBLISHED = "2026-02-01T12:00:00.000Z";

function tables(): PageRow[] {
  return [
    { id: "a1", slug: "sandbox", name: "The sandbox", summary: "Try anything without touching real orders", tags: ["setup"], body: "Open it from **Settings**.", publishedAt: PUBLISHED },
    { id: "a2", slug: "invoicing", name: "Invoicing", summary: "How an invoice is raised", tags: ["billing", "setup"], body: "## Before you start\n\nKeep the *order number* to hand.\n\n- Open the order\n- Press `Invoice`", publishedAt: PUBLISHED },
    { id: "a3", slug: "returns", name: "Returns", summary: "Taking an order back", tags: ["orders"], body: "Ask for the receipt.", publishedAt: PUBLISHED },
    // the team's own notes: an article that was never published is not on the help centre at all
    { id: "a4", slug: "pricing-notes", name: "Pricing notes", summary: "Internal margins", tags: ["internal"], body: "Margins.", publishedAt: null },
  ];
}

const LIST_SHAPE = "{ items { slug name summary tags } total }";
const PAGE_SHAPE = "{ slug name summary tags body publishedAt }";

describe("the help centre", () => {
  let pages: PageRow[];
  let ratings: RatingRow[];
  let cat: TestService;
  let fb: TestService;
  let go: ReturnType<typeof vi.fn<(to: string) => void>>;
  let root: HTMLElement;

  function serve(faults: Faults = {}): void {
    cat = catalogue(pages, faults);
    fb = feedback(ratings, "v-1", faults);
    vi.stubGlobal("fetch", gateway({ "/api/help": cat, "/api/feedback": fb }));
  }

  async function index(faults: Faults = {}): Promise<void> {
    serve(faults);
    root = render(
      <RayfoldProvider client={catalogueClient()}>
        <HelpIndex go={go} />
      </RayfoldProvider>,
    ).container;
    await settle(cat, fb);
  }

  async function article(slug: string, faults: Faults = {}): Promise<void> {
    serve(faults);
    root = render(
      <RayfoldProvider client={catalogueClient()}>
        <HelpArticle slug={slug} go={go} feedback={feedbackClient()} />
      </RayfoldProvider>,
    ).container;
    await settle(cat, fb);
  }

  beforeEach(() => {
    pages = tables();
    ratings = [];
    go = vi.fn<(to: string) => void>();
    document.title = "";
  });

  afterEach(async () => {
    cleanup();
    cat?.close();
    fb?.close();
    vi.unstubAllGlobals();
  });

  describe("its front page", () => {
    it("lists every published guide A to Z by address, read once with a GET a shared cache may keep", async () => {
      await index();
      expect(all(root, ".pages li")).toEqual(["Invoicing How an invoice is raised", "Returns Taking an order back", "The sandbox Try anything without touching real orders"]);
      expect([...root.querySelectorAll<HTMLAnchorElement>(".pages a")].map((a) => a.getAttribute("href"))).toEqual(["/help/invoicing", "/help/returns", "/help/sandbox"]);
      expect(cat.take()).toEqual([{ op: "helpPages", args: { page: { first: 100 } }, shape: LIST_SHAPE, via: "GET" }]);
      expect(cat.answered).toEqual([{ op: "helpPages", status: 200, cacheControl: "public, max-age=60, stale-while-revalidate=600" }]);
      // the help centre asks nothing of the feedback service until a guide is open
      expect(fb.take()).toEqual([]);
      expect(document.title).toBe("Order desk help");
    });

    it("opens a guide without reloading the page, and leaves a modified click to the browser", async () => {
      await index();
      const link = [...root.querySelectorAll<HTMLAnchorElement>(".pages a")].find((a) => text(a).startsWith("Returns"))!;
      // a click the page handles: no navigation of its own, the reader's address changes through go
      expect(fireEvent.click(link)).toBe(false);
      expect(go.mock.calls).toEqual([["returns"]]);
      // guard: a ctrl- or cmd-click opens a tab, as any link does; the page keeps out of the way
      expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
      expect(fireEvent.click(link, { metaKey: true })).toBe(true);
      expect(go.mock.calls).toEqual([["returns"]]);
    });

    it("offers every topic the guides carry, once each and in order, and narrows the list to one", async () => {
      await index();
      cat.take();
      expect(all(root, "nav.tags button")).toEqual(["Everything", "billing", "orders", "setup"]);
      expect(one(root, "nav.tags").getAttribute("aria-label")).toBe("Topics");
      const pressed = () => [...root.querySelectorAll("nav.tags button.accent")].map((b) => text(b));
      expect(pressed()).toEqual(["Everything"]);

      fireEvent.click(button(root, "setup"));
      await settle(cat, fb);
      expect(all(root, ".pages strong")).toEqual(["Invoicing", "The sandbox"]);
      expect(pressed()).toEqual(["setup"]);

      // pressed again, a topic lets go
      fireEvent.click(button(root, "setup"));
      await settle(cat, fb);
      expect(all(root, ".pages strong")).toEqual(["Invoicing", "Returns", "The sandbox"]);
      expect(pressed()).toEqual(["Everything"]);

      fireEvent.click(button(root, "orders"));
      await settle(cat, fb);
      expect(all(root, ".pages strong")).toEqual(["Returns"]);
      fireEvent.click(button(root, "Everything"));
      await settle(cat, fb);
      expect(all(root, ".pages strong")).toEqual(["Invoicing", "Returns", "The sandbox"]);
      // narrowing is the page's own: the catalogue was asked once, when the page opened
      expect(cat.take()).toEqual([]);
    });

    it("finds a guide by its name or summary as the reader types, in any case, and says when nothing matches", async () => {
      await index();
      cat.take();
      const box = one<HTMLInputElement>(root, "input[type=search]");
      expect(box.getAttribute("aria-label")).toBe("Find a guide");

      fireEvent.change(box, { target: { value: "  INVOICE " } });
      await settle(cat, fb);
      expect(all(root, ".pages strong")).toEqual(["Invoicing"]);

      // a summary counts as much as a name
      fireEvent.change(box, { target: { value: "real orders" } });
      await settle(cat, fb);
      expect(all(root, ".pages strong")).toEqual(["The sandbox"]);

      // with a topic as well, both have to hold
      fireEvent.click(button(root, "orders"));
      await settle(cat, fb);
      expect(root.querySelector(".pages")).toBeNull();
      expect(text(one(root, ".empty"))).toBe("Nothing matches. Try another word, or every topic.");

      fireEvent.click(button(root, "Everything"));
      fireEvent.change(box, { target: { value: "   " } });
      await settle(cat, fb);
      expect(all(root, ".pages strong")).toEqual(["Invoicing", "Returns", "The sandbox"]);
      expect(root.querySelector(".empty")).toBeNull();
      expect(cat.take()).toEqual([]);
    });

    it("offers no topics when no guide has one, and still lists them", async () => {
      for (const p of pages) p.tags = [];
      await index();
      expect(root.querySelector("nav.tags")).toBeNull();
      expect(all(root, ".pages strong")).toEqual(["Invoicing", "Returns", "The sandbox"]);
    });

    it("says nothing matches when nothing is published, rather than drawing an empty list", async () => {
      for (const p of pages) p.publishedAt = null;
      await index();
      expect(root.querySelector(".pages")).toBeNull();
      expect(text(one(root, ".empty"))).toBe("Nothing matches. Try another word, or every topic.");
    });

    it("says the guides could not be loaded, and why, when the catalogue refuses", async () => {
      await index({ helpPages: "the catalogue is restarting" });
      expect(reads(one(root, "[role=alert]"))).toBe("The guides could not be loaded. the catalogue is restarting");
      expect(root.querySelector(".pages")).toBeNull();
      expect(root.querySelector("nav.tags")).toBeNull();
    });

    it("says the help centre could not be reached when the gateway answers with an error of its own", async () => {
      serve();
      cat.unreachable = 502;
      root = render(
        <RayfoldProvider client={catalogueClient()}>
          <HelpIndex go={go} />
        </RayfoldProvider>,
      ).container;
      await settle(cat, fb);
      expect(reads(one(root, "[role=alert]"))).toBe("The guides could not be loaded. The help centre could not be reached (502)");
      expect(root.querySelector(".pages")).toBeNull();
      expect(root.querySelector("nav.tags")).toBeNull();
    });
  });

  describe("a guide", () => {
    it("reads one published guide by its address, with its body as prose, and asks the feedback service about it", async () => {
      await article("invoicing");
      expect(text(one(root, "article h1"))).toBe("Invoicing");
      expect(text(one(root, "article .lede"))).toBe("How an invoice is raised");
      const day = new Date(PUBLISHED).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
      expect(text(one(root, "article .byline"))).toBe(`Published ${day}`);
      expect(one(root, ".prose").innerHTML).toBe(
        "<h3>Before you start</h3><p>Keep the <em>order number</em> to hand.</p><ul><li>Open the order</li><li>Press <code>Invoice</code></li></ul>",
      );
      expect(document.title).toBe("Invoicing - Order desk help");
      expect(cat.take()).toEqual([{ op: "helpPage", args: { slug: "invoicing" }, shape: PAGE_SHAPE, via: "GET" }]);
      expect(cat.answered).toEqual([{ op: "helpPage", status: 200, cacheControl: "public, max-age=60, stale-while-revalidate=600" }]);
      // its feedback box asks after this page, by the address the catalogue answered with
      expect(fb.take()).toEqual([
        { op: "score", args: { slug: "invoicing" }, shape: "{ id helpful unhelpful }", live: true, via: "POST" },
        { op: "ratings", args: { slug: "invoicing" }, shape: "{ items { id helpful comment } }", via: "POST" },
      ]);
      expect(text(one(root, "#feedback-title"))).toBe("Was this page helpful?");

      // the way back is a link to the front page, followed without a reload
      const back = one<HTMLAnchorElement>(root, ".crumbs a");
      expect([text(back), back.getAttribute("href")]).toEqual(["All guides", "/help/"]);
      fireEvent.click(back);
      expect(go.mock.calls).toEqual([[""]]);
    });

    it("is not there when it was never published, and asks nobody whether it helped", async () => {
      await article("pricing-notes");
      expect(reads(one(root, ".empty"))).toBe("There is no guide here. It may have moved; every guide is on the front page.");
      expect(root.querySelector("article")).toBeNull();
      expect(root.querySelector(".feedback")).toBeNull();
      expect(fb.take()).toEqual([]);
      expect(document.title).toBe("");
      fireEvent.click(one(root, ".empty a"));
      expect(go.mock.calls).toEqual([[""]]);
    });

    it("is not there at an address nothing has", async () => {
      await article("no-such-page");
      expect(text(one(root, ".empty strong"))).toBe("There is no guide here.");
      expect(fb.take()).toEqual([]);
    });

    it("says the guide could not be loaded, and why, when the catalogue refuses", async () => {
      await article("invoicing", { helpPage: "the catalogue is restarting" });
      expect(reads(one(root, "[role=alert]"))).toBe("This guide could not be loaded. the catalogue is restarting");
      expect(root.querySelector("article")).toBeNull();
      expect(fb.take()).toEqual([]);
    });
  });
});

import { catalogueBase, catalogueClient, documentsBase } from "./client";
import { feedbackBase } from "./help-feedback";

describe("where the page finds its services", () => {
  const added: Element[] = [];
  function meta(name: string, content: string): void {
    const tag = document.createElement("meta");
    tag.name = name;
    tag.content = content;
    document.head.append(tag);
    added.push(tag);
  }

  afterEach(() => {
    for (const tag of added.splice(0)) tag.remove();
    vi.unstubAllGlobals();
  });

  it("uses the gateway's paths on the page's own origin when nothing says otherwise", () => {
    expect(catalogueBase()).toBe("/api/catalogue");
    expect(documentsBase()).toBe("/api/documents");
    expect(feedbackBase()).toBe("/api/feedback");
  });

  it("takes a page's meta tag instead, without its trailing slash", () => {
    meta("catalogue-base", "https://cat.example/x/");
    meta("documents-base", "/docs/");
    meta("feedback-base", "/fb");
    expect(catalogueBase()).toBe("https://cat.example/x");
    expect(documentsBase()).toBe("/docs");
    expect(feedbackBase()).toBe("/fb");
  });

  it("ignores an empty meta tag", () => {
    meta("catalogue-base", "");
    expect(catalogueBase()).toBe("/api/catalogue");
  });

  it("sends its requests to the service's endpoint under that base, naming itself", async () => {
    meta("catalogue-base", "/cat/");
    const seen: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ id: 1, data: null, fin: true }) + "\n", { headers: { "content-type": "application/x-ndjson" } });
    });
    await catalogueClient().query("product", { id: "p1" });
    expect(seen.map((s) => s.url)).toEqual(["/cat/rayfold"]);
    expect(seen[0]!.body).toEqual({ rayfold: "0.1", ops: [{ id: 1, op: "product", args: { id: "p1" } }], meta: { client: "catalogue-ui/0.1.0" } });
  });
});

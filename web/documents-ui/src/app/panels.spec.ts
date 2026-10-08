import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { Component, signal } from "@angular/core";
import { provideRayfold } from "@rayfold/angular";
import documentsSchema from "../../../../services/documents/src/documents.rayfold" with { type: "text" };
import { TestService, all, inUtc, one, settle, text } from "../testing/rayfold";
import { documentsBase, documentsClient } from "./client";
import { approvalsBase } from "./approvals";
import { ADA, GRACE, docs, documentsResolvers, type DocRow, type NoteRow } from "../testing/documents";
import { History } from "./history";
import { Notes } from "./notes";
import { Preview } from "./preview";

let zone: () => void;
beforeAll(() => (zone = inUtc()));
afterAll(() => zone());
afterEach(() => vi.unstubAllGlobals());

describe("a file's notes", () => {
  @Component({ imports: [Notes], template: `<documents-notes [documentId]="id()" />` })
  class Host {
    readonly id = signal("d1");
  }

  let notes: NoteRow[];
  let service: TestService;
  let fixture: ComponentFixture<Host>;
  let root: HTMLElement;

  async function mount(): Promise<void> {
    service = new TestService(documentsSchema, documentsResolvers(docs(), notes), ADA);
    fixture = TestBed.configureTestingModule({ providers: [provideRayfold(service.client())] }).createComponent(Host);
    root = fixture.nativeElement as HTMLElement;
    await settle(fixture, service);
  }

  async function post(body: string): Promise<void> {
    const input = one<HTMLInputElement>(root, "input");
    input.value = body;
    input.dispatchEvent(new Event("input"));
    fixture.detectChanges();
    one<HTMLFormElement>(root, "form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settle(fixture, service);
  }

  beforeEach(() => {
    notes = [
      { id: "n1", documentId: "d1", body: "Looks right", at: "2026-03-04T12:00:00.000Z", byId: "u2" },
      { id: "n2", documentId: "d2", body: "Other file", at: "2026-03-04T12:00:00.000Z", byId: "u2" },
      { id: "n3", documentId: "d1", body: "Mine", at: "2026-03-05T12:00:00.000Z", byId: "u1" },
      { id: "n4", documentId: "d1", body: "lower", at: "2026-03-05T12:00:00.000Z", byId: "u9" },
    ];
  });
  afterEach(() => {
    fixture?.destroy();
    service?.close();
  });

  it("lists what was said about this file only, with who said it", async () => {
    await mount();
    expect(service.take()).toEqual([{ op: "notes", args: { documentId: "d1" }, shape: "{ items { id body at by { id name } } }", live: true }]);
    expect(all(root, "li .meta")).toEqual(["Grace Hopper Mar 4", "Ada Lovelace Mar 5", "lin wei Mar 5"]);
    expect(all(root, "li .body")).toEqual(["Looks right", "Mine", "lower"]);
    expect(all(root, "li .avatar")).toEqual(["G", "A", "L"]);
    expect(root.querySelector("li .avatar")?.getAttribute("data-person")).toBe("u2");
  });

  it("posts a trimmed line, empties the box, and the list hears it", async () => {
    await mount();
    service.take();
    const send = one<HTMLButtonElement>(root, "form button");
    expect(send.disabled).toBe(true);
    const input = one<HTMLInputElement>(root, "input");
    input.value = "   ";
    input.dispatchEvent(new Event("input"));
    fixture.detectChanges();
    expect(send.disabled).toBe(true);

    await post("  Signed copy attached ");
    expect(service.take().filter((s) => !s.live)).toEqual([{ op: "addNote", args: { documentId: "d1", body: "Signed copy attached" } }]);
    expect(input.value).toBe("");
    expect(all(root, "li .body")).toEqual(["Looks right", "Mine", "lower", "Signed copy attached"]);
  });

  it("hears a note left from another screen as it is made", async () => {
    await mount();
    await service.client(GRACE).command("addNote", { documentId: "d1", body: "From elsewhere" });
    await settle(fixture, service);
    expect(all(root, "li .body")).toEqual(["Looks right", "Mine", "lower", "From elsewhere"]);
  });

  it("keeps the line and says why when the note is refused", async () => {
    await mount();
    await post("fail");
    expect(text(one(root, "p.bad"))).toBe("That file is gone");
    expect(one<HTMLInputElement>(root, "input").value).toBe("fail");
  });

  it("says when nothing has been said, and follows the file it is given", async () => {
    await mount();
    fixture.componentInstance.id.set("d9");
    await settle(fixture, service);
    expect(text(one(root, ".none"))).toBe("Nothing said about this file yet.");
    expect(service.take().at(-1)).toEqual({ op: "notes", args: { documentId: "d9" }, shape: "{ items { id body at by { id name } } }", live: true });
  });

  it("shows today's notes by the time and older ones by the day", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-04T18:00:00.000Z") });
    try {
      await mount();
      expect(all(root, "li .meta time")).toEqual(["12:00 PM", "Mar 5", "Mar 5"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a file's revisions", () => {
  @Component({ imports: [History], template: `<documents-history [documentId]="id()" base="/api/documents" />` })
  class Host {
    readonly id = signal("d2");
  }

  it("lists every revision newest first, each opened at its own address", async () => {
    const rows: DocRow[] = docs();
    const service = new TestService(documentsSchema, documentsResolvers(rows, []), ADA);
    const fixture = TestBed.configureTestingModule({ providers: [provideRayfold(service.client())] }).createComponent(Host);
    const root = fixture.nativeElement as HTMLElement;
    await settle(fixture, service);
    expect(service.take()).toEqual([{ op: "revisions", args: { documentId: "d2" }, shape: "{ items { id version size url at by { name } } }" }]);
    expect(all(root, "li")).toEqual(["v3 Grace Hopper Mar 4, 12:00 PM 100 B Open", "v2 Ada Lovelace Mar 4, 12:00 PM 2 KB Open", "v1 Grace Hopper Mar 4, 12:00 PM 3.0 MB Open"]);
    expect([...root.querySelectorAll("li a")].map((a) => a.getAttribute("href"))).toEqual(["/api/documents/files/d2-r3", "/api/documents/files/d2-r2", "https://cdn.example/old"]);
    expect(root.querySelector("li time")?.getAttribute("datetime")).toBe("2026-03-04T12:00:00.000Z");

    fixture.componentInstance.id.set("nope");
    await settle(fixture, service);
    expect(text(one(root, "[role=alert]"))).toBe("The revisions could not be loaded: No document nope");
    fixture.destroy();
  });
});

describe("a file's preview", () => {
  @Component({ imports: [Preview], template: `<documents-preview [url]="url()" [contentType]="type()" [name]="name()" />` })
  class Host {
    readonly url = signal("/api/documents/files/r1");
    readonly type = signal("text/plain");
    readonly name = signal("brief.txt");
  }

  let fixture: ComponentFixture<Host>;
  let root: HTMLElement;
  let asked: string[];
  let answer: (url: string) => Response | Promise<Response>;

  async function mount(type: string, name: string, url = "/api/documents/files/r1"): Promise<void> {
    asked = [];
    // as a browser's fetch does, an abort ends the request whatever stage it is at
    vi.stubGlobal("fetch", (u: string, init: RequestInit) => {
      asked.push(u);
      const signal = init.signal!;
      return new Promise<Response>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        void Promise.resolve(answer(u)).then(resolve);
      });
    });
    fixture = TestBed.createComponent(Host);
    fixture.componentInstance.type.set(type);
    fixture.componentInstance.name.set(name);
    fixture.componentInstance.url.set(url);
    root = fixture.nativeElement as HTMLElement;
    await settled();
  }

  async function settled(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r, 0));
    }
    fixture.detectChanges();
  }

  beforeEach(() => {
    answer = (u) => new Response(`text of ${u}`);
  });
  afterEach(() => fixture?.destroy());

  it("shows text as text, read from the same address a link opens", async () => {
    await mount("text/plain", "brief.txt");
    expect(asked).toEqual(["/api/documents/files/r1"]);
    expect(text(one(root, "pre"))).toBe("text of /api/documents/files/r1");
  });

  it("reads a file by its name when its type says nothing", async () => {
    await mount("application/octet-stream", "notes.md");
    expect(text(one(root, "pre"))).toBe("text of /api/documents/files/r1");
    await mount("application/json", "data");
    expect(text(one(root, "pre"))).toBe("text of /api/documents/files/r1");
  });

  it("shows a CSV as a table, with quoted cells and doubled quotes, its first row the header", async () => {
    answer = () => new Response('name,"note, with comma"\r\n\r\nAda,"said ""hi"""\nLin,\n');
    await mount("text/csv", "people.csv");
    expect(all(root, "th")).toEqual(["name", "note, with comma"]);
    expect([...root.querySelectorAll("tr")].slice(1).map((r) => all(r, "td"))).toEqual([
      ["Ada", 'said "hi"'],
      ["Lin", ""],
    ]);
    answer = () => new Response("a,b\n1,2");
    await mount("application/octet-stream", "x.CSV");
    expect(all(root, "th")).toEqual(["a", "b"]);
  });

  it("stops a table at two hundred rows and a text at two hundred thousand characters", async () => {
    answer = () => new Response(Array.from({ length: 300 }, (_, i) => `r${i}`).join("\n"));
    await mount("text/csv", "big.csv");
    expect(root.querySelectorAll("tr").length).toBe(201);
    answer = () => new Response("x".repeat(250_000));
    await mount("text/plain", "big.txt");
    expect(one(root, "pre").textContent?.length).toBe(200_000);
  });

  it("shows an image as itself and a PDF in the browser's viewer, without reading them", async () => {
    await mount("image/png", "logo.png");
    expect(one(root, "img").getAttribute("src")).toBe("/api/documents/files/r1");
    expect(one(root, "img").getAttribute("alt")).toBe("logo.png");
    await mount("application/pdf", "contract.pdf");
    expect(one(root, "iframe").getAttribute("src")).toBe("/api/documents/files/r1");
    expect(one(root, "iframe").getAttribute("title")).toBe("contract.pdf");
    expect(asked).toEqual([]);
  });

  it("says there is no preview for anything else", async () => {
    await mount("application/zip", "bundle.zip");
    expect(text(one(root, ".none"))).toBe("No preview for application/zip. Open it to download.");
    await mount("", "bundle");
    expect(text(one(root, ".none"))).toBe("No preview for this kind of file. Open it to download.");
    expect(asked).toEqual([]);
  });

  it("says why a file could not be read", async () => {
    answer = () => new Response("", { status: 401 });
    await mount("text/plain", "a.txt");
    expect(text(one(root, "[role=alert]"))).toBe("You are not signed in.");
    answer = () => new Response("", { status: 404 });
    await mount("text/plain", "a.txt");
    expect(text(one(root, "[role=alert]"))).toBe("The file could not be read (404).");
    // the next file starts clean
    answer = (u) => new Response(`text of ${u}`);
    fixture.componentInstance.url.set("/api/documents/files/r2");
    await settled();
    expect(root.querySelector("[role=alert]")).toBe(null);
    expect(text(one(root, "pre"))).toBe("text of /api/documents/files/r2");
  });

  it("drops the first file's answer when another is asked for before it arrives", async () => {
    let release!: (r: Response) => void;
    answer = (u) => (u.endsWith("r1") ? new Promise<Response>((resolve) => (release = resolve)) : new Response("second"));
    await mount("text/plain", "a.txt");
    fixture.componentInstance.url.set("/api/documents/files/r2");
    await settled();
    expect(text(one(root, "pre"))).toBe("second");
    release(new Response("first"));
    await settled();
    expect(text(one(root, "pre"))).toBe("second");
  });

  it("reads nothing without an address", async () => {
    await mount("text/plain", "a.txt", "");
    expect(asked).toEqual([]);
    expect(root.querySelector(".skeleton")).not.toBe(null);
  });
});

describe("the page a share link opens", () => {
  let fixture: ComponentFixture<unknown>;
  let service: TestService;
  let seen: Array<string | null>;
  // the page builds its client as its module loads, over the fetch there is then: so fetch is pointed at whatever
  // a spec routes it to before the module is loaded, and the page's own client is the one that runs
  let route: typeof fetch;
  const real = globalThis.fetch;
  let Shared: typeof import("./shared").Shared;
  beforeAll(async () => {
    globalThis.fetch = ((u: RequestInfo | URL, init?: RequestInit) => route(u, init)) as typeof fetch;
    ({ Shared } = await import("./shared"));
  });
  afterAll(() => {
    globalThis.fetch = real;
  });

  async function mount(rows: DocRow[], url: string): Promise<HTMLElement> {
    history.replaceState(null, "", url);
    seen = [];
    service = new TestService(documentsSchema, documentsResolvers(rows, []), null);
    const handler = service.fetchHandler("/api/documents", (request) => {
      const auth = request.headers.get("authorization");
      seen.push(auth);
      const token = auth?.slice("Bearer ".length) ?? "";
      return token.startsWith("tok-") ? { id: `share:${token.slice(4)}`, documentId: token.slice(4) } : null;
    });
    route = (async (u: RequestInfo | URL, init?: RequestInit) => (String(u).includes("/rayfold") ? handler(String(u), init) : new Response(`bytes at ${String(u)}`))) as typeof fetch;
    fixture = TestBed.createComponent(Shared);
    const root = fixture.nativeElement as HTMLElement;
    for (let i = 0; i < 20 && !root.querySelector("h1, .empty"); i++) {
      fixture.detectChanges();
      await new Promise((r) => setTimeout(r, 0));
    }
    for (let i = 0; i < 5; i++) {
      fixture.detectChanges();
      await new Promise((r) => setTimeout(r, 0));
    }
    return root;
  }

  afterEach(() => {
    fixture?.destroy();
    history.replaceState(null, "", "/");
  });

  it("reads the one document its token is for, with the token as its bearer and on the download", async () => {
    const root = await mount(docs(), "/?share=tok-d2");
    expect(seen).toEqual(["Bearer tok-d2"]);
    expect(service.take()).toEqual([{ op: "shared", args: {}, shape: "{ id name contentType size url version updatedAt owner { name } }" }]);
    expect(text(one(root, "h1"))).toBe("budget.csv");
    expect(text(one(root, ".sub"))).toBe("3 KB · text/csv · version 3 · Grace Hopper · Mar 4, 12:00 PM");
    expect(one(root, "a.btn").getAttribute("href")).toBe("/api/documents/files/r2?token=tok-d2");
    expect(all(root, "th")).toEqual(["bytes at /api/documents/files/r2?token=tok-d2"]);
  });

  it("says a link that no longer works does not, and why", async () => {
    const root = await mount(docs(), "/?share=expired");
    expect(seen).toEqual(["Bearer expired"]);
    expect(text(one(root, ".empty strong"))).toBe("This link does not work any more");
    expect(text(one(root, ".empty .why"))).toBe("Sign in to access shared()");
  });

  it("says a link that names no document names none", async () => {
    const root = await mount(docs(), "/?share=tok-gone");
    expect(text(one(root, ".empty"))).toBe("Nothing here The link names no document.");
  });
});

describe("where the panel finds its services", () => {
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
  });

  it("uses the gateway's paths unless a meta tag says otherwise, without a trailing slash", () => {
    expect(documentsBase()).toBe("/api/documents");
    expect(approvalsBase()).toBe("/api/approvals");
    meta("documents-base", "/docs/");
    meta("approvals-base", "https://a.example/");
    expect(documentsBase()).toBe("/docs");
    expect(approvalsBase()).toBe("https://a.example");
  });

  it("sends a file's bytes over HTTP to the upload route under the base", async () => {
    meta("documents-base", "/docs/");
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      seen.push(String(u));
      return new Response(JSON.stringify({ id: "k1", size: 2 }), { headers: { "content-type": "application/json" } });
    });
    const kept = await documentsClient().upload(new Blob(["hi"]));
    expect(kept.id).toBe("k1");
    expect(seen).toEqual(["/docs/rayfold/uploads"]);
  });
});

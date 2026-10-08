import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { Component, signal } from "@angular/core";
import { RAYFOLD_CLIENT } from "@rayfold/angular";
import { ADA, GRACE, T, approvalsResolvers, docs, documentsResolvers, type ApprovalRow, type DocRow, type NoteRow } from "../testing/documents";
import documentsSchema from "../../../../services/documents/src/documents.rayfold" with { type: "text" };
import approvalsSchema from "../../../../services/approvals/src/main/resources/approvals.rayfold" with { type: "text" };
import { TestService, all, button, inUtc, one, settle, text } from "../testing/rayfold";
import { Approvals } from "./approvals";
import { Documents } from "./documents";

const LIST_SHAPE = "{ items { id name contentType size url version updatedAt folder tags owner { id name } } }";

/** A file input with these files chosen, as a person picking them would leave it. */
function choose(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change"));
}

describe("the documents panel", () => {
  let rows: DocRow[];
  let notes: NoteRow[];
  let approvals: ApprovalRow[];
  let documents: TestService;
  let signoffs: TestService;
  let fixture: ComponentFixture<Documents>;
  let root: HTMLElement;
  let hold: { gate: Promise<void> } | undefined;
  let zone: () => void;
  beforeAll(() => (zone = inUtc()));
  afterAll(() => zone());

  beforeEach(() => {
    rows = docs();
    notes = [];
    approvals = [];
    hold = undefined;
  });

  afterEach(() => {
    fixture?.destroy();
    documents?.close();
    signoffs?.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  async function mount(viewer: unknown = ADA, projectId = "p1"): Promise<void> {
    documents = new TestService(documentsSchema, documentsResolvers(rows, notes, hold), viewer);
    signoffs = new TestService(approvalsSchema, approvalsResolvers(approvals), viewer);
    // a factory, not a value: an override of a component the panel imports is kept from the first spec that made it
    TestBed.overrideComponent(Documents, { set: { providers: [{ provide: RAYFOLD_CLIENT, useFactory: () => documents.client() }] } });
    TestBed.overrideComponent(Approvals, { set: { providers: [{ provide: RAYFOLD_CLIENT, useFactory: () => signoffs.client() }] } });
    // the preview reads the bytes over fetch; here they are the file's name
    vi.stubGlobal("fetch", async (url: string) => new Response(`bytes of ${url}`));
    fixture = TestBed.createComponent(Documents);
    fixture.componentRef.setInput("projectId", projectId);
    root = fixture.nativeElement as HTMLElement;
    await settled();
  }

  const settled = () => settle(fixture, documents, signoffs);

  async function click(el: HTMLElement): Promise<void> {
    el.click();
    await settled();
  }

  function row(id: string): HTMLElement {
    return one(root, `li[data-id="${id}"]`);
  }

  async function submit(form: HTMLFormElement, field: string, value: string): Promise<void> {
    (form.elements.namedItem(field) as HTMLInputElement).value = value;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await settled();
  }

  it("lists the project's files live, filtered by nothing, with the owner's actions on the owner's files only", async () => {
    await mount();
    expect(documents.take()).toEqual([
      { op: "me", args: {}, shape: "{ id }" },
      { op: "documents", args: { projectId: "p1", folder: null, tag: null }, shape: LIST_SHAPE, live: true },
      { op: "folders", args: { projectId: "p1" }, shape: "{ name count }", live: true },
      { op: "documents", args: { projectId: "p1" }, shape: "{ items { tags } }", live: true },
    ]);
    expect(text(one(root, "header .count"))).toBe("2 files");
    expect(all(root, "li .name")).toEqual(["brief.txt", "budget.csv"]);
    expect(text(one(row("d1"), ".sub"))).toBe("120 B · Ada Lovelace · Mar 4, 12:00 PM · Open");
    expect(text(one(row("d2"), ".sub"))).toBe("3 KB · v3 · Grace Hopper · Mar 4, 12:00 PM · Open");
    expect(one<HTMLAnchorElement>(row("d1"), ".sub a").getAttribute("href")).toBe("/api/documents/files/r1");
    expect(all(row("d1"), ".glyph")).toEqual(["TXT"]);
    expect(row("d2").querySelector(".glyph")?.getAttribute("data-kind")).toBe("sheet");
    expect(all(row("d1"), ".row-actions > *")).toEqual(["Tags", "File in…", "New version", "Rename", "Share", "Delete"]);
    expect(all(row("d2"), ".row-actions > *")).toEqual(["Tags"]);
    expect(all(row("d1"), ".marks button")).toEqual(["contracts/2026", "legal"]);
    expect(all(row("d2"), ".marks button")).toEqual(["q4", "legal"]);
    expect(all(root, ".folders button")).toEqual(["All", "contracts/2026 1"]);
    expect(all(root, ".tagfilter option")).toEqual(["Any", "legal", "q4"]);
    expect(text(one(root, ".drop .muted"))).toBe("or drop one here");
  });

  it("narrows by folder and by tag, each a new subscription, and says when nothing is left", async () => {
    await mount();
    documents.take();
    await click(button(root, "contracts/2026 1"));
    expect(documents.take()).toEqual([{ op: "documents", args: { projectId: "p1", folder: "contracts/2026", tag: null }, shape: LIST_SHAPE, live: true }]);
    expect(all(root, "li .name")).toEqual(["brief.txt"]);
    // the folder is the page's now, so no row repeats it
    expect(all(row("d1"), ".marks button")).toEqual(["legal"]);
    expect(text(one(root, ".drop .muted"))).toBe("or drop one here to file it in contracts/2026");

    const select = one<HTMLSelectElement>(root, ".tagfilter select");
    select.value = "q4";
    select.dispatchEvent(new Event("change"));
    await settled();
    expect(documents.take()).toEqual([{ op: "documents", args: { projectId: "p1", folder: "contracts/2026", tag: "q4" }, shape: LIST_SHAPE, live: true }]);
    expect(text(one(root, ".list .empty"))).toBe("Nothing here No file is in that folder with that tag. Choose All to see everything.");
    // the picker still offers every tag: it reads the project unfiltered
    expect(all(root, ".tagfilter option")).toEqual(["Any", "legal", "q4"]);

    await click(button(root, "All"));
    expect(all(root, "li .name")).toEqual(["budget.csv"]);
    await click(one(row("d2"), ".marks .tag.on"));
    expect(documents.take().at(-1)).toEqual({ op: "documents", args: { projectId: "p1", folder: null, tag: null }, shape: LIST_SHAPE, live: true });
    expect(all(root, "li .name")).toEqual(["brief.txt", "budget.csv"]);

    await click(one(row("d1"), ".marks .folder"));
    expect(all(root, "li .name")).toEqual(["brief.txt"]);
  });

  it("says a project with no files has none, in the singular for one", async () => {
    rows.splice(0, 2);
    await mount();
    expect(text(one(root, ".list .empty"))).toBe("No files yet Whatever you add here shows up on the project's activity feed.");
    expect(text(one(root, "header .count"))).toBe("0 files");
    expect(root.querySelector(".filters")).toBe(null);
    rows.splice(0, 0, docs()[0]!);
    fixture.destroy();
    TestBed.resetTestingModule();
    await mount();
    expect(text(one(root, "header .count"))).toBe("1 file");
  });

  it("sends nothing about a project until it has one", async () => {
    documents = new TestService(documentsSchema, documentsResolvers(rows, notes), ADA);
    signoffs = new TestService(approvalsSchema, approvalsResolvers(approvals), ADA);
    TestBed.overrideComponent(Documents, { set: { providers: [{ provide: RAYFOLD_CLIENT, useFactory: () => documents.client() }] } });
    fixture = TestBed.createComponent(Documents);
    await settle(fixture, documents);
    expect(documents.take()).toEqual([{ op: "me", args: {}, shape: "{ id }" }]);
  });

  it("uploads a chosen file's bytes on their own and names them in a command; the list hears it", async () => {
    await mount();
    documents.take();
    choose(one(root, ".picker input"), new File(["hey"], "hello.txt", { type: "text/plain" }));
    await settled();
    expect(documents.uploads).toEqual([{ id: "up1", text: "hey", name: "hello.txt", type: "text/plain" }]);
    expect(documents.take().filter((s) => !s.live)).toEqual([{ op: "createDocument", args: { upload: "up1", name: "hello.txt", projectId: "p1" } }]);
    expect(all(root, "li .name")).toEqual(["hello.txt", "brief.txt", "budget.csv"]);
    expect(text(one(root, "header .count"))).toBe("3 files");
  });

  it("files a file dropped while a folder is open in that folder, on the version it was created at", async () => {
    await mount();
    await click(button(root, "contracts/2026 1"));
    const drop = one(root, ".drop");
    drop.dispatchEvent(new Event("dragover", { cancelable: true }));
    await settled();
    expect(drop.classList.contains("over")).toBe(true);
    documents.take();
    const event = new Event("drop", { cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files: [new File(["x"], "dropped.md")] } });
    drop.dispatchEvent(event);
    await settled();
    expect(event.defaultPrevented).toBe(true);
    expect(drop.classList.contains("over")).toBe(false);
    expect(documents.take().filter((s) => !s.live)).toEqual([
      { op: "createDocument", args: { upload: "up1", name: "dropped.md", projectId: "p1" } },
      { op: "moveDocument", args: { id: "new1", folder: "contracts/2026" }, ifVersion: 1 },
    ]);
    expect(all(root, "li .name")).toEqual(["dropped.md", "brief.txt"]);

    drop.dispatchEvent(new Event("dragover", { cancelable: true }));
    drop.dispatchEvent(new Event("dragleave"));
    await settled();
    expect(drop.classList.contains("over")).toBe(false);
  });

  it("says what it is doing while a command runs, and holds every action until it is done", async () => {
    let open!: () => void;
    hold = { gate: new Promise<void>((resolve) => (open = resolve)) };
    await mount();
    choose(one(root, ".picker input"), new File(["hey"], "slow.txt"));
    await settle(fixture);
    fixture.detectChanges();
    expect(text(one(root, "header .pill"))).toBe("uploading");
    expect([...row("d1").querySelectorAll<HTMLButtonElement>(".row-actions button")].map((b) => b.disabled)).toEqual([true, true, true, true, true]);
    open();
    await settled();
    expect(root.querySelector("header .pill")).toBe(null);
    expect([...row("d1").querySelectorAll<HTMLButtonElement>(".row-actions button")].map((b) => b.disabled)).toEqual([false, false, false, false, false]);
  });

  it("keeps a new version on the version on screen, and clears the picker for the next", async () => {
    await mount();
    documents.take();
    const input = one<HTMLInputElement>(row("d1"), ".row-actions input[type=file]");
    // a file input's value cannot be set from a script, so what the panel writes to it is recorded instead
    const written: string[] = [];
    Object.defineProperty(input, "value", { set: (v: string) => void written.push(v), get: () => "C:\fakepath\brief.txt", configurable: true });
    choose(input, new File(["v2"], "brief.txt"));
    await settled();
    expect(documents.take().filter((s) => !s.live)).toEqual([{ op: "replaceContent", args: { id: "d1", upload: "up1" }, ifVersion: 1 }]);
    expect(written).toEqual([""]);
    expect(text(one(row("d1"), ".sub"))).toBe("120 B · v2 · Ada Lovelace · Mar 4, 12:00 PM · Open");
  });

  it("renames in place with the version it read, and sends nothing for no change", async () => {
    await mount();
    documents.take();
    await click(button(row("d1"), "Rename"));
    expect(one<HTMLInputElement>(row("d1"), "form input").value).toBe("brief.txt");
    await submit(one(row("d1"), "form"), "name", "  brief.txt ");
    expect(row("d1").querySelector("form")).toBe(null);
    expect(documents.take()).toEqual([]);

    await click(button(row("d1"), "Rename"));
    await submit(one(row("d1"), "form"), "name", "   ");
    expect(documents.take()).toEqual([]);

    await click(button(row("d1"), "Rename"));
    await submit(one(row("d1"), "form"), "name", " Brief v2.txt ");
    expect(documents.take().filter((s) => !s.live)).toEqual([{ op: "updateDocument", args: { id: "d1", changes: { name: "Brief v2.txt" } }, ifVersion: 1 }]);
    expect(all(root, "li .name")).toEqual(["Brief v2.txt", "budget.csv"]);

    await click(button(row("d1"), "Rename"));
    await click(button(row("d1"), "Cancel"));
    expect(row("d1").querySelector("form")).toBe(null);
  });

  it("files in a folder, or at the root when the folder is emptied, and not at all when it is unchanged", async () => {
    await mount();
    documents.take();
    await click(button(row("d1"), "File in…"));
    expect(one<HTMLInputElement>(row("d1"), "form input").value).toBe("contracts/2026");
    expect([...row("d1").querySelectorAll("datalist option")].map((o) => o.getAttribute("value"))).toEqual(["contracts/2026"]);
    await submit(one(row("d1"), "form"), "folder", " contracts/2026 ");
    expect(documents.take()).toEqual([]);

    await click(button(row("d1"), "File in…"));
    await submit(one(row("d1"), "form"), "folder", "   ");
    expect(documents.take().filter((s) => !s.live)).toEqual([{ op: "moveDocument", args: { id: "d1", folder: null }, ifVersion: 1 }]);
    expect(all(root, ".folders button")).toEqual(["All"]);

    await click(button(row("d1"), "File in…"));
    await submit(one(row("d1"), "form"), "folder", "hr");
    expect(documents.take().filter((s) => !s.live)).toEqual([{ op: "moveDocument", args: { id: "d1", folder: "hr" }, ifVersion: 2 }]);
    expect(all(root, ".folders button")).toEqual(["All", "hr 1"]);
  });

  it("tags anyone's file, splitting on commas and spaces", async () => {
    await mount();
    documents.take();
    await click(button(row("d2"), "Tags"));
    expect(one<HTMLInputElement>(row("d2"), "form input").value).toBe("q4, legal");
    await submit(one(row("d2"), "form"), "tags", " q4,, budget  final ");
    expect(documents.take().filter((s) => !s.live)).toEqual([{ op: "tagDocument", args: { id: "d2", tags: ["q4", "budget", "final"] }, ifVersion: 3 }]);
    expect(all(row("d2"), ".marks button")).toEqual(["q4", "budget", "final"]);
  });

  it("asks once before deleting, forgets the question after four seconds, and deletes on the second click", async () => {
    await mount();
    documents.take();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    button(row("d1"), "Delete").click();
    fixture.detectChanges();
    expect(button(row("d1"), "Really delete").disabled).toBe(false);
    vi.advanceTimersByTime(3999);
    fixture.detectChanges();
    expect(all(row("d1"), ".danger")).toEqual(["Really delete"]);
    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(all(row("d1"), ".danger")).toEqual(["Delete"]);
    vi.useRealTimers();
    expect(documents.take()).toEqual([]);

    await click(button(row("d1"), "Delete"));
    await click(button(row("d1"), "Really delete"));
    expect(documents.take().filter((s) => !s.live)).toEqual([{ op: "deleteDocument", args: { id: "d1" } }]);
    expect(all(root, "li .name")).toEqual(["budget.csv"]);
  });

  it("copies a share link to the clipboard and says so for a moment", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (s: string) => void copied.push(s) }, configurable: true });
    await mount();
    documents.take();
    await click(button(row("d1"), "Share"));
    expect(documents.take()).toEqual([{ op: "shareDocument", args: { id: "d1" }, shape: "{ token }" }]);
    expect(copied).toEqual([`${location.origin}${location.pathname}?share=rfcap1.tok%2Fen`]);
    expect(all(row("d1"), ".row-actions button")[3]).toBe("Link copied");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // the clock starts now; the 2.2 s were set on the real one, so set them again on this one
    await click(button(row("d1"), "Link copied"));
    vi.advanceTimersByTime(2199);
    fixture.detectChanges();
    expect(all(row("d1"), ".row-actions button")[3]).toBe("Link copied");
    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(all(row("d1"), ".row-actions button")[3]).toBe("Share");
  });

  it("shows the share link to copy by hand when the clipboard refuses it", async () => {
    await mount();
    await click(button(row("d1"), "Share"));
    expect(one<HTMLInputElement>(row("d1"), ".sharelink input").value).toBe(`${location.origin}${location.pathname}?share=rfcap1.tok%2Fen`);
    expect(all(row("d1"), ".row-actions button")[3]).toBe("Share");
    await click(button(row("d1"), "Done"));
    expect(row("d1").querySelector(".sharelink")).toBe(null);
  });

  it("opens a file kept elsewhere at its own address, and knows a table by its type or a kilobyte by its size", async () => {
    rows.push(
      { ...docs()[0]!, id: "d3", name: "data", contentType: "text/csv", size: 1024, url: "https://cdn.example/d3", folder: null, tags: [] },
      { ...docs()[0]!, id: "d4", name: "notes", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 3 * 1024 * 1024, folder: null, tags: [] },
      { ...docs()[0]!, id: "d5", name: "photo.PNG", contentType: "image/png", size: 1023, folder: null, tags: [] },
      { ...docs()[0]!, id: "d6", name: "blob", contentType: "application/octet-stream", size: 1, folder: null, tags: [] },
    );
    await mount();
    expect(one<HTMLAnchorElement>(row("d3"), ".sub a").getAttribute("href")).toBe("https://cdn.example/d3");
    expect(["d3", "d4", "d5", "d6"].map((id) => [row(id).querySelector(".glyph")?.getAttribute("data-kind"), text(row(id).querySelector(".glyph")), text(row(id).querySelector(".sub")).split(" · ")[0]])).toEqual([
      ["sheet", "FILE", "1 KB"],
      ["text", "FILE", "3.0 MB"],
      ["image", "PNG", "1023 B"],
      ["other", "FILE", "1 B"],
    ]);
  });

  it("asks again before a second delete when the first was refused", async () => {
    await mount();
    rows[0]!.ownerId = "u2";
    await click(button(row("d1"), "Delete"));
    await click(button(row("d1"), "Really delete"));
    expect(text(one(root, "p.bad[role=alert]"))).toBe("brief.txt is not yours");
    expect(all(row("d1"), ".danger")).toEqual(["Delete"]);
  });

  it("tells a refused command as itself, and clears it on the next", async () => {
    await mount();
    rows[0]!.version = 7;
    await click(button(row("d1"), "Rename"));
    await submit(one(row("d1"), "form"), "name", "x.txt");
    expect(text(one(root, "p.bad[role=alert]"))).toBe("Document:d1 is at version 7, not 1");
    expect(root.querySelector("header .pill")).toBe(null);

    await click(button(row("d2"), "Tags"));
    await submit(one(row("d2"), "form"), "tags", "a");
    expect(all(row("d2"), ".marks button")).toEqual(["a"]);
    expect(root.querySelector("p.bad[role=alert]")).toBe(null);
  });

  it("says the list could not be loaded, and why, rather than that there are no files", async () => {
    await mount({ documentId: "d1" });
    expect(text(one(root, "header .pill.bad"))).toBe("disconnected");
    expect(text(one(root, ".list .empty"))).toBe("Your files could not be loaded Not allowed to access Document at items.1");
  });

  it("opens a file into its preview, notes, sign-offs and revisions, one at a time", async () => {
    await mount();
    await click(button(row("d1"), "brief.txt"));
    expect(one(row("d1"), "button.name").getAttribute("aria-expanded")).toBe("true");
    expect(all(row("d1"), ".tabs button")).toEqual(["Preview", "Notes", "Sign-offs", "Revisions 1"]);
    expect(text(one(row("d1"), "documents-preview pre"))).toBe("bytes of /api/documents/files/r1");

    documents.take();
    await click(button(row("d1"), "Notes"));
    expect(documents.take()).toEqual([{ op: "notes", args: { documentId: "d1" }, shape: "{ items { id body at by { id name } } }", live: true }]);
    expect(text(one(row("d1"), "documents-notes .none"))).toBe("Nothing said about this file yet.");

    await click(button(row("d1"), "Revisions 1"));
    expect(documents.take()).toEqual([{ op: "revisions", args: { documentId: "d1" }, shape: "{ items { id version size url at by { name } } }" }]);
    expect(all(row("d1"), "documents-history li")).toEqual(["v1 Ada Lovelace Mar 4, 12:00 PM 100 B Open"]);

    await click(button(row("d1"), "Sign-offs"));
    expect(signoffs.take().map((s) => s.op)).toEqual(["members", "approvals"]);
    expect(text(one(row("d1"), "documents-approvals .none"))).toBe("Nobody has been asked to sign this off.");
    expect(text(one(row("d1"), "documents-approvals form button"))).toBe("Ask for sign-off on v1");

    // another file opens in its own preview, not the last tab
    await click(button(row("d2"), "budget.csv"));
    expect(row("d1").querySelector(".tabs")).toBe(null);
    expect(one(row("d2"), ".tabs button.on").textContent).toBe("Preview");
    // sign-offs are asked by the owner alone
    await click(button(row("d2"), "Sign-offs"));
    expect(row("d2").querySelector("documents-approvals form")).toBe(null);

    await click(button(row("d2"), "budget.csv"));
    expect(row("d2").querySelector(".tabs")).toBe(null);
    expect(one(row("d2"), "button.name").getAttribute("aria-expanded")).toBe("false");
  });
});

@Component({
  imports: [Approvals],
  template: `<documents-approvals documentId="d1" projectId="p1" documentName="brief.txt" [version]="2" [meId]="me()" [canAsk]="canAsk()" />`,
})
class ApprovalsHost {
  readonly me = signal<string | null>("u1");
  readonly canAsk = signal(true);
}

describe("a file's sign-offs", () => {
  let rows: ApprovalRow[];
  let service: TestService;
  let fixture: ComponentFixture<ApprovalsHost>;
  let root: HTMLElement;

  const row = (over: Partial<ApprovalRow>): ApprovalRow => ({
    id: "a1",
    documentId: "d1",
    projectId: "p1",
    documentName: "brief.txt",
    version: 1,
    requesterId: "u1",
    approverId: "u2",
    decision: "pending",
    note: null,
    stale: false,
    askedAt: T,
    decidedAt: null,
    ...over,
  });

  async function mount(viewer: { id: string; name: string } = ADA, stuck?: Promise<never>): Promise<void> {
    service = new TestService(approvalsSchema, approvalsResolvers(rows, stuck), viewer);
    TestBed.overrideComponent(Approvals, { set: { providers: [{ provide: RAYFOLD_CLIENT, useFactory: () => service.client() }] } });
    fixture = TestBed.createComponent(ApprovalsHost);
    fixture.componentInstance.me.set(viewer.id);
    root = fixture.nativeElement as HTMLElement;
    if (!stuck) await settle(fixture, service);
  }

  let zone: () => void;
  beforeAll(() => (zone = inUtc()));
  afterAll(() => zone());
  beforeEach(() => {
    rows = [];
  });
  afterEach(() => {
    fixture?.destroy();
    service?.close();
    vi.useRealTimers();
  });

  it("lists who asked whom about which version, with what they said and whether it is out of date", async () => {
    rows.push(
      row({ id: "a1", version: 1, stale: true }),
      row({ id: "a2", version: 2, approverId: "u3", decision: "approved", note: "Fine by me", decidedAt: T }),
      row({ id: "a3", version: 1, decision: "declined", stale: true }),
    );
    await mount();
    expect(service.take()).toEqual([
      { op: "members", args: {}, shape: "{ id name }" },
      { op: "approvals", args: { documentId: "d1" }, shape: "{ id version decision note stale askedAt decidedAt requester { id name } approver { id name } }", live: true },
    ]);
    expect(all(root, "li .state")).toEqual(["Waiting", "Approved", "Declined"]);
    expect(all(root, "li .who")).toEqual([
      "Ada Lovelace asked Grace Hopper · version 1 · Mar 4, 12:00 PM",
      "Ada Lovelace asked Noor Haddad · version 2 · Mar 4, 12:00 PM",
      "Ada Lovelace asked Grace Hopper · version 1 · Mar 4, 12:00 PM",
    ]);
    // only a pending one is stale: a decided one was decided with its version in view
    expect(all(root, "li .stale")).toEqual(["A newer version has been kept since; this asks about version 1."]);
    expect(all(root, "li .note")).toEqual(["“Fine by me”"]);
    expect([...root.querySelectorAll("li")].map((l) => l.getAttribute("data-decision"))).toEqual(["pending", "approved", "declined"]);
    // the one who asked may take back only what is still pending
    expect(all(root, "li .acts")).toEqual(["Withdraw", "", ""]);
  });

  it("lets the person asked approve or decline, and the one who asked withdraw; nobody else", async () => {
    rows.push(row({ id: "a1", requesterId: "u1", approverId: "u2" }), row({ id: "a2", requesterId: "u3", approverId: "u2" }), row({ id: "a3", requesterId: "u3", approverId: "u1" }));
    await mount(GRACE);
    expect(all(root, "li .acts")).toEqual(["Approve Decline", "Approve Decline", ""]);
    service.take();
    await click(root.querySelectorAll<HTMLButtonElement>("li .acts .primary")[0]!);
    expect(service.take().filter((s) => !s.live)).toEqual([{ op: "decide", args: { id: "a1", decision: "approved", note: null } }]);
    expect(all(root, "li .state")[0]).toBe("Approved");
    await click(button(root.querySelectorAll("li")[1]!, "Decline"));
    expect(service.take().filter((s) => !s.live)).toEqual([{ op: "decide", args: { id: "a2", decision: "declined", note: null } }]);
    expect(all(root, "li .acts")).toEqual(["", "", ""]);

    fixture.destroy();
    service.close();
    TestBed.resetTestingModule();
    rows.splice(0, rows.length, row({ id: "a1", requesterId: "u1", approverId: "u2" }), row({ id: "a3", requesterId: "u3", approverId: "u1" }));
    await mount(ADA);
    expect(all(root, "li .acts")).toEqual(["Withdraw", "Approve Decline"]);
    await click(button(root, "Withdraw"));
    expect(service.take().filter((s) => !s.live).at(-1)).toEqual({ op: "withdraw", args: { id: "a1" } });
    expect(all(root, "li .state")[0]).toBe("Withdrawn");
  });

  it("asks anyone but the person looking, about the version on screen, and lists it as it is asked", async () => {
    await mount();
    expect(all(root, "select option")).toEqual(["Grace Hopper", "Noor Haddad"]);
    const select = one<HTMLSelectElement>(root, "select");
    select.value = "u3";
    service.take();
    one<HTMLFormElement>(root, "form.ask").dispatchEvent(new Event("submit", { cancelable: true }));
    await settle(fixture, service);
    expect(service.take().filter((s) => !s.live)).toEqual([
      { op: "requestApproval", args: { documentId: "d1", projectId: "p1", documentName: "brief.txt", version: 2, approverId: "u3" } },
    ]);
    expect(all(root, "li .who")).toEqual(["Ada Lovelace asked Noor Haddad · version 2 · Mar 4, 12:00 PM"]);
  });

  it("shows a refusal and offers no form to anyone who may not ask", async () => {
    await mount();
    fixture.componentInstance.me.set("u9");
    await settle(fixture, service);
    expect(all(root, "select option")).toEqual(["Ada Lovelace", "Grace Hopper", "Noor Haddad"]);
    one<HTMLSelectElement>(root, "select").value = "u1";
    one<HTMLFormElement>(root, "form.ask").dispatchEvent(new Event("submit", { cancelable: true }));
    await settle(fixture, service);
    expect(text(one(root, "p.bad[role=alert]"))).toBe("You cannot ask yourself");

    fixture.componentInstance.canAsk.set(false);
    await settle(fixture, service);
    expect(root.querySelector("form.ask")).toBe(null);
  });

  it("says the service is not answering after four seconds of waiting, and not before", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await mount(ADA, new Promise<never>(() => {}));
    fixture.detectChanges();
    expect(root.querySelector(".skeleton")).not.toBe(null);
    vi.advanceTimersByTime(3999);
    fixture.detectChanges();
    expect(root.querySelector("[role=status]")).toBe(null);
    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(text(one(root, "[role=status]"))).toBe("The sign-offs service is not answering. It is retrying on its own; the rest of the file works without it.");
  });

  async function click(el: HTMLElement): Promise<void> {
    el.click();
    await settle(fixture, service);
  }
});

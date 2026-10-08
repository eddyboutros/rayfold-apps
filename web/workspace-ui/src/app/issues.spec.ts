import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { RAYFOLD_CLIENT } from "@rayfold/angular";
import type { RayfoldClient } from "@rayfold/client";
import workspaceSchema from "../../../../services/workspace/src/workspace.rayfold" with { type: "text" };
import documentsSchema from "../../../../services/documents/src/documents.rayfold" with { type: "text" };
import { RayfoldError } from "@rayfold/server/core";
import { TestService, all, button, inUtc, one, settle, text } from "../testing/rayfold";
import { FakeWebSocket, mounted } from "../testing/socket";
import { ADA, GRACE, T, emptyDb, issue, workspaceResolvers, type Db } from "../testing/workspace";

const SHAPE = "{ items { id title state version updatedAt priority labels dueOn description assignee { id name } attachments { id documentId name url } } }";

// the page's own clients are built as their modules load, over the WebSocket there is then
const RealSocket = globalThis.WebSocket;
let Issues: typeof import("./issues").Issues;
let zone: () => void;
beforeAll(async () => {
  zone = inUtc();
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  ({ Issues } = await import("./issues"));
});
afterAll(() => {
  globalThis.WebSocket = RealSocket;
  zone();
});

/** Every client the page holds, so a spec can empty their caches and not hand its answers to the next. */
function clientsOf(fixture: ComponentFixture<unknown>): Set<RayfoldClient> {
  const found = new Set<RayfoldClient>();
  for (const de of [fixture.debugElement, ...fixture.debugElement.queryAll(By.css("*"))]) {
    const c = de.injector.get(RAYFOLD_CLIENT, null);
    if (c) found.add(c);
  }
  return found;
}

describe("a project's issues", () => {
  let db: Db;
  let workspace: TestService;
  let documents: TestService;
  let fixture: ComponentFixture<InstanceType<typeof Issues>>;
  let root: HTMLElement;
  let clients: Set<RayfoldClient>;

  async function mount(viewer: unknown = ADA): Promise<void> {
    workspace = new TestService(workspaceSchema, workspaceResolvers(db), viewer);
    documents = new TestService(
      documentsSchema,
      {
        Query: {
          documents: ({ projectId }: { projectId: string }) => {
            if (projectId === "down") throw new RayfoldError("unavailable", "documents is down");
            const items = [
              { id: "d1", name: "brief.txt", url: "/files/r1" },
              { id: "d2", name: "budget.csv", url: "https://cdn.example/r2" },
            ];
            return { items, total: items.length, hasMore: false, cursor: null };
          },
        },
      },
      viewer,
    );
    mounted.set("/api/workspace", workspace);
    mounted.set("/api/documents", documents);
    fixture = TestBed.createComponent(Issues);
    fixture.componentRef.setInput("projectId", "p1");
    root = fixture.nativeElement as HTMLElement;
    clients = clientsOf(fixture);
    await settled();
  }

  const settled = () => settle(fixture, workspace, documents);

  async function click(el: HTMLElement): Promise<void> {
    el.click();
    await settled();
  }

  async function choose(select: HTMLSelectElement, value: string): Promise<void> {
    select.value = value;
    select.dispatchEvent(new Event("change"));
    await settled();
  }

  async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
    el.value = value;
    el.dispatchEvent(new Event("input"));
    await settled();
  }

  const row = (title: string): HTMLElement => {
    const found = [...root.querySelectorAll<HTMLElement>("li")].filter((li) => text(li.querySelector(".title .text")) === title);
    if (found.length !== 1) throw new Error(`expected one issue "${title}", found ${found.length}`);
    return found[0]!;
  };

  beforeEach(() => {
    db = emptyDb();
    db.issues.push(
      issue("i1", "Write the plan", { priority: "low", labels: ["ops"] }),
      issue("i6", "Sign the lease", { priority: "high" }),
      issue("i2", "Book the venue", { priority: "urgent", assigneeId: "u2", labels: ["wave-2", "ops"] }),
      issue("i3", "Order kit", { state: "doing", assigneeId: "u1", version: 4 }),
      issue("i4", "Ship it", { state: "done" }),
      issue("i5", "Elsewhere", { projectId: "p2" }),
    );
  });

  afterEach(() => {
    fixture?.destroy();
    for (const c of clients ?? []) c.cache.clear();
    FakeWebSocket.closeAll();
    workspace?.close();
    documents?.close();
    mounted.clear();
  });

  it("opens one socket to the workspace on the page's origin and lists the project's issues by state, most pressing first", async () => {
    await mount();
    expect(FakeWebSocket.opened.at(-1)).toEqual({ url: `ws://${location.host}/api/workspace/rayfold/ws`, protocols: ["rayfold.0.1"] });
    expect(workspace.take()).toEqual([
      { op: "members", args: {}, shape: "{ id name }" },
      { op: "issues", args: { projectId: "p1", assigneeId: null, label: null }, shape: SHAPE, live: true },
      { op: "issues", args: { projectId: "p1" }, shape: "{ items { labels } }", live: true },
    ]);
    expect(text(one(root, "header .count"))).toBe("4 open");
    expect(all(root, ".group")).toEqual(["Open 3", "In progress 1", "Done 1"]);
    expect(all(root, "li .title .text")).toEqual(["Book the venue", "Sign the lease", "Write the plan", "Order kit", "Ship it"]);
    expect([...root.querySelectorAll("li .priority")].map((p) => p.getAttribute("data-priority"))).toEqual(["urgent", "high", "low", "normal", "normal"]);
    expect(row("Ship it").classList.contains("done")).toBe(true);
    expect(all(row("Book the venue"), ".tag")).toEqual(["wave-2", "ops"]);
    expect(all(row("Book the venue"), ".assignee .name")).toEqual(["Grace"]);
    expect(all(row("Book the venue"), ".assignee .avatar")).toEqual(["GH"]);
    expect(all(row("Write the plan"), ".assignee .avatar")).toEqual(["+"]);
    expect(row("Write the plan").querySelector(".assignee")?.classList.contains("nobody")).toBe(true);
    expect(all(row("Write the plan"), ".assignee .name")).toEqual(["Assign"]);
    expect(all(row("Write the plan"), ".assignee option")).toEqual(["Nobody", "Ada Lovelace", "Grace Hopper", "Noor Haddad"]);
    expect(all(root, ".filters select")[1]).toBe("Any ops wave-2");
  });

  it("moves an issue one step either way, never a jump, on the version it read", async () => {
    await mount();
    expect(all(row("Write the plan"), ".moves button")).toEqual(["In progress"]);
    expect(all(row("Order kit"), ".moves button")).toEqual(["Done", "Open"]);
    expect(all(row("Ship it"), ".moves button")).toEqual(["In progress"]);
    workspace.take();
    await click(button(row("Order kit"), "Done"));
    expect(workspace.take().filter((s) => !s.live)).toEqual([{ op: "moveIssue", args: { id: "i3", to: "done" }, ifVersion: 4 }]);
    expect(all(root, ".group")).toEqual(["Open 3", "Done 2"]);
    expect(text(one(root, "header .count"))).toBe("3 open");
  });

  it("hands an issue to someone, or to nobody", async () => {
    await mount();
    workspace.take();
    await choose(one(row("Write the plan"), ".assignee select"), "u3");
    expect(workspace.take().filter((s) => !s.live)).toEqual([{ op: "assignIssue", args: { id: "i1", assigneeId: "u3" }, ifVersion: 1 }]);
    expect(all(row("Write the plan"), ".assignee .name")).toEqual(["Noor"]);
    expect(row("Write the plan").querySelector(".assignee")?.getAttribute("title")).toBe("Assigned to Noor Haddad");
    await choose(one(row("Write the plan"), ".assignee select"), "");
    expect(workspace.take().filter((s) => !s.live)).toEqual([{ op: "assignIssue", args: { id: "i1", assigneeId: null }, ifVersion: 2 }]);
    expect(all(row("Write the plan"), ".assignee .name")).toEqual(["Assign"]);
  });

  it("is told when someone else moved the issue first, and may try again", async () => {
    await mount();
    db.issues.find((i) => i.id === "i3")!.version = 9;
    await click(button(row("Order kit"), "Done"));
    expect(text(one(root, "p.bad[role=alert]"))).toBe("Issue:i3 is at version 9, not 4");
    expect(db.issues.find((i) => i.id === "i3")!.state).toBe("doing");
    // the controls are free again for the next try
    expect(button(row("Order kit"), "Done").disabled).toBe(false);
  });

  it("adds an issue by its trimmed title, empties the box, and the list hears it", async () => {
    await mount();
    const add = button(root, "Add");
    expect(add.disabled).toBe(true);
    await type(one(root, ".compose input"), "   ");
    expect(add.disabled).toBe(true);
    await type(one(root, ".compose input"), "  Print badges ");
    workspace.take();
    one<HTMLFormElement>(root, "form.compose").dispatchEvent(new Event("submit", { cancelable: true }));
    await settled();
    expect(workspace.take().filter((s) => !s.live)).toEqual([{ op: "createIssue", args: { projectId: "p1", title: "Print badges" } }]);
    expect(one<HTMLInputElement>(root, ".compose input").value).toBe("");
    expect(all(root, "li .title .text")).toEqual(["Book the venue", "Sign the lease", "Print badges", "Write the plan", "Order kit", "Ship it"]);
  });

  it("keeps the title and says why when the issue is refused", async () => {
    await mount();
    await type(one(root, ".compose input"), "fail");
    one<HTMLFormElement>(root, "form.compose").dispatchEvent(new Event("submit", { cancelable: true }));
    await settled();
    expect(text(one(root, "p.bad[role=alert]"))).toBe("That title is not allowed");
    expect(one<HTMLInputElement>(root, ".compose input").value).toBe("fail");
  });

  it("narrows by holder and by label, each a new subscription, and clears both at once", async () => {
    await mount();
    workspace.take();
    const [holder, label] = [...root.querySelectorAll<HTMLSelectElement>(".filters select")];
    await choose(holder!, "u2");
    expect(workspace.take()).toEqual([{ op: "issues", args: { projectId: "p1", assigneeId: "u2", label: null }, shape: SHAPE, live: true }]);
    expect(all(root, "li .title .text")).toEqual(["Book the venue"]);
    await choose(label!, "ops");
    expect(workspace.take()).toEqual([{ op: "issues", args: { projectId: "p1", assigneeId: "u2", label: "ops" }, shape: SHAPE, live: true }]);
    expect(all(root, "li .title .text")).toEqual(["Book the venue"]);
    await choose(holder!, "u3");
    expect(text(one(root, ".list .empty"))).toBe("Nothing matches No issue has that holder and label. Clear the filters to see them all.");
    // the label picker still offers every label: it reads the project unfiltered
    expect(all(root, ".filters select")[1]).toBe("Any ops wave-2");

    await click(button(root, "Clear"));
    expect(workspace.take().at(-1)).toEqual({ op: "issues", args: { projectId: "p1", assigneeId: null, label: null }, shape: SHAPE, live: true });
    expect(root.querySelectorAll("li .title").length).toBe(5);
    expect(root.querySelector(".filters .clear")).toBe(null);
  });

  it("says a project with no issues has nothing to do yet", async () => {
    db.issues.splice(0);
    await mount();
    expect(text(one(root, ".list .empty"))).toBe("Nothing to do yet Add the first issue above.");
    expect(text(one(root, "header .count"))).toBe("0 open");
  });

  it("marks a day that has passed as overdue and one within three days as soon, but never on a done issue", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-04T09:00:00.000Z") });
    try {
      db.issues.splice(0);
      db.issues.push(
        issue("d", "Later", { dueOn: "2026-03-08" }),
        issue("c", "Soon", { dueOn: "2026-03-07" }),
        issue("b", "Today", { dueOn: "2026-03-04" }),
        issue("a", "Late", { dueOn: "2026-03-03" }),
        issue("e", "Done late", { state: "done", dueOn: "2026-03-01" }),
      );
      await mount();
      const due = (t: string) => one(row(t), ".due");
      expect(["Late", "Today", "Soon", "Later", "Done late"].map((t) => [text(due(t)), due(t).className])).toEqual([
        ["overdue Mar 3", "due late"],
        ["due Mar 4", "due soon"],
        ["due Mar 7", "due soon"],
        ["due Mar 8", "due"],
        ["due Mar 1", "due"],
      ]);
      // the nearest day first within a priority
      expect(all(root, "li .title .text")).toEqual(["Late", "Today", "Soon", "Later", "Done late"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens an issue to change only the fields touched, on the version read", async () => {
    await mount();
    await click(one(row("Write the plan"), "button.title"));
    expect(one(row("Write the plan"), "button.title").getAttribute("aria-expanded")).toBe("true");
    const form = one<HTMLFormElement>(row("Write the plan"), "form.fields");
    const save = button(form, "Save changes");
    expect(save.disabled).toBe(true);
    expect(text(one(form, ".version"))).toBe("v1");
    expect(form.querySelector(".actions .quiet")).toBe(null);

    await choose(form.querySelector<HTMLSelectElement>("select[name=priority]")!, "high");
    await type(form.querySelector<HTMLInputElement>("input[name=labels]")!, " ops,, venue  wave-3 ");
    expect(save.disabled).toBe(false);
    workspace.take();
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await settled();
    expect(workspace.take().filter((s) => !s.live)).toEqual([{ op: "updateIssue", args: { id: "i1", changes: { priority: "high", labels: ["ops", "venue", "wave-3"] } }, ifVersion: 1 }]);
    expect(text(one(row("Write the plan"), ".version"))).toBe("v2");
    expect(button(row("Write the plan"), "Save changes").disabled).toBe(true);
    expect(all(row("Write the plan"), ".tag")).toEqual(["ops", "venue", "wave-3"]);

    const due = one<HTMLInputElement>(row("Write the plan"), "input[name=dueOn]");
    due.value = "2026-04-01";
    due.dispatchEvent(new Event("change"));
    await type(one(row("Write the plan"), "textarea"), "");
    workspace.take();
    one<HTMLFormElement>(row("Write the plan"), "form.fields").dispatchEvent(new Event("submit", { cancelable: true }));
    await settled();
    expect(workspace.take().filter((s) => !s.live)).toEqual([{ op: "updateIssue", args: { id: "i1", changes: { dueOn: "2026-04-01", description: null } }, ifVersion: 2 }]);
  });

  it("discards what was touched, and forgets it when the issue is closed", async () => {
    await mount();
    await click(one(row("Write the plan"), "button.title"));
    await type(one(row("Write the plan"), "textarea"), "Half a thought");
    await click(button(row("Write the plan"), "Discard"));
    expect(one<HTMLTextAreaElement>(row("Write the plan"), "textarea").value).toBe("");
    expect(button(row("Write the plan"), "Save changes").disabled).toBe(true);

    await type(one(row("Write the plan"), "textarea"), "Another");
    await click(one(row("Write the plan"), "button.title"));
    expect(row("Write the plan").querySelector(".detail")).toBe(null);
    await click(one(row("Write the plan"), "button.title"));
    expect(button(row("Write the plan"), "Save changes").disabled).toBe(true);
    workspace.take();
    one<HTMLFormElement>(row("Write the plan"), "form.fields").dispatchEvent(new Event("submit", { cancelable: true }));
    await settled();
    expect(workspace.take().filter((s) => !s.live)).toEqual([]);
  });

  it("pins one of the project's documents to an issue, from the documents service, and takes it off again", async () => {
    db.pins.push({ id: "pin0", issueId: "i1", documentId: "d2", name: "budget.csv", url: "https://cdn.example/r2", at: T, byId: "u2" });
    await mount();
    await click(one(row("Write the plan"), "button.title"));
    const pins = () => one(row("Write the plan"), ".pins");
    expect([...pins().querySelectorAll("li a")].map((a) => [text(a), a.getAttribute("href")])).toEqual([["budget.csv", "https://cdn.example/r2"]]);

    await click(button(pins(), "Attach a document"));
    expect(FakeWebSocket.opened.at(-1)).toEqual({ url: `ws://${location.host}/api/documents/rayfold/ws`, protocols: ["rayfold.0.1"] });
    expect(documents.take()).toEqual([{ op: "documents", args: { projectId: "p1" }, shape: "{ items { id name url } }" }]);
    // what is pinned already is not offered again
    expect(all(pins(), "select option")).toEqual(["Choose a document", "brief.txt"]);
    // choosing the prompt itself attaches nothing and keeps the picker open
    workspace.take();
    await choose(one(pins(), "select"), "");
    expect(workspace.take().filter((s) => !s.live)).toEqual([]);
    expect(pins().querySelector("select")).not.toBe(null);

    workspace.take();
    await choose(one(pins(), "select"), "d1");
    expect(workspace.take().filter((s) => !s.live)).toEqual([{ op: "attachDocument", args: { issueId: "i1", documentId: "d1", name: "brief.txt", url: "/files/r1" } }]);
    expect([...pins().querySelectorAll("li a")].map((a) => [text(a), a.getAttribute("href")])).toEqual([
      ["budget.csv", "https://cdn.example/r2"],
      ["brief.txt", "/api/documents/files/r1"],
    ]);
    expect(pins().querySelector("select")).toBe(null);

    await click(button(pins(), "Attach a document"));
    expect(all(pins(), "select option")).toEqual(["Every document is already attached"]);
    await click(button(pins(), "Cancel"));
    expect(pins().querySelector("select")).toBe(null);

    await click(one(pins(), "li button[aria-label='Detach budget.csv']"));
    expect(workspace.take().filter((s) => !s.live)).toEqual([{ op: "detachDocument", args: { id: "pin0" } }]);
    expect(all(pins(), "li a")).toEqual(["brief.txt"]);
  });

  it("says nothing is pinned, and says so when the documents service does not answer", async () => {
    await mount();
    fixture.componentRef.setInput("projectId", "down");
    db.issues.push(issue("x", "Down here", { projectId: "down" }));
    await settled();
    await click(one(row("Down here"), "button.title"));
    const pins = () => one(row("Down here"), ".pins");
    expect(text(one(pins(), ".none"))).toBe("Nothing yet.");
    await click(button(pins(), "Attach a document"));
    expect(text(one(pins(), ".bad"))).toBe("The documents service did not answer: documents is down");
    expect(all(pins(), "select option")).toEqual(["Every document is already attached"]);
  });

  it("holds the conversation on an open issue, live, and replies to it", async () => {
    db.comments.push({ id: "c0", issueId: "i1", body: "First!", at: T, byId: "u2" }, { id: "cx", issueId: "i2", body: "Not here", at: T, byId: "u2" });
    await mount();
    workspace.take();
    await click(one(row("Write the plan"), "button.title"));
    expect(workspace.take()).toEqual([{ op: "comments", args: { issueId: "i1" }, shape: "{ items { id body at by { name } } }", live: true }]);
    const thread = () => one(row("Write the plan"), "workspace-thread");
    expect(all(thread(), "li .body")).toEqual(["First!"]);
    expect(all(thread(), "li .meta")).toEqual(["Grace Hopper Mar 4"]);
    expect(all(thread(), "li .avatar")).toEqual(["G"]);

    const post = button(thread(), "Post");
    expect(post.disabled).toBe(true);
    await type(one(thread(), "input"), "  On it ");
    one<HTMLFormElement>(thread(), "form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settled();
    expect(workspace.take().filter((s) => !s.live)).toEqual([{ op: "addComment", args: { issueId: "i1", body: "On it" } }]);
    expect(one<HTMLInputElement>(thread(), "input").value).toBe("");
    expect(all(thread(), "li .body")).toEqual(["First!", "On it"]);

    await workspace.client(GRACE).command("addComment", { issueId: "i1", body: "Thanks" });
    await settled();
    expect(all(thread(), "li .body")).toEqual(["First!", "On it", "Thanks"]);

    await type(one(thread(), "input"), "fail");
    one<HTMLFormElement>(thread(), "form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settled();
    expect(text(one(thread(), "p.bad"))).toBe("That issue is gone");
    expect(one<HTMLInputElement>(thread(), "input").value).toBe("fail");

    // closing the issue ends the subscription
    await click(one(row("Write the plan"), "button.title"));
    expect(row("Write the plan").querySelector("workspace-thread")).toBe(null);
  });

  it("says an issue has no comments yet", async () => {
    await mount();
    await click(one(row("Order kit"), "button.title"));
    expect(text(one(row("Order kit"), "workspace-thread .none"))).toBe("No comments yet.");
  });
});

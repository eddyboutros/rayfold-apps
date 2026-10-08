import type { Type } from "@angular/core";
import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { RAYFOLD_CLIENT } from "@rayfold/angular";
import type { RayfoldClient } from "@rayfold/client";
import workspaceSchema from "../../../../services/workspace/src/workspace.rayfold" with { type: "text" };
import { TestService, all, button, inUtc, one, settle, text } from "../testing/rayfold";
import { FakeWebSocket, mounted } from "../testing/socket";
import { ADA, GRACE, NOOR, T, emptyDb, workspaceResolvers, type Db } from "../testing/workspace";

// the page's own clients are built as their modules load, over the WebSocket there is then
const RealSocket = globalThis.WebSocket;
let m: {
  Feed: typeof import("./feed").Feed;
  Chat: typeof import("./chat").Chat;
  Notifications: typeof import("./notifications").Notifications;
  People: typeof import("./people").People;
  ProjectSettings: typeof import("./project-settings").ProjectSettings;
  Quick: typeof import("./quick").Quick;
  client: typeof import("./client");
};
let zone: () => void;
beforeAll(async () => {
  zone = inUtc();
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  m = {
    ...(await import("./feed")),
    ...(await import("./chat")),
    ...(await import("./notifications")),
    ...(await import("./people")),
    ...(await import("./project-settings")),
    ...(await import("./quick")),
    client: await import("./client"),
  };
});
afterAll(() => {
  globalThis.WebSocket = RealSocket;
  zone();
});

let db: Db;
let gate: { failing?: string };
let workspace: TestService;
let fixture: ComponentFixture<unknown>;
let root: HTMLElement;
let clients: RayfoldClient[] = [];

async function mount<C>(type: Type<C>, inputs: Record<string, unknown> = {}, viewer: unknown = ADA): Promise<ComponentFixture<C>> {
  // a second mount in one spec starts from empty caches, as a page opened afresh would
  for (const c of clients.splice(0)) c.cache.clear();
  FakeWebSocket.closeAll();
  workspace = new TestService(workspaceSchema, workspaceResolvers(db, gate), viewer);
  mounted.set("/api/workspace", workspace);
  const f = TestBed.createComponent(type);
  for (const [k, v] of Object.entries(inputs)) f.componentRef.setInput(k, v);
  fixture = f as ComponentFixture<unknown>;
  root = f.nativeElement as HTMLElement;
  for (const de of [f.debugElement, ...f.debugElement.queryAll(By.css("*"))]) {
    const c = de.injector.get(RAYFOLD_CLIENT, null);
    if (c) clients.push(c);
  }
  await settled();
  return f;
}

const settled = () => settle(fixture, workspace);

async function click(el: HTMLElement): Promise<void> {
  el.click();
  await settled();
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  el.value = value;
  el.dispatchEvent(new Event("input"));
  await settled();
}

beforeEach(() => {
  db = emptyDb();
  gate = {};
});

afterEach(() => {
  fixture?.destroy();
  for (const c of clients.splice(0)) c.cache.clear();
  FakeWebSocket.closeAll();
  workspace?.close();
  mounted.clear();
  vi.useRealTimers();
  localStorage.clear();
});

describe("the project's feed", () => {
  const line = (id: string, kind: string, subject: string, detail: string | null = null, by: string | null = "u1", source = "workspace") => ({ id, projectId: "p1", source, kind, subject, detail, at: T, byId: by });

  it("reads each line as who did what to what, with the detail after", async () => {
    db.activity.push(
      line("a1", "issue.assigned", "Book the venue", "Grace Hopper"),
      line("a2", "document.replaced", "brief.txt", "now version 3", "u2", "documents"),
      line("a3", "document.filed", "brief.txt", "contracts/2026", "u2", "documents"),
      line("a4", "comment.added", "Book the venue", "On it"),
      line("a5", "approval.requested", "brief.txt", "Noor Haddad", "u1", "approvals"),
      line("a6", "document.indexed", "plan.pdf", null, null, "catalogue"),
      line("a7", "issue.created", "Order kit"),
      line("a8", "document.noted", "brief.txt", "Looks right", "u3", "documents"),
      line("a9", "something.new", "A thing"),
      line("a10", "document.attached", "Book the venue", "brief.txt"),
      line("a11", "issue.moved", "Order kit", "done"),
      { ...line("x", "issue.created", "Elsewhere"), projectId: "p2" },
    );
    await mount(m.Feed, { projectId: "p1" });
    expect(workspace.take()).toEqual([{ op: "activity", args: { projectId: "p1" }, shape: "{ items { id source kind subject detail at by { id name } } }", live: true }]);
    expect(text(one(root, "header .pill"))).toBe("live");
    expect(all(root, "li .what")).toEqual([
      "Ada Lovelace handed over Book the venue to Grace Hopper",
      "Grace Hopper replaced a file brief.txt now version 3",
      "Grace Hopper filed brief.txt in contracts/2026",
      "Ada Lovelace commented on Book the venue “On it”",
      "Ada Lovelace asked for a sign-off on brief.txt from Noor Haddad",
      "Keel made searchable plan.pdf",
      "Ada Lovelace opened Order kit",
      "Noor Haddad remarked on brief.txt “Looks right”",
      "Ada Lovelace something.new A thing",
      "Ada Lovelace attached a file to Book the venue brief.txt",
      "Ada Lovelace moved Order kit done",
    ]);
    expect(all(root, "li .avatar")).toEqual(["AL", "GH", "GH", "AL", "AL", "K", "AL", "NH", "AL", "AL", "AL"]);
    // a line from another service says which
    expect(all(root, "li .source")).toEqual(["documents", "documents", "approvals", "catalogue", "documents"]);
    expect(root.querySelectorAll("li .more").length).toBe(8);
  });

  it("tells each line by its subject and detail as the service gave them: a colon in either stays where it was", async () => {
    db.activity.push(
      line("b1", "issue.created", "Q3: audit pack"),
      line("b2", "issue.moved", "Q3: audit pack", "open → doing"),
      line("b3", "issue.assigned", "Q3: audit pack", "Grace Hopper"),
      line("b4", "issue.edited", "Q3: audit pack", "priority high, due 2026-03-09"),
      // the case a single text could not tell: a title with a colon, and a comment that has one too
      line("b5", "comment.added", "Q3: audit pack", "On it: noon works"),
      line("b6", "document.attached", "Q3: audit pack", "brief: v2.txt"),
      line("b7", "document.noted", "Q3: brief.txt", "Looks right: ship it", "u3", "documents"),
      line("b8", "approval.decided", "Q3: brief.txt", "approved, clause 3: fine", "u2", "approvals"),
    );
    await mount(m.Feed, { projectId: "p1" });
    expect(all(root, "li .what")).toEqual([
      "Ada Lovelace opened Q3: audit pack",
      "Ada Lovelace moved Q3: audit pack open → doing",
      "Ada Lovelace handed over Q3: audit pack to Grace Hopper",
      "Ada Lovelace changed Q3: audit pack priority high, due 2026-03-09",
      "Ada Lovelace commented on Q3: audit pack “On it: noon works”",
      "Ada Lovelace attached a file to Q3: audit pack brief: v2.txt",
      "Noor Haddad remarked on Q3: brief.txt “Looks right: ship it”",
      "Grace Hopper signed off on Q3: brief.txt approved, clause 3: fine",
    ]);
    expect(all(root, "li .text")).toEqual(["Q3: audit pack", "Q3: audit pack", "Q3: audit pack", "Q3: audit pack", "Q3: audit pack", "Q3: audit pack", "Q3: brief.txt", "Q3: brief.txt"]);
    expect(all(root, "li .more")).toEqual(["open → doing", "to Grace Hopper", "priority high, due 2026-03-09", "“On it: noon works”", "brief: v2.txt", "“Looks right: ship it”", "approved, clause 3: fine"]);
  });

  it("a line with no detail reads as its subject alone, as it always did, with nothing after it", async () => {
    db.activity.push(
      line("c1", "issue.created", "Q3: audit pack"),
      line("c2", "document.added", "notes: draft (v2).txt", null, "u2", "documents"),
      line("c3", "document.empty", "blank.txt", null, null, "catalogue"),
      line("c4", "project.edited", "Northwind: phase two"),
      // guard: the same kind with a detail still says it, so the absence above is the line's and not the feed's
      line("c5", "document.replaced", "notes: draft (v2).txt", "now version 2", "u2", "documents"),
    );
    await mount(m.Feed, { projectId: "p1" });
    expect(all(root, "li .what")).toEqual([
      "Ada Lovelace opened Q3: audit pack",
      "Grace Hopper added a file notes: draft (v2).txt",
      "Keel found nothing to index in blank.txt",
      "Ada Lovelace project.edited Northwind: phase two",
      "Grace Hopper replaced a file notes: draft (v2).txt now version 2",
    ]);
    expect([...root.querySelectorAll("li")].map((li) => li.querySelector(".more") !== null)).toEqual([false, false, false, false, true]);
  });

  it("hears what happens on the project as it happens", async () => {
    db.issues.push({ $type: "Issue", id: "i1", projectId: "p1", title: "x", state: "open", assigneeId: null, priority: "normal", labels: [], dueOn: null, description: null, version: 1, updatedAt: T });
    await mount(m.Feed, { projectId: "p1" });
    expect(text(one(root, ".empty"))).toBe("Nothing yet Files added, issues opened and comments left on this project will show up here as they happen.");
    db.activity.push(line("a1", "issue.moved", "x", "doing"));
    await workspace.client(GRACE).command("moveIssue", { id: "i1", to: "doing" }, { ifVersion: 1 });
    await settled();
    expect(all(root, "li .what")).toEqual(["Ada Lovelace moved x doing"]);
  });

  it("asks for nothing without a project, and says the feed stopped when it fails", async () => {
    await mount(m.Feed);
    expect(workspace.take()).toEqual([]);
    expect(text(one(root, ".empty"))).toBe("No project selected");
    fixture.destroy();
    gate.failing = "the database is away";
    await mount(m.Feed, { projectId: "p1" });
    expect(text(one(root, "header .pill"))).toBe("disconnected");
    expect(text(one(root, ".empty"))).toBe("The feed stopped the database is away");
  });

  it("shows today's lines by the time and older ones by the day", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-04T18:00:00.000Z") });
    db.activity.push(line("a1", "issue.created", "Today"), { ...line("a2", "issue.created", "Before"), at: "2026-03-01T12:00:00.000Z" });
    await mount(m.Feed, { projectId: "p1" });
    expect(all(root, "li time")).toEqual(["12:00 PM", "Mar 1"]);
  });
});

describe("the project's chat", () => {
  it("reads the history, then hears each line as it is said, here or on another screen", async () => {
    db.messages.push({ id: "m0", projectId: "p1", body: "Morning", at: T, byId: "u2" }, { id: "mx", projectId: "p2", body: "Other project", at: T, byId: "u2" });
    await mount(m.Chat, { projectId: "p1" });
    expect(workspace.take()).toEqual([
      { op: "messages", args: { projectId: "p1" }, shape: "{ items { id body at by { id name } } }" },
      { op: "chat", args: { projectId: "p1" } },
    ]);
    expect(text(one(root, "header .pill"))).toBe("stream open");
    expect(all(root, "li .text")).toEqual(["Morning"]);

    await workspace.client(GRACE).command("say", { projectId: "p1", body: "Coffee?" });
    await workspace.client(GRACE).command("say", { projectId: "p2", body: "Not for p1" });
    await settled();
    expect(all(root, "li .text")).toEqual(["Morning", "Coffee?"]);
    expect(all(root, "li .meta strong")).toEqual(["Grace Hopper", "Grace Hopper"]);
    // a line the history already holds, heard again on the stream, is shown once
    workspace.server.events.publish("Said", { projectId: "p1", messageId: "m0", body: "Morning", byId: "u2", byName: "Grace Hopper", at: T });
    await settled();
    expect(all(root, "li .text")).toEqual(["Morning", "Coffee?"]);
    expect(root.querySelector("li.mine")).toBe(null);

    const send = button(root, "Send");
    expect(send.disabled).toBe(true);
    await type(one(root, "form.say input"), "  Yes please ");
    workspace.take();
    one<HTMLFormElement>(root, "form.say").dispatchEvent(new Event("submit", { cancelable: true }));
    await settled();
    expect(workspace.take()).toEqual([{ op: "say", args: { projectId: "p1", body: "Yes please" }, shape: "{ id by { id } }" }]);
    expect(one<HTMLInputElement>(root, "form.say input").value).toBe("");
    // the line arrives once, on the stream; the person who said it is known from the answer, and it is theirs
    expect(all(root, "li .text")).toEqual(["Morning", "Coffee?", "Yes please"]);
    expect([...root.querySelectorAll("li.line")].map((l) => l.classList.contains("mine"))).toEqual([false, false, true]);
    expect(all(root, "li .avatar")).toEqual(["GH", "GH", "AL"]);
  });

  it("says the stream ended when it did, and opens it again on a reconnect", async () => {
    await mount(m.Chat, { projectId: "p1" });
    expect(text(one(root, "li.none"))).toBe("Nothing said yet. Whatever you say here reaches everyone with this project open.");
    FakeWebSocket.closeAll();
    await settled();
    expect(text(one(root, "header .pill"))).toBe("stream closed");
    expect(text(one(root, "p.bad[role=alert]"))).toBe("The stream ended: Connection closed Reconnect");
    workspace.take();
    await click(button(root, "Reconnect"));
    expect(workspace.take()).toEqual([{ op: "chat", args: { projectId: "p1" } }]);
    expect(text(one(root, "header .pill"))).toBe("stream open");
    await workspace.client(NOOR).command("say", { projectId: "p1", body: "Back" });
    await settled();
    expect(all(root, "li .text")).toEqual(["Back"]);
  });

  it("follows the project it is given, one stream at a time", async () => {
    const f = await mount(m.Chat, { projectId: "p1" });
    await workspace.client(GRACE).command("say", { projectId: "p1", body: "Before the switch" });
    await settled();
    expect(all(root, "li .text")).toEqual(["Before the switch"]);
    f.componentRef.setInput("projectId", "p2");
    workspace.take();
    await settled();
    expect(workspace.take()).toEqual([
      { op: "messages", args: { projectId: "p2" }, shape: "{ items { id body at by { id name } } }" },
      { op: "chat", args: { projectId: "p2" } },
    ]);
    await workspace.client(GRACE).command("say", { projectId: "p1", body: "Old project" });
    await workspace.client(GRACE).command("say", { projectId: "p2", body: "New project" });
    await settled();
    expect(all(root, "li .text")).toEqual(["New project"]);
    expect(text(one(root, "header .pill"))).toBe("stream open");
  });

  it("keeps the line and says why when it is refused, and asks for nothing without a project", async () => {
    await mount(m.Chat, { projectId: "p1" });
    await type(one(root, "form.say input"), "fail");
    one<HTMLFormElement>(root, "form.say").dispatchEvent(new Event("submit", { cancelable: true }));
    await settled();
    expect(text(root.querySelectorAll("p.bad")[0]!)).toBe("The chat is resting");
    expect(one<HTMLInputElement>(root, "form.say input").value).toBe("fail");
    fixture.destroy();
    await mount(m.Chat);
    expect(workspace.take()).toEqual([]);
    expect(text(one(root, ".empty"))).toBe("No project selected");
  });
});

describe("the bell", () => {
  const note = (id: string, over: Partial<Db["notifications"][number]> = {}) => ({ id, recipientId: "u1", kind: "issue.assigned", text: `Note ${id}`, projectId: "p1", issueId: null, at: T, readAt: null, ...over });

  function notify(recipientId: string, notificationId: string, kind = "issue.assigned"): void {
    workspace.server.events.publish("Notified", { recipientId, notificationId, kind, text: `Told ${notificationId}`, projectId: "p1", issueId: null, at: T });
  }

  it("counts what is unread, live, and lists it only while open", async () => {
    db.notifications.push(note("n1"), note("n2", { readAt: T, kind: "comment.added" }), note("n3", { kind: "document.indexed" }), note("nx", { recipientId: "u2" }));
    await mount(m.Notifications);
    expect(workspace.take()).toEqual([
      { op: "unread", args: {}, live: true },
      { op: "notified", args: {} },
    ]);
    expect(text(one(root, ".bell .count"))).toBe("2");
    expect(one(root, ".bell .count").getAttribute("aria-label")).toBe("2 unread");
    expect(root.querySelector(".panel")).toBe(null);

    await click(one(root, ".bell"));
    expect(workspace.take()).toEqual([{ op: "notifications", args: {}, shape: "{ items { id kind text projectId issueId at readAt } }", live: true }]);
    expect(one(root, ".bell").getAttribute("aria-expanded")).toBe("true");
    expect(all(root, ".panel li .what")).toEqual(["Handed to you Note n1", "A reply Note n2", "Searchable now Note n3"]);
    expect([...root.querySelectorAll(".panel li")].map((l) => l.classList.contains("unread"))).toEqual([true, false, true]);

    await click(button(root, "Mark all read"));
    const marked = workspace.take().filter((s) => !s.live);
    expect(marked.map((s) => s.op)).toEqual(["markRead"]);
    expect(Date.parse(String(marked[0]!.args["upTo"]))).toBeGreaterThanOrEqual(Date.parse(T));
    expect(root.querySelector(".bell .count")).toBe(null);
    expect(button(root, "Mark all read").disabled).toBe(true);
    expect([...root.querySelectorAll(".panel li")].map((l) => l.classList.contains("unread"))).toEqual([false, false, false]);

    await click(one(root, ".scrim"));
    expect(root.querySelector(".panel")).toBe(null);
  });

  it("shows a count over ninety-nine as 99+, and nothing for none", async () => {
    for (let i = 0; i < 100; i++) db.notifications.push(note(`n${i}`));
    await mount(m.Notifications);
    expect(text(one(root, ".bell .count"))).toBe("99+");
    db.notifications.splice(1);
    fixture.destroy();
    await mount(m.Notifications);
    expect(text(one(root, ".bell .count"))).toBe("1");
  });

  it("says there is nothing yet for someone told nothing", async () => {
    await mount(m.Notifications);
    await click(one(root, ".bell"));
    expect(text(one(root, ".panel .empty strong"))).toBe("Nothing for you yet");
  });

  it("toasts each notification for this person as it is written, for six seconds or until dismissed", async () => {
    await mount(m.Notifications);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    notify("u1", "t1", "approval.requested");
    notify("u2", "t-other");
    notify("u1", "t2", "made.up");
    // the same notification told twice is one toast
    notify("u1", "t2", "made.up");
    await settled();
    expect(all(root, ".toast")).toEqual(["Sign-off asked Told t1 ×", "made.up Told t2 ×"]);
    await click(one(root, ".toast:last-child .close"));
    expect(all(root, ".toast .text")).toEqual(["Told t1"]);
    vi.advanceTimersByTime(5999);
    await settled();
    expect(all(root, ".toast .text")).toEqual(["Told t1"]);
    vi.advanceTimersByTime(1);
    await settled();
    expect(all(root, ".toast")).toEqual([]);
  });

  it("toasts nothing for a person who turned toasts off, and still for one whose setting is unreadable", async () => {
    localStorage.setItem("keel.settings", JSON.stringify({ toasts: false }));
    await mount(m.Notifications);
    notify("u1", "t1");
    await settled();
    expect(all(root, ".toast")).toEqual([]);
    localStorage.setItem("keel.settings", JSON.stringify({ theme: "dark" }));
    notify("u1", "t-unsaid");
    await settled();
    expect(all(root, ".toast .text")).toEqual(["Told t-unsaid"]);
    await click(one(root, ".toast .close"));
    localStorage.setItem("keel.settings", "{not json");
    notify("u1", "t2");
    await settled();
    expect(all(root, ".toast .text")).toEqual(["Told t2"]);
  });

  it("opens the stream again after it drops, after a pause that doubles", async () => {
    await mount(m.Notifications);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    workspace.take();
    FakeWebSocket.closeAll();
    await settled();
    expect(workspace.take().filter((s) => s.op === "notified")).toEqual([]);
    vi.advanceTimersByTime(999);
    await settled();
    expect(workspace.take().filter((s) => s.op === "notified")).toEqual([]);
    vi.advanceTimersByTime(1);
    await settled();
    expect(workspace.take().filter((s) => s.op === "notified")).toEqual([{ op: "notified", args: {} }]);
    notify("u1", "back");
    await settled();
    expect(all(root, ".toast .text")).toEqual(["Told back"]);
    // the pause starts again from a second once an item has come through
    FakeWebSocket.closeAll();
    await settled();
    workspace.take();
    vi.advanceTimersByTime(1000);
    await settled();
    expect(workspace.take().filter((s) => s.op === "notified")).toEqual([{ op: "notified", args: {} }]);
    FakeWebSocket.closeAll();
    await settled();
    vi.advanceTimersByTime(1999);
    await settled();
    expect(workspace.take().filter((s) => s.op === "notified")).toEqual([]);
    vi.advanceTimersByTime(1);
    await settled();
    expect(workspace.take().filter((s) => s.op === "notified")).toEqual([{ op: "notified", args: {} }]);
  });
});

describe("the people page", () => {
  it("adds up what everyone holds, and says who is free and who is late", async () => {
    db.workload.push(
      { memberId: "u1", title: "Engineering lead", email: "ada@keel.example", open: 2, doing: 1, done: 4, overdue: 1 },
      { memberId: "u2", title: null, email: null, open: 0, doing: 0, done: 0, overdue: 0 },
      { memberId: "u4", title: null, email: null, open: 0, doing: 1, done: 0, overdue: 0 },
      { memberId: "u3", title: "Product", email: "noor@keel.example", open: 1, doing: 2, done: 0, overdue: 3 },
    );
    await mount(m.People);
    expect(workspace.take()).toEqual([{ op: "workload", args: {}, shape: "{ member { id name title email } open doing done overdue }", live: true }]);
    expect(all(root, ".totals .total")).toEqual(["7 in flight", "4 in progress", "4 overdue", "4 done"]);
    expect(one(root, ".totals .total:nth-child(3)").classList.contains("hot")).toBe(true);
    expect(all(root, ".person .who .text")).toEqual(["Ada Lovelace Engineering lead ada@keel.example", "Grace Hopper", "Tomás Ferreira", "Noor Haddad Product noor@keel.example"]);
    expect(all(root, ".person .note")).toEqual(["One issue past its day.", "Holds nothing right now. A good person to hand something to.", "3 issues past their day."]);
    expect([...root.querySelectorAll(".person")].map((p) => p.classList.contains("free"))).toEqual([false, true, false, false]);
    expect([...root.querySelectorAll(".person .bar")].map((b) => b.getAttribute("aria-label"))).toEqual(["1 in progress, 2 open, 4 done", "0 in progress, 0 open, 0 done", "1 in progress, 0 open, 0 done", "2 in progress, 1 open, 0 done"]);
    expect([...root.querySelectorAll(".person")].map((p) => p.querySelectorAll(".seg.none").length)).toEqual([0, 1, 0, 0]);
    expect(all(root, ".person .counts dd")).toEqual(["1", "2", "4", "1", "0", "0", "0", "0", "1", "0", "0", "0", "2", "1", "0", "3"]);
    expect([...root.querySelectorAll(".person a.mail")].map((a) => a.getAttribute("href"))).toEqual(["mailto:ada@keel.example", "mailto:noor@keel.example"]);
    expect(text(one(root, ".head .pill"))).toBe("live");
  });

  it("follows every hand-over, re-run by name", async () => {
    db.workload.push({ memberId: "u1", title: null, email: null, open: 0, doing: 0, done: 0, overdue: 0 });
    db.issues.push({ $type: "Issue", id: "i1", projectId: "p1", title: "x", state: "open", assigneeId: null, priority: "normal", labels: [], dueOn: null, description: null, version: 1, updatedAt: T });
    await mount(m.People);
    expect(all(root, ".totals .total")[0]).toBe("0 in flight");
    db.workload[0]!.open = 1;
    await workspace.client(GRACE).command("assignIssue", { id: "i1", assigneeId: "u1" }, { ifVersion: 1 });
    await settled();
    expect(all(root, ".totals .total")[0]).toBe("1 in flight");
    expect(root.querySelector(".person .note")).toBe(null);
  });
});

describe("a project's settings", () => {
  beforeEach(() => {
    db.projects.push({ id: "p1", name: "Northwind rollout", description: "Ship it", color: "teal", defaultAssigneeId: "u2", version: 3, updatedAt: T });
  });

  it("shows the project as it is, and saves only what was touched, on the version read, telling the page around it", async () => {
    const f = await mount(m.ProjectSettings, { projectId: "p1" });
    expect(workspace.take()).toEqual([
      { op: "members", args: {}, shape: "{ id name }" },
      { op: "project", args: { id: "p1" }, shape: "{ id name description color version updatedAt defaultAssignee { id name } }", live: true },
    ]);
    expect(text(one(root, "h1"))).toBe("Northwind rollout");
    expect(one<HTMLInputElement>(root, "input[name=name]").value).toBe("Northwind rollout");
    expect(one<HTMLTextAreaElement>(root, "textarea").value).toBe("Ship it");
    expect([...root.querySelectorAll(".color")].map((c) => c.getAttribute("aria-checked"))).toEqual(["false", "false", "true", "false", "false", "false"]);
    expect(one<HTMLSelectElement>(root, "select").value).toBe("u2");
    expect(text(one(root, "footer .version"))).toBe("Version 3 · changed Mar 4, 12:00 PM");
    const save = button(root, "Save changes");
    expect(save.disabled).toBe(true);

    await click(one(root, ".color[data-color=rose]"));
    expect([...root.querySelectorAll(".color")].map((c) => c.getAttribute("aria-checked"))).toEqual(["false", "false", "false", "true", "false", "false"]);
    const select = one<HTMLSelectElement>(root, "select");
    select.value = "";
    select.dispatchEvent(new Event("change"));
    await settled();
    expect(save.disabled).toBe(false);

    const told: Event[] = [];
    document.addEventListener("keel-projects", (e) => told.push(e), { once: true });
    workspace.take();
    one<HTMLFormElement>(root, "form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settled();
    expect(workspace.take().filter((s) => !s.live)).toEqual([{ op: "updateProject", args: { id: "p1", changes: { color: "rose", defaultAssigneeId: null } }, shape: "{ id name color version }", ifVersion: 3 }]);
    expect(told.length).toBe(1);
    expect(text(one(root, "footer [role=status]"))).toBe("Saved.");
    expect(text(one(root, "footer .version"))).toBe("Version 4 · changed Mar 4, 12:00 PM");
    expect(button(root, "Save changes").disabled).toBe(true);
    expect(root.querySelector("footer .quiet")).toBe(null);
    void f;

    // touching again hides the word saved until the next save
    await type(one(root, "input[name=name]"), "Northwind");
    expect(root.querySelector("footer [role=status]")).toBe(null);
  });

  it("puts every field back on discard", async () => {
    await mount(m.ProjectSettings, { projectId: "p1" });
    await type(one(root, "input[name=name]"), "Something else");
    await type(one(root, "textarea"), "");
    await click(button(root, "Discard"));
    expect(one<HTMLInputElement>(root, "input[name=name]").value).toBe("Northwind rollout");
    expect(button(root, "Save changes").disabled).toBe(true);
    workspace.take();
    one<HTMLFormElement>(root, "form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settled();
    expect(workspace.take()).toEqual([]);
  });

  it("says plainly when someone else changed the settings first", async () => {
    await mount(m.ProjectSettings, { projectId: "p1" });
    await type(one(root, "textarea"), "");
    db.projects[0]!.version = 5;
    db.projects[0]!.name = "Theirs";
    one<HTMLFormElement>(root, "form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settled();
    expect(text(one(root, "footer [role=alert]"))).toBe("Someone changed these settings while you were editing. The page shows theirs now; make your change again.");
    expect(db.projects[0]!.description).toBe("Ship it");
    expect(workspace.take().filter((s) => !s.live).at(-1)).toEqual({ op: "updateProject", args: { id: "p1", changes: { description: null } }, shape: "{ id name color version }", ifVersion: 3 });
  });

  it("hears an edit made on another screen, and loads nothing without a project", async () => {
    await mount(m.ProjectSettings, { projectId: "p1" });
    await workspace.client(GRACE).command("updateProject", { id: "p1", changes: { name: "Renamed" } }, { ifVersion: 3 });
    await settled();
    expect(text(one(root, "h1"))).toBe("Renamed");
    fixture.destroy();
    await mount(m.ProjectSettings);
    expect(workspace.take().filter((s) => s.op === "project")).toEqual([]);
    expect(text(one(root, "h1"))).toBe("…");
  });
});

describe("the palette's quick actions", () => {
  beforeEach(() => {
    db.issues.push({ $type: "Issue", id: "seed", projectId: "p1", title: "x", state: "open", assigneeId: null, priority: "normal", labels: [], dueOn: null, description: null, version: 1, updatedAt: T });
  });

  it("offers nothing until something is typed", async () => {
    await mount(m.Quick, { query: "   ", projectId: "p1" });
    expect(text(one(root, ".none"))).toBe("Type a few words, and they become an issue or a line in the chat.");
  });

  it("opens an issue, hands it to the caller and leaves a first note, in one request", async () => {
    await mount(m.Quick, { query: "  Print badges ", projectId: "p1", projectName: "Northwind" });
    expect(all(root, ".label")).toEqual(["New issue “Print badges”", "Say “Print badges” in the chat"]);
    expect(all(root, ".hint")[0]).toBe("Opened on Northwind, handed to you, with a first note. Three commands, one request.");
    const told: string[] = [];
    const listen = (e: Event) => told.push((e as CustomEvent<string>).detail);
    document.addEventListener("keel-done", listen);
    workspace.take();
    const sentBefore = FakeWebSocket.opened.length;
    await click(button(root, all(root, "button")[0]!));
    document.removeEventListener("keel-done", listen);
    expect(FakeWebSocket.opened.length).toBe(sentBefore);
    // the socket numbers the ops of every batch from one counter, so the reference is whatever the first op's is
    const [opened_, assigned, noted] = workspace.take();
    expect(opened_).toEqual({ op: "createIssue", args: { projectId: "p1", title: "Print badges" }, shape: "{ id title version }" });
    expect(assigned).toEqual({ op: "assignIssue", args: { id: { $ref: expect.stringMatching(/^\d+\.id$/) }, assigneeId: "u1" }, shape: "{ id }" });
    expect(noted).toEqual({ op: "addComment", args: { issueId: assigned!.args["id"], body: "Opened from the command palette." }, shape: "{ id }" });
    const opened = db.issues.find((i) => i.title === "Print badges")!;
    expect(opened.assigneeId).toBe("u1");
    expect(db.comments).toEqual([{ id: expect.any(String), issueId: opened.id, body: "Opened from the command palette.", at: T, byId: "u1" }]);
    expect(told).toEqual(["Opened “Print badges” and handed it to you."]);
  });

  it("says the line in the chat", async () => {
    await mount(m.Quick, { query: "  hello all ", projectId: "p1" });
    expect(all(root, ".hint")[1]).toBe("Everyone with the project open hears it as you send it.");
    const told: string[] = [];
    const listen = (e: Event) => told.push((e as CustomEvent<string>).detail);
    document.addEventListener("keel-done", listen);
    workspace.take();
    await click(button(root, all(root, "button")[1]!));
    document.removeEventListener("keel-done", listen);
    expect(workspace.take().map(({ op, args }) => ({ op, args }))).toEqual([{ op: "say", args: { projectId: "p1", body: "hello all" } }]);
    expect(told).toEqual(["Said in the chat."]);
  });

  it("says why when it cannot", async () => {
    await mount(m.Quick, { query: "fail", projectId: "p1" });
    await click(button(root, all(root, "button")[1]!));
    expect(text(one(root, "[role=alert]"))).toBe("The chat is resting");
    fixture.destroy();
    await mount(m.Quick, { query: "x", projectId: "p1" }, { id: "nobody", name: "Nobody" });
    workspace.take();
    await click(button(root, all(root, "button")[0]!));
    expect(text(one(root, "[role=alert]"))).toBe("Not signed in.");
    expect(workspace.take()).toEqual([]);
  });
});

describe("where the panels find their services", () => {
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

  it("uses the gateway's paths unless a meta tag says otherwise, as a socket address on the page's origin", () => {
    expect(m.client.workspaceBase()).toBe("/api/workspace");
    expect(m.client.documentsBase()).toBe("/api/documents");
    expect(m.client.workspaceSocket()).toBe(`ws://${location.host}/api/workspace/rayfold/ws`);
    meta("workspace-base", "https://ws.example/w/");
    meta("documents-base", "/d/");
    expect(m.client.workspaceBase()).toBe("https://ws.example/w");
    expect(m.client.documentsBase()).toBe("/d");
    expect(m.client.workspaceSocket()).toBe("wss://ws.example/w/rayfold/ws");
  });
});

import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { App } from "./app";
import { COOKIE, TEAM, current, initials, signIn, signOut } from "./session";
import { DEFAULTS, SETTINGS_KEY, applyTheme, loadSettings, saveSettings } from "./settings";

/** The text a person reads in an element: its text nodes, a space between each, whitespace collapsed. */
function text(el: Element | null | undefined): string {
  if (!el) return "";
  const parts: string[] = [];
  const walk = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) parts.push(n.nodeValue ?? "");
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
const all = (root: Element, selector: string) => [...root.querySelectorAll(selector)].map((e) => text(e));
function one<T extends Element = HTMLElement>(root: Element, selector: string): T {
  const found = root.querySelectorAll<T>(selector);
  if (found.length !== 1) throw new Error(`expected one ${selector}, found ${found.length}`);
  return found[0]!;
}
function button(root: Element, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].filter((b) => text(b) === label);
  if (found.length !== 1) throw new Error(`expected one button "${label}", found ${found.length}: ${all(root, "button").join(" | ")}`);
  return found[0]!;
}

let dark = false;
let asked: string[];
let projects: () => Response | Promise<Response>;
let fixture: ComponentFixture<App>;
let root: HTMLElement;

async function settled(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
  // the remotes' loads settle on a later turn
  await new Promise<void>((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => (ch.port1.close(), resolve());
    ch.port2.postMessage(0);
  });
  fixture.detectChanges();
  await fixture.whenStable();
}

async function mount(): Promise<void> {
  fixture = TestBed.createComponent(App);
  root = fixture.nativeElement as HTMLElement;
  await settled();
}

function key(k: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  fixture.detectChanges();
  return event;
}

const view = () => {
  if (root.querySelector("keel-settings")) return "settings";
  if (root.querySelector("keel-guide")) return "guide";
  if (root.querySelector("header.topbar")) return `project:${text(root.querySelector(".topbar h1"))}`;
  return text(root.querySelector("main.single .empty strong"));
};

beforeEach(() => {
  dark = false;
  asked = [];
  projects = () =>
    new Response(JSON.stringify([
      { id: "p1", name: "Northwind", color: "teal", version: 2 },
      { id: "p2", name: "Q3", color: "rose" },
      { id: "p3", name: "Third", color: "slate" },
    ]));
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(prefers-color-scheme: dark)" && dark, media: q }));
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    asked.push(`${url} ${JSON.stringify(init?.headers ?? {})}`);
    return projects();
  });
  localStorage.clear();
  signOut();
  delete document.documentElement.dataset["theme"];
});

afterEach(() => {
  fixture?.destroy();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
  signOut();
  delete document.documentElement.dataset["theme"];
  history.replaceState(null, "", "/");
});

describe("signing in", () => {
  it("lists the team, and sets the session cookie for whoever is chosen", async () => {
    await mount();
    expect(all(root, ".gate .person .text")).toEqual([
      "Ada Lovelace Engineering lead · ada@keel.example",
      "Grace Hopper Platform · grace@keel.example",
      "Noor Haddad Product · noor@keel.example",
      "Tomás Ferreira Legal & compliance · tomas@keel.example",
    ]);
    expect(all(root, ".gate .avatar")).toEqual(["AL", "GH", "NH", "TF"]);
    // the keyboard does nothing before someone is signed in
    key("k", { ctrlKey: true });
    expect(root.querySelector("keel-palette")).toBe(null);

    root.querySelectorAll<HTMLButtonElement>(".gate .person")[3]!.click();
    await settled();
    expect(document.cookie).toBe(`${COOKIE}=tomas`);
    expect(text(one(root, ".who .text"))).toBe("Tomás Ferreira tomas@keel.example");
    expect(root.querySelector(".gate")).toBe(null);

    await settled();
    button(root, "Sign out").click();
    await settled();
    expect(document.cookie).toBe("");
    expect(root.querySelectorAll(".gate .person").length).toBe(4);
  });

  it("keeps whoever the cookie names across a reload, and nobody for a name it does not know", async () => {
    signIn(TEAM[2]!);
    await mount();
    expect(text(one(root, ".who strong"))).toBe("Noor Haddad");
    fixture.destroy();
    document.cookie = `${COOKIE}=mallory; path=/`;
    await mount();
    expect(root.querySelector(".gate")).not.toBe(null);
  });
});

describe("the session", () => {
  it("reads the handle back out of a cookie among others, decoded", () => {
    document.cookie = "other=1; path=/";
    signIn(TEAM[0]!);
    document.cookie = "after=2; path=/";
    expect(current()).toEqual(TEAM[0]);
    signOut();
    // a cookie whose name only contains the session's is someone else's, before the session's own or alone
    document.cookie = `x${COOKIE}=grace; path=/`;
    expect(current()).toBe(null);
    signIn(TEAM[0]!);
    expect(current()).toEqual(TEAM[0]);
    signOut();
    document.cookie = `x${COOKIE}=; path=/; max-age=0`;
    expect(current()).toBe(null);
    document.cookie = "other=; path=/; max-age=0";
    document.cookie = "after=; path=/; max-age=0";
  });

  it("makes initials of the first two names", () => {
    expect(initials("Ada")).toBe("A");
    expect(initials("ada  king lovelace")).toBe("AK");
  });
});

describe("the page, signed in", () => {
  beforeEach(() => signIn(TEAM[0]!));

  it("reads the rail from the workspace's plain route, with the cookie, and opens on the first project", async () => {
    await mount();
    expect(asked).toEqual(['/api/workspace/projects {"accept":"application/json"}']);
    expect(all(root, ".rail .nav .swatch").length).toBe(3);
    expect([...root.querySelectorAll(".rail .nav .swatch")].map((s) => s.getAttribute("data-color"))).toEqual(["teal", "rose", "slate"]);
    expect(view()).toBe("project:Northwind");
    expect(text(one(root, ".topbar .path"))).toBe("Projects / Northwind");
    expect(one(root, ".topbar .swatch").getAttribute("data-color")).toBe("teal");
    // each remote that cannot be loaded is one panel missing, named, not a blank page
    expect(all(root, "main .slot .empty strong")).toEqual(["Issues is unavailable", "Documents is unavailable", "Activity is unavailable", "Chat is unavailable"]);
  });

  it("keeps the rail it has when the workspace does not answer, answers badly or has no projects", async () => {
    const failing = () => new Response(JSON.stringify([{ id: "p9", name: "From an error page", color: "rose" }]), { status: 502 });
    for (const answer of [() => Promise.reject(new Error("offline")), failing, () => new Response("[]")]) {
      projects = answer;
      await mount();
      expect(all(root, ".rail .nav").slice(0, 2)).toEqual(["Northwind rollout", "Q3 compliance"]);
      fixture.destroy();
    }
  });

  it("opens the project last looked at, or the one the settings name, or the first", async () => {
    localStorage.setItem("keel.lastProject", "p2");
    await mount();
    expect(view()).toBe("project:Q3");
    fixture.destroy();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ startOn: "p1" }));
    await mount();
    expect(view()).toBe("project:Northwind");
    fixture.destroy();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ startOn: "last" }));
    localStorage.setItem("keel.lastProject", "gone");
    await mount();
    expect(view()).toBe("project:Northwind");
    // the first project is the one open, not a project that is not there
    expect([...root.querySelectorAll(".rail .nav")].slice(0, 3).map((b) => b.classList.contains("on"))).toEqual([true, false, false]);
  });

  it("remembers the project opened from the rail", async () => {
    await mount();
    root.querySelectorAll<HTMLButtonElement>(".rail .nav")[2]!.click();
    await settled();
    expect(view()).toBe("project:Third");
    expect(localStorage.getItem("keel.lastProject")).toBe("p3");
    expect([...root.querySelectorAll(".rail .nav")].slice(0, 3).map((b) => b.classList.contains("on"))).toEqual([false, false, true]);
  });

  it("goes to the company's pages, the guide and the settings from the rail", async () => {
    await mount();
    button(root, "⌕ Catalogue").click();
    await settled();
    expect(view()).toBe("Catalogue is unavailable");
    expect(all(root, ".rail .nav.on")).toEqual(["⌕ Catalogue"]);
    button(root, "◎ People").click();
    await settled();
    expect(view()).toBe("People is unavailable");
    button(root, "? What this shows").click();
    await settled();
    expect(view()).toBe("guide");
    button(root, "⚙ Settings").click();
    await settled();
    expect(view()).toBe("settings");
    root.querySelectorAll<HTMLButtonElement>(".rail .nav")[1]!.click();
    await settled();
    expect(view()).toBe("project:Q3");
    button(root, "⚙ Project settings").click();
    await settled();
    expect(text(one(root, "main.single .empty strong"))).toBe("Project settings are unavailable");
    // the project stays the one on the rail
    expect(root.querySelectorAll(".rail .nav.on").length).toBe(1);
  });

  it("follows the keyboard: g and a number or a letter, ?, t, / and Escape; not while typing", async () => {
    await mount();
    key("g");
    key("2");
    expect(view()).toBe("project:Q3");
    key("g");
    key("c");
    expect(view()).toBe("Catalogue is unavailable");
    key("g");
    key("p");
    expect(view()).toBe("People is unavailable");
    key("g");
    key("s");
    expect(view()).toBe("settings");
    key("Escape");
    expect(view()).toBe("project:Q3");
    key("g");
    key("9");
    expect(view()).toBe("project:Q3");
    key("?");
    expect(view()).toBe("guide");
    key("Escape");
    expect(view()).toBe("project:Q3");

    // a person typing a g into a field is not taken anywhere
    const input = document.createElement("input");
    document.body.append(input);
    key("g", {}, input);
    key("1", {}, input);
    key("g", { altKey: true });
    key("1");
    expect(view()).toBe("project:Q3");
    input.remove();

    const slash = key("/");
    expect(slash.defaultPrevented).toBe(true);
    expect(root.querySelector("keel-palette")).not.toBe(null);
  });

  it("forgets a g after a second", async () => {
    await mount();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    key("g");
    vi.advanceTimersByTime(999);
    key("2");
    expect(view()).toBe("project:Q3");
    key("g");
    vi.advanceTimersByTime(1000);
    key("1");
    expect(view()).toBe("project:Q3");
  });

  it("switches the theme, stamps it on the page and keeps it", async () => {
    await mount();
    expect(text(root.querySelectorAll(".account .nav")[2]!)).toBe("☀ Light");
    key("t");
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(localStorage.getItem("keel.theme")).toBe("dark");
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)).toEqual({ ...DEFAULTS, theme: "dark" });
    expect(text(root.querySelectorAll(".account .nav")[2]!)).toBe("☾ Dark");
    root.querySelectorAll<HTMLButtonElement>(".account .nav")[2]!.click();
    await settled();
    expect(document.documentElement.dataset["theme"]).toBe("light");
  });

  it("starts dark on a dark system, and on a theme already stamped", async () => {
    dark = true;
    await mount();
    expect(text(root.querySelectorAll(".account .nav")[2]!)).toBe("☾ Dark");
    fixture.destroy();
    dark = true;
    document.documentElement.dataset["theme"] = "light";
    await mount();
    expect(text(root.querySelectorAll(".account .nav")[2]!)).toBe("☀ Light");
  });

  it("opens the palette on Ctrl K and closes it on Ctrl K, even from a field", async () => {
    await mount();
    const input = document.createElement("input");
    document.body.append(input);
    const opened = key("k", { ctrlKey: true }, input);
    expect(opened.defaultPrevented).toBe(true);
    expect(root.querySelector("keel-palette")).not.toBe(null);
    // nothing else fires while the palette is open
    key("t");
    expect(document.documentElement.dataset["theme"]).toBe(undefined);
    key("K", { metaKey: true });
    expect(root.querySelector("keel-palette")).toBe(null);
    input.remove();
  });

  it("goes where the palette says, from the list or the keyboard", async () => {
    await mount();
    button(root, "⌘ Anything… Ctrl K").click();
    await settled();
    const palette = () => one(root, "keel-palette");
    expect(all(palette(), ".list .label")).toEqual(["Northwind", "Q3", "Third", "Project settings", "Catalogue", "People", "What this shows", "Settings", "Switch to dark", "Sign out"]);
    expect(all(palette(), ".list li")[0]).toBe("Northwind Project g 1");
    expect(all(palette(), ".list li")[3]).toBe("Project settings Northwind");
    expect(all(palette(), ".list li")[9]).toBe("Sign out Ada Lovelace");

    const box = one<HTMLInputElement>(palette(), "input.input");
    expect(document.activeElement).toBe(box);
    box.value = "q3";
    box.dispatchEvent(new Event("input"));
    fixture.detectChanges();
    expect(all(palette(), ".list .label")).toEqual(["Q3"]);
    box.value = "COMPANY";
    box.dispatchEvent(new Event("input"));
    fixture.detectChanges();
    expect(all(palette(), ".list .label")).toEqual(["Catalogue", "People"]);
    key("ArrowDown", {}, box);
    key("ArrowDown", {}, box);
    expect(all(palette(), ".list button.on")).toEqual(["People Company g p"]);
    key("ArrowUp", {}, box);
    key("ArrowUp", {}, box);
    expect(all(palette(), ".list button.on")).toEqual(["Catalogue Company g c"]);
    // typing again starts from the top of what is left
    key("ArrowDown", {}, box);
    box.value = "compan";
    box.dispatchEvent(new Event("input"));
    fixture.detectChanges();
    expect(all(palette(), ".list button.on")).toEqual(["Catalogue Company g c"]);
    key("ArrowDown", {}, box);
    key("Enter", {}, box);
    await settled();
    expect(root.querySelector("keel-palette")).toBe(null);
    expect(view()).toBe("People is unavailable");
  });

  it("says nothing matches, hides the keys when the settings say so, and closes on Escape or outside", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ hints: false }));
    await mount();
    key("/");
    await settled();
    expect(root.querySelectorAll("keel-palette kbd").length).toBe(1);
    const box = one<HTMLInputElement>(root, "keel-palette input.input");
    box.value = "zebra";
    box.dispatchEvent(new Event("input"));
    fixture.detectChanges();
    expect(text(one(root, "keel-palette .none"))).toBe("Nothing matches.");
    key("Escape", {}, box);
    await settled();
    expect(root.querySelector("keel-palette")).toBe(null);
    key("/");
    await settled();
    one(root, "keel-palette .scrim").click();
    await settled();
    expect(root.querySelector("keel-palette")).toBe(null);
  });

  it("shows for four seconds what a remote in the palette said it did", async () => {
    await mount();
    key("/");
    await settled();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    one(root, "keel-palette .list").dispatchEvent(new CustomEvent("keel-done", { bubbles: true, detail: "Opened “x” and handed it to you." }));
    fixture.detectChanges();
    expect(root.querySelector("keel-palette")).toBe(null);
    expect(text(one(root, ".said[role=status]"))).toBe("Opened “x” and handed it to you.");
    vi.advanceTimersByTime(3999);
    fixture.detectChanges();
    expect(root.querySelector(".said")).not.toBe(null);
    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(root.querySelector(".said")).toBe(null);
  });

  it("says Done for a remote that says nothing more", async () => {
    await mount();
    key("/");
    await settled();
    one(root, "keel-palette .list").dispatchEvent(new CustomEvent("keel-done", { bubbles: true }));
    fixture.detectChanges();
    expect(text(one(root, ".said"))).toBe("Done");
  });

  it("changes the settings from their page, and the palette follows", async () => {
    await mount();
    key("g");
    key("s");
    await settled();
    const settings = () => one(root, "keel-settings");
    expect(all(settings(), ".seg button")).toEqual(["System", "Light", "Dark"]);
    expect([...settings().querySelectorAll(".seg button")].map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(all(settings(), "select option")).toEqual(["The project I looked at last", "Northwind", "Q3", "Third"]);
    expect(all(settings(), ".keys > div")[0]).toBe("Ctrl K Open the command palette");
    expect(root.querySelectorAll("keel-settings .keys > div").length).toBe(10);

    button(settings(), "Dark").click();
    await settled();
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect([...settings().querySelectorAll(".seg button")].map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    button(settings(), "System").click();
    await settled();
    expect(document.documentElement.dataset["theme"]).toBe(undefined);
    expect(localStorage.getItem("keel.theme")).toBe(null);

    const [toasts, hints] = [...settings().querySelectorAll<HTMLInputElement>("input.switch")];
    // one change at a time, as a person makes them: each is drawn before the next
    toasts!.checked = false;
    toasts!.dispatchEvent(new Event("change"));
    await settled();
    hints!.checked = false;
    hints!.dispatchEvent(new Event("change"));
    await settled();
    const select = one<HTMLSelectElement>(settings(), "select");
    select.value = "p3";
    select.dispatchEvent(new Event("change"));
    await settled();
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)).toEqual({ theme: "system", toasts: false, startOn: "p3", hints: false });

    key("Escape");
    key("/");
    await settled();
    expect(root.querySelectorAll("keel-palette .list kbd").length).toBe(0);
  });

  it("opens what the guide points at", async () => {
    await mount();
    key("?");
    await settled();
    const guide = one(root, "keel-guide");
    expect(all(guide, "h2")).toEqual(["Reading", "Writing", "Beyond the browser", "The contract", "Between services", "With the Rayfold Console"]);
    [...guide.querySelectorAll<HTMLButtonElement>("button")].find((b) => text(b) === "People →")!.click();
    await settled();
    expect(view()).toBe("People is unavailable");
    key("?");
    await settled();
    [...one(root, "keel-guide").querySelectorAll<HTMLButtonElement>("button")].find((b) => text(b) === "Issues →")!.click();
    await settled();
    expect(view()).toBe("project:Northwind");
    // going back to the project is opening it, remembered like any other
    expect(localStorage.getItem("keel.lastProject")).toBe("p1");
  });
});

describe("a share link", () => {
  it("shows the shared file and nothing else, asking for no session and no projects", async () => {
    history.replaceState(null, "", "/?share=rfcap1.abc");
    await mount();
    expect(asked).toEqual([]);
    expect(root.querySelector(".gate")).toBe(null);
    expect(root.querySelector(".rail")).toBe(null);
    expect(text(one(root, "main.share .empty strong"))).toBe("The shared file cannot be shown");
    key("k", { ctrlKey: true });
    expect(root.querySelector("keel-palette")).toBe(null);
  });

  it("takes no shortcuts on a share link, even for someone signed in", async () => {
    signIn(TEAM[0]!);
    history.replaceState(null, "", "/?share=rfcap1.abc");
    await mount();
    key("t");
    expect(document.documentElement.dataset["theme"]).toBe(undefined);
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(null);
  });
});

describe("the settings, kept in the browser", () => {
  afterEach(() => localStorage.clear());

  it("reads the defaults under whatever was saved, and the defaults alone when nothing or nonsense was", () => {
    expect(loadSettings()).toEqual(DEFAULTS);
    localStorage.setItem(SETTINGS_KEY, "{nope");
    expect(loadSettings()).toEqual(DEFAULTS);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ toasts: false }));
    expect(loadSettings()).toEqual({ ...DEFAULTS, toasts: false });
  });

  it("keeps the theme where the first paint reads it, and stamps or clears it on the page", () => {
    saveSettings({ ...DEFAULTS, theme: "light" });
    expect(localStorage.getItem("keel.theme")).toBe("light");
    saveSettings({ ...DEFAULTS, theme: "system" });
    expect(localStorage.getItem("keel.theme")).toBe(null);
    applyTheme("dark");
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    applyTheme("system");
    expect(document.documentElement.dataset["theme"]).toBe(undefined);
  });
});

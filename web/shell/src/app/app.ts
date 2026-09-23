/**
 * The shell.
 *
 * It owns the page, the session and the project switcher — and none of the features. Each panel is loaded at
 * runtime from a remote the owning team deploys on its own, which is the point of the arrangement: the workspace
 * team ships a new feed without this application being rebuilt or redeployed.
 */
import { ChangeDetectionStrategy, Component, HostListener, computed, signal, type Type } from "@angular/core";
import { NgComponentOutlet } from "@angular/common";
import { loadRemoteModule } from "@angular-architects/native-federation";
import { GuidePage } from "./guide";
import { Palette, type Action } from "./palette";
import { SHORTCUTS, SettingsPage, applyTheme, loadSettings, saveSettings, type Settings } from "./settings";
import { TEAM, current, initials, signIn, signOut, type Person } from "./session";

/** A panel on the page, and the remote it comes from. */
interface Panel {
  key: string;
  label: string;
  remote: string;
  exposed: string;
  component: Type<unknown> | null;
  failed: string | null;
}

/** A project as the rail needs it: what to call it, and its colour. */
interface ProjectRow {
  id: string;
  name: string;
  color: string;
}

/**
 * What the rail shows before the workspace service answers, and if it cannot: the two projects the fleet starts
 * with. The real list, with whatever names and colours the team gave them, replaces it as soon as it arrives.
 */
const PROJECTS: ProjectRow[] = [
  { id: "p1", name: "Northwind rollout", color: "indigo" },
  { id: "p2", name: "Q3 compliance", color: "amber" },
];

/** Where the page opens: what the settings say, and the last project looked at when they say "last". */
function startProject(settings: Settings): string {
  const wanted = settings.startOn === "last" ? safeGet("keel.lastProject") : settings.startOn;
  return PROJECTS.some((p) => p.id === wanted) ? (wanted as string) : PROJECTS[0]!.id;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

@Component({
  selector: "app-root",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgComponentOutlet, Palette, SettingsPage, GuidePage],
  styleUrl: "./app.css",
  template: `
    @if (shareToken) {
      <div class="frame">
        <main class="single share">
          <div class="brand big">
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2 L21 8 V16 L12 22 L3 16 V8 Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
              <path d="M12 7 L16.5 9.8 V14.2 L12 17 L7.5 14.2 V9.8 Z" fill="currentColor" opacity="0.45" />
            </svg>
            <span class="name">Keel</span>
          </div>
          @if (sharePage().component; as component) {
            <ng-container *ngComponentOutlet="component; inputs: { token: shareToken }" />
          } @else if (sharePage().failed; as failed) {
            <div class="card"><div class="body empty"><strong>The shared file cannot be shown</strong>{{ failed }}</div></div>
          } @else {
            <div class="card"><div class="body"><span class="skeleton" style="width: 60%"></span></div></div>
          }
        </main>
      </div>
    } @else if (!me()) {
      <div class="gate">
        <div class="gate-card card">
          <div class="brand big">
            <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2 L21 8 V16 L12 22 L3 16 V8 Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
              <path d="M12 7 L16.5 9.8 V14.2 L12 17 L7.5 14.2 V9.8 Z" fill="currentColor" opacity="0.45" />
            </svg>
            <span class="name">Keel</span>
          </div>
          <h1>Sign in</h1>
          <p class="lede">Choose who you are. Everything you do on the projects is done in that name.</p>
          <ul class="people">
            @for (person of team; track person.handle) {
              <li>
                <button type="button" class="person" (click)="enter(person)">
                  <span class="avatar">{{ initials(person.name) }}</span>
                  <span class="text">
                    <strong>{{ person.name }}</strong>
                    <span class="muted">{{ person.title }} · {{ person.email }}</span>
                  </span>
                  <span class="go" aria-hidden="true">→</span>
                </button>
              </li>
            }
          </ul>
          <p class="note muted">
            This environment signs in without a password. Your organisation's identity provider takes this screen's
            place in production; the rest of the product does not change.
          </p>
        </div>
      </div>
    } @else {
      <div class="shell">
        <nav class="rail">
          <div class="brand">
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2 L21 8 V16 L12 22 L3 16 V8 Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
              <path d="M12 7 L16.5 9.8 V14.2 L12 17 L7.5 14.2 V9.8 Z" fill="currentColor" opacity="0.45" />
            </svg>
            <span class="name">Keel</span>
          </div>

          <p class="eyebrow group">Projects</p>
          @for (project of projects(); track project.id) {
            <button type="button" class="nav" [class.on]="(view() === 'project' || view() === 'project-settings') && project.id === projectId()" (click)="openProject(project.id)">
              <span class="swatch" [attr.data-color]="project.color"></span>
              {{ project.name }}
            </button>
          }

          <p class="eyebrow group">Company</p>
          @for (page of pages(); track page.key) {
            <button type="button" class="nav" [class.on]="view() === page.key" (click)="view.set(page.key)">
              <span class="glyph">{{ page.glyph }}</span>
              {{ page.label }}
            </button>
          }

          <button type="button" class="nav palette-nav" (click)="openPalette()" title="Ctrl K">
            <span class="glyph">⌘</span>
            Anything…
            <kbd>Ctrl K</kbd>
          </button>

          <span class="spacer"></span>

          <div class="account">
            @if (bell().component; as component) {
              <ng-container *ngComponentOutlet="component" />
            }
            <button type="button" class="nav" [class.on]="view() === 'guide'" (click)="view.set('guide')">
              <span class="glyph">?</span>
              What this shows
            </button>
            <button type="button" class="nav" [class.on]="view() === 'settings'" (click)="view.set('settings')">
              <span class="glyph">⚙</span>
              Settings
            </button>
            <button type="button" class="nav" (click)="toggleTheme()">
              <span class="glyph">{{ theme() === "dark" ? "☾" : "☀" }}</span>
              {{ theme() === "dark" ? "Dark" : "Light" }}
            </button>
            <div class="who">
              <span class="avatar">{{ initials(me()!.name) }}</span>
              <span class="text">
                <strong>{{ me()!.name }}</strong>
                <span class="muted">{{ me()!.email }}</span>
              </span>
              <button type="button" class="btn quiet leave" (click)="leave()" title="Sign out">Sign out</button>
            </div>
          </div>
        </nav>

        <div class="frame">
          @if (view() === "settings") {
            <main class="single">
              <keel-settings [value]="settings()" [projects]="projects()" (changed)="applySettings($event)" />
            </main>
          } @else if (view() === "guide") {
            <main class="single">
              <keel-guide (open)="goFromGuide($event)" />
            </main>
          } @else if (view() === "project-settings") {
            <main class="single" (keel-projects)="loadProjects()">
              @if (projectSettings().component; as component) {
                <ng-container *ngComponentOutlet="component; inputs: { projectId: projectId() }" />
              } @else if (projectSettings().failed; as failed) {
                <div class="card">
                  <div class="body empty">
                    <strong>Project settings are unavailable</strong>
                    {{ failed }}
                  </div>
                </div>
              } @else {
                <div class="card">
                  <header><span class="skeleton" style="width: 120px"></span></header>
                  <div class="body"><span class="skeleton" style="width: 80%"></span></div>
                </div>
              }
            </main>
          } @else if (page(); as page) {
            <main class="single">
              @if (page.component; as component) {
                <ng-container *ngComponentOutlet="component" />
              } @else if (page.failed; as failed) {
                <div class="card">
                  <div class="body empty">
                    <strong>{{ page.label }} is unavailable</strong>
                    {{ failed }}
                  </div>
                </div>
              } @else {
                <div class="card">
                  <header><span class="skeleton" style="width: 120px"></span></header>
                  <div class="body"><span class="skeleton" style="width: 80%"></span></div>
                </div>
              }
            </main>
          } @else {
            <header class="topbar">
              <div>
                <h1><span class="swatch big" [attr.data-color]="project().color" aria-hidden="true"></span>{{ project().name }}</h1>
                <p class="path">Projects <span aria-hidden="true">/</span> {{ project().name }}</p>
              </div>
              <button type="button" class="btn quiet" (click)="view.set('project-settings')">
                <span aria-hidden="true">⚙</span> Project settings
              </button>
            </header>

            <main>
              @for (panel of panels(); track panel.key) {
                <section class="slot">
                  @if (panel.component) {
                    <ng-container *ngComponentOutlet="panel.component; inputs: { projectId: projectId() }" />
                  } @else if (panel.failed) {
                    <div class="card">
                      <div class="body empty">
                        <strong>{{ panel.label }} is unavailable</strong>
                        {{ panel.failed }}
                      </div>
                    </div>
                  } @else {
                    <div class="card">
                      <header><span class="skeleton" style="width: 120px"></span></header>
                      <div class="body">
                        <span class="skeleton" style="width: 80%; margin-bottom: 9px"></span>
                        <span class="skeleton" style="width: 55%"></span>
                      </div>
                    </div>
                  }
                </section>
              }
            </main>
          }
        </div>
      </div>

      @if (palette()) {
        <keel-palette
          [actions]="actions()"
          [hints]="settings().hints"
          [quick]="quick().component"
          [projectId]="projectId()"
          [projectName]="project().name"
          [initial]="paletteInitial()"
          (close)="palette.set(false)"
          (did)="say($event)"
        />
      }
      @if (said(); as line) {
        <div class="said card" role="status">{{ line }}</div>
      }
    }
  `,
})
export class App {
  readonly team = TEAM;
  readonly shortcuts = SHORTCUTS;
  readonly me = signal<Person | null>(current());
  readonly initials = initials;

  /** The rail's projects: the workspace service's list, read from its plain REST route, with the fallback until then. */
  readonly projects = signal<ProjectRow[]>(PROJECTS);
  readonly settings = signal<Settings>(loadSettings());
  readonly projectId = signal(startProject(loadSettings()));
  /** What fills the page: a project's panels, or one of the company-wide pages by its key. */
  readonly view = signal<string>("project");
  readonly project = computed(() => this.projects().find((p) => p.id === this.projectId()) ?? this.projects()[0]!);
  // what is actually on screen: a chosen theme if there is one, otherwise whatever the system decided
  readonly theme = signal<"light" | "dark">(
    (document.documentElement.dataset["theme"] as "light" | "dark" | undefined) ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  );

  /**
   * A share link: `?share=<token>` opens one document for whoever holds it, signed in or not. The page is the
   * documents remote's own, so the shell never sees what the token is for; it only knows to show that page and no
   * other, and to ask for no session.
   */
  readonly shareToken = new URLSearchParams(location.search).get("share");
  readonly sharePage = signal<Panel>({ key: "share", label: "Shared file", remote: "documents-ui", exposed: "./Shared", component: null, failed: null });

  readonly panels = signal<Panel[]>([
    { key: "issues", label: "Issues", remote: "workspace-ui", exposed: "./Issues", component: null, failed: null },
    { key: "documents", label: "Documents", remote: "documents-ui", exposed: "./Documents", component: null, failed: null },
    { key: "activity", label: "Activity", remote: "workspace-ui", exposed: "./Feed", component: null, failed: null },
    { key: "chat", label: "Chat", remote: "workspace-ui", exposed: "./Chat", component: null, failed: null },
  ]);
  /** Whole pages from one remote each, rather than panels among others: the company's, not a project's. */
  readonly pages = signal<Array<Panel & { glyph: string }>>([
    { key: "catalogue", label: "Catalogue", glyph: "\u2315", remote: "catalogue-ui", exposed: "./Catalogue", component: null, failed: null },
    { key: "people", label: "People", glyph: "\u25CE", remote: "workspace-ui", exposed: "./People", component: null, failed: null },
  ]);
  readonly page = computed(() => this.pages().find((p) => p.key === this.view()) ?? null);
  /** The bell in the rail: the person's, not a project's, so it is on every page. A missing remote is a missing bell. */
  readonly bell = signal<Panel>({ key: "bell", label: "Notifications", remote: "workspace-ui", exposed: "./Notifications", component: null, failed: null });
  /** The palette's "do" entries come from the workspace team, like a panel: the shell has no client to do them with. */
  readonly quick = signal<Panel>({ key: "quick", label: "Quick actions", remote: "workspace-ui", exposed: "./Quick", component: null, failed: null });
  /** A project's own settings page, from the workspace team like the panels. */
  readonly projectSettings = signal<Panel>({ key: "project-settings", label: "Project settings", remote: "workspace-ui", exposed: "./ProjectSettings", component: null, failed: null });

  readonly palette = signal(false);
  readonly paletteInitial = signal("");
  /** What the palette last did, shown for a moment where a toast would be. */
  readonly said = signal<string | null>(null);
  /** The first key of a two-key shortcut, while the second is awaited. */
  private chord: string | null = null;

  /** Everything the shell itself can do, for the palette. */
  readonly actions = computed<Action[]>(() => [
    ...this.projects().map((p, i) => ({ id: `project:${p.id}`, label: p.name, hint: "Project", keys: ["g", String(i + 1)], run: () => this.openProject(p.id) })),
    { id: "project-settings", label: "Project settings", hint: this.project().name, run: () => this.view.set("project-settings") },
    ...this.pages().map((p) => ({ id: `page:${p.key}`, label: p.label, hint: "Company", keys: ["g", p.key[0]!], run: () => this.view.set(p.key) })),
    { id: "guide", label: "What this shows", hint: "The guide to every Rayfold feature on this page", keys: ["?"], run: () => this.view.set("guide") },
    { id: "settings", label: "Settings", hint: "Theme, toasts, where the page opens", keys: ["g", "s"], run: () => this.view.set("settings") },
    { id: "theme", label: this.theme() === "dark" ? "Switch to light" : "Switch to dark", hint: "Theme", keys: ["t"], run: () => this.toggleTheme() },
    { id: "signout", label: "Sign out", hint: this.me()?.name ?? "", run: () => this.leave() },
  ]);

  constructor() {
    // a share link loads one remote and nothing else: the person may not be on the team, and the rest of the page is theirs
    if (!this.shareToken) void this.loadProjects();
    for (const panel of this.shareToken ? [this.sharePage()] : [...this.panels(), ...this.pages(), this.bell(), this.quick(), this.projectSettings()]) {
      // one remote failing is one panel missing, not a blank page: each is loaded and settled on its own
      void loadRemoteModule(panel.remote, panel.exposed)
        .then((m: Record<string, Type<unknown>>) => this.settle(panel.key, Object.values(m)[0] ?? null, null))
        .catch((e: unknown) => this.settle(panel.key, null, e instanceof Error ? e.message : String(e)));
    }
  }

  private settle(key: string, component: Type<unknown> | null, failed: string | null): void {
    if (key === this.sharePage().key) this.sharePage.update((p) => ({ ...p, component, failed }));
    else if (key === this.bell().key) this.bell.update((p) => ({ ...p, component, failed }));
    else if (key === this.quick().key) this.quick.update((p) => ({ ...p, component, failed }));
    else if (key === this.projectSettings().key) this.projectSettings.update((p) => ({ ...p, component, failed }));
    else if (this.pages().some((p) => p.key === key)) this.pages.update((pages) => pages.map((p) => (p.key === key ? { ...p, component, failed } : p)));
    else this.panels.update((panels) => panels.map((p) => (p.key === key ? { ...p, component, failed } : p)));
  }

  /**
   * The rail's list from the workspace service. A plain GET on a route the schema binds (`@http`), because the shell
   * keeps no Rayfold client of its own: the session cookie goes with it like any same-origin request. A service that
   * does not answer leaves the rail as it was.
   */
  async loadProjects(): Promise<void> {
    try {
      const res = await fetch("/api/workspace/projects", { headers: { accept: "application/json" } });
      if (!res.ok) return;
      const rows = (await res.json()) as ProjectRow[];
      if (rows.length) this.projects.set(rows.map((p) => ({ id: p.id, name: p.name, color: p.color })));
    } catch {
      // the fallback list stays; the panels still work, only a renamed project shows its old name
    }
  }

  openProject(id: string): void {
    this.projectId.set(id);
    this.view.set("project");
    try {
      localStorage.setItem("keel.lastProject", id);
    } catch {
      // then the page opens on the first project next time, which is no worse than before
    }
  }

  goFromGuide(view: string): void {
    if (view === "project") this.openProject(this.projectId());
    else this.view.set(view);
  }

  openPalette(initial = ""): void {
    this.paletteInitial.set(initial);
    this.palette.set(true);
  }

  say(line: string): void {
    this.said.set(line);
    setTimeout(() => this.said.update((s) => (s === line ? null : s)), 4000);
  }

  applySettings(next: Settings): void {
    this.settings.set(next);
    saveSettings(next);
    applyTheme(next.theme);
    this.theme.set(next.theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : next.theme);
  }

  /**
   * The keyboard, page-wide. Nothing fires while a field has focus, except the palette's own key: a person typing
   * "g" into a chat must not be taken to a project. Two-key shortcuts start with g and wait one second for the rest.
   */
  @HostListener("document:keydown", ["$event"])
  onKey(event: KeyboardEvent): void {
    if (!this.me() || this.shareToken) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      this.palette.update((open) => !open);
      return;
    }
    if (this.palette()) return;
    const target = event.target as HTMLElement | null;
    const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
    if (typing || event.ctrlKey || event.metaKey || event.altKey) return;

    if (this.chord === "g") {
      this.chord = null;
      const n = Number(event.key);
      if (n >= 1 && n <= this.projects().length) return this.openProject(this.projects()[n - 1]!.id);
      if (event.key === "s") return this.view.set("settings");
      const page = this.pages().find((p) => p.key[0] === event.key);
      if (page) this.view.set(page.key);
      return;
    }
    switch (event.key) {
      case "g":
        this.chord = "g";
        setTimeout(() => (this.chord = null), 1000);
        break;
      case "/":
        event.preventDefault();
        this.openPalette();
        break;
      case "?":
        this.view.set("guide");
        break;
      case "t":
        this.toggleTheme();
        break;
      case "Escape":
        if (this.view() === "settings" || this.view() === "guide") this.view.set("project");
        break;
    }
  }

  enter(person: Person): void {
    signIn(person);
    // the panels are created after this, so every call they make carries the session from the first
    this.me.set(current());
  }

  leave(): void {
    signOut();
    // the panels go with the page: their live queries end with them, and nothing is left open in the old name
    this.me.set(null);
  }

  toggleTheme(): void {
    const next = this.theme() === "dark" ? "light" : "dark";
    this.applySettings({ ...this.settings(), theme: next });
  }
}

/**
 * The shell.
 *
 * It owns the page, the session and the project switcher — and none of the features. Each panel is loaded at
 * runtime from a remote the owning team deploys on its own, which is the point of the arrangement: the workspace
 * team ships a new feed without this application being rebuilt or redeployed.
 */
import { ChangeDetectionStrategy, Component, computed, signal, type Type } from "@angular/core";
import { NgComponentOutlet } from "@angular/common";
import { loadRemoteModule } from "@angular-architects/native-federation";
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

const PROJECTS = [
  { id: "p1", name: "Northwind rollout" },
  { id: "p2", name: "Q3 compliance" },
];

@Component({
  selector: "app-root",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgComponentOutlet],
  styleUrl: "./app.css",
  template: `
    @if (!me()) {
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
          @for (project of projects; track project.id) {
            <button type="button" class="nav" [class.on]="view() === 'project' && project.id === projectId()" (click)="openProject(project.id)">
              <span class="swatch" [attr.data-project]="project.id"></span>
              {{ project.name }}
            </button>
          }

          <p class="eyebrow group">Company</p>
          <button type="button" class="nav" [class.on]="view() === 'catalogue'" (click)="view.set('catalogue')">
            <span class="glyph">⌕</span>
            Catalogue
          </button>

          <span class="spacer"></span>

          <div class="account">
            @if (bell().component; as component) {
              <ng-container *ngComponentOutlet="component" />
            }
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
          @if (view() === "catalogue") {
            <main class="single">
              @if (catalogue().component; as component) {
                <ng-container *ngComponentOutlet="component" />
              } @else if (catalogue().failed; as failed) {
                <div class="card">
                  <div class="body empty">
                    <strong>The catalogue is unavailable</strong>
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
                <h1>{{ project().name }}</h1>
                <p class="path">Projects <span aria-hidden="true">/</span> {{ project().name }}</p>
              </div>
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
    }
  `,
})
export class App {
  readonly team = TEAM;
  readonly me = signal<Person | null>(current());
  readonly initials = initials;

  readonly projects = PROJECTS;
  readonly projectId = signal(PROJECTS[0]!.id);
  /** What fills the page: a project's panels, or the company-wide catalogue. */
  readonly view = signal<"project" | "catalogue">("project");
  readonly project = computed(() => this.projects.find((p) => p.id === this.projectId()) ?? this.projects[0]!);
  // what is actually on screen: a chosen theme if there is one, otherwise whatever the system decided
  readonly theme = signal<"light" | "dark">(
    (document.documentElement.dataset["theme"] as "light" | "dark" | undefined) ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  );

  readonly panels = signal<Panel[]>([
    { key: "issues", label: "Issues", remote: "workspace-ui", exposed: "./Issues", component: null, failed: null },
    { key: "documents", label: "Documents", remote: "documents-ui", exposed: "./Documents", component: null, failed: null },
    { key: "activity", label: "Activity", remote: "workspace-ui", exposed: "./Feed", component: null, failed: null },
    { key: "chat", label: "Chat", remote: "workspace-ui", exposed: "./Chat", component: null, failed: null },
  ]);
  /** A whole page from one remote, rather than a panel among others. */
  readonly catalogue = signal<Panel>({ key: "catalogue", label: "Catalogue", remote: "catalogue-ui", exposed: "./Catalogue", component: null, failed: null });
  /** The bell in the rail: the person's, not a project's, so it is on every page. A missing remote is a missing bell. */
  readonly bell = signal<Panel>({ key: "bell", label: "Notifications", remote: "workspace-ui", exposed: "./Notifications", component: null, failed: null });

  constructor() {
    for (const panel of [...this.panels(), this.catalogue(), this.bell()]) {
      // one remote failing is one panel missing, not a blank page: each is loaded and settled on its own
      void loadRemoteModule(panel.remote, panel.exposed)
        .then((m: Record<string, Type<unknown>>) => this.settle(panel.key, Object.values(m)[0] ?? null, null))
        .catch((e: unknown) => this.settle(panel.key, null, e instanceof Error ? e.message : String(e)));
    }
  }

  private settle(key: string, component: Type<unknown> | null, failed: string | null): void {
    if (key === this.catalogue().key) this.catalogue.update((p) => ({ ...p, component, failed }));
    else if (key === this.bell().key) this.bell.update((p) => ({ ...p, component, failed }));
    else this.panels.update((panels) => panels.map((p) => (p.key === key ? { ...p, component, failed } : p)));
  }

  openProject(id: string): void {
    this.projectId.set(id);
    this.view.set("project");
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
    this.theme.set(next);
    document.documentElement.dataset["theme"] = next;
    try {
      localStorage.setItem("keel.theme", next);
    } catch {
      // a browser that refuses storage still gets the theme for this visit, which is the part that matters
    }
  }
}

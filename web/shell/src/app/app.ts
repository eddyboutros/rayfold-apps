/**
 * The shell.
 *
 * It owns the page, the Rayfold client and who is signed in — and none of the features. Each panel is loaded at
 * runtime from a remote the owning team deploys on its own, which is the point of the arrangement: the workspace
 * team ships a new feed without this application being rebuilt or redeployed.
 */
import { ChangeDetectionStrategy, Component, computed, signal, type Type } from "@angular/core";
import { NgComponentOutlet } from "@angular/common";
import { loadRemoteModule } from "@angular-architects/native-federation";

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
          <button type="button" class="nav" [class.on]="project.id === projectId()" (click)="projectId.set(project.id)">
            <span class="swatch" [attr.data-project]="project.id"></span>
            {{ project.name }}
          </button>
        }

        <span class="spacer"></span>

        <div class="account">
          <button type="button" class="nav" (click)="toggleTheme()">
            <span class="glyph">{{ theme() === "dark" ? "☾" : "☀" }}</span>
            {{ theme() === "dark" ? "Dark" : "Light" }}
          </button>
          <div class="who">
            <span class="avatar">A</span>
            <span>
              <strong>Ada Lovelace</strong>
              <span class="muted">ada&#64;keel.example</span>
            </span>
          </div>
        </div>
      </nav>

      <div class="frame">
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
      </div>
    </div>
  `,
})
export class App {
  readonly projects = PROJECTS;
  readonly projectId = signal(PROJECTS[0]!.id);
  readonly project = computed(() => this.projects.find((p) => p.id === this.projectId()) ?? this.projects[0]!);
  // what is actually on screen: a chosen theme if there is one, otherwise whatever the system decided
  readonly theme = signal<"light" | "dark">(
    (document.documentElement.dataset["theme"] as "light" | "dark" | undefined) ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  );

  readonly panels = signal<Panel[]>([
    { key: "documents", label: "Documents", remote: "documents-ui", exposed: "./Documents", component: null, failed: null },
    { key: "activity", label: "Activity", remote: "workspace-ui", exposed: "./Feed", component: null, failed: null },
  ]);

  constructor() {
    for (const panel of this.panels()) {
      // one remote failing is one panel missing, not a blank page: each is loaded and settled on its own
      void loadRemoteModule(panel.remote, panel.exposed)
        .then((m: Record<string, Type<unknown>>) => this.settle(panel.key, Object.values(m)[0] ?? null, null))
        .catch((e: unknown) => this.settle(panel.key, null, e instanceof Error ? e.message : String(e)));
    }
  }

  private settle(key: string, component: Type<unknown> | null, failed: string | null): void {
    this.panels.update((panels) => panels.map((p) => (p.key === key ? { ...p, component, failed } : p)));
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

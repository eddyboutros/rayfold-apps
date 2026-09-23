/**
 * One project's settings: its name, what it is for, its colour, and who takes an issue nobody was named for.
 *
 * The project is a live query, so an edit made on another screen shows here as it lands; the form sends only what
 * its person touched, with the version it read, so two people changing the settings at once cannot both win — the
 * second is told, and the page already shows what the first one did. The shell's rail reads its list from a plain
 * REST route and keeps no Rayfold client, so a save also tells the page around this one, with an event, that the
 * projects changed.
 */
import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, signal } from "@angular/core";
import { injectCommand, injectLive, injectQuery, provideRayfold } from "@rayfold/angular";
import { workspaceClient } from "./client";

type Color = "indigo" | "amber" | "teal" | "rose" | "violet" | "slate";

interface Project {
  id: string;
  name: string;
  description: string | null;
  color: Color;
  version: number;
  updatedAt: number;
  defaultAssignee: { id: string; name: string } | null;
}

interface Changes {
  name?: string;
  description?: string | null;
  color?: Color;
  defaultAssigneeId?: string | null;
}

const COLORS: Color[] = ["indigo", "amber", "teal", "rose", "violet", "slate"];

@Component({
  selector: "workspace-project-settings",
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [provideRayfold(workspaceClient())],
  styleUrl: "./project-settings.css",
  template: `
    <div class="head">
      <div>
        <p class="eyebrow">Project settings</p>
        <h1>{{ project()?.name ?? "…" }}</h1>
        <p class="lede">What the rail calls this project, what it is for, and who takes an issue nobody was named for. Everyone on the team can change them.</p>
      </div>
      @if (load.error()) {
        <span class="pill bad"><span class="dot"></span>disconnected</span>
      } @else if (project()) {
        <span class="pill ok live"><span class="dot"></span>live</span>
      }
    </div>

    @if (load.error(); as e) {
      <div class="card"><div class="body empty"><strong>Could not load the project</strong>{{ describe(e) }}</div></div>
    } @else if (project(); as p) {
      <form class="card" (submit)="save($event, p)">
        <div class="body">
          <label class="row">
            <span class="label"><strong>Name</strong><span class="muted">What the rail and the page title say.</span></span>
            <input class="input" name="name" [value]="p.name" (input)="touch('name', $any($event.target).value)" maxlength="80" required autocomplete="off" />
          </label>

          <label class="row">
            <span class="label"><strong>Description</strong><span class="muted">One or two sentences: what done looks like.</span></span>
            <textarea class="input" name="description" rows="3" maxlength="500" [value]="p.description ?? ''" (input)="touch('description', $any($event.target).value || null)"></textarea>
          </label>

          <div class="row">
            <span class="label"><strong>Colour</strong><span class="muted">The swatch beside it in the rail.</span></span>
            <span class="colors" role="radiogroup" aria-label="Colour">
              @for (c of colors; track c) {
                <button
                  type="button"
                  class="color"
                  role="radio"
                  [attr.data-color]="c"
                  [attr.aria-checked]="color(p) === c"
                  [attr.aria-label]="c"
                  [title]="c"
                  (click)="touch('color', c)"
                ></button>
              }
            </span>
          </div>

          <label class="row">
            <span class="label">
              <strong>Default assignee</strong>
              <span class="muted">Takes a new issue when whoever opens it names nobody.</span>
            </span>
            <select name="defaultAssignee" (change)="touch('defaultAssigneeId', $any($event.target).value || null)">
              <option value="" [selected]="!p.defaultAssignee">Nobody: new issues wait to be picked up</option>
              @for (m of members(); track m.id) {
                <option [value]="m.id" [selected]="p.defaultAssignee?.id === m.id">{{ m.name }}</option>
              }
            </select>
          </label>
        </div>

        <footer>
          <span class="muted version">Version {{ p.version }} · changed {{ when(p.updatedAt) }}</span>
          @if (failed(); as message) {
            <span class="bad" role="alert">{{ message }}</span>
          } @else if (saved()) {
            <span class="ok-text" role="status">Saved.</span>
          }
          @if (touched().length) {
            <button type="button" class="btn quiet" (click)="discard()">Discard</button>
          }
          <button type="submit" class="btn primary" [disabled]="!touched().length || update.running()">
            {{ update.running() ? "Saving…" : "Save changes" }}
          </button>
        </footer>
      </form>
    } @else {
      <div class="card"><div class="body"><span class="skeleton" style="width: 60%"></span></div></div>
    }
  `,
})
export class ProjectSettings {
  readonly projectId = input<string>("");
  private readonly host = inject(ElementRef<HTMLElement>);
  readonly colors = COLORS;

  readonly load = injectLive<Project | null>("project", () => ({ id: this.projectId() }), {
    shape: "{ id name description color version updatedAt defaultAssignee { id name } }",
    enabled: () => this.projectId() !== "",
  });
  readonly roster = injectQuery<Array<{ id: string; name: string }>>("members", {}, { shape: "{ id name }" });
  readonly update = injectCommand<Project>("updateProject");

  readonly project = computed(() => this.load.data() ?? null);
  readonly members = computed(() => this.roster.data() ?? []);
  /** What the form has changed and not yet saved: only these keys are sent. */
  readonly changes = signal<Changes>({});
  readonly touched = computed(() => Object.keys(this.changes()));
  readonly failed = signal<string | null>(null);
  readonly saved = signal(false);

  /** The colour on screen: the one picked and not saved yet, or the project's. */
  color(p: Project): Color {
    return this.changes().color ?? p.color;
  }

  touch<K extends keyof Changes>(key: K, value: Changes[K]): void {
    this.changes.update((c) => ({ ...c, [key]: value }));
    this.saved.set(false);
  }

  discard(): void {
    this.changes.set({});
    this.failed.set(null);
    // the fields read their first value only; reloading the query puts every one back
    const form = this.host.nativeElement.querySelector("form");
    form?.reset();
  }

  async save(event: Event, p: Project): Promise<void> {
    event.preventDefault();
    const changes = this.changes();
    if (!Object.keys(changes).length) return;
    this.failed.set(null);
    try {
      await this.update.run({ id: p.id, changes }, { ifVersion: p.version, shape: "{ id name color version }" });
      this.changes.set({});
      this.saved.set(true);
      // the rail keeps no Rayfold client: it is told, and reads its list again
      this.host.nativeElement.dispatchEvent(new CustomEvent("keel-projects", { bubbles: true, composed: true }));
    } catch (e: unknown) {
      this.failed.set(this.describe(e));
    }
  }

  when(at: number): string {
    return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  describe(e: unknown): string {
    const code = (e as { code?: string }).code;
    if (code === "failed_precondition") return "Someone changed these settings while you were editing. The page shows theirs now; make your change again.";
    return e instanceof Error ? e.message : String(e);
  }
}

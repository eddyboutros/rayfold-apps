/**
 * The people page: who is on the team, and what each of them holds across every project.
 *
 * One live query, `workload`, computed by the service in one statement over every project's issues. Nothing on this
 * page is an entity the counts name, so a command cannot patch it into being right; instead each command that
 * changes an issue names the operation in its patch (`invOp: ["workload"]`) and every open copy of this page
 * re-runs. That is the other half of live queries: an entity's fields update by key, an aggregate by name.
 */
import { ChangeDetectionStrategy, Component, computed } from "@angular/core";
import { injectLive, provideRayfold } from "@rayfold/angular";
import { workspaceClient } from "./client";

export interface Workload {
  member: { id: string; name: string; title: string | null; email: string | null };
  open: number;
  doing: number;
  done: number;
  overdue: number;
}

@Component({
  selector: "workspace-people",
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [provideRayfold(workspaceClient())],
  styleUrl: "./people.css",
  template: `
    <div class="head">
      <div>
        <h1>People</h1>
        <p class="lede">Everyone on the team, and what each of them holds across the projects. It follows every hand-over.</p>
      </div>
      @if (load.error()) {
        <span class="pill bad"><span class="dot"></span>disconnected</span>
      } @else if (load.loading() && !people().length) {
        <span class="pill"><span class="dot"></span>connecting</span>
      } @else {
        <span class="pill ok live"><span class="dot"></span>live</span>
      }
    </div>

    <div class="totals">
      <div class="total">
        <span class="num big">{{ sum("open") + sum("doing") }}</span>
        <span class="muted">in flight</span>
      </div>
      <div class="total">
        <span class="num big">{{ sum("doing") }}</span>
        <span class="muted">in progress</span>
      </div>
      <div class="total" [class.hot]="sum('overdue') > 0">
        <span class="num big">{{ sum("overdue") }}</span>
        <span class="muted">overdue</span>
      </div>
      <div class="total">
        <span class="num big">{{ sum("done") }}</span>
        <span class="muted">done</span>
      </div>
    </div>

    @if (load.error(); as e) {
      <div class="card"><div class="body empty"><strong>Could not load the team</strong>{{ describe(e) }}</div></div>
    } @else {
      <div class="grid">
        @for (w of people(); track w.member.id) {
          <article class="card person" [class.free]="w.open + w.doing === 0">
            <div class="who">
              <span class="avatar" [attr.data-person]="w.member.id" aria-hidden="true">{{ initials(w.member.name) }}</span>
              <span class="text">
                <strong>{{ w.member.name }}</strong>
                <span class="muted">{{ w.member.title ?? "" }}</span>
                @if (w.member.email; as email) {
                  <a class="muted mail" [href]="'mailto:' + email">{{ email }}</a>
                }
              </span>
            </div>
            <div class="bar" role="img" [attr.aria-label]="w.doing + ' in progress, ' + w.open + ' open, ' + w.done + ' done'">
              <span class="seg doing" [style.flex]="w.doing"></span>
              <span class="seg open" [style.flex]="w.open"></span>
              <span class="seg done" [style.flex]="w.done"></span>
              @if (w.open + w.doing + w.done === 0) {
                <span class="seg none" style="flex: 1"></span>
              }
            </div>
            <dl class="counts">
              <div><dt class="muted">In progress</dt><dd class="num">{{ w.doing }}</dd></div>
              <div><dt class="muted">Open</dt><dd class="num">{{ w.open }}</dd></div>
              <div><dt class="muted">Done</dt><dd class="num">{{ w.done }}</dd></div>
              <div [class.hot]="w.overdue > 0"><dt class="muted">Overdue</dt><dd class="num">{{ w.overdue }}</dd></div>
            </dl>
            @if (w.open + w.doing === 0) {
              <p class="note muted">Holds nothing right now. A good person to hand something to.</p>
            } @else if (w.overdue > 0) {
              <p class="note bad">{{ w.overdue === 1 ? "One issue past its day." : w.overdue + " issues past their day." }}</p>
            }
          </article>
        }
      </div>
    }
  `,
})
export class People {
  readonly load = injectLive<Workload[]>("workload", {}, { shape: "{ member { id name title email } open doing done overdue }" });
  readonly people = computed(() => this.load.data() ?? []);

  sum(key: "open" | "doing" | "done" | "overdue"): number {
    return this.people().reduce((n, w) => n + w[key], 0);
  }

  initials(name: string): string {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0] ?? "")
      .join("")
      .toUpperCase();
  }

  describe(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }
}

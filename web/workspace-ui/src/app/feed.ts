/**
 * A project's feed, live.
 *
 * `injectLive` subscribes through the Rayfold client and returns signals. The server keeps the query open and pushes
 * a new answer whenever the op's result changes — including when the change was caused by a *different service*,
 * because the workspace service records what it hears on the relay. So a document uploaded somewhere else appears
 * here with no polling, no refresh and no socket of this component's own.
 */
import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import { injectLive } from "@rayfold/angular";

export interface Line {
  id: string;
  source: string;
  kind: string;
  text: string;
  at: number;
}

@Component({
  selector: "workspace-feed",
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: "./feed.css",
  template: `
    <section class="feed">
      <header>
        <h2>Activity</h2>
        <span class="state" [class.on]="!feed.loading()">{{ feed.loading() ? "connecting" : "live" }}</span>
      </header>

      @if (!projectId()) {
        <p class="muted">No project selected.</p>
      } @else if (feed.error()) {
        <p role="alert" class="bad">The feed stopped: {{ message() }}</p>
      } @else if (feed.loading() && !lines().length) {
        <p class="muted">Opening the feed…</p>
      } @else if (!lines().length) {
        <p class="muted">Nothing has happened on this project yet.</p>
      } @else {
        <ol>
          @for (line of lines(); track line.id) {
            <li>
              <span class="source" [attr.data-source]="line.source">{{ line.source }}</span>
              <span class="text">{{ line.text }}</span>
              <time [attr.datetime]="line.at">{{ when(line.at) }}</time>
            </li>
          }
        </ol>
      }
    </section>
  `,
})
export class Feed {
  /**
   * Not `input.required`. `injectLive` reads its arguments the moment it is injected — which is the behaviour you
   * want, since the query is then already in flight — and a required input is not readable that early: it throws
   * NG0950 during field initialisation. So the input carries a default and `enabled` waits for the real one.
   */
  readonly projectId = input<string>("");

  // both are functions, so they are read reactively: the query starts by itself once the id arrives, and re-runs
  // if it ever changes
  readonly feed = injectLive<{ items: Line[] }>("activity", () => ({ projectId: this.projectId() }), {
    shape: "{ items { id source kind text at } }",
    enabled: () => this.projectId() !== "",
  });

  readonly lines = computed(() => this.feed.data()?.items ?? []);

  message(): string {
    const e = this.feed.error();
    return e instanceof Error ? e.message : String(e);
  }

  when(at: number): string {
    return new Date(at).toLocaleTimeString();
  }
}

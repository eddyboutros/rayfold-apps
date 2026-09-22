/**
 * A project's feed, live.
 *
 * `injectLive` keeps the query open and the server pushes a new answer whenever the result changes — including
 * when the cause was a *different service*, because the workspace service records what it hears on the relay. So a
 * document uploaded in the panel next to this one appears here with no polling, no refresh and no socket of this
 * component's own.
 */
import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import { injectLive, provideRayfold } from "@rayfold/angular";
import { workspaceClient } from "./client";

export interface Line {
  id: string;
  source: string;
  kind: string;
  text: string;
  at: number;
  by: { id: string; name: string } | null;
}

const KIND_LABEL: Record<string, string> = {
  "document.added": "added a file",
  "document.replaced": "replaced a file",
  "document.indexed": "made searchable",
  "document.empty": "found nothing to index in",
  "issue.created": "opened",
  "issue.moved": "moved",
  "issue.assigned": "handed over",
  "issue.edited": "changed",
  "comment.added": "commented on",
};

@Component({
  selector: "workspace-feed",
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [provideRayfold(workspaceClient())],
  styleUrl: "./feed.css",
  template: `
    <section class="card">
      <header>
        <h2>Activity</h2>
        @if (feed.error()) {
          <span class="pill bad"><span class="dot"></span>disconnected</span>
        } @else if (feed.loading() && !lines().length) {
          <span class="pill"><span class="dot"></span>connecting</span>
        } @else {
          <span class="pill ok live"><span class="dot"></span>live</span>
        }
      </header>

      <div class="body">
        @if (!projectId()) {
          <div class="empty"><strong>No project selected</strong></div>
        } @else if (feed.error()) {
          <div class="empty">
            <strong>The feed stopped</strong>
            {{ message() }}
          </div>
        } @else if (feed.loading() && !lines().length) {
          @for (row of [1, 2, 3]; track row) {
            <div class="row"><span class="skeleton" style="width: 62%"></span></div>
          }
        } @else if (!lines().length) {
          <div class="empty">
            <strong>Nothing yet</strong>
            Files added, issues opened and comments left on this project will show up here as they happen.
          </div>
        } @else {
          <ol>
            @for (line of lines(); track line.id) {
              <li class="row">
                <span class="avatar" [attr.data-person]="line.by?.id" aria-hidden="true">{{ initials(line) }}</span>
                <span class="what">
                  <span class="who">{{ line.by?.name ?? "Keel" }}</span>
                  <span class="verb">{{ verb(line.kind) }}</span>
                  <span class="text">{{ subject(line) }}</span>
                  @if (detail(line); as more) {
                    <span class="more muted">{{ more }}</span>
                  }
                </span>
                <span class="when">
                  @if (line.source !== "workspace") {
                    <span class="source pill" [attr.data-source]="line.source">{{ line.source }}</span>
                  }
                  <time [attr.datetime]="line.at">{{ when(line.at) }}</time>
                </span>
              </li>
            }
          </ol>
        }
      </div>
    </section>
  `,
})
export class Feed {
  /**
   * Not `input.required`: `injectLive` reads its arguments the moment it is injected, which is the behaviour you
   * want, and a required input is not readable that early (NG0950). A default, and `enabled` waits for the real one.
   */
  readonly projectId = input<string>("");

  readonly feed = injectLive<{ items: Line[] }>("activity", () => ({ projectId: this.projectId() }), {
    shape: "{ items { id source kind text at by { id name } } }",
    enabled: () => this.projectId() !== "",
  });

  readonly lines = computed(() => this.feed.data()?.items ?? []);

  verb(kind: string): string {
    return KIND_LABEL[kind] ?? kind;
  }

  initials(line: Line): string {
    const name = line.by?.name;
    if (!name) return "K";
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0] ?? "")
      .join("")
      .toUpperCase();
  }

  /** The text minus the id in brackets the service appends: a person reads the name, a log reads the id. */
  private clean(line: Line): string {
    return line.text.replace(/\s*\([0-9a-f-]{20,}\)\s*$/i, "");
  }

  /** What was acted on: the issue's title, or the file's name. */
  subject(line: Line): string {
    const text = this.clean(line);
    if (line.kind === "document.replaced") return text.replace(/, now version \d+$/, "");
    if (line.kind.startsWith("issue.") || line.kind.startsWith("comment.")) return text.split(": ")[0] ?? text;
    return text;
  }

  /** What happened to it, when the line says more than its subject: where it moved, what was said, which version. */
  detail(line: Line): string {
    const text = this.clean(line);
    if (line.kind === "document.replaced") return text.match(/now version \d+$/)?.[0] ?? "";
    if (line.kind.startsWith("issue.") || line.kind.startsWith("comment.")) {
      const i = text.indexOf(": ");
      if (i < 0) return "";
      const rest = text.slice(i + 2);
      if (line.kind === "issue.assigned") return `to ${rest}`;
      if (line.kind === "comment.added") return `“${rest}”`;
      return rest;
    }
    return "";
  }

  message(): string {
    const e = this.feed.error();
    return e instanceof Error ? e.message : String(e);
  }

  when(at: number): string {
    const d = new Date(at);
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
}

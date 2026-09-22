/**
 * What a document was before: every revision, newest first, each still readable at its own URL.
 *
 * Opened inside the list, so it asks only for the one document someone is looking at.
 */
import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import { injectQuery } from "@rayfold/angular";

export interface Revision {
  id: string;
  version: number;
  size: number;
  url: string;
  at: number;
  by: { name: string } | null;
}

@Component({
  selector: "documents-history",
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: "./history.css",
  template: `
    <div class="history">
      @if (page.error(); as e) {
        <p class="bad" role="alert">The revisions could not be loaded: {{ describe(e) }}</p>
      } @else if (page.loading() && !revisions().length) {
        <span class="skeleton" style="width: 44%"></span>
      } @else {
        <ol>
          @for (r of revisions(); track r.id) {
            <li>
              <span class="v">v{{ r.version }}</span>
              <span class="who">{{ r.by?.name ?? "someone" }}</span>
              <time [attr.datetime]="r.at">{{ when(r.at) }}</time>
              <span class="size muted">{{ size(r.size) }}</span>
              <a [href]="href(r)" target="_blank" rel="noreferrer">Open</a>
            </li>
          }
        </ol>
      }
    </div>
  `,
})
export class History {
  readonly documentId = input<string>("");
  readonly base = input<string>("");

  readonly page = injectQuery<{ items: Revision[] }>("revisions", () => ({ documentId: this.documentId() }), {
    shape: "{ items { id version size url at by { name } } }",
    enabled: () => this.documentId() !== "",
  });

  readonly revisions = computed(() => this.page.data()?.items ?? []);

  describe(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  href(r: Revision): string {
    return r.url.startsWith("http") ? r.url : `${this.base()}${r.url}`;
  }

  size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  when(at: number): string {
    return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
}

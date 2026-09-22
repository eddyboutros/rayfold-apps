/**
 * The documents panel, owned by the team that owns the documents service.
 *
 * It talks to its *own* service, on its own origin, with a client it provides itself. That is what keeps a
 * micro-frontend honest: the panel and the service it reads ship together, and no other team — including whoever
 * owns the page it lands on — has to know either exists.
 */
import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { injectCommand, injectQuery, injectRayfoldClient, provideRayfold } from "@rayfold/angular";
import { documentsClient, documentsOrigin } from "./client";

export interface Doc {
  id: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
  version: number;
  updatedAt: number;
}

@Component({
  selector: "documents-panel",
  changeDetection: ChangeDetectionStrategy.OnPush,
  // the remote provides its own client, so this panel is the same component wherever it is dropped
  providers: [provideRayfold(documentsClient())],
  styleUrl: "./documents.css",
  template: `
    <section class="card">
      <header>
        <h2>Documents</h2>
        @if (busy()) {
          <span class="pill"><span class="dot"></span>uploading</span>
        } @else {
          <span class="muted count">{{ items().length }} {{ items().length === 1 ? "file" : "files" }}</span>
        }
      </header>

      <div
        class="drop"
        [class.over]="over()"
        (dragover)="$event.preventDefault(); over.set(true)"
        (dragleave)="over.set(false)"
        (drop)="onDrop($event)"
      >
        <label class="picker">
          <input type="file" (change)="onPick($event)" hidden />
          <span class="btn">Choose a file</span>
        </label>
        <span class="muted">or drop one here</span>
      </div>

      @if (failed(); as message) {
        <p class="body bad" role="alert">{{ message }}</p>
      }

      <div class="body list">
        @if (page.loading() && !items().length) {
          @for (row of [1, 2, 3]; track row) {
            <span class="skeleton" style="width: 70%"></span>
          }
        } @else if (!items().length) {
          <div class="empty">
            <strong>No files yet</strong>
            Whatever you add here shows up on the project's activity feed.
          </div>
        } @else {
          <ol>
            @for (doc of items(); track doc.id) {
              <li>
                <span class="glyph" aria-hidden="true">▤</span>
                <span class="meta">
                  <a [href]="href(doc)" target="_blank" rel="noreferrer">{{ doc.name }}</a>
                  <span class="muted sub">{{ size(doc.size) }} · v{{ doc.version }} · {{ when(doc.updatedAt) }}</span>
                </span>
                <span class="row-actions">
                  <button type="button" class="btn quiet" (click)="share(doc)" [disabled]="sharing() === doc.id">
                    {{ shared() === doc.id ? "Link copied" : "Share" }}
                  </button>
                </span>
              </li>
            }
          </ol>
        }
      </div>
    </section>
  `,
})
export class Documents {
  readonly projectId = input<string>("");

  private readonly client = injectRayfoldClient();
  private readonly origin = documentsOrigin();

  readonly over = signal(false);
  readonly busy = signal(false);
  readonly failed = signal<string | null>(null);
  readonly sharing = signal<string | null>(null);
  readonly shared = signal<string | null>(null);

  readonly page = injectQuery<{ items: Doc[] }>("documents", {}, {
    shape: "{ items { id name contentType size url version updatedAt } }",
  });

  readonly items = computed(() => this.page.data()?.items ?? []);
  readonly create = injectCommand<Doc>("createDocument");

  href(doc: Doc): string {
    return doc.url.startsWith("http") ? doc.url : `${this.origin}${doc.url}`;
  }

  size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  when(at: number): string {
    return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  onPick(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) void this.upload(file);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.over.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void this.upload(file);
  }

  /**
   * The bytes go to the upload route on their own, then a command names what arrived. They never travel inside the
   * batch — that is what the extension is for, and what keeps a 40 MB file from becoming 53 MB of base64.
   */
  private async upload(file: File): Promise<void> {
    this.busy.set(true);
    this.failed.set(null);
    try {
      // the bytes go on their own route; the command only names what arrived
      const kept = await this.client.upload(file);
      await this.create.run({ upload: kept.id, name: file.name });
      await this.page.refetch();
    } catch (e: unknown) {
      this.failed.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }

  async share(doc: Doc): Promise<void> {
    this.sharing.set(doc.id);
    try {
      const share = await this.client.command<{ token: string }>("shareDocument", { id: doc.id }, { shape: "{ token }" });
      // a capability token in the query string: a browser following a link cannot set a header, which is the
      // trade-off every signed URL makes. it expires on its own, which is what makes that acceptable.
      await navigator.clipboard.writeText(`${this.href(doc)}?token=${share.token}`);
      this.shared.set(doc.id);
      setTimeout(() => this.shared.set(null), 2200);
    } catch (e: unknown) {
      this.failed.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.sharing.set(null);
    }
  }
}

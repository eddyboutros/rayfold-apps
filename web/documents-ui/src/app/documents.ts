/**
 * The documents panel, owned by the team that owns the documents service.
 *
 * It talks to its *own* service, on its own origin, with a client it provides itself. That is what keeps a
 * micro-frontend honest: the panel and the service it reads ship together, and no other team — including whoever
 * owns the page it lands on — has to know either exists.
 */
import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { injectCommand, injectQuery, injectRayfoldClient, provideRayfold } from "@rayfold/angular";
import { documentsBase, documentsClient } from "./client";
import { History } from "./history";

export interface Doc {
  id: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
  version: number;
  updatedAt: number;
  owner: { id: string; name: string } | null;
}

@Component({
  selector: "documents-panel",
  changeDetection: ChangeDetectionStrategy.OnPush,
  // the remote provides its own client, so this panel is the same component wherever it is dropped
  providers: [provideRayfold(documentsClient())],
  imports: [History],
  styleUrl: "./documents.css",
  template: `
    <section class="card">
      <header>
        <h2>Documents</h2>
        @if (busy()) {
          <span class="pill"><span class="dot"></span>{{ busy() }}</span>
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
        @if (page.error(); as e) {
          <div class="empty" role="alert">
            <strong>Your files could not be loaded</strong>
            {{ describe(e) }}
          </div>
        } @else if (page.loading() && !items().length) {
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
              <li [class.open]="openId() === doc.id">
                <div class="row">
                  <span class="glyph" [attr.data-kind]="kind(doc)" aria-hidden="true">{{ ext(doc) }}</span>
                  <span class="meta">
                    @if (renaming() === doc.id) {
                      <form class="rename" (submit)="rename($event, doc)">
                        <input class="input" name="name" [value]="doc.name" autocomplete="off" autofocus aria-label="New name" />
                        <button type="submit" class="btn primary">Save</button>
                        <button type="button" class="btn quiet" (click)="renaming.set(null)">Cancel</button>
                      </form>
                    } @else {
                      <a [href]="href(doc)" target="_blank" rel="noreferrer">{{ doc.name }}</a>
                      <span class="muted sub">
                        {{ size(doc.size) }}
                        @if (doc.version > 1) {
                          ·
                          <button type="button" class="link" (click)="toggle(doc.id)" [attr.aria-expanded]="openId() === doc.id">
                            v{{ doc.version }}, {{ doc.version }} revisions
                          </button>
                        }
                        · {{ doc.owner?.name ?? "someone" }} · {{ when(doc.updatedAt) }}
                      </span>
                    }
                  </span>
                  <span class="row-actions">
                    @if (mine(doc)) {
                      <label class="btn quiet" [class.disabled]="!!busy()" title="Upload a new version; the old one is kept">
                        <input type="file" hidden [disabled]="!!busy()" (change)="onReplace($event, doc)" />
                        New version
                      </label>
                      <button type="button" class="btn quiet" (click)="renaming.set(doc.id)" [disabled]="!!busy()">Rename</button>
                      <button type="button" class="btn quiet" (click)="share(doc)" [disabled]="!!busy()">
                        {{ shared() === doc.id ? "Link copied" : "Share" }}
                      </button>
                      <button type="button" class="btn quiet danger" (click)="remove(doc)" [disabled]="!!busy()">
                        {{ confirming() === doc.id ? "Really delete" : "Delete" }}
                      </button>
                    }
                  </span>
                </div>
                @if (openId() === doc.id) {
                  <documents-history [documentId]="doc.id" [base]="base" />
                }
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
  readonly base = documentsBase();

  readonly over = signal(false);
  /** What is happening, in a word, while a command runs: the header says it and the actions wait. */
  readonly busy = signal<string | null>(null);
  readonly failed = signal<string | null>(null);
  readonly shared = signal<string | null>(null);
  readonly renaming = signal<string | null>(null);
  /** Delete asks once, in place, rather than with a dialog: the second click on the same file is the answer. */
  readonly confirming = signal<string | null>(null);
  /** The one document whose revisions are open. */
  readonly openId = signal<string | null>(null);

  // scoped to the project, and read reactively: switching projects re-runs it and ends the old one
  readonly page = injectQuery<{ items: Doc[] }>("documents", () => ({ projectId: this.projectId() }), {
    shape: "{ items { id name contentType size url version updatedAt owner { id name } } }",
    enabled: () => this.projectId() !== "",
  });
  /** Whose files this panel may offer to change: that is the owner's, and nobody else is shown the buttons. */
  readonly me = injectQuery<{ id: string } | null>("me", {}, { shape: "{ id }" });

  readonly items = computed(() => this.page.data()?.items ?? []);
  readonly create = injectCommand<Doc>("createDocument");
  readonly replace = injectCommand<Doc>("replaceContent");
  readonly renameDocument = injectCommand<Doc>("renameDocument");
  readonly deleteDocument = injectCommand<Doc>("deleteDocument");

  mine(doc: Doc): boolean {
    const me = this.me.data();
    return !!me && doc.owner?.id === me.id;
  }

  /** A failure is told as itself. This panel once showed "No files yet" for a 403, which is a lie a person acts on. */
  describe(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  /** The service hands out `/files/<id>`, its own path; it is reached under the service's base. */
  href(doc: Doc): string {
    return doc.url.startsWith("http") ? doc.url : `${this.base}${doc.url}`;
  }

  /** The extension, as the mark on the row: a file's name tells you what it is before its icon would. */
  ext(doc: Doc): string {
    const m = doc.name.match(/\.([a-z0-9]{1,4})$/i);
    return m ? m[1]!.toUpperCase() : "FILE";
  }

  kind(doc: Doc): string {
    const t = doc.contentType;
    if (t.startsWith("image/")) return "image";
    if (t === "application/pdf") return "pdf";
    if (t.includes("spreadsheet") || t === "text/csv" || /\.(xlsx?|csv)$/i.test(doc.name)) return "sheet";
    if (t.startsWith("text/") || t.includes("document") || /\.(docx?|md|txt)$/i.test(doc.name)) return "text";
    return "other";
  }

  size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  when(at: number): string {
    return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  toggle(id: string): void {
    this.openId.update((open) => (open === id ? null : id));
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

  onReplace(event: Event, doc: Doc): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) void this.newVersion(doc, file);
  }

  /**
   * The bytes go to the upload route on their own, then a command names what arrived. They never travel inside the
   * batch — that is what the extension is for, and what keeps a 40 MB file from becoming 53 MB of base64.
   */
  private upload(file: File): Promise<void> {
    return this.run("uploading", async () => {
      const kept = await this.client.upload(file);
      await this.create.run({ upload: kept.id, name: file.name, projectId: this.projectId() });
    });
  }

  private newVersion(doc: Doc, file: File): Promise<void> {
    return this.run("uploading", async () => {
      const kept = await this.client.upload(file);
      // the version on screen is the version sent: a new version on top of someone else's is refused, not lost
      await this.replace.run({ id: doc.id, upload: kept.id }, { ifVersion: doc.version });
    });
  }

  rename(event: Event, doc: Doc): Promise<void> {
    event.preventDefault();
    const name = ((event.target as HTMLFormElement).elements.namedItem("name") as HTMLInputElement).value.trim();
    this.renaming.set(null);
    if (!name || name === doc.name) return Promise.resolve();
    return this.run("renaming", () => this.renameDocument.run({ id: doc.id, name }, { ifVersion: doc.version }));
  }

  remove(doc: Doc): Promise<void> {
    if (this.confirming() !== doc.id) {
      this.confirming.set(doc.id);
      setTimeout(() => this.confirming.update((c) => (c === doc.id ? null : c)), 4000);
      return Promise.resolve();
    }
    this.confirming.set(null);
    return this.run("deleting", () => this.deleteDocument.run({ id: doc.id }));
  }

  async share(doc: Doc): Promise<void> {
    await this.run("sharing", async () => {
      const share = await this.client.command<{ token: string }>("shareDocument", { id: doc.id }, { shape: "{ token }" });
      // a capability token in the query string: a browser following a link cannot set a header, which is the
      // trade-off every signed URL makes. it expires on its own, which is what makes that acceptable.
      await navigator.clipboard.writeText(`${this.href(doc)}?token=${share.token}`);
      this.shared.set(doc.id);
      setTimeout(() => this.shared.update((s) => (s === doc.id ? null : s)), 2200);
    }, false);
  }

  /** One command at a time, its name in the header while it runs, and the list read again after one that changed it. */
  private async run(what: string, work: () => Promise<unknown>, refetch = true): Promise<void> {
    this.busy.set(what);
    this.failed.set(null);
    try {
      await work();
      if (refetch) await this.page.refetch();
    } catch (e: unknown) {
      this.failed.set(this.describe(e));
    } finally {
      this.busy.set(null);
    }
  }
}

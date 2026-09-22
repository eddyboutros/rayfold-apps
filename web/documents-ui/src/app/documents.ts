/**
 * The documents panel, owned by the team that owns the documents service.
 *
 * It talks to its *own* service, on its own origin, with a client it provides itself. That is what keeps a
 * micro-frontend honest: the panel and the service it reads ship together, and no other team — including whoever
 * owns the page it lands on — has to know either exists.
 *
 * The list is a live query with the folder and tag filters as its arguments: narrowing it is a new subscription, and
 * a file filed elsewhere from another screen leaves this list as it happens, because the command names the
 * operation in its patch. Each row opens into a preview, the team's notes on the file, and its revisions.
 */
import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { injectCommand, injectLive, injectQuery, injectRayfoldClient, provideRayfold } from "@rayfold/angular";
import { documentsBase, documentsClient } from "./client";
import { Approvals } from "./approvals";
import { History } from "./history";
import { Notes } from "./notes";
import { Preview } from "./preview";

export interface Doc {
  id: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
  version: number;
  updatedAt: number;
  owner: { id: string; name: string } | null;
  folder: string | null;
  tags: string[];
}

export interface Folder {
  name: string;
  count: number;
}

type Tab = "preview" | "notes" | "approvals" | "history";

@Component({
  selector: "documents-panel",
  changeDetection: ChangeDetectionStrategy.OnPush,
  // the remote provides its own client, so this panel is the same component wherever it is dropped
  providers: [provideRayfold(documentsClient())],
  imports: [Approvals, History, Notes, Preview],
  styleUrl: "./documents.css",
  template: `
    <section class="card">
      <header>
        <h2>Documents</h2>
        @if (busy()) {
          <span class="pill"><span class="dot"></span>{{ busy() }}</span>
        } @else if (page.error()) {
          <span class="pill bad"><span class="dot"></span>disconnected</span>
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
        <span class="muted">or drop one here{{ folder() ? " to file it in " + folder() : "" }}</span>
      </div>

      @if (folderList().length || tagList().length) {
        <div class="filters">
          <div class="folders" role="tablist" aria-label="Folders">
            <button type="button" class="chip" [class.on]="!folder()" (click)="folder.set('')">All</button>
            @for (f of folderList(); track f.name) {
              <button type="button" class="chip" [class.on]="folder() === f.name" (click)="folder.set(f.name)">
                <span class="glyph-folder" aria-hidden="true"></span>{{ f.name }} <span class="n">{{ f.count }}</span>
              </button>
            }
          </div>
          @if (tagList().length) {
            <label class="tagfilter">
              <span class="muted">Tag</span>
              <select (change)="tag.set($any($event.target).value)" aria-label="Filter by tag">
                <option value="" [selected]="!tag()">Any</option>
                @for (t of tagList(); track t) {
                  <option [value]="t" [selected]="tag() === t">{{ t }}</option>
                }
              </select>
            </label>
          }
        </div>
      }

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
            @if (folder() || tag()) {
              <strong>Nothing here</strong>
              No file is in that folder with that tag. Choose All to see everything.
            } @else {
              <strong>No files yet</strong>
              Whatever you add here shows up on the project's activity feed.
            }
          </div>
        } @else {
          <ol>
            @for (doc of items(); track doc.id) {
              <li [class.open]="openId() === doc.id" [class.editing]="editing()?.id === doc.id" [attr.data-id]="doc.id">
                <div class="row">
                  <span class="glyph" [attr.data-kind]="kind(doc)" aria-hidden="true">{{ ext(doc) }}</span>
                  <span class="meta">
                    @if (editing()?.id === doc.id && editing()?.what === "name") {
                      <form class="inline" (submit)="rename($event, doc)">
                        <input class="input" name="name" [value]="doc.name" autocomplete="off" autofocus aria-label="New name" />
                        <button type="submit" class="btn primary">Save</button>
                        <button type="button" class="btn quiet" (click)="editing.set(null)">Cancel</button>
                      </form>
                    } @else if (editing()?.id === doc.id && editing()?.what === "folder") {
                      <form class="inline" (submit)="file($event, doc)">
                        <input class="input" name="folder" [value]="doc.folder ?? ''" list="folders-known" placeholder="contracts/2026, or empty for the root" autocomplete="off" autofocus aria-label="Folder" />
                        <datalist id="folders-known">
                          @for (f of folderList(); track f.name) {
                            <option [value]="f.name"></option>
                          }
                        </datalist>
                        <button type="submit" class="btn primary">File</button>
                        <button type="button" class="btn quiet" (click)="editing.set(null)">Cancel</button>
                      </form>
                    } @else if (editing()?.id === doc.id && editing()?.what === "tags") {
                      <form class="inline" (submit)="retag($event, doc)">
                        <input class="input" name="tags" [value]="doc.tags.join(', ')" placeholder="legal, q4" autocomplete="off" autofocus aria-label="Tags" />
                        <button type="submit" class="btn primary">Save</button>
                        <button type="button" class="btn quiet" (click)="editing.set(null)">Cancel</button>
                      </form>
                    } @else {
                      <button type="button" class="name" (click)="toggle(doc.id)" [attr.aria-expanded]="openId() === doc.id">{{ doc.name }}</button>
                      <span class="muted sub">
                        {{ size(doc.size) }}
                        @if (doc.version > 1) {
                          · v{{ doc.version }}
                        }
                        · {{ doc.owner?.name ?? "someone" }} · {{ when(doc.updatedAt) }}
                        · <a [href]="href(doc)" target="_blank" rel="noreferrer">Open</a>
                      </span>
                      @if ((doc.folder && !folder()) || doc.tags.length) {
                        <span class="marks">
                          @if (doc.folder && !folder()) {
                            <button type="button" class="mark folder" (click)="folder.set(doc.folder!)" title="Show this folder"><span class="glyph-folder" aria-hidden="true"></span>{{ doc.folder }}</button>
                          }
                          @for (t of doc.tags; track t) {
                            <button type="button" class="mark tag" [class.on]="tag() === t" (click)="tag.set(tag() === t ? '' : t)" title="Filter by this tag">{{ t }}</button>
                          }
                        </span>
                      }
                    }
                  </span>
                  <span class="row-actions">
                    <button type="button" class="btn quiet" (click)="editing.set({ id: doc.id, what: 'tags' })" [disabled]="!!busy()">Tags</button>
                    @if (mine(doc)) {
                      <button type="button" class="btn quiet" (click)="editing.set({ id: doc.id, what: 'folder' })" [disabled]="!!busy()">File in…</button>
                      <label class="btn quiet" [class.disabled]="!!busy()" title="Upload a new version; the old one is kept">
                        <input type="file" hidden [disabled]="!!busy()" (change)="onReplace($event, doc)" />
                        New version
                      </label>
                      <button type="button" class="btn quiet" (click)="editing.set({ id: doc.id, what: 'name' })" [disabled]="!!busy()">Rename</button>
                      <button type="button" class="btn quiet" (click)="share(doc)" [disabled]="!!busy()">
                        {{ shared() === doc.id ? "Link copied" : "Share" }}
                      </button>
                      <button type="button" class="btn quiet danger" (click)="remove(doc)" [disabled]="!!busy()">
                        {{ confirming() === doc.id ? "Really delete" : "Delete" }}
                      </button>
                    }
                  </span>
                </div>
                @if (shareLink()?.id === doc.id) {
                  <form class="inline sharelink" (submit)="$event.preventDefault(); shareLink.set(null)">
                    <input class="input" [value]="shareLink()!.link" readonly aria-label="Share link" (focus)="$any($event.target).select()" />
                    <button type="submit" class="btn quiet">Done</button>
                  </form>
                }
                @if (openId() === doc.id) {
                  <div class="tabs" role="tablist">
                    <button type="button" role="tab" [class.on]="tab() === 'preview'" (click)="tab.set('preview')">Preview</button>
                    <button type="button" role="tab" [class.on]="tab() === 'notes'" (click)="tab.set('notes')">Notes</button>
                    <button type="button" role="tab" [class.on]="tab() === 'approvals'" (click)="tab.set('approvals')">Sign-offs</button>
                    <button type="button" role="tab" [class.on]="tab() === 'history'" (click)="tab.set('history')">Revisions <span class="n">{{ doc.version }}</span></button>
                  </div>
                  @switch (tab()) {
                    @case ("preview") {
                      <documents-preview [url]="href(doc)" [contentType]="doc.contentType" [name]="doc.name" />
                    }
                    @case ("notes") {
                      <documents-notes [documentId]="doc.id" />
                    }
                    @case ("approvals") {
                      <documents-approvals [documentId]="doc.id" [projectId]="projectId()" [documentName]="doc.name" [version]="doc.version" [meId]="me.data()?.id ?? null" [canAsk]="mine(doc)" />
                    }
                    @case ("history") {
                      <documents-history [documentId]="doc.id" [base]="base" />
                    }
                  }
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
  /** A share link the clipboard would not take, shown under its row until dismissed. */
  readonly shareLink = signal<{ id: string; link: string } | null>(null);
  /** The one row with an inline form open, and which of its fields. */
  readonly editing = signal<{ id: string; what: "name" | "folder" | "tags" } | null>(null);
  /** Delete asks once, in place, rather than with a dialog: the second click on the same file is the answer. */
  readonly confirming = signal<string | null>(null);
  /** The one document that is open, and which of its tabs. */
  readonly openId = signal<string | null>(null);
  readonly tab = signal<Tab>("preview");
  readonly folder = signal("");
  readonly tag = signal("");

  // scoped to the project and the filters, and read reactively: a change to any re-runs it and ends the old one
  readonly page = injectLive<{ items: Doc[] }>(
    "documents",
    () => ({ projectId: this.projectId(), folder: this.folder() || null, tag: this.tag() || null }),
    {
      shape: "{ items { id name contentType size url version updatedAt folder tags owner { id name } } }",
      enabled: () => this.projectId() !== "",
    },
  );
  readonly folders = injectLive<Folder[]>("folders", () => ({ projectId: this.projectId() }), { shape: "{ name count }", enabled: () => this.projectId() !== "" });
  /** Every tag on the project, for the picker: read unfiltered, so narrowing by one keeps the others offered. */
  readonly all = injectLive<{ items: Array<{ tags: string[] }> }>("documents", () => ({ projectId: this.projectId() }), {
    shape: "{ items { tags } }",
    enabled: () => this.projectId() !== "",
  });
  /** Whose files this panel may offer to change: that is the owner's, and nobody else is shown the buttons. */
  readonly me = injectQuery<{ id: string } | null>("me", {}, { shape: "{ id }" });

  readonly items = computed(() => this.page.data()?.items ?? []);
  readonly folderList = computed(() => this.folders.data() ?? []);
  readonly tagList = computed(() => [...new Set((this.all.data()?.items ?? []).flatMap((d) => d.tags))].sort());
  readonly create = injectCommand<Doc>("createDocument");
  readonly replace = injectCommand<Doc>("replaceContent");
  readonly updateDocument = injectCommand<Doc>("updateDocument");
  readonly moveDocument = injectCommand<Doc>("moveDocument");
  readonly tagDocument = injectCommand<Doc>("tagDocument");
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
    this.tab.set("preview");
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
   * batch — that is what the extension is for, and what keeps a 40 MB file from becoming 53 MB of base64. A file
   * dropped while a folder is open is filed there, in a second command on the version the first answered with.
   */
  private upload(file: File): Promise<void> {
    return this.run("uploading", async () => {
      const kept = await this.client.upload(file);
      const doc = await this.create.run({ upload: kept.id, name: file.name, projectId: this.projectId() });
      if (this.folder()) await this.moveDocument.run({ id: doc.id, folder: this.folder() }, { ifVersion: doc.version });
    });
  }

  private newVersion(doc: Doc, file: File): Promise<void> {
    return this.run("uploading", async () => {
      const kept = await this.client.upload(file);
      // the version on screen is the version sent: a new version on top of someone else's is refused, not lost
      await this.replace.run({ id: doc.id, upload: kept.id }, { ifVersion: doc.version });
    });
  }

  private field(event: Event, name: string): string {
    return ((event.target as HTMLFormElement).elements.namedItem(name) as HTMLInputElement).value.trim();
  }

  rename(event: Event, doc: Doc): Promise<void> {
    event.preventDefault();
    const name = this.field(event, "name");
    this.editing.set(null);
    if (!name || name === doc.name) return Promise.resolve();
    // updateDocument, not renameDocument: the older command is deprecated with a sunset, and this panel has moved
    return this.run("renaming", () => this.updateDocument.run({ id: doc.id, changes: { name } }, { ifVersion: doc.version }));
  }

  file(event: Event, doc: Doc): Promise<void> {
    event.preventDefault();
    const folder = this.field(event, "folder");
    this.editing.set(null);
    if (folder === (doc.folder ?? "")) return Promise.resolve();
    return this.run("filing", () => this.moveDocument.run({ id: doc.id, folder: folder || null }, { ifVersion: doc.version }));
  }

  retag(event: Event, doc: Doc): Promise<void> {
    event.preventDefault();
    const tags = this.field(event, "tags")
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    this.editing.set(null);
    return this.run("tagging", () => this.tagDocument.run({ id: doc.id, tags }, { ifVersion: doc.version }));
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
      // the link opens the share page on this origin, with the token as the whole of who the reader is. it expires
      // on its own, which is what makes a permission in a query string acceptable.
      const link = `${location.origin}${location.pathname}?share=${encodeURIComponent(share.token)}`;
      try {
        await navigator.clipboard.writeText(link);
        this.shared.set(doc.id);
        setTimeout(() => this.shared.update((s) => (s === doc.id ? null : s)), 2200);
      } catch {
        // a page without focus, or a browser that asks first: the link is shown instead, to copy by hand
        this.shareLink.set({ id: doc.id, link });
      }
    });
  }

  /** One command at a time, its name in the header while it runs. The live list hears the change on its own. */
  private async run(what: string, work: () => Promise<unknown>): Promise<void> {
    this.busy.set(what);
    this.failed.set(null);
    try {
      await work();
    } catch (e: unknown) {
      this.failed.set(this.describe(e));
    } finally {
      this.busy.set(null);
    }
  }
}

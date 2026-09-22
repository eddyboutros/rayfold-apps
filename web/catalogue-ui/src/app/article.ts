/**
 * One page of the knowledge base, read or edited.
 *
 * The body is `@lazy` in the schema: it is not on any list, and here it arrives in a later frame than the title,
 * which the reader sees as the heading landing first. An edit sends the version that was read, so two people
 * editing the same page cannot both win.
 */
import { ChangeDetectionStrategy, Component, ViewEncapsulation, computed, input, output, signal } from "@angular/core";
import { injectCommand, injectQuery } from "@rayfold/angular";
import { render } from "./markdown";

export interface FullArticle {
  id: string;
  slug: string;
  name: string;
  summary: string;
  tags: string[];
  body: string | null;
  version: number;
  updatedAt: number;
  author: { id: string; name: string } | null;
  editor: { id: string; name: string } | null;
}

/** An earlier version, as the history lists it; the body arrives in a later frame, as the article's own does. */
export interface Revision {
  id: string;
  version: number;
  name: string;
  summary: string;
  tags: string[];
  body: string | null;
  at: number;
  editor: { name: string } | null;
}

@Component({
  selector: "catalogue-article",
  changeDetection: ChangeDetectionStrategy.OnPush,
  // the body is rendered HTML, which scoped styles cannot reach; every rule in the sheet is prefixed with this
  // element's own selector instead, so nothing leaks either way
  encapsulation: ViewEncapsulation.None,
  styleUrl: "./article.css",
  template: `
    <article class="card">
      @if (page.error(); as e) {
        <div class="body empty" role="alert">
          <strong>This page could not be loaded</strong>
          {{ describe(e) }}
        </div>
      } @else if (!article()) {
        <header><span class="skeleton" style="width: 40%"></span></header>
        <div class="body"><span class="skeleton" style="width: 90%"></span></div>
      } @else if (editing()) {
        <form class="edit" (submit)="save($event)">
          <header>
            <input class="input title" name="name" [value]="article()!.name" required aria-label="Title" />
            <span class="actions">
              <button type="button" class="btn quiet" (click)="editing.set(false)">Cancel</button>
              <button type="submit" class="btn primary" [disabled]="write.running()">Save</button>
            </span>
          </header>
          <div class="body">
            <input class="input" name="summary" [value]="article()!.summary" placeholder="One line about this page" aria-label="Summary" />
            <input class="input" name="tags" [value]="article()!.tags.join(', ')" placeholder="tags, separated by commas" aria-label="Tags" />
            <textarea class="input" name="body" rows="22" aria-label="Body">{{ article()!.body }}</textarea>
            @if (failed(); as message) {
              <p class="bad" role="alert">{{ message }}</p>
            }
          </div>
        </form>
      } @else {
        <header>
          <div>
            <p class="crumbs"><button type="button" class="link" (click)="close.emit()">Catalogue</button> <span aria-hidden="true">/</span> Articles</p>
            <h1>{{ article()!.name }}</h1>
            <p class="byline muted">
              @if (article()!.author; as by) {
                {{ by.name }} ·
              }
              updated {{ when(article()!.updatedAt) }}
              @if (article()!.version > 1) {
                · version {{ article()!.version }}
                @if (article()!.editor && article()!.editor?.id !== article()!.author?.id) {
                  · last edited by {{ article()!.editor?.name }}
                }
              }
            </p>
          </div>
          <span class="actions">
            @if (article()!.version > 1) {
              <button type="button" class="btn quiet" [class.on]="history()" (click)="history.update((h) => !h); viewing.set(null)">History</button>
            }
            <button type="button" class="btn" (click)="editing.set(true)">Edit</button>
          </span>
        </header>
        @if (history()) {
          <div class="history">
            @if (revisions.error(); as e) {
              <p class="bad" role="alert">The history could not be loaded: {{ describe(e) }}</p>
            } @else if (!revisions.data()) {
              <span class="skeleton" style="width: 50%"></span>
            } @else {
              <ol>
                <li class="current" [class.on]="!viewing()">
                  <button type="button" (click)="viewing.set(null)">
                    <span class="v mono">v{{ article()!.version }}</span>
                    <span class="what">{{ article()!.name }} <span class="muted">— current</span></span>
                    <span class="who muted">{{ article()!.editor?.name ?? article()!.author?.name ?? "" }} · {{ when(article()!.updatedAt) }}</span>
                  </button>
                </li>
                @for (r of revisions.data()!.items; track r.id) {
                  <li [class.on]="viewing()?.id === r.id">
                    <button type="button" (click)="viewing.set(r)">
                      <span class="v mono">v{{ r.version }}</span>
                      <span class="what">{{ r.name }}</span>
                      <span class="who muted">{{ r.editor?.name ?? "" }} · {{ when(r.at) }}</span>
                    </button>
                  </li>
                }
              </ol>
            }
          </div>
        }
        <div class="body">
          @if (viewing(); as r) {
            <p class="notice">
              <span>Reading version {{ r.version }}, from {{ when(r.at) }}. The page is at version {{ article()!.version }}.</span>
              <span class="actions">
                <button type="button" class="btn quiet" (click)="viewing.set(null)">Back to current</button>
                <button type="button" class="btn primary" (click)="restore(r)" [disabled]="write.running()">Restore this version</button>
              </span>
            </p>
            @if (failed(); as message) {
              <p class="bad" role="alert">{{ message }}</p>
            }
            @if (r.tags.length) {
              <p class="tags">
                @for (tag of r.tags; track tag) {
                  <span class="pill">{{ tag }}</span>
                }
              </p>
            }
            @if (r.body === null) {
              <span class="skeleton" style="width: 90%; margin-bottom: 9px"></span>
              <span class="skeleton" style="width: 76%"></span>
            } @else {
              <div class="prose" [innerHTML]="render(r.body)"></div>
            }
          } @else {
            @if (article()!.tags.length) {
              <p class="tags">
                @for (tag of article()!.tags; track tag) {
                  <span class="pill">{{ tag }}</span>
                }
              </p>
            }
            @if (article()!.body === null) {
              <span class="skeleton" style="width: 90%; margin-bottom: 9px"></span>
              <span class="skeleton" style="width: 76%; margin-bottom: 9px"></span>
              <span class="skeleton" style="width: 84%"></span>
            } @else {
              <div class="prose" [innerHTML]="html()"></div>
            }
          }
        </div>
      }
    </article>
  `,
})
export class ArticleView {
  readonly slug = input<string>("");
  readonly close = output<void>();

  readonly editing = signal(false);
  readonly failed = signal<string | null>(null);
  /** The history panel, and the earlier version being read instead of the current one. */
  readonly history = signal(false);
  readonly viewing = signal<Revision | null>(null);
  readonly render = render;

  readonly page = injectQuery<FullArticle | null>("article", () => ({ slug: this.slug() }), {
    shape: "{ id slug name summary tags body version updatedAt author { id name } editor { id name } }",
    enabled: () => this.slug() !== "",
  });
  readonly article = computed(() => this.page.data() ?? null);
  readonly html = computed(() => render(this.article()?.body ?? ""));

  // asked for only while the history is open, with the bodies: the shape asks for the lazy field, so each arrives
  // in its own later frame and the list is on screen before any of them
  readonly revisions = injectQuery<{ items: Revision[] }>("articleRevisions", () => ({ id: this.article()?.id ?? "" }), {
    shape: "{ items { id version name summary tags body at editor { name } } total }",
    enabled: () => this.history() && !!this.article(),
  });

  readonly write = injectCommand<FullArticle>("writeArticle");

  describe(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  when(at: number): string {
    return new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  async save(event: Event): Promise<void> {
    event.preventDefault();
    const current = this.article();
    if (!current) return;
    const form = event.target as HTMLFormElement;
    const field = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement).value;
    const tags = field("tags")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    this.failed.set(null);
    try {
      // the version that was read: an edit on top of someone else's is refused, and the refusal says what it is now
      await this.write.run({ id: current.id, name: field("name").trim(), summary: field("summary").trim(), body: field("body"), tags }, { ifVersion: current.version });
      this.editing.set(false);
      await this.page.refetch();
      if (this.history()) await this.revisions.refetch();
    } catch (e: unknown) {
      this.failed.set(this.describe(e));
    }
  }

  /** An old version made current: a new edit with its text, on the version the page has now, so nothing is lost. */
  async restore(r: Revision): Promise<void> {
    const current = this.article();
    if (!current || r.body === null) return;
    this.failed.set(null);
    try {
      await this.write.run({ id: current.id, name: r.name, summary: r.summary, body: r.body, tags: r.tags }, { ifVersion: current.version });
      this.viewing.set(null);
      await this.page.refetch();
      await this.revisions.refetch();
    } catch (e: unknown) {
      this.failed.set(this.describe(e));
    }
  }
}

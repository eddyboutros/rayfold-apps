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
                · revision {{ article()!.version }}
              }
            </p>
          </div>
          <span class="actions">
            <button type="button" class="btn" (click)="editing.set(true)">Edit</button>
          </span>
        </header>
        <div class="body">
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

  readonly page = injectQuery<FullArticle | null>("article", () => ({ slug: this.slug() }), {
    shape: "{ id slug name summary tags body version updatedAt author { id name } }",
    enabled: () => this.slug() !== "",
  });
  readonly article = computed(() => this.page.data() ?? null);
  readonly html = computed(() => render(this.article()?.body ?? ""));

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
    } catch (e: unknown) {
      this.failed.set(this.describe(e));
    }
  }
}

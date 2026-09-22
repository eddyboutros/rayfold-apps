/**
 * One person: who they are, what they have written, and who they work with.
 *
 * Two loaded fields, `articles` and `colleagues`, each one read for a whole page however many people it holds.
 * Every name here is a way somewhere else: an article opens, a colleague swaps in.
 */
import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";
import { injectQuery } from "@rayfold/angular";

export interface PersonDetail {
  id: string;
  name: string;
  title: string;
  department: string;
  email: string;
  location: string;
  updatedAt: number;
  articles: Array<{ id: string; slug: string; name: string; summary: string; tags: string[]; updatedAt: number }>;
  colleagues: Array<{ id: string; name: string; title: string; location: string }>;
}

@Component({
  selector: "catalogue-person",
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: "./person.css",
  template: `
    <article class="card">
      @if (page.error(); as e) {
        <div class="body empty" role="alert"><strong>This person could not be loaded</strong>{{ describe(e) }}</div>
      } @else if (!person()) {
        <header><span class="skeleton" style="width: 40%"></span></header>
        <div class="body"><span class="skeleton" style="width: 80%"></span></div>
      } @else {
        @let p = person()!;
        <header>
          <div class="who">
            <span class="avatar" [attr.data-person]="p.id" aria-hidden="true">{{ initials(p.name) }}</span>
            <div>
              <p class="crumbs"><button type="button" class="link" (click)="close.emit()">Catalogue</button> <span aria-hidden="true">/</span> People <span aria-hidden="true">/</span> {{ p.department }}</p>
              <h1>{{ p.name }}</h1>
              <p class="byline muted">{{ p.title }} · {{ p.department }} · {{ p.location }}</p>
            </div>
          </div>
          <a class="btn" [href]="'mailto:' + p.email">Email</a>
        </header>
        <div class="body">
          <dl class="facts">
            <div><dt class="muted">Title</dt><dd>{{ p.title }}</dd></div>
            <div><dt class="muted">Department</dt><dd>{{ p.department }}</dd></div>
            <div><dt class="muted">Location</dt><dd>{{ p.location }}</dd></div>
            <div><dt class="muted">Email</dt><dd><a [href]="'mailto:' + p.email">{{ p.email }}</a></dd></div>
          </dl>

          <div class="columns">
            <section>
              <h2 class="section-title">Written by {{ first(p.name) }} <span class="muted">{{ p.articles.length }}</span></h2>
              @if (p.articles.length) {
                <ol class="articles">
                  @for (a of p.articles; track a.id) {
                    <li>
                      <button type="button" class="row" (click)="openArticle.emit(a.slug)">
                        <span class="name">{{ a.name }}</span>
                        <span class="text muted">{{ a.summary }}</span>
                        <span class="meta muted">{{ when(a.updatedAt) }}@for (t of a.tags; track t) { · {{ t }}}</span>
                      </button>
                    </li>
                  }
                </ol>
              } @else {
                <p class="muted none">Nothing in the knowledge base yet.</p>
              }
            </section>
            <section>
              <h2 class="section-title">{{ p.department }} <span class="muted">{{ p.colleagues.length + 1 }}</span></h2>
              @if (p.colleagues.length) {
                <ol class="colleagues">
                  @for (c of p.colleagues; track c.id) {
                    <li>
                      <button type="button" class="row person" (click)="openPerson.emit(c.id)">
                        <span class="avatar small" [attr.data-person]="c.id" aria-hidden="true">{{ initials(c.name) }}</span>
                        <span class="text">
                          <span class="name">{{ c.name }}</span>
                          <span class="muted line">{{ c.title }} · {{ c.location }}</span>
                        </span>
                      </button>
                    </li>
                  }
                </ol>
              } @else {
                <p class="muted none">The whole department.</p>
              }
            </section>
          </div>
        </div>
      }
    </article>
  `,
})
export class PersonView {
  readonly id = input<string>("");
  readonly close = output<void>();
  readonly openPerson = output<string>();
  readonly openArticle = output<string>();

  readonly page = injectQuery<PersonDetail | null>("person", () => ({ id: this.id() }), {
    shape: "{ id name title department email location updatedAt articles { id slug name summary tags updatedAt } colleagues { id name title location } }",
    enabled: () => this.id() !== "",
  });
  readonly person = computed(() => this.page.data() ?? null);

  describe(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  first(name: string): string {
    return name.split(/\s+/)[0] ?? name;
  }

  initials(name: string): string {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0] ?? "")
      .join("")
      .toUpperCase();
  }

  when(at: number): string {
    return new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
}

/**
 * The catalogue page: one search over what the company sells, who works here and what is written down, and a
 * catalogue to leaf through when there is nothing to search for.
 *
 * The search returns a union and the list an interface. One shape asks for what it wants of each kind with `...on`,
 * and the card for each kind reads its own fields; nothing here switches on a type it did not ask for. The list is
 * numbered pages — `@page(offset)` — because that is what a person browsing wants.
 */
import { ChangeDetectionStrategy, Component, computed, effect, signal, untracked } from "@angular/core";
import { injectQuery, provideRayfold } from "@rayfold/angular";
import { catalogueClient } from "./client";
import { ArticleView } from "./article";

export type Kind = "product" | "person" | "article";

/** One entry, whichever kind: the interface's fields, and each kind's own when the shape asked for them. */
export interface Entry {
  $type: "Product" | "Person" | "Article";
  id: string;
  name: string;
  updatedAt: number;
  // Product
  sku?: string;
  category?: string;
  price?: number;
  availability?: "available" | "limited" | "waitlist" | "retired";
  summary?: string;
  // Person
  title?: string;
  department?: string;
  location?: string;
  email?: string;
  // Article
  slug?: string;
  tags?: string[];
  author?: { name: string } | null;
}

interface Page {
  items: Entry[];
  total: number;
  hasMore: boolean;
}

const PAGE = 12;
const SHAPE =
  "{ items { id name updatedAt " +
  "...on Product { sku category price availability summary } " +
  "...on Person { title department location email } " +
  "...on Article { slug summary tags author { name } } } total hasMore }";

const KINDS: Array<{ kind: Kind | null; label: string }> = [
  { kind: null, label: "Everything" },
  { kind: "product", label: "Products" },
  { kind: "person", label: "People" },
  { kind: "article", label: "Articles" },
];

const AVAILABILITY: Record<NonNullable<Entry["availability"]>, string> = { available: "available", limited: "limited", waitlist: "waitlist", retired: "retired" };

@Component({
  selector: "catalogue-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [provideRayfold(catalogueClient())],
  imports: [ArticleView],
  styleUrl: "./catalogue.css",
  template: `
    @if (reading(); as slug) {
      <catalogue-article [slug]="slug" (close)="reading.set(null)" />
    } @else {
      <div class="page-head">
        <div>
          <h1>Catalogue</h1>
          <p class="lede">What we sell, who we are, and what we have written down.</p>
        </div>
      </div>

      <form class="search" role="search" (submit)="$event.preventDefault()">
        <span class="glyph" aria-hidden="true">⌕</span>
        <input
          class="input"
          type="search"
          name="q"
          [value]="typed()"
          (input)="type($any($event.target).value)"
          placeholder="Search products, people and articles"
          autocomplete="off"
          aria-label="Search"
        />
        @if (typed()) {
          <button type="button" class="btn quiet clear" (click)="type('')">Clear</button>
        }
      </form>

      @if (q()) {
        <p class="status muted">
          @if (results.loading() && !results.data()) {
            Searching…
          } @else if (results.error(); as e) {
            <span class="bad-text">{{ describe(e) }}</span>
          } @else {
            {{ results.data()?.total ?? 0 }} {{ (results.data()?.total ?? 0) === 1 ? "result" : "results" }} for “{{ q() }}”
          }
        </p>
      } @else {
        <div class="seg" role="tablist">
          @for (k of kinds; track k.label) {
            <button type="button" role="tab" [class.on]="kind() === k.kind" [attr.aria-selected]="kind() === k.kind" (click)="pick(k.kind)">{{ k.label }}</button>
          }
        </div>
      }

      @let page = shown();
      @if (page?.error(); as e) {
        <div class="card"><div class="body empty" role="alert"><strong>The catalogue could not be loaded</strong>{{ describe(e) }}</div></div>
      } @else if (!page?.data() && page?.loading()) {
        <div class="grid">
          @for (n of [1, 2, 3, 4, 5, 6]; track n) {
            <div class="card entry"><div class="body"><span class="skeleton" style="width: 55%; margin-bottom: 10px"></span><span class="skeleton" style="width: 85%"></span></div></div>
          }
        </div>
      } @else if (page?.data(); as data) {
        @if (!data.items.length) {
          <div class="card"><div class="body empty"><strong>Nothing matches</strong>Try fewer words, or a different spelling.</div></div>
        } @else {
          <div class="grid">
            @for (e of data.items; track e.$type + e.id) {
              @switch (e.$type) {
                @case ("Product") {
                  <div class="card entry product">
                    <div class="body">
                      <p class="eyebrow">{{ e.category }} · <span class="mono">{{ e.sku }}</span></p>
                      <h2>{{ e.name }}</h2>
                      <p class="text">{{ e.summary }}</p>
                      <p class="foot">
                        <span class="price">{{ money(e.price ?? 0) }}</span>
                        <span class="pill" [attr.data-availability]="e.availability">{{ availability(e) }}</span>
                      </p>
                    </div>
                  </div>
                }
                @case ("Person") {
                  <div class="card entry person">
                    <div class="body">
                      <div class="who">
                        <span class="avatar" [attr.data-person]="e.id" aria-hidden="true">{{ initials(e.name) }}</span>
                        <span>
                          <h2>{{ e.name }}</h2>
                          <p class="muted">{{ e.title }} · {{ e.department }}</p>
                        </span>
                      </div>
                      <p class="foot">
                        <span class="muted">{{ e.location }}</span>
                        <a [href]="'mailto:' + e.email">{{ e.email }}</a>
                      </p>
                    </div>
                  </div>
                }
                @case ("Article") {
                  <button type="button" class="card entry article" (click)="reading.set(e.slug ?? null)">
                    <div class="body">
                      <p class="eyebrow">Article</p>
                      <h2>{{ e.name }}</h2>
                      <p class="text">{{ e.summary }}</p>
                      <p class="foot">
                        <span class="muted">{{ e.author?.name ?? "" }}{{ e.author ? " · " : "" }}{{ when(e.updatedAt) }}</span>
                        <span class="tags">
                          @for (tag of e.tags ?? []; track tag) {
                            <span class="pill quiet">{{ tag }}</span>
                          }
                        </span>
                      </p>
                    </div>
                  </button>
                }
              }
            }
          </div>

          @if (q()) {
            @if (data.hasMore) {
              <p class="more"><button type="button" class="btn" (click)="wanted.update((n) => n + 20)" [disabled]="results.loading()">Show more</button></p>
            }
          } @else if (pages() > 1) {
            <nav class="pager" aria-label="Pages">
              <button type="button" class="btn quiet" (click)="go(pageNo() - 1)" [disabled]="pageNo() === 1">Previous</button>
              @for (n of pageNumbers(); track n) {
                <button type="button" class="btn quiet n" [class.on]="n === pageNo()" (click)="go(n)" [attr.aria-current]="n === pageNo() ? 'page' : null">{{ n }}</button>
              }
              <button type="button" class="btn quiet" (click)="go(pageNo() + 1)" [disabled]="pageNo() === pages()">Next</button>
              <span class="muted count">{{ data.total }} entries</span>
            </nav>
          }
        }
      }
    }
  `,
})
export class Catalogue {
  readonly kinds = KINDS;

  /** What is in the box, and what is searched for: the second follows the first after a pause, not on every key. */
  readonly typed = signal("");
  readonly q = signal("");
  private pending: ReturnType<typeof setTimeout> | null = null;

  readonly kind = signal<Kind | null>(null);
  readonly pageNo = signal(1);
  /** How many search results to show; "show more" widens the same query rather than paging away from the first. */
  readonly wanted = signal(20);
  readonly reading = signal<string | null>(null);

  readonly results = injectQuery<Page>("search", () => ({ q: this.q(), page: { first: this.wanted() } }), {
    shape: SHAPE,
    enabled: () => this.q() !== "",
  });

  readonly list = injectQuery<Page>("items", () => ({ ...(this.kind() ? { kind: this.kind() } : {}), page: { first: PAGE, offset: (this.pageNo() - 1) * PAGE } }), {
    shape: SHAPE,
    enabled: () => this.q() === "",
  });

  readonly shown = computed(() => (this.q() ? this.results : this.list));
  readonly pages = computed(() => Math.max(1, Math.ceil((this.list.data()?.total ?? 0) / PAGE)));
  readonly pageNumbers = computed(() => Array.from({ length: this.pages() }, (_, i) => i + 1));

  constructor() {
    // a new phrase starts from the first results again
    effect(() => {
      this.q();
      untracked(() => this.wanted.set(20));
    });
  }

  type(value: string): void {
    this.typed.set(value);
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => this.q.set(value.trim()), 220);
  }

  pick(kind: Kind | null): void {
    this.kind.set(kind);
    this.pageNo.set(1);
  }

  go(n: number): void {
    if (n < 1 || n > this.pages()) return;
    this.pageNo.set(n);
  }

  describe(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  money(cents: number): string {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(cents / 100);
  }

  availability(e: Entry): string {
    return e.availability ? AVAILABILITY[e.availability] : "";
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
    return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
}

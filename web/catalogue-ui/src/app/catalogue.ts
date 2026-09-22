/**
 * The catalogue page: one search over what the company sells, who works here and what is written down, and a
 * catalogue to leaf through when there is nothing to search for.
 *
 * The search returns a union and the list an interface. One shape asks for what it wants of each kind with `...on`,
 * and each kind is drawn its own way — a product is a priced card, a person a directory entry, an article a line in
 * an index — because they are different things and a page that draws them alike is a jumble. Browsing one kind is
 * numbered pages (`@page(offset)`), because that is what a person leafing through a catalogue wants.
 */
import { ChangeDetectionStrategy, Component, computed, effect, signal, untracked } from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
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

const PER_PAGE: Record<Kind, number> = { product: 12, person: 16, article: 10 };
const ON_HOME: Record<Kind, number> = { product: 4, person: 8, article: 5 };

const SHAPE =
  "{ items { id name updatedAt " +
  "...on Product { sku category price availability summary } " +
  "...on Person { title department location email } " +
  "...on Article { slug summary tags author { name } } } total hasMore }";

const KINDS: Array<{ kind: Kind; label: string; one: string }> = [
  { kind: "product", label: "Products", one: "product" },
  { kind: "person", label: "People", one: "person" },
  { kind: "article", label: "Articles", one: "article" },
];

const AVAILABILITY: Record<NonNullable<Entry["availability"]>, string> = {
  available: "Available",
  limited: "Limited",
  waitlist: "Waitlist",
  retired: "Retired",
};

@Component({
  selector: "catalogue-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [provideRayfold(catalogueClient())],
  imports: [ArticleView, NgTemplateOutlet],
  styleUrl: "./catalogue.css",
  template: `
    @if (reading(); as slug) {
      <catalogue-article [slug]="slug" (close)="reading.set(null)" />
    } @else {
      <header class="head">
        <div class="titles">
          <h1>Catalogue</h1>
          <p class="lede">What we sell, who we are, and what we have written down.</p>
        </div>
        <form class="search" role="search" (submit)="$event.preventDefault()">
          <span class="glyph" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
            </svg>
          </span>
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
      </header>

      <nav class="tabs" aria-label="Kinds">
        <button type="button" [class.on]="!q() && !kind()" (click)="home()">Overview</button>
        @for (k of kinds; track k.kind) {
          <button type="button" [class.on]="!q() && kind() === k.kind" (click)="pick(k.kind)">
            {{ k.label }}
            @if (count(k.kind); as n) {
              <span class="n">{{ n }}</span>
            }
          </button>
        }
      </nav>

      <!-- ---- search results, grouped by what they are -->
      @if (q()) {
        @if (results.error(); as e) {
          <div class="card"><div class="body empty" role="alert"><strong>The search failed</strong>{{ describe(e) }}</div></div>
        } @else if (!results.data() && results.loading()) {
          <p class="status muted">Searching…</p>
        } @else if (results.data(); as data) {
          @if (!data.items.length) {
            <div class="card">
              <div class="body empty">
                <strong>Nothing matches “{{ q() }}”</strong>
                Try fewer words, a name, a SKU, or a tag.
              </div>
            </div>
          } @else {
            <p class="status muted">{{ data.total }} {{ data.total === 1 ? "result" : "results" }} for “{{ q() }}”, best match first</p>
            @for (group of grouped(data.items); track group.kind) {
              <section class="section">
                <h2 class="section-title">{{ group.label }} <span class="muted">{{ group.items.length }}</span></h2>
                <ng-container *ngTemplateOutlet="byKind; context: { kind: group.kind, items: group.items }" />
              </section>
            }
            @if (data.hasMore) {
              <p class="more"><button type="button" class="btn" (click)="wanted.update((n) => n + 20)" [disabled]="results.loading()">Show more results</button></p>
            }
          }
        }
      }

      <!-- ---- the overview: a little of each kind, and the way to all of it -->
      @else if (!kind()) {
        @for (k of kinds; track k.kind) {
          @let page = home_(k.kind);
          <section class="section">
            <div class="section-head">
              <h2 class="section-title">{{ k.label }} <span class="muted">{{ page.data()?.total ?? "" }}</span></h2>
              <button type="button" class="link" (click)="pick(k.kind)">All {{ k.label.toLowerCase() }} →</button>
            </div>
            @if (page.error(); as e) {
              <div class="card"><div class="body empty" role="alert">{{ describe(e) }}</div></div>
            } @else if (!page.data()) {
              <ng-container *ngTemplateOutlet="loading; context: { kind: k.kind }" />
            } @else {
              <ng-container *ngTemplateOutlet="byKind; context: { kind: k.kind, items: page.data()!.items }" />
            }
          </section>
        }
      }

      <!-- ---- one kind, all of it, in numbered pages -->
      @else {
        @let page = list;
        @if (page.error(); as e) {
          <div class="card"><div class="body empty" role="alert"><strong>The catalogue could not be loaded</strong>{{ describe(e) }}</div></div>
        } @else if (!page.data()) {
          <ng-container *ngTemplateOutlet="loading; context: { kind: kind()! }" />
        } @else {
          <ng-container *ngTemplateOutlet="byKind; context: { kind: kind()!, items: page.data()!.items }" />
          @if (pages() > 1) {
            <nav class="pager" aria-label="Pages">
              <button type="button" class="btn quiet" (click)="go(pageNo() - 1)" [disabled]="pageNo() === 1">Previous</button>
              @for (n of pageNumbers(); track n) {
                <button type="button" class="btn quiet n" [class.on]="n === pageNo()" (click)="go(n)" [attr.aria-current]="n === pageNo() ? 'page' : null">{{ n }}</button>
              }
              <button type="button" class="btn quiet" (click)="go(pageNo() + 1)" [disabled]="pageNo() === pages()">Next</button>
              <span class="muted count">{{ page.data()!.total }} {{ label(kind()!).toLowerCase() }}</span>
            </nav>
          }
        }
      }
    }

    <!-- ---- how each kind is drawn. one template, three kinds, each its own shape on the page -->
    <ng-template #byKind let-kind="kind" let-items="items">
      @switch (kind) {
        @case ("product") {
          <div class="products">
            @for (e of items; track e.id) {
              <div class="card product">
                <div class="body">
                  <p class="eyebrow">{{ e.category }}</p>
                  <h3>{{ e.name }}</h3>
                  <p class="text">{{ e.summary }}</p>
                  <div class="foot">
                    <span class="price">{{ money(e.price ?? 0) }}</span>
                    <span class="pill" [attr.data-availability]="e.availability">{{ availability(e) }}</span>
                  </div>
                  <p class="sku mono">{{ e.sku }}</p>
                </div>
              </div>
            }
          </div>
        }
        @case ("person") {
          <div class="people">
            @for (e of items; track e.id) {
              <div class="card person">
                <span class="avatar" [attr.data-person]="e.id" aria-hidden="true">{{ initials(e.name) }}</span>
                <span class="text">
                  <h3>{{ e.name }}</h3>
                  <span class="muted line">{{ e.title }}</span>
                  <span class="muted line small">{{ e.department }} · {{ e.location }}</span>
                  <a class="line small" [href]="'mailto:' + e.email">{{ e.email }}</a>
                </span>
              </div>
            }
          </div>
        }
        @case ("article") {
          <div class="card articles">
            @for (e of items; track e.id) {
              <button type="button" class="row" (click)="reading.set(e.slug ?? null)">
                <span class="main">
                  <h3>{{ e.name }}</h3>
                  <span class="muted line">{{ e.summary }}</span>
                </span>
                <span class="meta">
                  <span class="tags">
                    @for (tag of e.tags ?? []; track tag) {
                      <span class="pill quiet">{{ tag }}</span>
                    }
                  </span>
                  <span class="muted small by">{{ e.author?.name ?? "" }}{{ e.author ? " · " : "" }}{{ when(e.updatedAt) }}</span>
                </span>
              </button>
            }
          </div>
        }
      }
    </ng-template>

    <ng-template #loading let-kind="kind">
      @switch (kind) {
        @case ("product") {
          <div class="products">
            @for (n of [1, 2, 3, 4]; track n) {
              <div class="card product"><div class="body"><span class="skeleton" style="width: 40%"></span><span class="skeleton" style="width: 70%; margin-top: 10px"></span><span class="skeleton" style="width: 90%; margin-top: 8px"></span></div></div>
            }
          </div>
        }
        @case ("person") {
          <div class="people">
            @for (n of [1, 2, 3, 4]; track n) {
              <div class="card person"><span class="avatar"></span><span class="text"><span class="skeleton" style="width: 60%"></span><span class="skeleton" style="width: 40%; margin-top: 8px"></span></span></div>
            }
          </div>
        }
        @case ("article") {
          <div class="card articles">
            @for (n of [1, 2, 3]; track n) {
              <div class="row"><span class="main"><span class="skeleton" style="width: 35%"></span><span class="skeleton" style="width: 80%; margin-top: 8px"></span></span></div>
            }
          </div>
        }
      }
    </ng-template>
  `,
})
export class Catalogue {
  readonly kinds = KINDS;

  /** What is in the box, and what is searched for: the second follows the first after a pause, not on every key. */
  readonly typed = signal("");
  readonly q = signal("");
  private pending: ReturnType<typeof setTimeout> | null = null;

  /** Which kind fills the page; none is the overview. */
  readonly kind = signal<Kind | null>(null);
  readonly pageNo = signal(1);
  /** How many search results to show; "show more" widens the same query rather than paging away from the first. */
  readonly wanted = signal(20);
  readonly reading = signal<string | null>(null);

  readonly results = injectQuery<Page>("search", () => ({ q: this.q(), page: { first: this.wanted() } }), {
    shape: SHAPE,
    enabled: () => this.q() !== "",
  });

  // the overview's three lists: a few of each, and their totals for the tabs. they stay live across views, which is
  // what keeps the counts on the tabs and makes coming back to the overview instant
  private readonly homeProducts = injectQuery<Page>("items", { kind: "product", page: { first: ON_HOME.product } }, { shape: SHAPE });
  private readonly homePeople = injectQuery<Page>("items", { kind: "person", page: { first: ON_HOME.person } }, { shape: SHAPE });
  private readonly homeArticles = injectQuery<Page>("items", { kind: "article", page: { first: ON_HOME.article } }, { shape: SHAPE });

  readonly list = injectQuery<Page>(
    "items",
    () => ({ kind: this.kind(), page: { first: PER_PAGE[this.kind() ?? "product"], offset: (this.pageNo() - 1) * PER_PAGE[this.kind() ?? "product"] } }),
    { shape: SHAPE, enabled: () => this.q() === "" && this.kind() !== null },
  );

  readonly pages = computed(() => Math.max(1, Math.ceil((this.list.data()?.total ?? 0) / PER_PAGE[this.kind() ?? "product"])));
  readonly pageNumbers = computed(() => Array.from({ length: this.pages() }, (_, i) => i + 1));

  constructor() {
    // a new phrase starts from the first results again
    effect(() => {
      this.q();
      untracked(() => this.wanted.set(20));
    });
  }

  home_(kind: Kind) {
    return kind === "product" ? this.homeProducts : kind === "person" ? this.homePeople : this.homeArticles;
  }

  count(kind: Kind): number | null {
    return this.home_(kind).data()?.total ?? null;
  }

  label(kind: Kind): string {
    return KINDS.find((k) => k.kind === kind)?.label ?? kind;
  }

  /** Search hits in the order they came, gathered by kind: within a kind the best match is still first. */
  grouped(items: Entry[]): Array<{ kind: Kind; label: string; items: Entry[] }> {
    const of: Record<Kind, Entry[]> = { product: [], person: [], article: [] };
    for (const e of items) of[e.$type === "Product" ? "product" : e.$type === "Person" ? "person" : "article"].push(e);
    return KINDS.filter((k) => of[k.kind].length).map((k) => ({ kind: k.kind, label: k.label, items: of[k.kind] }));
  }

  type(value: string): void {
    this.typed.set(value);
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => this.q.set(value.trim()), 220);
  }

  home(): void {
    this.type("");
    this.kind.set(null);
    this.pageNo.set(1);
  }

  pick(kind: Kind): void {
    this.type("");
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
    return new Intl.NumberFormat("en", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(cents / 100);
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
    return new Date(at).toLocaleDateString("en", { month: "short", day: "numeric" });
  }
}

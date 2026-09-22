/**
 * One product, and the rest of its category.
 *
 * `related` is a field with a loader: the service reads the category once for however many products a shape asks
 * about, and this page asks about one. The same field on a page of twelve costs the same one read.
 */
import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";
import { injectQuery } from "@rayfold/angular";

export interface ProductDetail {
  id: string;
  name: string;
  sku: string;
  summary: string;
  category: string;
  price: number;
  availability: "available" | "limited" | "waitlist" | "retired";
  updatedAt: number;
  related: Array<{ id: string; name: string; sku: string; price: number; availability: ProductDetail["availability"]; summary: string }>;
}

const AVAILABILITY: Record<ProductDetail["availability"], string> = { available: "Available", limited: "Limited", waitlist: "Waitlist", retired: "Retired" };

const WHAT_IT_MEANS: Record<ProductDetail["availability"], string> = {
  available: "Orderable now; provisioned within two working days.",
  limited: "Orderable, with a lead time: a rollout engineer confirms the date.",
  waitlist: "Not orderable yet. Sales keeps a list and calls in order.",
  retired: "No new orders. Existing customers are being moved to its successor.",
};

@Component({
  selector: "catalogue-product",
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: "./product.css",
  template: `
    <article class="card">
      @if (page.error(); as e) {
        <div class="body empty" role="alert"><strong>This product could not be loaded</strong>{{ describe(e) }}</div>
      } @else if (!product()) {
        <header><span class="skeleton" style="width: 40%"></span></header>
        <div class="body"><span class="skeleton" style="width: 80%"></span></div>
      } @else {
        @let p = product()!;
        <header>
          <div>
            <p class="crumbs"><button type="button" class="link" (click)="close.emit()">Catalogue</button> <span aria-hidden="true">/</span> Products <span aria-hidden="true">/</span> {{ p.category }}</p>
            <h1>{{ p.name }}</h1>
            <p class="byline muted mono">{{ p.sku }} · updated {{ when(p.updatedAt) }}</p>
          </div>
          <div class="buy">
            <span class="price">{{ money(p.price) }}<span class="per"> / year</span></span>
            <span class="pill" [attr.data-availability]="p.availability">{{ label(p.availability) }}</span>
          </div>
        </header>
        <div class="body">
          <p class="lede">{{ p.summary }}</p>
          <dl class="facts">
            <div><dt class="muted">Category</dt><dd>{{ p.category }}</dd></div>
            <div><dt class="muted">SKU</dt><dd class="mono">{{ p.sku }}</dd></div>
            <div><dt class="muted">Availability</dt><dd>{{ means(p.availability) }}</dd></div>
          </dl>

          @if (p.related.length) {
            <h2 class="section-title">Also in {{ p.category }} <span class="muted">{{ p.related.length }}</span></h2>
            <div class="related">
              @for (r of p.related; track r.id) {
                <button type="button" class="card mini" (click)="open.emit(r.id)">
                  <span class="name">{{ r.name }}</span>
                  <span class="text muted">{{ r.summary }}</span>
                  <span class="foot">
                    <span class="price small">{{ money(r.price) }}</span>
                    <span class="pill" [attr.data-availability]="r.availability">{{ label(r.availability) }}</span>
                  </span>
                </button>
              }
            </div>
          } @else {
            <p class="muted alone">The only product in its category.</p>
          }
        </div>
      }
    </article>
  `,
})
export class ProductView {
  readonly id = input<string>("");
  readonly close = output<void>();
  /** Another product to look at: the page swaps to it, the way a link would. */
  readonly open = output<string>();

  readonly page = injectQuery<ProductDetail | null>("product", () => ({ id: this.id() }), {
    shape: "{ id name sku summary category price availability updatedAt related { id name sku price availability summary } }",
    enabled: () => this.id() !== "",
  });
  readonly product = computed(() => this.page.data() ?? null);

  describe(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  label(a: ProductDetail["availability"]): string {
    return AVAILABILITY[a];
  }

  means(a: ProductDetail["availability"]): string {
    return WHAT_IT_MEANS[a];
  }

  money(cents: number): string {
    return new Intl.NumberFormat("en", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(cents / 100);
  }

  when(at: number): string {
    return new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
}

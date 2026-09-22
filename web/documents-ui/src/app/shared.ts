/**
 * The page a share link opens: one document, for someone with no account here.
 *
 * The link carries a capability token and nothing else. This page hands it to the service as its bearer, asks
 * `shared` (the document the token is for: no id travels in the link), and shows the file. The token speaks for a
 * viewer that can read this document and nothing else, may call only the operations it names, and expires on its
 * own, so there is no account to create, nothing to revoke, and nothing whoever holds it can widen.
 */
import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import { RayfoldClient, createFetchTransport } from "@rayfold/client";
import { injectQuery, provideRayfold } from "@rayfold/angular";
import { documentsBase } from "./client";
import { Preview } from "./preview";

export interface SharedDoc {
  id: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
  version: number;
  updatedAt: number;
  owner: { name: string } | null;
}

/** The token is read from the page's address, once, before the client exists: it is the whole of who this page is. */
function tokenFromPage(): string {
  return new URLSearchParams(location.search).get("share") ?? "";
}

@Component({
  selector: "documents-shared",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Preview],
  providers: [
    provideRayfold(
      new RayfoldClient({
        // the token as the bearer: the service's viewer is the one the token speaks for, not a person
        transport: createFetchTransport({ url: `${documentsBase()}/rayfold`, headers: () => ({ authorization: `Bearer ${tokenFromPage()}` }) }),
        client: "documents-ui/0.1.0 shared",
      }),
    ),
  ],
  styleUrl: "./shared.css",
  template: `
    <div class="shared">
      @if (page.error(); as e) {
        <div class="card">
          <div class="body empty">
            <strong>This link does not work any more</strong>
            A share link lasts an hour. Ask whoever sent it for a new one.
            <span class="muted why">{{ describe(e) }}</span>
          </div>
        </div>
      } @else if (page.loading()) {
        <div class="card"><div class="body"><span class="skeleton" style="width: 60%"></span></div></div>
      } @else if (doc(); as doc) {
        <div class="card">
          <header class="head">
            <div>
              <p class="eyebrow">Shared with you</p>
              <h1>{{ doc.name }}</h1>
              <p class="muted sub">{{ size(doc.size) }} · {{ doc.contentType }} · version {{ doc.version }} · {{ doc.owner?.name ?? "someone" }} · {{ when(doc.updatedAt) }}</p>
            </div>
            <a class="btn primary" [href]="href(doc)" download>Download</a>
          </header>
          <div class="body">
            <documents-preview [url]="href(doc)" [contentType]="doc.contentType" [name]="doc.name" />
          </div>
        </div>
        <p class="note muted">
          You are reading this with a link, not an account. The link reads this one file, nothing else on the project,
          and stops working when it expires.
        </p>
      } @else {
        <div class="card"><div class="body empty"><strong>Nothing here</strong>The link names no document.</div></div>
      }
    </div>
  `,
})
export class Shared {
  /** Taken from the page by default; a host that routes differently can pass it. */
  readonly token = input<string>(tokenFromPage());
  readonly base = documentsBase();

  readonly page = injectQuery<SharedDoc | null>("shared", {}, { shape: "{ id name contentType size url version updatedAt owner { name } }" });
  readonly doc = computed(() => this.page.data() ?? null);

  describe(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  /** The bytes, with the token in the query: a browser following a link cannot set a header. */
  href(doc: SharedDoc): string {
    const url = doc.url.startsWith("http") ? doc.url : `${this.base}${doc.url}`;
    return `${url}?token=${encodeURIComponent(this.token())}`;
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

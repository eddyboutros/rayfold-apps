/**
 * What the help centre's readers said about one published page, from the feedback service: the support team's
 * service, on another runtime (Hono), with a client of its own, as the sign-offs panel in documents-ui keeps one to
 * the approvals service.
 *
 * Both reads are live. A reader answering on the public page moves the count here, and their comment arrives, while
 * the writer has the article open. The list is every answer because the person reading it is on the team: the
 * service's rule, pushed into its SQL, would give a visitor only their own.
 */
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from "@angular/core";
import { RayfoldClient, createFetchTransport } from "@rayfold/client";
import { injectLive, provideRayfold } from "@rayfold/angular";

interface Score {
  helpful: number;
  unhelpful: number;
}

interface Rating {
  id: string;
  helpful: boolean;
  comment: string | null;
  /** RFC 3339: this service sends an Instant as the protocol writes it. */
  at: string;
}

/** Where the feedback service is: `/api/feedback` on the page's own origin, like the others. */
export function feedbackBase(): string {
  const tag = document.querySelector<HTMLMetaElement>('meta[name="feedback-base"]');
  return (tag?.content || "/api/feedback").replace(/\/$/, "");
}

/**
 * Over HTTP: the service is a fetch handler, which has no socket, and a live query is a response it keeps open. The
 * session cookie goes with it, which is what makes the reader a member of the team rather than a visitor.
 */
function feedbackClient(): RayfoldClient {
  return new RayfoldClient({ transport: createFetchTransport({ url: `${feedbackBase()}/rayfold` }), client: "catalogue-ui/0.1.0 feedback" });
}

@Component({
  selector: "catalogue-help-feedback",
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [provideRayfold(feedbackClient())],
  styleUrl: "./help-feedback.css",
  template: `
    <section class="readers" aria-labelledby="readers-title">
      <h2 id="readers-title">What readers said</h2>
      @if (score.error() || answers.error()) {
        <p class="bad" role="alert">What readers said could not be loaded: {{ describe(score.error() ?? answers.error()) }}</p>
      } @else if (slow()) {
        <p class="bad" role="status">The feedback service is not answering. It is retrying on its own; the page works without it.</p>
      } @else if (!score.data()) {
        <span class="skeleton" style="width: 40%"></span>
      } @else if (total() === 0) {
        <p class="muted">Nobody has answered on this page yet.</p>
      } @else {
        <p class="tally">
          <span class="pill ok">{{ score.data()!.helpful }} helped</span>
          <span class="pill bad">{{ score.data()!.unhelpful }} did not</span>
          <span class="muted">{{ share() }}% of {{ total() }} {{ total() === 1 ? "reader" : "readers" }} found it helpful</span>
        </p>
        @if (said().length) {
          <ol class="said">
            @for (r of said(); track r.id) {
              <li>
                <span class="pill" [class.ok]="r.helpful" [class.bad]="!r.helpful">{{ r.helpful ? "Helped" : "Did not help" }}</span>
                <span>“{{ r.comment }}”</span>
                <time class="muted" [attr.datetime]="r.at">{{ when(r.at) }}</time>
              </li>
            }
          </ol>
          @if (answers.data()!.total > answers.data()!.items.length) {
            <p class="muted more">The latest {{ answers.data()!.items.length }} of {{ answers.data()!.total }} answers.</p>
          }
        }
      }
    </section>
  `,
})
export class HelpFeedback {
  /** The page's address on the help centre: the article's slug. */
  readonly slug = input<string>("");

  readonly score = injectLive<Score>("score", () => ({ slug: this.slug() }), { shape: "{ id helpful unhelpful }", enabled: () => this.slug() !== "" });
  readonly answers = injectLive<{ items: Rating[]; total: number }>("ratings", () => ({ slug: this.slug(), page: { first: 20 } }), {
    shape: "{ items { id helpful comment at } total }",
    enabled: () => this.slug() !== "",
  });

  readonly total = computed(() => (this.score.data()?.helpful ?? 0) + (this.score.data()?.unhelpful ?? 0));
  readonly share = computed(() => (this.total() ? Math.round((100 * (this.score.data()?.helpful ?? 0)) / this.total()) : 0));
  /** Only the answers that say something; the count above has the rest. */
  readonly said = computed(() => (this.answers.data()?.items ?? []).filter((r) => r.comment));

  /** As the sign-offs panel does: a live query to a service that is down retries quietly, so after a moment, say so. */
  readonly slow = signal(false);

  constructor() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const waiting = this.score.loading() && !this.score.data();
      clearTimeout(timer);
      if (!waiting) this.slow.set(false);
      else timer = setTimeout(() => this.slow.set(true), 4000);
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(timer));
  }

  describe(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  when(at: string): string {
    return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
}

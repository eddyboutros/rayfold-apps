/**
 * The sign-offs on one document, from the approvals service: the fleet's JVM member, on its own port, with a client
 * of its own. This panel talks to two services, and keeps two clients to do it, because a document's sign-offs are
 * a fact about the document and the person looking at it is here. The list is live: a decision made on another
 * screen, or a version kept in the documents service that makes a pending sign-off stale, lands as it happens.
 */
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from "@angular/core";
import { RayfoldClient, createWebSocketTransport } from "@rayfold/client";
import { injectCommand, injectLive, injectQuery, provideRayfold } from "@rayfold/angular";

export interface Approval {
  id: string;
  version: number;
  decision: "pending" | "approved" | "declined" | "withdrawn";
  note: string | null;
  stale: boolean;
  askedAt: number;
  decidedAt: number | null;
  requester: { id: string; name: string } | null;
  approver: { id: string; name: string } | null;
}

interface Member {
  id: string;
  name: string;
}

/** Where the approvals service is: `/api/approvals` on the page's own origin, like the others. */
export function approvalsBase(): string {
  const tag = document.querySelector<HTMLMetaElement>('meta[name="approvals-base"]');
  return (tag?.content || "/api/approvals").replace(/\/$/, "");
}

function approvalsClient(): RayfoldClient {
  const url = new URL(`${approvalsBase()}/rayfold/ws`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new RayfoldClient({ transport: createWebSocketTransport({ url: url.toString() }), client: "documents-ui/0.1.0 approvals" });
}

const LABEL: Record<Approval["decision"], string> = { pending: "Waiting", approved: "Approved", declined: "Declined", withdrawn: "Withdrawn" };

@Component({
  selector: "documents-approvals",
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [provideRayfold(approvalsClient())],
  styleUrl: "./approvals.css",
  template: `
    <div class="approvals">
      @if (list.error(); as e) {
        <p class="bad" role="alert">The sign-offs could not be loaded: {{ describe(e) }}</p>
      } @else if (list.loading() && !items().length && slow()) {
        <p class="bad" role="status">The sign-offs service is not answering. It is retrying on its own; the rest of the file works without it.</p>
      } @else if (list.loading() && !items().length) {
        <span class="skeleton" style="width: 48%"></span>
      } @else if (!items().length) {
        <p class="muted none">Nobody has been asked to sign this off.</p>
      } @else {
        <ol>
          @for (a of items(); track a.id) {
            <li [attr.data-decision]="a.decision">
              <span class="state pill" [attr.data-decision]="a.decision">{{ label(a.decision) }}</span>
              <span class="text">
                <span class="who"><strong>{{ a.requester?.name ?? "Someone" }}</strong> asked <strong>{{ a.approver?.name ?? "someone" }}</strong> <span class="muted">· version {{ a.version }} · {{ when(a.askedAt) }}</span></span>
                @if (a.stale && a.decision === "pending") {
                  <span class="stale">A newer version has been kept since; this asks about version {{ a.version }}.</span>
                }
                @if (a.note) {
                  <span class="note">“{{ a.note }}”</span>
                }
              </span>
              <span class="acts">
                @if (a.decision === "pending" && a.approver?.id === meId()) {
                  <button type="button" class="btn primary" (click)="decideIt(a, 'approved')" [disabled]="busy()">Approve</button>
                  <button type="button" class="btn quiet" (click)="decideIt(a, 'declined')" [disabled]="busy()">Decline</button>
                } @else if (a.decision === "pending" && a.requester?.id === meId()) {
                  <button type="button" class="btn quiet" (click)="withdrawIt(a)" [disabled]="busy()">Withdraw</button>
                }
              </span>
            </li>
          }
        </ol>
      }

      @if (canAsk()) {
        <form class="ask" (submit)="ask($event)">
          <select name="approver" aria-label="Who signs off" [disabled]="busy()">
            @for (m of others(); track m.id) {
              <option [value]="m.id">{{ m.name }}</option>
            }
          </select>
          <button type="submit" class="btn" [disabled]="busy() || !others().length">Ask for sign-off on v{{ version() }}</button>
        </form>
      }
      @if (failed(); as message) {
        <p class="bad" role="alert">{{ message }}</p>
      }
    </div>
  `,
})
export class Approvals {
  readonly documentId = input<string>("");
  readonly projectId = input<string>("");
  readonly documentName = input<string>("");
  readonly version = input<number>(1);
  /** Who is looking: from the documents service's `me`, handed in so this panel need not ask twice. */
  readonly meId = input<string | null>(null);
  /** Whether the person may ask: the owner's file. */
  readonly canAsk = input<boolean>(false);

  readonly busy = signal(false);
  readonly failed = signal<string | null>(null);

  readonly list = injectLive<Approval[]>("approvals", () => ({ documentId: this.documentId() }), {
    shape: "{ id version decision note stale askedAt decidedAt requester { id name } approver { id name } }",
    enabled: () => this.documentId() !== "",
  });
  readonly roster = injectQuery<Member[]>("members", {}, { shape: "{ id name }" });
  readonly items = computed(() => this.list.data() ?? []);
  readonly others = computed(() => (this.roster.data() ?? []).filter((m) => m.id !== this.meId()));

  /**
   * True once the list has been loading for a few seconds. A live query to a service that is down retries quietly
   * rather than failing, which is right for a blip and wrong for a service that is not running: after a moment the
   * panel says so instead of showing a placeholder for ever.
   */
  readonly slow = signal(false);

  constructor() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const waiting = this.list.loading() && !this.items().length;
      clearTimeout(timer);
      if (!waiting) this.slow.set(false);
      else timer = setTimeout(() => this.slow.set(true), 4000);
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(timer));
  }

  readonly request = injectCommand<Approval>("requestApproval");
  readonly decide = injectCommand<Approval>("decide");
  readonly withdraw = injectCommand<Approval>("withdraw");

  label(d: Approval["decision"]): string {
    return LABEL[d];
  }

  describe(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  when(at: number): string {
    return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  async ask(event: Event): Promise<void> {
    event.preventDefault();
    const approverId = ((event.target as HTMLFormElement).elements.namedItem("approver") as HTMLSelectElement).value;
    await this.run(() => this.request.run({ documentId: this.documentId(), projectId: this.projectId(), documentName: this.documentName(), version: this.version(), approverId }));
  }

  decideIt(a: Approval, decision: "approved" | "declined"): Promise<void> {
    return this.run(() => this.decide.run({ id: a.id, decision, note: null }));
  }

  withdrawIt(a: Approval): Promise<void> {
    return this.run(() => this.withdraw.run({ id: a.id }));
  }

  private async run(work: () => Promise<unknown>): Promise<void> {
    this.busy.set(true);
    this.failed.set(null);
    try {
      await work();
    } catch (e: unknown) {
      this.failed.set(this.describe(e));
    } finally {
      this.busy.set(false);
    }
  }
}

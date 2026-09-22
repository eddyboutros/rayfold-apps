/**
 * The bell.
 *
 * Three ways the same service speaks to one person, side by side. The count on the bell is `unread`, a live query:
 * whichever command wrote a notification names it in a patch, so the number is right without asking again. The list
 * is `notifications`, live while it is open. And the toast is `notified`, a stream: each notification as it is
 * written, pushed once — a hand-over made on another screen, or a file the catalogue finished indexing on another
 * service, shows up in the corner the moment it happens.
 */
import { ChangeDetectionStrategy, Component, computed, effect, signal, untracked } from "@angular/core";
import { injectCommand, injectLive, injectRayfoldClient, provideRayfold } from "@rayfold/angular";
import { workspaceClient } from "./client";

export interface Notification {
  id: string;
  kind: string;
  text: string;
  projectId: string;
  issueId: string | null;
  at: number;
  readAt: number | null;
}

interface Notified {
  notificationId: string;
  kind: string;
  text: string;
  at: number;
}

const KIND_LABEL: Record<string, string> = {
  "issue.assigned": "Handed to you",
  "comment.added": "A reply",
  "document.indexed": "Searchable now",
};

/** How long a toast stays: long enough to read, short enough that four in a row do not pile up. */
const TOAST_MS = 6000;

@Component({
  selector: "workspace-notifications",
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [provideRayfold(workspaceClient())],
  styleUrl: "./notifications.css",
  template: `
    <button type="button" class="bell" [class.on]="open()" (click)="toggle()" [attr.aria-expanded]="open()" aria-haspopup="dialog" title="Notifications">
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 16 V11 a6 6 0 0 1 12 0 v5 l1.5 2 h-15 Z M10 20 a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" />
      </svg>
      <span class="label">Notifications</span>
      @if (count(); as n) {
        <span class="count num" aria-label="{{ n }} unread">{{ n > 99 ? "99+" : n }}</span>
      }
      @if (unread.error()) {
        <span class="off" title="The count is not live"></span>
      }
    </button>

    @if (open()) {
      <div class="scrim" (click)="open.set(false)"></div>
      <div class="panel card" role="dialog" aria-label="Notifications">
        <header>
          <h2>Notifications</h2>
          <span class="tools">
            @if (list.error()) {
              <span class="pill bad"><span class="dot"></span>disconnected</span>
            } @else {
              <span class="pill ok live"><span class="dot"></span>live</span>
            }
            <button type="button" class="btn quiet" (click)="readAll()" [disabled]="!count() || mark.running()">Mark all read</button>
          </span>
        </header>
        <div class="body">
          @if (list.error(); as e) {
            <div class="empty"><strong>Could not load</strong>{{ describe(e) }}</div>
          } @else if (list.loading() && !items().length) {
            <span class="skeleton" style="width: 60%"></span>
          } @else if (!items().length) {
            <div class="empty">
              <strong>Nothing for you yet</strong>
              You are told here when an issue is handed to you, when someone replies on one you hold, and when a file you
              added becomes searchable.
            </div>
          } @else {
            <ol>
              @for (n of items(); track n.id) {
                <li class="item" [class.unread]="n.readAt === null">
                  <span class="mark" aria-hidden="true"></span>
                  <span class="what">
                    <span class="kind">{{ label(n.kind) }}</span>
                    <span class="text">{{ n.text }}</span>
                  </span>
                  <time [attr.datetime]="n.at">{{ when(n.at) }}</time>
                </li>
              }
            </ol>
          }
          @if (failed(); as message) {
            <p class="bad" role="alert">{{ message }}</p>
          }
        </div>
      </div>
    }

    <div class="toasts" aria-live="polite">
      @for (t of toasts(); track t.notificationId) {
        <div class="toast card">
          <span class="kind">{{ label(t.kind) }}</span>
          <span class="text">{{ t.text }}</span>
          <button type="button" class="close" (click)="dismiss(t.notificationId)" aria-label="Dismiss">×</button>
        </div>
      }
    </div>
  `,
})
export class Notifications {
  private readonly client = injectRayfoldClient();
  readonly open = signal(false);
  readonly failed = signal<string | null>(null);
  readonly toasts = signal<Notified[]>([]);

  readonly unread = injectLive<number>("unread", {}, {});
  readonly count = computed(() => this.unread.data() ?? 0);

  readonly list = injectLive<{ items: Notification[] }>("notifications", {}, {
    shape: "{ items { id kind text projectId issueId at readAt } }",
    enabled: () => this.open(),
  });
  readonly items = computed(() => this.list.data()?.items ?? []);

  readonly mark = injectCommand<number>("markRead");

  constructor() {
    // the stream lives as long as the bell does, which is as long as the session: one per person on the page
    effect((onCleanup) => {
      const ac = new AbortController();
      onCleanup(() => ac.abort());
      untracked(() => void this.listen(ac.signal));
    });
  }

  private async listen(signal: AbortSignal): Promise<void> {
    try {
      for await (const n of this.client.stream<Notified>("notified", {}, { signal })) {
        this.toasts.update((ts) => [...ts.filter((t) => t.notificationId !== n.notificationId), n]);
        setTimeout(() => this.dismiss(n.notificationId), TOAST_MS);
      }
    } catch (e: unknown) {
      // the badge and the list still work on their own; a toast that does not arrive is a toast, not a bug shown
      if (!signal.aborted) console.warn("the notification stream ended", e);
    }
  }

  dismiss(id: string): void {
    this.toasts.update((ts) => ts.filter((t) => t.notificationId !== id));
  }

  toggle(): void {
    this.open.update((o) => !o);
  }

  async readAll(): Promise<void> {
    this.failed.set(null);
    try {
      // no idempotency key: the command declares @idempotent(false), and the binding sends none for it
      await this.mark.run({ upTo: new Date().toISOString() });
    } catch (e: unknown) {
      this.failed.set(this.describe(e));
    }
  }

  label(kind: string): string {
    return KIND_LABEL[kind] ?? kind;
  }

  describe(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  when(at: number): string {
    const d = new Date(at);
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
}

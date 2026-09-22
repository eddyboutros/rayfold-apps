/**
 * The conversation on one issue.
 *
 * Opened inside the issues list, so it subscribes only while someone is looking at it: `injectLive` on `comments`
 * for this issue, and `addComment` to reply. A reply from another screen lands here without a refresh because the
 * command names the `comments` operation in its patch — a new row touches nothing an open thread has read.
 */
import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { injectCommand, injectLive } from "@rayfold/angular";

export interface Comment {
  id: string;
  body: string;
  at: number;
  by: { name: string } | null;
}

@Component({
  selector: "workspace-thread",
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: "./thread.css",
  template: `
    <div class="thread">
      @if (list.error(); as e) {
        <p class="bad" role="alert">The conversation could not be loaded: {{ describe(e) }}</p>
      } @else if (list.loading() && !comments().length) {
        <span class="skeleton" style="width: 48%"></span>
      } @else if (!comments().length) {
        <p class="muted none">No comments yet.</p>
      } @else {
        <ol>
          @for (c of comments(); track c.id) {
            <li>
              <span class="avatar" aria-hidden="true">{{ initial(c) }}</span>
              <span class="bubble">
                <span class="meta"><strong>{{ c.by?.name ?? "Someone" }}</strong> <time [attr.datetime]="c.at">{{ when(c.at) }}</time></span>
                <span class="body">{{ c.body }}</span>
              </span>
            </li>
          }
        </ol>
      }

      <form class="reply" (submit)="submit($event)">
        <input
          class="input"
          name="body"
          [value]="draft()"
          (input)="draft.set($any($event.target).value)"
          placeholder="Reply…"
          autocomplete="off"
        />
        <button type="submit" class="btn" [disabled]="!draft().trim() || add.running()">Post</button>
      </form>
      @if (failed(); as message) {
        <p class="bad" role="alert">{{ message }}</p>
      }
    </div>
  `,
})
export class Thread {
  readonly issueId = input<string>("");

  readonly draft = signal("");
  readonly failed = signal<string | null>(null);

  readonly list = injectLive<{ items: Comment[] }>("comments", () => ({ issueId: this.issueId() }), {
    shape: "{ items { id body at by { name } } }",
    enabled: () => this.issueId() !== "",
  });

  readonly comments = computed(() => this.list.data()?.items ?? []);
  readonly add = injectCommand<Comment>("addComment");

  initial(c: Comment): string {
    return (c.by?.name ?? "?").slice(0, 1).toUpperCase();
  }

  describe(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  when(at: number): string {
    const d = new Date(at);
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    const body = this.draft().trim();
    if (!body) return;
    this.failed.set(null);
    try {
      await this.add.run({ issueId: this.issueId(), body });
      this.draft.set("");
    } catch (e: unknown) {
      this.failed.set(this.describe(e));
    }
  }
}

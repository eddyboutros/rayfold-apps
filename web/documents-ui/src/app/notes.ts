/**
 * What the team has said about one document, live, and a line to add to it.
 *
 * `injectLive` on `notes`: a remark left from another screen lands here as it is made, because a new Note is an
 * entity of a type this query returns and the protocol re-runs it for that alone. The service raises an event for
 * each one too, which is how the project's feed, in another service, says "remarked on".
 */
import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { injectCommand, injectLive } from "@rayfold/angular";

export interface Note {
  id: string;
  body: string;
  at: number;
  by: { id: string; name: string } | null;
}

@Component({
  selector: "documents-notes",
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: "./notes.css",
  template: `
    <div class="notes">
      @if (list.error(); as e) {
        <p class="bad" role="alert">The notes could not be loaded: {{ describe(e) }}</p>
      } @else if (list.loading() && !notes().length) {
        <span class="skeleton" style="width: 48%"></span>
      } @else if (!notes().length) {
        <p class="muted none">Nothing said about this file yet.</p>
      } @else {
        <ol>
          @for (n of notes(); track n.id) {
            <li>
              <span class="avatar" [attr.data-person]="n.by?.id" aria-hidden="true">{{ initial(n) }}</span>
              <span class="bubble">
                <span class="meta"><strong>{{ n.by?.name ?? "Someone" }}</strong> <time [attr.datetime]="n.at">{{ when(n.at) }}</time></span>
                <span class="body">{{ n.body }}</span>
              </span>
            </li>
          }
        </ol>
      }

      <form class="reply" (submit)="submit($event)">
        <input class="input" name="body" [value]="draft()" (input)="draft.set($any($event.target).value)" placeholder="Say something about this file…" autocomplete="off" maxlength="4000" />
        <button type="submit" class="btn" [disabled]="!draft().trim() || add.running()">Post</button>
      </form>
      @if (failed(); as message) {
        <p class="bad" role="alert">{{ message }}</p>
      }
    </div>
  `,
})
export class Notes {
  readonly documentId = input<string>("");

  readonly draft = signal("");
  readonly failed = signal<string | null>(null);

  readonly list = injectLive<{ items: Note[] }>("notes", () => ({ documentId: this.documentId() }), {
    shape: "{ items { id body at by { id name } } }",
    enabled: () => this.documentId() !== "",
  });
  readonly notes = computed(() => this.list.data()?.items ?? []);
  readonly add = injectCommand<Note>("addNote");

  initial(n: Note): string {
    return (n.by?.name ?? "?").slice(0, 1).toUpperCase();
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
      await this.add.run({ documentId: this.documentId(), body });
      this.draft.set("");
    } catch (e: unknown) {
      this.failed.set(this.describe(e));
    }
  }
}

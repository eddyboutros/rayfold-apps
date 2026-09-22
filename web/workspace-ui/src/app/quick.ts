/**
 * The workspace's quick actions, loaded into the shell's palette: what the typed text could be made into.
 *
 * "New issue for me" is the point of the file. It is three commands — open the issue, hand it to the caller, leave
 * a first note — sent as one batch, the second and third naming the first's result with `$ref` before it exists.
 * One round trip, one idempotency key each, and the pipeline runs on the server in order: the way a form that
 * touches three things should talk to a service, and the way this one does.
 */
import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { injectCommand, injectQuery, injectRayfoldClient, provideRayfold } from "@rayfold/angular";
import { workspaceClient } from "./client";

@Component({
  selector: "workspace-quick",
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [provideRayfold(workspaceClient())],
  styleUrl: "./quick.css",
  template: `
    @if (!query().trim()) {
      <p class="muted none">Type a few words, and they become an issue or a line in the chat.</p>
    } @else {
      <ol class="list">
        <li>
          <button type="button" (click)="issue()" [disabled]="busy()">
            <span class="glyph" aria-hidden="true">+</span>
            <span class="text">
              <span class="label">New issue “{{ query().trim() }}”</span>
              <span class="hint muted">Opened on {{ projectName() || "the project" }}, handed to you, with a first note. Three commands, one request.</span>
            </span>
          </button>
        </li>
        <li>
          <button type="button" (click)="say()" [disabled]="busy()">
            <span class="glyph" aria-hidden="true">›</span>
            <span class="text">
              <span class="label">Say “{{ query().trim() }}” in the chat</span>
              <span class="hint muted">Everyone with {{ projectName() || "the project" }} open hears it as you send it.</span>
            </span>
          </button>
        </li>
      </ol>
      @if (failed(); as message) {
        <p class="bad" role="alert">{{ message }}</p>
      }
    }
  `,
})
export class Quick {
  readonly query = input("");
  readonly projectId = input("");
  readonly projectName = input("");

  private readonly client = injectRayfoldClient();
  readonly busy = signal(false);
  readonly failed = signal<string | null>(null);
  readonly me = injectQuery<{ id: string; name: string } | null>("me", {}, { shape: "{ id name }" });
  readonly sayIt = injectCommand("say");

  readonly title = computed(() => this.query().trim().slice(0, 200));

  async issue(): Promise<void> {
    const me = this.me.data();
    if (!me) return this.failed.set("Not signed in.");
    await this.run(async () => {
      const batch = this.client.batch();
      const opened = batch.command<{ id: string; title: string }>("createIssue", { projectId: this.projectId(), title: this.title() }, { shape: "{ id title version }" });
      // the id does not exist yet on this side; the server fills it in from the first op's result (spec 03 §5)
      batch.command("assignIssue", { id: opened.ref("id"), assigneeId: me.id }, { shape: "{ id }" });
      batch.command("addComment", { issueId: opened.ref("id"), body: "Opened from the command palette." }, { shape: "{ id }" });
      await batch.run();
      const issue = await opened.promise;
      this.tell(`Opened “${issue.title}” and handed it to you.`);
    });
  }

  async say(): Promise<void> {
    await this.run(async () => {
      await this.sayIt.run({ projectId: this.projectId(), body: this.query().trim().slice(0, 2000) });
      this.tell("Said in the chat.");
    });
  }

  /** Tells the page that holds this component, which it knows nothing about: a DOM event that bubbles out of it. */
  private tell(what: string): void {
    // dispatched from the host element, so it bubbles through the palette to whatever listens
    const host = (document.querySelector("workspace-quick") as HTMLElement | null) ?? document.body;
    host.dispatchEvent(new CustomEvent("keel-done", { bubbles: true, composed: true, detail: what }));
  }

  private async run(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.failed.set(null);
    try {
      await work();
    } catch (e: unknown) {
      this.failed.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }
}

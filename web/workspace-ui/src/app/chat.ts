/**
 * A project's chat.
 *
 * The first consumer of a `stream` in the fleet. The history is one query; everything after it arrives on
 * `chat(projectId)`, a stream the service feeds from the `Said` event, so a line said on another screen — or by
 * another instance of the service — lands here the moment it is said. Sending is `say`, a command like any other.
 * A stream is not a live query: nothing re-runs, each item is pushed once, in order, which is what a conversation is.
 */
import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, effect, input, signal, untracked, viewChild } from "@angular/core";
import { injectCommand, injectQuery, injectRayfoldClient, provideRayfold } from "@rayfold/angular";
import { workspaceClient } from "./client";

export interface Message {
  id: string;
  body: string;
  at: number;
  by: { id: string; name: string } | null;
}

/** What the stream carries: the event, not the entity. */
interface Said {
  messageId: string;
  body: string;
  byId: string;
  byName: string;
  at: number;
}

@Component({
  selector: "workspace-chat",
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [provideRayfold(workspaceClient())],
  styleUrl: "./chat.css",
  template: `
    <section class="card">
      <header>
        <h2>Chat</h2>
        @if (closedWhy()) {
          <span class="pill bad"><span class="dot"></span>stream closed</span>
        } @else {
          <span class="pill ok live"><span class="dot"></span>stream open</span>
        }
      </header>

      <div class="body">
        @if (!projectId()) {
          <div class="empty"><strong>No project selected</strong></div>
        } @else if (history.error()) {
          <div class="empty">
            <strong>The chat could not be loaded</strong>
            {{ describe(history.error()) }}
          </div>
        } @else {
          <ol class="log" #log>
            @if (history.loading() && !lines().length) {
              <li class="line"><span class="skeleton" style="width: 40%"></span></li>
            } @else if (!lines().length) {
              <li class="none muted">Nothing said yet. Whatever you say here reaches everyone with this project open.</li>
            }
            @for (m of lines(); track m.id) {
              <li class="line" [class.mine]="m.by?.id === me()">
                <span class="avatar" [attr.data-person]="m.by?.id" aria-hidden="true">{{ initials(m.by?.name) }}</span>
                <span class="bubble">
                  <span class="meta"><strong>{{ m.by?.name ?? "Someone" }}</strong> <time [attr.datetime]="m.at">{{ when(m.at) }}</time></span>
                  <span class="text">{{ m.body }}</span>
                </span>
              </li>
            }
          </ol>
          @if (closedWhy(); as why) {
            <p class="bad" role="alert">The stream ended: {{ why }} <button type="button" class="btn quiet" (click)="reopen()">Reconnect</button></p>
          }
          <form class="say" (submit)="submit($event)">
            <input class="input" name="body" [value]="draft()" (input)="draft.set($any($event.target).value)" placeholder="Say something to the project…" autocomplete="off" maxlength="2000" />
            <button type="submit" class="btn primary" [disabled]="!draft().trim() || say.running()">Send</button>
          </form>
          @if (failed(); as message) {
            <p class="bad" role="alert">{{ message }}</p>
          }
        }
      </div>
    </section>
  `,
})
export class Chat {
  readonly projectId = input<string>("");

  private readonly client = injectRayfoldClient();
  readonly draft = signal("");
  readonly failed = signal<string | null>(null);
  /** Why the stream ended, when it did: a stream is silent until something is said, so open is the absence of this. */
  readonly closedWhy = signal<string | null>(null);
  /** Who is signed in, read from the first message that is ours: the session is a cookie the page never sees. */
  readonly me = signal<string | null>(null);

  readonly history = injectQuery<{ items: Message[] }>("messages", () => ({ projectId: this.projectId() }), {
    shape: "{ items { id body at by { id name } } }",
    enabled: () => this.projectId() !== "",
  });

  /** Lines the stream delivered since the history was read. */
  private readonly arrived = signal<Message[]>([]);
  /** Bumped to reopen a stream that ended; the effect below reads it. */
  private readonly attempt = signal(0);

  readonly lines = computed(() => {
    const seen = new Set<string>();
    const all: Message[] = [];
    for (const m of [...(this.history.data()?.items ?? []), ...this.arrived()]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      all.push(m);
    }
    return all;
  });

  readonly say = injectCommand<Message>("say");

  private readonly log = viewChild<ElementRef<HTMLElement>>("log");

  constructor() {
    // one stream per project on screen: switching projects ends the old one and opens the next
    effect((onCleanup) => {
      const projectId = this.projectId();
      this.attempt();
      if (!projectId) return;
      const ac = new AbortController();
      onCleanup(() => ac.abort());
      untracked(() => {
        this.arrived.set([]);
        this.closedWhy.set(null);
        void this.listen(projectId, ac.signal);
      });
    });
    // the newest line is the one being read: keep it in view as lines arrive
    afterRenderEffect(() => {
      this.lines();
      const el = this.log()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  private async listen(projectId: string, signal: AbortSignal): Promise<void> {
    try {
      for await (const said of this.client.stream<Said>("chat", { projectId }, { signal })) {
        this.arrived.update((lines) => [...lines, { id: said.messageId, body: said.body, at: said.at, by: { id: said.byId, name: said.byName } }]);
      }
      if (!signal.aborted) this.close("the server closed it");
    } catch (e: unknown) {
      if (!signal.aborted) this.close(this.describe(e));
    }
  }

  private close(why: string): void {
    this.closedWhy.set(why);
  }

  reopen(): void {
    this.attempt.update((n) => n + 1);
  }

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    const body = this.draft().trim();
    if (!body) return;
    this.failed.set(null);
    try {
      const said = await this.say.run({ projectId: this.projectId(), body }, { shape: "{ id by { id } }" } as never);
      this.me.set(said.by?.id ?? null);
      this.draft.set("");
    } catch (e: unknown) {
      this.failed.set(this.describe(e));
    }
  }

  initials(name: string | undefined): string {
    if (!name) return "?";
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0] ?? "")
      .join("")
      .toUpperCase();
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

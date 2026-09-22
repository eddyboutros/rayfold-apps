/**
 * A project's issues: open one, move one along.
 *
 * `injectLive` keeps the list current for everyone with the page open — a move made on another screen lands here
 * without a refresh. `moveIssue` sends `ifVersion`, so two people moving the same issue at once cannot both win:
 * the second is told what it is now, and the list already shows it.
 */
import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { injectCommand, injectLive, provideRayfold } from "@rayfold/angular";
import { workspaceClient } from "./client";
import { Thread } from "./thread";

export type State = "open" | "doing" | "done";

export interface Issue {
  id: string;
  title: string;
  state: State;
  version: number;
  updatedAt: number;
  assignee: { name: string } | null;
}

const STATES: State[] = ["open", "doing", "done"];
const LABEL: Record<State, string> = { open: "Open", doing: "In progress", done: "Done" };

@Component({
  selector: "workspace-issues",
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [provideRayfold(workspaceClient())],
  imports: [Thread],
  styleUrl: "./issues.css",
  template: `
    <section class="card">
      <header>
        <h2>Issues</h2>
        <span class="muted count">{{ open().length }} open</span>
      </header>

      <form class="compose" (submit)="submit($event)">
        <input
          class="input"
          name="title"
          [value]="draft()"
          (input)="draft.set($any($event.target).value)"
          placeholder="What needs doing?"
          autocomplete="off"
        />
        <button type="submit" class="btn primary" [disabled]="!draft().trim() || create.running()">Add</button>
      </form>

      @if (failed(); as message) {
        <p class="body bad" role="alert">{{ message }}</p>
      }

      <div class="body list">
        @if (list.loading() && !issues().length) {
          @for (row of [1, 2, 3]; track row) {
            <div class="row"><span class="skeleton" style="width: 58%"></span></div>
          }
        } @else if (!issues().length) {
          <div class="empty">
            <strong>Nothing to do yet</strong>
            Add the first issue above.
          </div>
        } @else {
          @for (group of groups(); track group.state) {
            @if (group.items.length) {
              <p class="eyebrow group">{{ label(group.state) }}</p>
              <ol>
                @for (issue of group.items; track issue.id) {
                  <li [class.done]="issue.state === 'done'" [class.open]="openId() === issue.id">
                    <div class="row">
                      <button type="button" class="title" (click)="toggle(issue.id)" [attr.aria-expanded]="openId() === issue.id">
                        {{ issue.title }}
                      </button>
                      @if (issue.assignee) {
                        <span class="who muted">{{ issue.assignee.name }}</span>
                      }
                      <span class="moves">
                        @for (to of next(issue.state); track to) {
                          <button type="button" class="btn quiet" (click)="move(issue, to)" [disabled]="moving() === issue.id">
                            {{ label(to) }}
                          </button>
                        }
                      </span>
                    </div>
                    @if (openId() === issue.id) {
                      <workspace-thread [issueId]="issue.id" />
                    }
                  </li>
                }
              </ol>
            }
          }
        }
      </div>
    </section>
  `,
})
export class Issues {
  readonly projectId = input<string>("");

  readonly draft = signal("");
  readonly failed = signal<string | null>(null);
  readonly moving = signal<string | null>(null);
  /** The one issue whose conversation is open; its thread subscribes only while it is. */
  readonly openId = signal<string | null>(null);

  readonly list = injectLive<{ items: Issue[] }>("issues", () => ({ projectId: this.projectId() }), {
    shape: "{ items { id title state version updatedAt assignee { name } } }",
    enabled: () => this.projectId() !== "",
  });

  readonly issues = computed(() => this.list.data()?.items ?? []);
  readonly open = computed(() => this.issues().filter((i) => i.state !== "done"));
  readonly groups = computed(() => STATES.map((state) => ({ state, items: this.issues().filter((i) => i.state === state) })));

  readonly create = injectCommand<Issue>("createIssue");
  readonly moveIssue = injectCommand<Issue>("moveIssue");

  label(state: State): string {
    return LABEL[state];
  }

  toggle(id: string): void {
    this.openId.update((open) => (open === id ? null : id));
  }

  /** Where an issue may go from here: forward one step, and back one, never a jump to the end. */
  next(state: State): State[] {
    const i = STATES.indexOf(state);
    return [STATES[i + 1], STATES[i - 1]].filter((s): s is State => !!s);
  }

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    const title = this.draft().trim();
    if (!title) return;
    this.failed.set(null);
    try {
      await this.create.run({ projectId: this.projectId(), title });
      this.draft.set("");
      // the live list hears its own command's change; nothing to refetch
    } catch (e: unknown) {
      this.failed.set(e instanceof Error ? e.message : String(e));
    }
  }

  async move(issue: Issue, to: State): Promise<void> {
    this.moving.set(issue.id);
    this.failed.set(null);
    try {
      // the version read is the version sent: a move on top of someone else's is refused, not silently applied
      await this.moveIssue.run({ id: issue.id, to }, { ifVersion: issue.version });
    } catch (e: unknown) {
      this.failed.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.moving.set(null);
    }
  }
}

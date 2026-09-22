/**
 * A project's issues: open one, hand it to someone, move it along.
 *
 * `injectLive` keeps the list current for everyone with the page open — a move made on another screen lands here
 * without a refresh. `moveIssue` and `assignIssue` send `ifVersion`, so two people changing the same issue at once
 * cannot both win: the second is told what it is now, and the list already shows it.
 */
import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { injectCommand, injectLive, injectQuery, provideRayfold } from "@rayfold/angular";
import { workspaceClient } from "./client";
import { Thread } from "./thread";

export type State = "open" | "doing" | "done";

export interface Member {
  id: string;
  name: string;
}

export interface Issue {
  id: string;
  title: string;
  state: State;
  version: number;
  updatedAt: number;
  assignee: Member | null;
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
              <p class="eyebrow group">{{ label(group.state) }} <span class="n">{{ group.items.length }}</span></p>
              <ol>
                @for (issue of group.items; track issue.id) {
                  <li [class.done]="issue.state === 'done'" [class.open]="openId() === issue.id">
                    <div class="row">
                      <button type="button" class="title" (click)="toggle(issue.id)" [attr.aria-expanded]="openId() === issue.id">
                        {{ issue.title }}
                      </button>
                      <span class="moves">
                        @for (to of next(issue.state); track to) {
                          <button type="button" class="btn quiet" (click)="move(issue, to)" [disabled]="busy() === issue.id">
                            {{ label(to) }}
                          </button>
                        }
                      </span>
                      <label class="assignee" [class.nobody]="!issue.assignee" [title]="issue.assignee ? 'Assigned to ' + issue.assignee.name : 'Unassigned'">
                        <span class="avatar" [attr.data-person]="issue.assignee?.id" aria-hidden="true">{{ initials(issue.assignee) }}</span>
                        <span class="name">{{ issue.assignee ? short(issue.assignee.name) : "Assign" }}</span>
                        <select (change)="assign(issue, $any($event.target).value)" [disabled]="busy() === issue.id" aria-label="Assignee">
                          <option value="" [selected]="!issue.assignee">Nobody</option>
                          @for (m of members(); track m.id) {
                            <option [value]="m.id" [selected]="issue.assignee?.id === m.id">{{ m.name }}</option>
                          }
                        </select>
                      </label>
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
  /** The issue a command is running on, so its controls wait rather than fire twice. */
  readonly busy = signal<string | null>(null);
  /** The one issue whose conversation is open; its thread subscribes only while it is. */
  readonly openId = signal<string | null>(null);

  readonly list = injectLive<{ items: Issue[] }>("issues", () => ({ projectId: this.projectId() }), {
    shape: "{ items { id title state version updatedAt assignee { id name } } }",
    enabled: () => this.projectId() !== "",
  });
  readonly roster = injectQuery<Member[]>("members", {}, { shape: "{ id name }" });

  readonly issues = computed(() => this.list.data()?.items ?? []);
  readonly members = computed(() => this.roster.data() ?? []);
  readonly open = computed(() => this.issues().filter((i) => i.state !== "done"));
  readonly groups = computed(() => STATES.map((state) => ({ state, items: this.issues().filter((i) => i.state === state) })));

  readonly create = injectCommand<Issue>("createIssue");
  readonly moveIssue = injectCommand<Issue>("moveIssue");
  readonly assignIssue = injectCommand<Issue>("assignIssue");

  label(state: State): string {
    return LABEL[state];
  }

  initials(member: Member | null): string {
    if (!member) return "+";
    return member.name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0] ?? "")
      .join("")
      .toUpperCase();
  }

  /** First name, in a row that has no room for two. */
  short(name: string): string {
    return name.split(/\s+/)[0] ?? name;
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
    // the version read is the version sent: a move on top of someone else's is refused, not silently applied
    await this.change(issue, () => this.moveIssue.run({ id: issue.id, to }, { ifVersion: issue.version }));
  }

  async assign(issue: Issue, assigneeId: string): Promise<void> {
    await this.change(issue, () => this.assignIssue.run({ id: issue.id, assigneeId: assigneeId || null }, { ifVersion: issue.version }));
  }

  private async change(issue: Issue, run: () => Promise<unknown>): Promise<void> {
    this.busy.set(issue.id);
    this.failed.set(null);
    try {
      await run();
    } catch (e: unknown) {
      this.failed.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(null);
    }
  }
}

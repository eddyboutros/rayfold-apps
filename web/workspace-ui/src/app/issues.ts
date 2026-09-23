/**
 * A project's issues: open one, hand it to someone, move it along, and open one up to change the rest.
 *
 * `injectLive` keeps the list current for everyone with the page open — a move made on another screen lands here
 * without a refresh. The filters are arguments to that live query, read from signals, so narrowing the list is a
 * new subscription rather than a filter over a list already fetched. Every change sends `ifVersion`, so two people
 * changing the same issue at once cannot both win: the second is told what it is now, and the list already shows it.
 * The detail form sends only the fields a person touched (`updateIssue` leaves absent fields alone), which is what
 * lets two people edit different fields of one issue at the same time.
 */
import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { injectCommand, injectLive, injectQuery, provideRayfold } from "@rayfold/angular";
import { workspaceClient } from "./client";
import { Attachments, type Pin } from "./attachments";
import { Thread } from "./thread";

export type State = "open" | "doing" | "done";
export type Priority = "low" | "normal" | "high" | "urgent";

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
  priority: Priority;
  labels: string[];
  dueOn: string | null;
  description: string | null;
  attachments: Pin[];
}

/** What the detail form sends: the keys present are the fields touched. */
interface Changes {
  title?: string;
  description?: string | null;
  priority?: Priority;
  labels?: string[];
  dueOn?: string | null;
}

const STATES: State[] = ["open", "doing", "done"];
const LABEL: Record<State, string> = { open: "Open", doing: "In progress", done: "Done" };
const PRIORITIES: Priority[] = ["urgent", "high", "normal", "low"];
const PRIORITY_LABEL: Record<Priority, string> = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };
const RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

@Component({
  selector: "workspace-issues",
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [provideRayfold(workspaceClient())],
  imports: [Thread, Attachments],
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

      <div class="filters">
        <label class="filter">
          <span class="muted">Holder</span>
          <select (change)="holder.set($any($event.target).value)" aria-label="Filter by holder">
            <option value="" [selected]="!holder()">Anyone</option>
            @for (m of members(); track m.id) {
              <option [value]="m.id" [selected]="holder() === m.id">{{ m.name }}</option>
            }
          </select>
        </label>
        <label class="filter">
          <span class="muted">Label</span>
          <select (change)="label.set($any($event.target).value)" aria-label="Filter by label">
            <option value="" [selected]="!label()">Any</option>
            @for (l of knownLabels(); track l) {
              <option [value]="l" [selected]="label() === l">{{ l }}</option>
            }
          </select>
        </label>
        @if (holder() || label()) {
          <button type="button" class="btn quiet clear" (click)="holder.set(''); label.set('')">Clear</button>
        }
      </div>

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
            @if (holder() || label()) {
              <strong>Nothing matches</strong>
              No issue has that holder and label. Clear the filters to see them all.
            } @else {
              <strong>Nothing to do yet</strong>
              Add the first issue above.
            }
          </div>
        } @else {
          @for (group of groups(); track group.state) {
            @if (group.items.length) {
              <p class="eyebrow group">{{ stateLabel(group.state) }} <span class="n">{{ group.items.length }}</span></p>
              <ol>
                @for (issue of group.items; track issue.id) {
                  <li [class.done]="issue.state === 'done'" [class.open]="openId() === issue.id">
                    <div class="row">
                      <span class="priority" [attr.data-priority]="issue.priority" [title]="priorityLabel(issue.priority) + ' priority'" aria-hidden="true"></span>
                      <button type="button" class="title" (click)="toggle(issue.id)" [attr.aria-expanded]="openId() === issue.id">
                        <span class="text">{{ issue.title }}</span>
                        @if (issue.dueOn || issue.labels.length) {
                          <span class="tags">
                            @if (issue.dueOn) {
                              <span class="due" [class.late]="isLate(issue)" [class.soon]="isSoon(issue)">{{ dueText(issue) }}</span>
                            }
                            @for (l of issue.labels; track l) {
                              <span class="tag">{{ l }}</span>
                            }
                          </span>
                        }
                      </button>
                      <span class="moves">
                        @for (to of next(issue.state); track to) {
                          <button type="button" class="btn quiet" (click)="move(issue, to)" [disabled]="busy() === issue.id">
                            {{ stateLabel(to) }}
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
                      <div class="detail">
                        <form class="fields" (submit)="save($event, issue)">
                          <label>
                            <span class="muted">Priority</span>
                            <select name="priority" [disabled]="busy() === issue.id" (change)="touch('priority', $any($event.target).value)">
                              @for (p of priorities; track p) {
                                <option [value]="p" [selected]="issue.priority === p">{{ priorityLabel(p) }}</option>
                              }
                            </select>
                          </label>
                          <label>
                            <span class="muted">Due</span>
                            <input type="date" name="dueOn" [value]="issue.dueOn ?? ''" (change)="touch('dueOn', $any($event.target).value || null)" />
                          </label>
                          <label class="wide">
                            <span class="muted">Labels</span>
                            <input class="input" name="labels" [value]="issue.labels.join(', ')" (input)="touch('labels', splitLabels($any($event.target).value))" placeholder="ops, wave-2" autocomplete="off" />
                          </label>
                          <label class="wide">
                            <span class="muted">Description</span>
                            <textarea class="input" name="description" rows="3" [value]="issue.description ?? ''" (input)="touch('description', $any($event.target).value || null)" placeholder="What is this about, and what does done look like?"></textarea>
                          </label>
                          <span class="actions">
                            <span class="muted version">v{{ issue.version }}</span>
                            <button type="submit" class="btn primary" [disabled]="!touched().length || busy() === issue.id">Save changes</button>
                            @if (touched().length) {
                              <button type="button" class="btn quiet" (click)="untouch()">Discard</button>
                            }
                          </span>
                        </form>
                        <workspace-attachments [issueId]="issue.id" [projectId]="projectId()" [pins]="issue.attachments" />
                        <workspace-thread [issueId]="issue.id" />
                      </div>
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
  /** The one issue that is open; its thread subscribes only while it is. */
  readonly openId = signal<string | null>(null);
  readonly holder = signal("");
  readonly label = signal("");
  /** What the open issue's form has changed and not yet saved: only these keys are sent. */
  readonly changes = signal<Changes>({});
  readonly touched = computed(() => Object.keys(this.changes()));
  readonly priorities = PRIORITIES;

  readonly list = injectLive<{ items: Issue[] }>(
    "issues",
    () => ({ projectId: this.projectId(), assigneeId: this.holder() || null, label: this.label() || null }),
    {
      shape: "{ items { id title state version updatedAt priority labels dueOn description assignee { id name } attachments { id documentId name url } } }",
      enabled: () => this.projectId() !== "",
    },
  );
  /** Every label on the project, for the filter: read once unfiltered, so narrowing by one label keeps the others in the picker. */
  readonly all = injectLive<{ items: Array<{ labels: string[] }> }>("issues", () => ({ projectId: this.projectId() }), {
    shape: "{ items { labels } }",
    enabled: () => this.projectId() !== "",
  });
  readonly roster = injectQuery<Member[]>("members", {}, { shape: "{ id name }" });

  readonly issues = computed(() => this.list.data()?.items ?? []);
  readonly members = computed(() => this.roster.data() ?? []);
  readonly knownLabels = computed(() => [...new Set((this.all.data()?.items ?? []).flatMap((i) => i.labels))].sort());
  readonly open = computed(() => this.issues().filter((i) => i.state !== "done"));
  readonly groups = computed(() =>
    STATES.map((state) => ({
      state,
      // the most pressing first: priority, then the nearest day, then whatever is left in the order it was opened
      items: this.issues()
        .filter((i) => i.state === state)
        .sort((a, b) => RANK[a.priority] - RANK[b.priority] || (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999")),
    })),
  );

  readonly create = injectCommand<Issue>("createIssue");
  readonly moveIssue = injectCommand<Issue>("moveIssue");
  readonly assignIssue = injectCommand<Issue>("assignIssue");
  readonly updateIssue = injectCommand<Issue>("updateIssue");

  stateLabel(state: State): string {
    return LABEL[state];
  }

  priorityLabel(p: Priority): string {
    return PRIORITY_LABEL[p];
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

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  isLate(issue: Issue): boolean {
    return issue.state !== "done" && !!issue.dueOn && issue.dueOn < this.today();
  }

  isSoon(issue: Issue): boolean {
    if (issue.state === "done" || !issue.dueOn || this.isLate(issue)) return false;
    const days = (Date.parse(issue.dueOn) - Date.parse(this.today())) / 86_400_000;
    return days <= 3;
  }

  dueText(issue: Issue): string {
    const d = new Date(`${issue.dueOn}T00:00:00`);
    const when = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return this.isLate(issue) ? `overdue ${when}` : `due ${when}`;
  }

  toggle(id: string): void {
    this.openId.update((open) => (open === id ? null : id));
    this.changes.set({});
  }

  /** Where an issue may go from here: forward one step, and back one, never a jump to the end. */
  next(state: State): State[] {
    const i = STATES.indexOf(state);
    return [STATES[i + 1], STATES[i - 1]].filter((s): s is State => !!s);
  }

  splitLabels(text: string): string[] {
    return text
      .split(/[,\s]+/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  touch<K extends keyof Changes>(key: K, value: Changes[K]): void {
    this.changes.update((c) => ({ ...c, [key]: value }));
  }

  untouch(): void {
    this.changes.set({});
    // the inputs are uncontrolled beyond their initial value; closing and reopening re-reads the issue
    const id = this.openId();
    this.openId.set(null);
    this.openId.set(id);
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

  async save(event: Event, issue: Issue): Promise<void> {
    event.preventDefault();
    const changes = this.changes();
    if (!Object.keys(changes).length) return;
    await this.change(issue, async () => {
      await this.updateIssue.run({ id: issue.id, changes }, { ifVersion: issue.version });
      this.changes.set({});
    });
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

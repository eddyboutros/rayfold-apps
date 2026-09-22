/**
 * The command palette: everything the page can do, from the keyboard.
 *
 * The shell's own entries go somewhere. The entries that do something come from a remote — the workspace team's
 * quick actions — loaded into the palette like any panel, with the typed text as their input, because a command
 * belongs to the service it changes and the shell provides no client. A remote says it is done with a DOM event
 * that bubbles up to here, which is the one thing a component can say to a page it knows nothing about.
 */
import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, input, output, signal, viewChild, type Type } from "@angular/core";
import { NgComponentOutlet } from "@angular/common";

export interface Action {
  id: string;
  label: string;
  hint?: string;
  keys?: string[];
  run: () => void;
}

@Component({
  selector: "keel-palette",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgComponentOutlet],
  styleUrl: "./palette.css",
  template: `
    <div class="scrim" (click)="close.emit()"></div>
    <div class="palette card" role="dialog" aria-label="Command palette" (keydown)="onKey($event)" (keel-done)="done($event)">
      <div class="box">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
        </svg>
        <input #box class="input" [value]="query()" (input)="query.set($any($event.target).value); cursor.set(0)" placeholder="Go somewhere, or type what needs doing…" autocomplete="off" spellcheck="false" aria-label="Command" />
        <kbd>Esc</kbd>
      </div>

      @if (matches().length) {
        <p class="eyebrow group">Go to</p>
        <ol class="list" role="listbox">
          @for (a of matches(); track a.id; let i = $index) {
            <li>
              <button type="button" role="option" [class.on]="i === cursor()" [attr.aria-selected]="i === cursor()" (mouseenter)="cursor.set(i)" (click)="pick(a)">
                <span class="label">{{ a.label }}</span>
                @if (a.hint) {
                  <span class="hint muted">{{ a.hint }}</span>
                }
                @if (hints() && a.keys) {
                  <span class="keys">
                    @for (k of a.keys; track $index) {
                      <kbd>{{ k }}</kbd>
                    }
                  </span>
                }
              </button>
            </li>
          }
        </ol>
      }

      @if (quick(); as component) {
        <p class="eyebrow group">Do</p>
        <div class="quick">
          <ng-container *ngComponentOutlet="component; inputs: { query: query(), projectId: projectId(), projectName: projectName() }" />
        </div>
      }

      @if (!matches().length && !quick()) {
        <p class="muted none">Nothing matches.</p>
      }
    </div>
  `,
})
export class Palette {
  readonly actions = input<Action[]>([]);
  readonly hints = input(true);
  /** The remote's quick actions, once the shell has loaded them; null while it has not, or if it could not. */
  readonly quick = input<Type<unknown> | null>(null);
  readonly projectId = input("");
  readonly projectName = input("");
  readonly initial = input("");
  readonly close = output<void>();
  /** A line for the page to show once something was done: what, in the remote's words. */
  readonly did = output<string>();

  readonly query = signal("");
  readonly cursor = signal(0);
  private readonly box = viewChild<ElementRef<HTMLInputElement>>("box");

  readonly matches = computed(() => {
    const q = this.query().trim().toLowerCase();
    const all = this.actions();
    if (!q) return all;
    return all.filter((a) => a.label.toLowerCase().includes(q) || (a.hint ?? "").toLowerCase().includes(q));
  });

  constructor() {
    afterNextRender(() => {
      this.query.set(this.initial());
      this.box()?.nativeElement.focus();
    });
  }

  onKey(event: KeyboardEvent): void {
    // arrows and enter belong to the list; the remote's inputs get everything else
    if (event.key === "Escape") {
      event.preventDefault();
      this.close.emit();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      this.cursor.update((c) => Math.min(c + 1, Math.max(0, this.matches().length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      this.cursor.update((c) => Math.max(c - 1, 0));
    } else if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT" && (event.target as HTMLElement).classList.contains("input") && this.matches().length && (event.target as HTMLInputElement) === this.box()?.nativeElement) {
      event.preventDefault();
      const a = this.matches()[this.cursor()];
      if (a) this.pick(a);
    }
  }

  pick(a: Action): void {
    a.run();
    this.close.emit();
  }

  done(event: Event): void {
    const detail = (event as CustomEvent<string>).detail;
    this.did.emit(typeof detail === "string" ? detail : "Done");
    this.close.emit();
  }
}

/**
 * What a person has chosen about the page itself: the theme, whether the bell toasts, where the page opens.
 *
 * Kept in the browser, not a service: none of it is the team's business, and a page that opens with no service to
 * ask still has to know it is dark. The remotes read the same key for the one choice that is theirs to honour (the
 * bell's toasts), which is the whole of what the shell and a remote share.
 */
import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";

export interface Settings {
  theme: "system" | "light" | "dark";
  toasts: boolean;
  /** Where the page opens: the last project looked at, or one by id. */
  startOn: "last" | string;
  hints: boolean;
}

export const SETTINGS_KEY = "keel.settings";
export const DEFAULTS: Settings = { theme: "system", toasts: true, startOn: "last", hints: true };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    // the theme is read before the first paint by a script that knows only this key
    if (s.theme === "system") localStorage.removeItem("keel.theme");
    else localStorage.setItem("keel.theme", s.theme);
  } catch {
    // a browser that refuses storage keeps the choice for this visit, which is the part that matters
  }
}

/** Puts the chosen theme on the document: an explicit choice stamps it, "system" leaves it to the OS. */
export function applyTheme(theme: Settings["theme"]): void {
  if (theme === "system") delete document.documentElement.dataset["theme"];
  else document.documentElement.dataset["theme"] = theme;
}

export const SHORTCUTS: Array<{ keys: string[]; does: string }> = [
  { keys: ["Ctrl", "K"], does: "Open the command palette" },
  { keys: ["/"], does: "Open the palette with the search ready" },
  { keys: ["g", "1"], does: "Go to the first project" },
  { keys: ["g", "2"], does: "Go to the second project" },
  { keys: ["g", "c"], does: "Go to the catalogue" },
  { keys: ["g", "p"], does: "Go to people" },
  { keys: ["g", "s"], does: "Go to settings" },
  { keys: ["?"], does: "Open the guide" },
  { keys: ["t"], does: "Switch between light and dark" },
  { keys: ["Esc"], does: "Close whatever is open" },
];

@Component({
  selector: "keel-settings",
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: "./settings.css",
  template: `
    <div class="settings">
      <div class="head">
        <h1>Settings</h1>
        <p class="lede">Yours, on this browser. Nothing here is sent anywhere.</p>
      </div>

      <section class="card">
        <header><h2>Appearance</h2></header>
        <div class="body">
          <div class="row">
            <div class="label">
              <strong>Theme</strong>
              <span class="muted">System follows the operating system; the others stay put.</span>
            </div>
            <div class="seg" role="radiogroup" aria-label="Theme">
              @for (t of themes; track t.value) {
                <button type="button" role="radio" [attr.aria-checked]="value().theme === t.value" [class.on]="value().theme === t.value" (click)="set({ theme: t.value })">{{ t.label }}</button>
              }
            </div>
          </div>
        </div>
      </section>

      <section class="card">
        <header><h2>Notifications</h2></header>
        <div class="body">
          <label class="row">
            <div class="label">
              <strong>Toasts</strong>
              <span class="muted">A note in the corner when something is handed to you, replied to, or made searchable. The bell counts either way.</span>
            </div>
            <input type="checkbox" class="switch" [checked]="value().toasts" (change)="set({ toasts: $any($event.target).checked })" />
          </label>
        </div>
      </section>

      <section class="card">
        <header><h2>On opening</h2></header>
        <div class="body">
          <div class="row">
            <div class="label">
              <strong>Start on</strong>
              <span class="muted">Which project the page opens to.</span>
            </div>
            <select (change)="set({ startOn: $any($event.target).value })" aria-label="Start on">
              <option value="last" [selected]="value().startOn === 'last'">The project I looked at last</option>
              @for (p of projects(); track p.id) {
                <option [value]="p.id" [selected]="value().startOn === p.id">{{ p.name }}</option>
              }
            </select>
          </div>
          <label class="row">
            <div class="label">
              <strong>Keyboard hints</strong>
              <span class="muted">Show the shortcut beside each entry in the palette.</span>
            </div>
            <input type="checkbox" class="switch" [checked]="value().hints" (change)="set({ hints: $any($event.target).checked })" />
          </label>
        </div>
      </section>

      <section class="card">
        <header><h2>Keyboard</h2></header>
        <div class="body">
          <dl class="keys">
            @for (s of shortcuts; track s.does) {
              <div>
                <dt>
                  @for (k of s.keys; track $index) {
                    <kbd>{{ k }}</kbd>
                  }
                </dt>
                <dd>{{ s.does }}</dd>
              </div>
            }
          </dl>
        </div>
      </section>
    </div>
  `,
})
export class SettingsPage {
  readonly value = input.required<Settings>();
  readonly projects = input<Array<{ id: string; name: string }>>([]);
  readonly changed = output<Settings>();
  readonly themes: Array<{ value: Settings["theme"]; label: string }> = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];
  readonly shortcuts = SHORTCUTS;

  set(change: Partial<Settings>): void {
    this.changed.emit({ ...this.value(), ...change });
  }
}

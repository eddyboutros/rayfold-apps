/**
 * What a document looks like, inside the list: text as text, a table as a table, an image as itself, a PDF in the
 * browser's own viewer. The bytes are fetched from the same URL a link would open, with the same session cookie (or
 * the same share token in the query), so what this shows is exactly what the service lets this person read.
 */
import { ChangeDetectionStrategy, Component, computed, effect, input, signal, untracked } from "@angular/core";

type Shown = { kind: "text"; text: string } | { kind: "table"; rows: string[][] } | { kind: "image" } | { kind: "pdf" } | { kind: "none"; why: string };

/** More than this and a preview is a download: the point is a glance, not the whole file in the page. */
const MOST_TEXT = 200_000;

@Component({
  selector: "documents-preview",
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: "./preview.css",
  template: `
    <div class="preview">
      @if (failed(); as why) {
        <p class="bad" role="alert">{{ why }}</p>
      } @else if (!shown()) {
        <span class="skeleton" style="width: 55%"></span>
      } @else {
        @switch (shown()!.kind) {
          @case ("text") {
            <pre>{{ $any(shown()).text }}</pre>
          }
          @case ("table") {
            <div class="scroll">
              <table>
                @for (row of $any(shown()).rows; track $index; let head = $first) {
                  <tr>
                    @for (cell of row; track $index) {
                      @if (head) {
                        <th>{{ cell }}</th>
                      } @else {
                        <td>{{ cell }}</td>
                      }
                    }
                  </tr>
                }
              </table>
            </div>
          }
          @case ("image") {
            <img [src]="url()" [alt]="name()" />
          }
          @case ("pdf") {
            <iframe [src]="url()" [title]="name()"></iframe>
          }
          @case ("none") {
            <p class="muted none">{{ $any(shown()).why }}</p>
          }
        }
      }
    </div>
  `,
})
export class Preview {
  readonly url = input<string>("");
  readonly contentType = input<string>("");
  readonly name = input<string>("");

  readonly shown = signal<Shown | null>(null);
  readonly failed = signal<string | null>(null);

  constructor() {
    effect((onCleanup) => {
      const url = this.url();
      const type = this.contentType();
      const name = this.name();
      const ac = new AbortController();
      onCleanup(() => ac.abort());
      untracked(() => {
        this.shown.set(null);
        this.failed.set(null);
        void this.load(url, type, name, ac.signal);
      });
    });
  }

  private async load(url: string, type: string, name: string, signal: AbortSignal): Promise<void> {
    if (!url) return;
    if (type.startsWith("image/")) return this.shown.set({ kind: "image" });
    if (type === "application/pdf") return this.shown.set({ kind: "pdf" });
    const textual = type.startsWith("text/") || type === "application/json" || /\.(md|txt|csv|json|log|ya?ml)$/i.test(name);
    if (!textual) return this.shown.set({ kind: "none", why: `No preview for ${type || "this kind of file"}. Open it to download.` });
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(res.status === 401 ? "You are not signed in." : `The file could not be read (${res.status}).`);
      const text = (await res.text()).slice(0, MOST_TEXT);
      if (type === "text/csv" || /\.csv$/i.test(name)) this.shown.set({ kind: "table", rows: csv(text) });
      else this.shown.set({ kind: "text", text });
    } catch (e: unknown) {
      if (!signal.aborted) this.failed.set(e instanceof Error ? e.message : String(e));
    }
  }
}

/** Enough CSV for a glance: commas, quoted cells with commas or doubled quotes, one row per line. */
function csv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") {
        cells.push(cell);
        cell = "";
      } else cell += c;
    }
    cells.push(cell);
    rows.push(cells);
    if (rows.length > 200) break;
  }
  return rows;
}

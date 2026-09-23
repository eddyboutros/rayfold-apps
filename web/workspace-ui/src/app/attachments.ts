/**
 * The documents pinned to one issue, and the picker that pins another.
 *
 * Two services in one small panel. The pins are the workspace's — they arrive with the issue, and the list of
 * issues is live, so a pin made on another screen shows here as it happens. The picker's choices are the documents
 * service's, read with a client of its own when the picker opens: this panel never asks the workspace what the
 * documents service knows, and the workspace never asks either. What crosses between them is the pin — an id, a
 * name and an address — and later the rename the documents service announces over the relay.
 */
import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { RayfoldClient } from "@rayfold/client";
import { injectCommand, injectRayfoldClient } from "@rayfold/angular";
import { documentsBase, documentsClient } from "./client";

export interface Pin {
  id: string;
  documentId: string;
  name: string;
  url: string;
}

interface Doc {
  id: string;
  name: string;
  url: string;
}

@Component({
  selector: "workspace-attachments",
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: "./attachments.css",
  template: `
    <div class="pins">
      <span class="muted label">Attached</span>
      @if (pins().length) {
        <ul>
          @for (p of pins(); track p.id) {
            <li>
              <a [href]="href(p)" target="_blank" rel="noopener">{{ p.name }}</a>
              <button type="button" class="btn quiet tiny" (click)="detach(p)" [disabled]="busy()" [attr.aria-label]="'Detach ' + p.name">Detach</button>
            </li>
          }
        </ul>
      } @else {
        <span class="muted none">Nothing yet.</span>
      }
      @if (picking()) {
        <span class="picker">
          <select (change)="pick($any($event.target).value)" [disabled]="busy()" aria-label="Document to attach" autofocus>
            <option value="">{{ docs() === null ? "Loading the project's documents…" : choices().length ? "Choose a document" : "Every document is already attached" }}</option>
            @for (d of choices(); track d.id) {
              <option [value]="d.id">{{ d.name }}</option>
            }
          </select>
          <button type="button" class="btn quiet tiny" (click)="picking.set(false)">Cancel</button>
        </span>
      } @else {
        <button type="button" class="btn quiet tiny" (click)="open()">Attach a document</button>
      }
      @if (failed(); as message) {
        <span class="bad">{{ message }}</span>
      }
    </div>
  `,
})
export class Attachments {
  readonly issueId = input.required<string>();
  readonly projectId = input.required<string>();
  readonly pins = input<Pin[]>([]);

  private readonly workspace: RayfoldClient = injectRayfoldClient();
  private readonly documents = documentsClient();
  readonly attach = injectCommand<Pin>("attachDocument");
  readonly picking = signal(false);
  readonly busy = signal(false);
  readonly failed = signal<string | null>(null);
  /** The project's documents, read when the picker opens; null until they arrive. */
  readonly docs = signal<Doc[] | null>(null);
  readonly choices = computed(() => (this.docs() ?? []).filter((d) => !this.pins().some((p) => p.documentId === d.id)));

  /** The documents service hands out `/files/<id>`, its own path; it is reached under that service's base. */
  href(p: Pin): string {
    return p.url.startsWith("http") ? p.url : `${documentsBase()}${p.url}`;
  }

  async open(): Promise<void> {
    this.picking.set(true);
    this.failed.set(null);
    this.docs.set(null);
    try {
      const page = await this.documents.query<{ items: Doc[] }>("documents", { projectId: this.projectId() }, { shape: "{ items { id name url } }", policy: "network" });
      this.docs.set(page.items);
    } catch (e: unknown) {
      this.failed.set(`The documents service did not answer: ${e instanceof Error ? e.message : String(e)}`);
      this.docs.set([]);
    }
  }

  async pick(documentId: string): Promise<void> {
    const doc = this.docs()?.find((d) => d.id === documentId);
    if (!doc) return;
    await this.run(async () => {
      await this.attach.run({ issueId: this.issueId(), documentId: doc.id, name: doc.name, url: doc.url });
      this.picking.set(false);
    });
  }

  async detach(p: Pin): Promise<void> {
    await this.run(() => this.workspace.command("detachDocument", { id: p.id }));
  }

  private async run(work: () => Promise<unknown>): Promise<void> {
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


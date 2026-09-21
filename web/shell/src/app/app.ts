/**
 * The shell.
 *
 * It owns the page, the Rayfold client and who is signed in — and none of the features. Each panel below is loaded
 * at runtime from a remote the owning team deploys on its own, which is the point of the arrangement: the workspace
 * team ships its feed without this application being rebuilt.
 */
import { ChangeDetectionStrategy, Component, signal, type Type } from "@angular/core";
import { loadRemoteModule } from "@angular-architects/native-federation";
import { NgComponentOutlet } from "@angular/common";

@Component({
  selector: "app-root",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgComponentOutlet],
  styleUrl: "./app.css",
  template: `
    <header class="bar">
      <strong>Rayfold apps</strong>
      <span class="who">signed in as Ada</span>
    </header>

    <main>
      <section class="panel">
        <h1>Project p1</h1>
        <p class="lede">
          Everything below is one service's work or another's. Upload a file to the documents service on :4001 and it
          appears here, because the workspace service hears it on the relay and this query is live.
        </p>

        @if (feed(); as Feed) {
          <ng-container *ngComponentOutlet="Feed; inputs: { projectId: 'p1' }" />
        } @else if (failed()) {
          <p role="alert" class="bad">The workspace feed could not be loaded: {{ failed() }}</p>
        } @else {
          <p class="muted">Loading the workspace feed…</p>
        }
      </section>
    </main>
  `,
})
export class App {
  readonly feed = signal<Type<unknown> | null>(null);
  readonly failed = signal<string | null>(null);

  constructor() {
    // loaded at runtime, from a build this application has never seen
    void loadRemoteModule("workspace-ui", "./Feed")
      .then((m: { Feed: Type<unknown> }) => this.feed.set(m.Feed))
      .catch((e: unknown) => this.failed.set(e instanceof Error ? e.message : String(e)));
  }
}

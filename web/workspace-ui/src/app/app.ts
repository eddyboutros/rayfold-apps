/** What this remote is when run on its own: the issues and the feed, for the default project. */
import { ChangeDetectionStrategy, Component } from "@angular/core";
import { Feed } from "./feed";
import { Issues } from "./issues";

@Component({
  selector: "app-root",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Issues, Feed],
  styles: `
    :host { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; padding: 16px; }
  `,
  template: `
    <workspace-issues projectId="p1" />
    <workspace-feed projectId="p1" />
  `,
})
export class App {}

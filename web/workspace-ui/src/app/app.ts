/**
 * What this remote exposes to the shell.
 *
 * The team that owns the workspace service owns this too: it is built, versioned and deployed on its own, and the
 * shell loads it at runtime from `remoteEntry.json`. Nothing about it is compiled into the shell.
 */
import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { Feed } from "./feed";

@Component({
  selector: "workspace-ui",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Feed],
  template: `<workspace-feed [projectId]="projectId()" />`,
})
export class App {
  readonly projectId = input<string>("p1");
}

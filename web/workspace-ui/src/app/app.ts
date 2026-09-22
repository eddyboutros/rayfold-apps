/** What this remote is when run on its own: the feed, for the default project. */
import { ChangeDetectionStrategy, Component } from "@angular/core";
import { Feed } from "./feed";

@Component({
  selector: "workspace-ui",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Feed],
  template: `<workspace-feed projectId="p1" />`,
})
export class App {}

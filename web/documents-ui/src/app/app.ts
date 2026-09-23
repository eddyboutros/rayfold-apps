import { ChangeDetectionStrategy, Component } from "@angular/core";
import { Documents } from "./documents";

/** What this remote is when run on its own: the documents panel, for the default project. */
@Component({
  selector: "app-root",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Documents],
  template: `<documents-panel projectId="p1" />`,
})
export class App {}

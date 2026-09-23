import { ChangeDetectionStrategy, Component } from "@angular/core";
import { Documents } from "./documents";

/** What this remote is when run on its own: the documents panel, for the default project. */
@Component({
  selector: "app-root",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Documents],
  styles: `
    :host { display: block; max-width: 900px; margin: 0 auto; padding: 16px; }
  `,
  template: `<documents-panel projectId="p1" />`,
})
export class App {}

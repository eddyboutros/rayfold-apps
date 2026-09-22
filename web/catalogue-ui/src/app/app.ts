/**
 * The remote on its own, for the team that owns it: the page at :4203 with nothing around it. The shell never
 * loads this; it loads `./Catalogue` from the remote entry.
 */
import { ChangeDetectionStrategy, Component } from "@angular/core";
import { Catalogue } from "./catalogue";

@Component({
  selector: "app-root",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Catalogue],
  template: `<main style="max-width: 1100px; margin: 0 auto; padding: 24px"><catalogue-page /></main>`,
})
export class App {}

/**
 * What this application shows, for someone who cloned it to see Rayfold work.
 *
 * Each row is one thing the protocol does, where it is on the page, and the file that does it. The page is static
 * on purpose: it is a map, and a map that needed a service to draw itself would be a poor one.
 */
import { ChangeDetectionStrategy, Component, output } from "@angular/core";

interface Entry {
  what: string;
  how: string;
  where: string;
  /** A view the shell can open to show it, when there is one. */
  go?: { view: string; label: string };
  file: string;
}

interface Group {
  title: string;
  blurb: string;
  entries: Entry[];
}

const GUIDE: Group[] = [
  {
    title: "Reading",
    blurb: "One request, the shape you want, and results that stay right after you have them.",
    entries: [
      { what: "Shapes", how: "Every query names the fields it wants, nested as deep as it likes; nothing else is sent.", where: "Every panel. The issues list asks for the assignee's name inside each issue.", go: { view: "project", label: "Issues" }, file: "web/workspace-ui/src/app/issues.ts" },
      { what: "Live queries", how: "A query kept open: the server re-runs it when something it read changes, whoever changed it, and sends only the difference.", where: "The issues, the feed, the documents, the bell's count, the People page. Change something in another tab and watch.", go: { view: "project", label: "Activity" }, file: "web/workspace-ui/src/app/feed.ts" },
      { what: "Streams", how: "Items pushed once each, in order, from a server-side event: a conversation, not a list that re-runs.", where: "The chat, and the toasts from the bell.", go: { view: "project", label: "Chat" }, file: "services/workspace/src/resolvers.ts (Stream.chat)" },
      { what: "Interfaces and unions", how: "A list of one interface holds four kinds of thing; a search returns a union and the shape says what it wants of each with ...on.", where: "The catalogue's overview and its search.", go: { view: "catalogue", label: "Catalogue" }, file: "services/catalogue/src/catalogue.rayfold" },
      { what: "Lazy fields", how: "A field marked @lazy arrives in a later frame, so a page shows its heading before its body lands.", where: "An article's body, and each revision's in its history.", go: { view: "catalogue", label: "Catalogue" }, file: "web/catalogue-ui/src/app/article.ts" },
      { what: "Loaded fields", how: "A field with a loader is read once for a whole page, however many parents ask for it.", where: "A product's category, a person's writing and department, every issue's assignee.", go: { view: "catalogue", label: "Catalogue" }, file: "services/catalogue/src/resolvers.ts (Product.related)" },
      { what: "Numbered and cursor pages", how: "@page(offset) for a catalogue a person leafs through; cursors for feeds that grow at the top.", where: "The catalogue's pages; the feed and the chat.", go: { view: "catalogue", label: "Catalogue" }, file: "services/catalogue/src/store.ts" },
    ],
  },
  {
    title: "Writing",
    blurb: "Commands that cannot run twice, cannot land on someone else's change, and say what they changed.",
    entries: [
      { what: "Idempotency keys", how: "Every command carries a key; a retry replays the first answer instead of running again. One command opts out with @idempotent(false).", where: "Every button. Mark all read on the bell is the one without a key.", go: { view: "project", label: "Issues" }, file: "services/workspace/src/workspace.rayfold (markRead)" },
      { what: "Versions", how: "An entity carries a version; a command sends ifVersion and a change on top of someone else's is refused with what it is now.", where: "Moving, handing over or editing an issue; a new version of a document; editing an article.", go: { view: "project", label: "Issues" }, file: "web/workspace-ui/src/app/issues.ts (move)" },
      { what: "Partial updates", how: "An absent argument stays absent in the resolver, so a form sends only the fields it touched.", where: "The open issue's form: priority, due day, labels and description each on their own.", go: { view: "project", label: "Issues" }, file: "services/workspace/src/resolvers.ts (updateIssue)" },
      { what: "Dry runs", how: "@simulate runs a command without committing and answers with what would have happened.", where: "Used by the services' tests; the palette's quick issue could be previewed the same way.", file: "services/workspace/src/workspace.test.ts" },
      { what: "Batches with references", how: "Several ops in one request, a later one naming an earlier one's result with $ref, run in one round trip.", where: "The palette: a new issue, handed to you, with a first note, is three commands and one request.", go: { view: "project", label: "Ctrl K" }, file: "web/workspace-ui/src/app/quick.ts" },
      { what: "Patches", how: "A command answers with what it changed, and every live query that read it re-runs; one that names an operation re-runs every open copy of it.", where: "Hand an issue over and watch the People page and the feed follow.", go: { view: "people", label: "People" }, file: "services/workspace/src/resolvers.ts (feedChanged)" },
      { what: "Uploads", how: "Bytes go to their own route and a command names what arrived; nothing binary travels in a batch.", where: "Dropping a file on Documents.", go: { view: "project", label: "Documents" }, file: "web/documents-ui/src/app/documents.ts (upload)" },
      { what: "Cost budgets", how: "Every op has a static cost from its shape and page sizes; a batch over the viewer's budget is refused before it runs, with the cost and the budget.", where: "COST_BUDGET on a service; the catalogue's tests run at 150 and refuse a page of five hundred.", file: "services/catalogue/src/catalogue.test.ts (cost budget)" },
    ],
  },
  {
    title: "Beyond the browser",
    blurb: "Two programs under clients/ that a panel never needed to be: run them against the dev fleet and read what they say.",
    entries: [
      { what: "Rayfold Binary", how: "The same frames as bytes: a field name costs one small integer on the wire, decoded with the schema from the manifest.", where: "npm run field, step 1: one WebSocket in RB.", file: "clients/field/lib.mts" },
      { what: "Deferred blocks (@defer)", how: "A shape marks a block to arrive after the frame that carries the rest, addressed to its place; the client hands back the whole.", where: "npm run field, step 2: the issue first, its thread after.", file: "clients/field/field.mts" },
      { what: "Offline queue and predictions", how: "Commands made while the server cannot be reached wait with their keys and go out in order, once; meanwhile the cache shows the prediction, under the field's @merge policy.", where: "npm run field, steps 3 and 4: the line is cut, a move is made, the line is back.", file: "e2e/field.test.ts" },
      { what: "Trusted shapes", how: "In production a service serves only the shapes it registered at start, by id; anything else is refused whoever sends it.", where: "TRUSTED_SHAPES=1 on the workspace; the shapes in services/workspace/src/shapes.ts.", file: "services/workspace/src/shapes.ts" },
      { what: "MCP and scoped tokens", how: "Every Rayfold server is an MCP server: commands are tools with a dry-run twin, queries are tools and resources. An agent holds a token narrowed to a few operations and cannot widen it.", where: "npm run agent: mint, list, dry-run, run, and be refused.", file: "clients/agent/agent.mts" },
    ],
  },
  {
    title: "The contract",
    blurb: "One schema per service is the API, the REST routes, the OpenAPI document and the rule for changing it.",
    entries: [
      { what: "REST routes (@http)", how: "A query or command bound to a method and a path is the same operation: validation, policies, typed errors and idempotency keys apply. GET carries an ETag, PATCH takes If-Match, errors are RFC 9457 problems.", where: "curl /api/documents/documents/{id}, PATCH it with If-Match, DELETE it twice with one Idempotency-Key; /api/documents/rayfold/openapi.json lists them.", file: "services/documents/src/documents.rayfold (@http)" },
      { what: "Named views", how: "A shape attached to a type by name: default is what a caller gets with no shape, and a shape spreads another with ...Product.card.", where: "The catalogue's product and person views; GET /api/catalogue/products/{id} answers the default view.", go: { view: "catalogue", label: "Catalogue" }, file: "services/catalogue/src/catalogue.rayfold (view Product.card)" },
      { what: "Cache headers (@cache)", how: "An entity's cache annotation becomes the route's Cache-Control and the batch's, public or private, for as long as it says.", where: "A product route answers max-age=60; a notification is private, max-age=0.", file: "services/catalogue/src/catalogue.rayfold (@cache)" },
      { what: "Denials (@deny)", how: "Evaluated after @allow, so a second gate can refuse what the first let through: a share may never delete, however wide its token.", where: "deleteDocument, tested with a token minted to name it.", file: "services/documents/src/documents.rayfold (deleteDocument)" },
      { what: "Deprecation and the lockfile", how: "@deprecated names a reason, a sunset and a replacement; rayfold check against each service's lockfile in CI refuses a breaking change before its sunset.", where: "renameDocument is deprecated in favour of updateDocument; npm run schema:check.", file: "services/*/rayfold.lock.json, .github/workflows/ci.yml" },
    ],
  },
  {
    title: "Between services",
    blurb: "Four services, one relay, and nothing shared but the name of an event.",
    entries: [
      { what: "Events over the relay", how: "A service declares another's event without raising it, and subscribes; the relay delivers it to every instance.", where: "Add, file, tag or remark on a document and the feed says so, in another service.", go: { view: "project", label: "Activity" }, file: "services/workspace/src/main.ts" },
      { what: "Policies", how: "Who may read what is one expression in the schema: an owner, the team, or the holder of a share for this one document.", where: "Only your own files show New version, Rename, Share and Delete. A share link reads one file and nothing else.", go: { view: "project", label: "Documents" }, file: "services/documents/src/documents.rayfold (entity Document)" },
      { what: "Capability tokens", how: "A share is a token that speaks for a viewer that can read one document, call three operations, and expires; no account, nothing to revoke.", where: "Share on a file of yours, then open the link in a private window.", go: { view: "project", label: "Documents" }, file: "web/documents-ui/src/app/shared.ts" },
      { what: "One socket", how: "A WebSocket carries every op, live query and stream of a remote on one connection; uploads keep HTTP.", where: "The workspace and documents panels; open the network tab.", file: "web/workspace-ui/src/app/client.ts" },
      { what: "Two runtimes, one fleet", how: "The approvals service is Kotlin on Spring Boot: the same Postgres, the same relay format, the same idempotency table, the same cookie. Nothing in front of it knows the runtime.", where: "A file's Sign-offs tab. Ask someone; the feed and their bell say so, from a Kotlin process over the relay.", go: { view: "project", label: "Documents" }, file: "services/approvals/src/main/kotlin/keel/approvals/Resolvers.kt" },
      { what: "Micro-frontends", how: "Each panel is loaded at runtime from the team that owns its service, with a client of its own; the shell provides none.", where: "This page. Every panel is a remote.", file: "web/shell/src/app/app.ts" },
      { what: "Identity and stats", how: "Every service says who it is and counts what it did, so a console can tell two apart and say which is behind.", where: "GET /api/workspace/rayfold/stats with the ops token.", file: "packages/service-kit/src/index.ts" },
    ],
  },
  {
    title: "With the Rayfold Console",
    blurb: "A separate, commercial product in a private repository, not yet on sale. The apps run without it; these parts wait for it.",
    entries: [
      { what: "Live configuration", how: "A service subscribes to its configuration with a live query and a change reaches every instance without a restart.", where: "The upload limit on Documents (uploads.maxBytes).", file: "packages/service-kit/src/platform.ts" },
      { what: "Queues and flows", how: "A kept document starts a three-step flow across two services: extract its text, index it if there was any, tell the workspace; with a lock so two versions never race.", where: "Add a text file, then search for a phrase from it in the catalogue and watch the feed say it is searchable.", go: { view: "catalogue", label: "Catalogue" }, file: "services/documents/src/resolvers.ts (DOCUMENT_KEPT_STEPS)" },
      { what: "Traces and logs", how: "Every batch is a span and every log line carries its trace, shipped over OTLP.", where: "The console's Traces and Logs screens.", file: "packages/service-kit/src/platform.ts" },
    ],
  },
];

@Component({
  selector: "keel-guide",
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: "./guide.css",
  template: `
    <div class="guide">
      <div class="head">
        <h1>What this shows</h1>
        <p class="lede">
          Keel is a small product built to show Rayfold working: four services, one page, and every part of the protocol
          somewhere you can click on. Each row says what to look at, and which file does it.
        </p>
      </div>
      @for (group of groups; track group.title) {
        <section class="card">
          <header>
            <div>
              <h2>{{ group.title }}</h2>
              <p class="muted blurb">{{ group.blurb }}</p>
            </div>
          </header>
          <div class="body">
            <ol>
              @for (e of group.entries; track e.what) {
                <li>
                  <div class="what">
                    <strong>{{ e.what }}</strong>
                    <span class="how">{{ e.how }}</span>
                  </div>
                  <div class="where">
                    <span>{{ e.where }}</span>
                    <span class="foot">
                      <code class="mono">{{ e.file }}</code>
                      @if (e.go; as go) {
                        <button type="button" class="btn quiet" (click)="open.emit(go.view)">{{ go.label }} →</button>
                      }
                    </span>
                  </div>
                </li>
              }
            </ol>
          </div>
        </section>
      }
      <p class="muted foot-note">
        The services are under <code class="mono">services/</code>, the front ends under <code class="mono">web/</code>, the shared wiring in
        <code class="mono">packages/service-kit</code>. The tests in <code class="mono">e2e/</code> drive the flows that cross services.
      </p>
    </div>
  `,
})
export class GuidePage {
  readonly groups = GUIDE;
  readonly open = output<string>();
}

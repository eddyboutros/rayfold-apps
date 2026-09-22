/**
 * The catalogue service: what the company sells, who works here, and what has been written down, behind one search.
 *
 * Nothing here reacts to the rest of the fleet, and nothing in the fleet reacts to it: it is reference data with a
 * search in front. What it adds to the fleet is in its schema — an interface, a union, numbered pages, a lazy field
 * — and the console shows a third service with a third schema hash.
 */
import { personOf, schemaAt, startService } from "@apps/service-kit";
import { CatalogueStore } from "./store.ts";
import { resolvers, type Viewer } from "./resolvers.ts";

function whoIs(req: Parameters<typeof personOf>[0]): Viewer | null {
  const person = personOf(req);
  return person ? { id: person.id, name: person.name } : null;
}

const service = await startService({
  name: "catalogue",
  schema: schemaAt(new URL("./catalogue.rayfold", import.meta.url)),
  migrate: async (sql) => new CatalogueStore(sql).migrate(),
  resolvers: (deps) => resolvers({ store: new CatalogueStore(deps.sql) }),
  viewer: (req) => whoIs(req),
});

export default service;

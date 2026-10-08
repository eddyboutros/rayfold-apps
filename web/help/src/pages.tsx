/**
 * The help centre's two screens: every published page, and one of them.
 *
 * Both read the catalogue with `useQuery` through a client whose reads are cacheable GETs (see clients.ts). Neither
 * signs anyone in or sends anything that says who is reading, so what one visitor is shown is what every visitor is
 * shown, and the gateway in front of the catalogue serves most of them from its cache.
 */
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { RayfoldProvider, useQuery } from "@rayfold/react";
import type { RayfoldClient } from "@rayfold/client";
import type { HelpPage, Page } from "./gen/catalogue";
import { Feedback } from "./Feedback";
import { Markdown } from "./Markdown";

type Listed = Pick<HelpPage, "slug" | "name" | "summary" | "tags">;
type Full = Pick<HelpPage, "slug" | "name" | "summary" | "tags" | "body" | "publishedAt">;

/** A link inside the help centre: an address a reader can copy, followed without reloading the page. */
export function Link({ to, go, children, className }: { to: string; go: (to: string) => void; children: ReactNode; className?: string }) {
  const href = `${import.meta.env.BASE_URL}${to}`;
  const follow = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    go(to);
  };
  return (
    <a href={href} onClick={follow} {...(className ? { className } : {})}>
      {children}
    </a>
  );
}

const day = (at: string) => new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
const describe = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

export function HelpIndex({ go }: { go: (to: string) => void }) {
  const pages = useQuery<Page<Listed>>("helpPages", { page: { first: 100 } }, { shape: "{ items { slug name summary tags } total }" });
  const [tag, setTag] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    document.title = "Order desk help";
  }, []);

  const items = pages.data?.items ?? [];
  const tags = useMemo(() => [...new Set(items.flatMap((p) => p.tags))].sort(), [items]);
  const shown = items.filter((p) => (!tag || p.tags.includes(tag)) && (!q.trim() || `${p.name} ${p.summary}`.toLowerCase().includes(q.trim().toLowerCase())));

  return (
    <main className="index">
      <header className="hero">
        <p className="eyebrow">Order desk</p>
        <h1>How can we help?</h1>
        <p className="lede">Guides for the people who run Order desk day to day: invoicing, returns, the sandbox and the rest.</p>
        <input className="input search" type="search" placeholder="Find a guide" aria-label="Find a guide" value={q} onChange={(e) => setQ(e.target.value)} />
      </header>
      {pages.error ? (
        <p className="empty" role="alert">
          <strong>The guides could not be loaded.</strong> {describe(pages.error)}
        </p>
      ) : pages.loading && !pages.data ? (
        <ul className="pages">
          {[0, 1, 2].map((n) => (
            <li key={n} className="card">
              <span className="skeleton" style={{ width: "60%" }} />
            </li>
          ))}
        </ul>
      ) : (
        <>
          {tags.length ? (
            <nav className="tags" aria-label="Topics">
              <button type="button" className={`pill${tag === null ? " accent" : ""}`} onClick={() => setTag(null)}>
                Everything
              </button>
              {tags.map((t) => (
                <button key={t} type="button" className={`pill${tag === t ? " accent" : ""}`} onClick={() => setTag(tag === t ? null : t)}>
                  {t}
                </button>
              ))}
            </nav>
          ) : null}
          {shown.length ? (
            <ul className="pages">
              {shown.map((p) => (
                <li key={p.slug} className="card">
                  <Link to={p.slug} go={go}>
                    <strong>{p.name}</strong>
                    <span className="muted">{p.summary}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">
              <strong>Nothing matches.</strong> Try another word, or every topic.
            </p>
          )}
        </>
      )}
    </main>
  );
}

export function HelpArticle({ slug, go, feedback }: { slug: string; go: (to: string) => void; feedback: RayfoldClient }) {
  const page = useQuery<Full | null>("helpPage", { slug }, { shape: "{ slug name summary tags body publishedAt }" });
  const found = page.data;

  useEffect(() => {
    if (found) document.title = `${found.name} - Order desk help`;
  }, [found]);

  return (
    <main className="article">
      <p className="crumbs">
        <Link to="" go={go}>
          All guides
        </Link>
      </p>
      {page.error ? (
        <p className="empty" role="alert">
          <strong>This guide could not be loaded.</strong> {describe(page.error)}
        </p>
      ) : page.loading && found === undefined ? (
        <article>
          <span className="skeleton" style={{ width: "50%", height: 28 }} />
          <span className="skeleton" style={{ width: "90%" }} />
          <span className="skeleton" style={{ width: "80%" }} />
        </article>
      ) : !found ? (
        <p className="empty">
          <strong>There is no guide here.</strong> It may have moved; every guide is on <Link to="" go={go}>the front page</Link>.
        </p>
      ) : (
        <>
          <article>
            <h1>{found.name}</h1>
            <p className="lede">{found.summary}</p>
            <p className="byline muted">Published {day(found.publishedAt)}</p>
            <div className="prose">
              <Markdown source={found.body} />
            </div>
          </article>
          <RayfoldProvider client={feedback}>
            <Feedback slug={found.slug} />
          </RayfoldProvider>
        </>
      )}
    </main>
  );
}

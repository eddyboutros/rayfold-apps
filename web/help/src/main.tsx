/**
 * Order desk help: the public help centre, at /help/ on Keel's origin.
 *
 * Built by a different team from the rest of Keel, in React rather than Angular, and on its own: it is not loaded
 * into the shell, because the people reading it are customers, not the team. It reads only what the catalogue has
 * published, and asks only one thing of anyone: whether a page helped.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { RayfoldProvider } from "@rayfold/react";
import type { RayfoldClient } from "@rayfold/client";
import { catalogueClient, feedbackClient } from "./clients";
import { HelpArticle, HelpIndex } from "./pages";
import "../../design/tokens.css";
import "../../design/base.css";
import "./styles.css";

/** Where the reader is: "" for the front page, or a page's slug. The base is /help/, wherever that is served. */
const here = () => decodeURIComponent(location.pathname.slice(import.meta.env.BASE_URL.length).replace(/\/$/, ""));

function App({ feedback }: { feedback: RayfoldClient }) {
  const [path, setPath] = useState(here);
  useEffect(() => {
    const back = () => setPath(here());
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
  }, []);
  const go = (to: string) => {
    history.pushState(null, "", `${import.meta.env.BASE_URL}${to}`);
    setPath(to);
    scrollTo(0, 0);
  };

  return (
    <div className="help">
      <nav className="top">
        <a href={import.meta.env.BASE_URL} className="brand" onClick={(e) => (e.preventDefault(), go(""))}>
          <span aria-hidden="true" className="mark" /> Order desk <span className="muted">help</span>
        </a>
      </nav>
      {path ? <HelpArticle key={path} slug={path} go={go} feedback={feedback} /> : <HelpIndex go={go} />}
      <footer className="muted">Can’t find it here? Your account team is a reply away.</footer>
    </div>
  );
}

const catalogue = catalogueClient();
const feedback = feedbackClient();

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root to render into");
createRoot(root).render(
  <StrictMode>
    <RayfoldProvider client={catalogue}>
      <App feedback={feedback} />
    </RayfoldProvider>
  </StrictMode>,
);

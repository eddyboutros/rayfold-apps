/**
 * "Was this page helpful?", answered once per visitor per page and changed as often as they like.
 *
 * Its own client, the feedback service's, provided around this component and nothing else. The score is live: it
 * moves as other visitors answer, and with the visitor's own answer. The visitor's answer is read with `ratings`,
 * which for a visitor holds exactly theirs: the service's rule, pushed into its SQL, keeps everyone else's out.
 */
import { useState, type FormEvent } from "react";
import { useCommand, useLive, useQuery } from "@rayfold/react";
import type { Page, Rating, Score } from "./gen/feedback";

type Mine = Pick<Rating, "id" | "helpful" | "comment">;

export function Feedback({ slug }: { slug: string }) {
  const score = useLive<Pick<Score, "helpful" | "unhelpful">>("score", { slug }, { shape: "{ id helpful unhelpful }" });
  const mine = useQuery<Page<Mine>>("ratings", { slug }, { shape: "{ items { id helpful comment } }" });
  const [rate, rating] = useCommand<Mine>("rate");
  const [editing, setEditing] = useState<"answer" | "comment" | null>(null);

  const answer = mine.data?.items[0];
  const helpful = score.data?.helpful ?? 0;
  const total = helpful + (score.data?.unhelpful ?? 0);

  async function send(isHelpful: boolean, comment: string | null) {
    try {
      await rate({ slug, helpful: isHelpful, comment }, { shape: "{ id helpful comment }" });
    } catch {
      return; // the hook's error says why, below
    }
    setEditing(null);
    await mine.refetch();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get("comment");
    void send(answer?.helpful ?? false, typeof text === "string" && text.trim() ? text.trim() : null);
  }

  return (
    <aside className="feedback card" aria-labelledby="feedback-title">
      <div className="body">
        {mine.loading && !mine.data ? (
          <span className="skeleton" style={{ width: "40%" }} />
        ) : !answer || editing === "answer" ? (
          <div className="ask">
            <p id="feedback-title">
              <strong>Was this page helpful?</strong>
            </p>
            <span className="actions">
              <button type="button" className="btn" disabled={rating.running} onClick={() => void send(true, answer?.comment ?? null)}>
                Yes
              </button>
              <button type="button" className="btn" disabled={rating.running} onClick={() => void send(false, answer?.comment ?? null)}>
                No
              </button>
            </span>
          </div>
        ) : editing === "comment" ? (
          <form className="why" onSubmit={submit}>
            <label htmlFor="feedback-comment" id="feedback-title">
              <strong>{answer.helpful ? "What helped?" : "What was missing?"}</strong>{" "}
              <span className="muted">The people who wrote this page read every answer.</span>
            </label>
            <textarea id="feedback-comment" name="comment" className="input" rows={3} maxLength={1000} defaultValue={answer.comment ?? ""} autoFocus />
            <span className="actions">
              <button type="button" className="btn quiet" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={rating.running}>
                Send
              </button>
            </span>
          </form>
        ) : (
          <div className="answered">
            <p id="feedback-title">
              <strong>Thanks.</strong> You said this page {answer.helpful ? "helped" : "did not help"}.
              {answer.comment ? <span className="muted"> “{answer.comment}”</span> : null}
            </p>
            <span className="actions">
              <button type="button" className="btn quiet" onClick={() => setEditing("comment")}>
                {answer.comment ? "Edit what you said" : answer.helpful ? "Say what helped" : "Say what was missing"}
              </button>
              <button type="button" className="btn quiet" onClick={() => setEditing("answer")}>
                Change your answer
              </button>
            </span>
          </div>
        )}
        {rating.error ? (
          <p className="bad" role="alert">
            Your answer could not be sent{rating.error instanceof Error ? `: ${rating.error.message}` : ""}. Try again in a moment.
          </p>
        ) : null}
        {total > 0 ? (
          <p className="score muted" aria-live="polite">
            {helpful} of {total} {total === 1 ? "reader" : "readers"} found this page helpful.
          </p>
        ) : null}
      </div>
    </aside>
  );
}

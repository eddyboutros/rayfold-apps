import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { RayfoldProvider } from "@rayfold/react";
import { feedbackClient } from "./clients";
import { Feedback } from "./Feedback";
import { all, button, gateway, one, reads, settle, text, type TestService } from "./testing/rayfold";
import { feedback, type Faults, type RatingRow } from "./testing/services";

const SLUG = "invoicing";
const AT = "2026-03-05T12:00:00.000Z";
const ME = "v-1";

describe("was this page helpful?", () => {
  let ratings: RatingRow[];
  let fb: TestService;
  let root: HTMLElement;
  let unmount: () => void;

  async function open(faults: Faults = {}): Promise<void> {
    fb = feedback(ratings, ME, faults);
    vi.stubGlobal("fetch", gateway({ "/api/feedback": fb }));
    const view = render(
      <RayfoldProvider client={feedbackClient()}>
        <Feedback slug={SLUG} />
      </RayfoldProvider>,
    );
    root = view.container;
    unmount = view.unmount;
    await settle(fb);
    fb.take();
  }

  async function click(label: string): Promise<void> {
    fireEvent.click(button(root, label));
    await settle(fb);
  }

  /** Another visitor, in another browser, answering the same page. */
  async function elsewhere(visitor: string, helpful: boolean): Promise<void> {
    await fb.client({ visitor }).command("rate", { slug: SLUG, helpful, comment: null }, { shape: "{ id }" });
    await settle(fb);
  }

  const score = () => text(root.querySelector(".score"));
  const stored = () => ratings.map((r) => [r.visitorId, r.slug, r.helpful, r.comment]);

  beforeEach(() => {
    ratings = [];
  });

  afterEach(() => {
    cleanup();
    fb?.close();
    vi.unstubAllGlobals();
  });

  it("asks once, and says nothing about a score nobody has given", async () => {
    await open();
    expect(reads(one(root, "#feedback-title"))).toBe("Was this page helpful?");
    expect(all(root, ".ask .actions button")).toEqual(["Yes", "No"]);
    expect(root.querySelector(".score")).toBeNull();
    expect(one(root, "aside.feedback").getAttribute("aria-labelledby")).toBe("feedback-title");
  });

  it("takes a yes, thanks the reader, and counts it in the score, which the service keeps as theirs", async () => {
    await open();
    await click("Yes");
    expect(fb.take()).toEqual([
      { op: "rate", args: { slug: SLUG, helpful: true, comment: null }, shape: "{ id helpful comment }", via: "POST" },
      // the reader's own answer is read again; the live score hears it without being asked
      { op: "ratings", args: { slug: SLUG }, shape: "{ items { id helpful comment } }", via: "POST" },
    ]);
    expect(stored()).toEqual([[ME, SLUG, true, null]]);
    expect(reads(one(root, "#feedback-title"))).toBe("Thanks. You said this page helped.");
    expect(all(root, ".answered .actions button")).toEqual(["Say what helped", "Change your answer"]);
    expect(score()).toBe("1 of 1 reader found this page helpful.");
    expect(one(root, ".score").getAttribute("aria-live")).toBe("polite");
  });

  it("takes a no, and asks what was missing rather than what helped", async () => {
    await open();
    await click("No");
    expect(stored()).toEqual([[ME, SLUG, false, null]]);
    expect(reads(one(root, "#feedback-title"))).toBe("Thanks. You said this page did not help.");
    expect(all(root, ".answered .actions button")).toEqual(["Say what was missing", "Change your answer"]);
    expect(score()).toBe("0 of 1 reader found this page helpful.");
  });

  it("moves the score live as other visitors answer, without asking for it again", async () => {
    await open();
    expect(fb.open).toBe(1);
    await elsewhere("v-2", true);
    expect(score()).toBe("1 of 1 reader found this page helpful.");
    await elsewhere("v-3", false);
    expect(score()).toBe("1 of 2 readers found this page helpful.");
    // another visitor's answer is not this reader's: still asked, never thanked
    expect(reads(one(root, "#feedback-title"))).toBe("Was this page helpful?");
    // the page sent nothing for either: the open score heard both
    expect(fb.take().filter((o) => o.via !== "local")).toEqual([]);
  });

  it("closes its live score when the reader leaves the page", async () => {
    await open();
    expect(fb.open).toBe(1);
    unmount();
    await settle(fb);
    expect(fb.open).toBe(0);
  });

  it("shows a returning visitor their own answer and nobody else's", async () => {
    ratings.push(
      { id: "r1", slug: SLUG, visitorId: "v-2", helpful: false, comment: "Not about my country", at: AT },
      { id: "r2", slug: SLUG, visitorId: ME, helpful: true, comment: "The list was what I needed", at: AT },
      { id: "r3", slug: "returns", visitorId: ME, helpful: false, comment: null, at: AT },
    );
    await open();
    expect(reads(one(root, "#feedback-title"))).toBe("Thanks. You said this page helped. “The list was what I needed”");
    expect(all(root, ".answered .actions button")).toEqual(["Edit what you said", "Change your answer"]);
    // the score counts every visitor on this page, and only this page
    expect(score()).toBe("1 of 2 readers found this page helpful.");
  });

  it("says what helped, sends it with the answer it belongs to, and shows it back", async () => {
    await open();
    await click("Yes");
    await click("Say what helped");
    expect(text(one(root, "label[for=feedback-comment] strong"))).toBe("What helped?");
    const box = one<HTMLTextAreaElement>(root, "textarea#feedback-comment");
    expect([box.value, box.maxLength, document.activeElement === box]).toEqual(["", 1000, true]);
    fb.take();

    fireEvent.change(box, { target: { value: "  The list of steps  " } });
    fireEvent.submit(one(root, "form.why"));
    await settle(fb);
    expect(fb.take()[0]).toEqual({ op: "rate", args: { slug: SLUG, helpful: true, comment: "The list of steps" }, shape: "{ id helpful comment }", via: "POST" });
    expect(stored()).toEqual([[ME, SLUG, true, "The list of steps"]]);
    expect(reads(one(root, "#feedback-title"))).toBe("Thanks. You said this page helped. “The list of steps”");
    // one visitor, one answer: saying why changed it rather than adding a second
    expect(score()).toBe("1 of 1 reader found this page helpful.");

    // editing starts from what was said
    await click("Edit what you said");
    expect(one<HTMLTextAreaElement>(root, "textarea#feedback-comment").value).toBe("The list of steps");
  });

  it("asks what was missing after a no, and a blank comment is no comment", async () => {
    await open();
    await click("No");
    await click("Say what was missing");
    expect(text(one(root, "label[for=feedback-comment] strong"))).toBe("What was missing?");
    fb.take();
    fireEvent.change(one(root, "textarea#feedback-comment"), { target: { value: "   " } });
    fireEvent.submit(one(root, "form.why"));
    await settle(fb);
    expect(fb.take()[0]!.args).toEqual({ slug: SLUG, helpful: false, comment: null });
    expect(reads(one(root, "#feedback-title"))).toBe("Thanks. You said this page did not help.");
  });

  it("cancels a comment without sending anything", async () => {
    await open();
    await click("Yes");
    await click("Say what helped");
    fb.take();
    fireEvent.change(one(root, "textarea#feedback-comment"), { target: { value: "never sent" } });
    await click("Cancel");
    expect(fb.take()).toEqual([]);
    expect(stored()).toEqual([[ME, SLUG, true, null]]);
    expect(reads(one(root, "#feedback-title"))).toBe("Thanks. You said this page helped.");
  });

  it("changes an answer, keeping what the reader said, and the score follows", async () => {
    ratings.push({ id: "r2", slug: SLUG, visitorId: ME, helpful: true, comment: "Clear", at: AT });
    await open();
    expect(score()).toBe("1 of 1 reader found this page helpful.");
    await click("Change your answer");
    expect(reads(one(root, "#feedback-title"))).toBe("Was this page helpful?");
    await click("No");
    expect(fb.take()[0]!.args).toEqual({ slug: SLUG, helpful: false, comment: "Clear" });
    expect(stored()).toEqual([[ME, SLUG, false, "Clear"]]);
    expect(reads(one(root, "#feedback-title"))).toBe("Thanks. You said this page did not help. “Clear”");
    expect(score()).toBe("0 of 1 reader found this page helpful.");
  });

  it("says an answer could not be sent, and why, and still asks", async () => {
    await open({ rate: "feedback is read-only for a minute" });
    await click("Yes");
    expect(reads(one(root, "[role=alert]"))).toBe("Your answer could not be sent: feedback is read-only for a minute. Try again in a moment.");
    expect(reads(one(root, "#feedback-title"))).toBe("Was this page helpful?");
    expect(stored()).toEqual([]);
    expect(root.querySelector(".score")).toBeNull();
    // the failed command is the only thing sent: the reader's answer is not read again for nothing
    expect(fb.take().map((o) => o.op)).toEqual(["rate"]);
  });
});

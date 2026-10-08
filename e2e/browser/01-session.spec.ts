import { expect, test } from "@playwright/test";
import { ADA, BASE, GRACE, asBrowser, session, signIn } from "./fleet.ts";

/**
 * Signing in: the shell's page sets the session cookie, and every service behind /api reads the same person from it.
 * No bundle handles a credential; the browser carries it.
 */
test("the sign-in page lists the team, and choosing a person signs in as them everywhere at once", async ({ page, context }) => {
  await page.goto(`${BASE}/`);
  await expect(page.locator(".gate h1")).toHaveText("Sign in");
  await expect(page.locator("button.person strong")).toHaveText(["Ada Lovelace", "Grace Hopper", "Noor Haddad", "Tomás Ferreira"]);
  expect(await session(context)).toBeUndefined();
  // guard: signed out, a service does not know anyone
  expect(await asBrowser<unknown>(page, "workspace", "me", {}, "{ id name }").catch((e: { code?: string }) => e.code)).toBe("unauthenticated");

  await signIn(page, ADA);
  expect(await session(context)).toBe("ada");
  await expect(page.locator(".rail .who .muted")).toHaveText("ada@keel.example");
  await expect(page.locator(".topbar h1")).toHaveText("Northwind rollout");
  await expect(page.locator("section.slot h2")).toHaveText(["Issues", "Documents", "Activity", "Chat"]);
  // the same cookie, read by four services in two runtimes
  expect(await asBrowser(page, "workspace", "me", {}, "{ id name }")).toEqual({ $type: "Member", id: "u1", name: "Ada Lovelace" });
  expect(await asBrowser(page, "documents", "me", {}, "{ id name }")).toEqual({ $type: "Member", id: "u1", name: "Ada Lovelace" });
  expect(await asBrowser(page, "approvals", "members", {}, "{ id name }")).toEqual([
    { $type: "Member", id: "u1", name: "Ada Lovelace" },
    { $type: "Member", id: "u2", name: "Grace Hopper" },
    { $type: "Member", id: "u3", name: "Noor Haddad" },
    { $type: "Member", id: "u4", name: "Tomás Ferreira" },
  ]);
  expect(await asBrowser(page, "catalogue", "items", { kind: "person", page: { first: 1 } }, "{ total }")).toEqual({ total: 12 });
});

test("signing out clears the cookie and the next person is someone else to every service", async ({ page, context }) => {
  await signIn(page, ADA);
  await page.locator(".rail button.leave").click();
  await expect(page.locator(".gate h1")).toHaveText("Sign in");
  expect(await session(context)).toBeUndefined();

  await signIn(page, GRACE);
  expect(await session(context)).toBe("grace");
  expect(await asBrowser(page, "workspace", "me", {}, "{ id name }")).toEqual({ $type: "Member", id: "u2", name: "Grace Hopper" });
  // a reload keeps the session: it is the cookie, not the page's memory
  await page.reload();
  await expect(page.locator(".rail .who strong")).toHaveText("Grace Hopper");
});

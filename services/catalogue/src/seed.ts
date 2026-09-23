/**
 * The catalogue's reference data: what the company sells, who works here, and what has been written down.
 *
 * This is content, not activity — it is what a catalogue holds on the day the service is first started, and it is
 * inserted once. The four people who can sign in are here under the ids the whole fleet knows them by, with the
 * rest of the company around them.
 */
import { TEAM } from "@apps/service-kit";

const day = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d, 9, 30);

interface ProductRow {
  id: string;
  name: string;
  sku: string;
  summary: string;
  category: string;
  price: number;
  availability: "available" | "limited" | "waitlist" | "retired";
  updatedAt: number;
}

interface PersonRow {
  id: string;
  name: string;
  title: string;
  department: string;
  email: string;
  location: string;
  updatedAt: number;
}

interface ArticleRow {
  id: string;
  name: string;
  slug: string;
  summary: string;
  tags: string[];
  authorId: string;
  body: string;
  updatedAt: number;
}

const PRODUCTS: ProductRow[] = [
  { id: "pr-core", name: "Order desk", sku: "OD-CORE", summary: "Orders, returns and fulfilment for a tenant, with an API and a back office.", category: "Platform", price: 240000, availability: "available", updatedAt: day(2026, 9, 18) },
  { id: "pr-invoicing", name: "Invoicing module", sku: "OD-INV", summary: "Invoices raised from orders, credit notes, and the export the finance system reads.", category: "Modules", price: 60000, availability: "available", updatedAt: day(2026, 9, 4) },
  { id: "pr-returns", name: "Returns module", sku: "OD-RET", summary: "Return authorisations, inspection outcomes and refunds against the original payment.", category: "Modules", price: 45000, availability: "available", updatedAt: day(2026, 8, 27) },
  { id: "pr-tax", name: "Tax engine add-on", sku: "OD-TAX", summary: "Per-line or per-order rounding, rates by region, and the audit trail an inspector asks for.", category: "Modules", price: 35000, availability: "limited", updatedAt: day(2026, 9, 15) },
  { id: "pr-edi", name: "EDI connector", sku: "OD-EDI", summary: "Orders in and dispatch advice out over EDIFACT and X12, mapped per trading partner.", category: "Integrations", price: 80000, availability: "waitlist", updatedAt: day(2026, 7, 30) },
  { id: "pr-onboarding", name: "Onboarding package", sku: "SV-ONB", summary: "Six weeks with a rollout engineer: tenant setup, data migration, two rehearsal cutovers.", category: "Services", price: 1800000, availability: "available", updatedAt: day(2026, 9, 10) },
  { id: "pr-migration", name: "Data migration", sku: "SV-MIG", summary: "Customers, catalogue and open orders moved from the previous system, reconciled to the cent.", category: "Services", price: 950000, availability: "available", updatedAt: day(2026, 8, 12) },
  { id: "pr-support", name: "Premium support", sku: "SV-SUP", summary: "A named engineer, a one-hour response on a P1, and a quarterly review of the tenant.", category: "Services", price: 120000, availability: "available", updatedAt: day(2026, 6, 20) },
  { id: "pr-sandbox", name: "Sandbox tenant", sku: "OD-SBX", summary: "A second tenant with the customer's data, reset on request, for their own testing.", category: "Platform", price: 30000, availability: "available", updatedAt: day(2026, 8, 3) },
  { id: "pr-training", name: "Training day", sku: "SV-TRN", summary: "One day on site for up to twelve people: the back office, returns, and month-end.", category: "Services", price: 320000, availability: "available", updatedAt: day(2026, 7, 8) },
  { id: "pr-legacy", name: "Order desk classic", sku: "OD-V1", summary: "The previous generation. No new tenants; existing ones are being moved to Order desk.", category: "Platform", price: 180000, availability: "retired", updatedAt: day(2026, 5, 2) },
];

const title: Record<string, string> = { u1: "Engineering lead", u2: "Platform engineer", u3: "Product manager", u4: "Legal & compliance" };
const department: Record<string, string> = { u1: "Engineering", u2: "Engineering", u3: "Product", u4: "Legal" };
const location: Record<string, string> = { u1: "Lisbon", u2: "Amsterdam", u3: "Lisbon", u4: "Porto" };

const PEOPLE: PersonRow[] = [
  ...TEAM.map((p) => ({ id: p.id, name: p.name, title: title[p.id] ?? p.title, department: department[p.id] ?? "Engineering", email: p.email, location: location[p.id] ?? "Lisbon", updatedAt: day(2026, 9, 1) })),
  { id: "u5", name: "Priya Raman", title: "Rollout engineer", department: "Services", email: "priya@keel.example", location: "Amsterdam", updatedAt: day(2026, 8, 19) },
  { id: "u6", name: "Jonas Lindqvist", title: "Account executive", department: "Sales", email: "jonas@keel.example", location: "Stockholm", updatedAt: day(2026, 7, 14) },
  { id: "u7", name: "Mei Tanaka", title: "Support engineer", department: "Support", email: "mei@keel.example", location: "Lisbon", updatedAt: day(2026, 9, 9) },
  { id: "u8", name: "Samuel Osei", title: "Finance manager", department: "Finance", email: "samuel@keel.example", location: "Porto", updatedAt: day(2026, 6, 30) },
  { id: "u9", name: "Elena Petrova", title: "Site reliability engineer", department: "Engineering", email: "elena@keel.example", location: "Amsterdam", updatedAt: day(2026, 8, 25) },
  { id: "u10", name: "Diego Álvarez", title: "Designer", department: "Product", email: "diego@keel.example", location: "Lisbon", updatedAt: day(2026, 7, 22) },
  { id: "u11", name: "Hannah Weiss", title: "Security engineer", department: "Engineering", email: "hannah@keel.example", location: "Berlin", updatedAt: day(2026, 9, 12) },
  { id: "u12", name: "Kwame Mensah", title: "Head of services", department: "Services", email: "kwame@keel.example", location: "Porto", updatedAt: day(2026, 6, 11) },
];

const ARTICLES: ArticleRow[] = [
  {
    id: "ar-rollout",
    name: "Rollout playbook",
    slug: "rollout-playbook",
    summary: "How a tenant moves from the previous system to Order desk in three waves, and what has to be true before each.",
    tags: ["rollout", "services", "cutover"],
    authorId: "u12",
    updatedAt: day(2026, 9, 16),
    body: `# Rollout playbook

Every rollout is three waves. The order never changes; the dates do.

## Wave 1 — the mirror

Orders are copied into the new tenant as they arrive in the old system. Nobody works in the new tenant yet. The
point of the wave is the reconciliation: every evening, order counts and totals are compared per day, and the
rollout engineer signs the day off or does not. Five consecutive days within 0.1% is the exit criterion, and it is
not negotiable, because a mirror that drifts is a cutover that loses orders.

## Wave 2 — orders and returns

The customer's staff work in Order desk for new orders and returns; invoicing stays in the old system. This is the
wave that finds the workflows nobody documented. Expect a week of small changes to the tenant's configuration and
plan for the rollout engineer to be on site for the first three days.

## Wave 3 — invoicing, and the old system switched off

Invoicing moves, the old system is set to read-only, and the on-call rota for the fortnight after is confirmed
before the switch. Nothing is switched off that cannot be switched back on within the hour for the first week.

## Before any wave

- The customer has named one person who can say yes.
- The revised agreement is signed (legal will not accept a signature "next week").
- A rehearsal cutover has been run in the sandbox tenant, timed, and written up.
`,
  },
  {
    id: "ar-oncall",
    name: "On-call handbook",
    slug: "on-call-handbook",
    summary: "What the on-call engineer is for, what they are not for, and what to do in the first ten minutes of a page.",
    tags: ["on-call", "incidents", "engineering"],
    authorId: "u9",
    updatedAt: day(2026, 9, 2),
    body: `# On-call handbook

You are on call to keep tenants working, not to fix everything you find. If it is not affecting a tenant now, it is
a ticket for tomorrow.

## The first ten minutes

1. Acknowledge the page. The customer sees that.
2. Open the fleet view and look at readiness before anything else. A service that is not ready is usually the
   whole story.
3. Say what you see in the incident channel, even if it is "nothing yet". Silence is what people escalate.

## Severities

- **P1** — a tenant cannot take orders. Wake whoever you need.
- **P2** — a tenant is degraded: slow, or one workflow broken with a workaround. Fix it in hours, not minutes.
- **P3** — cosmetic, or one user. Tomorrow.

## What you may do without asking

Restart a service, roll back a deploy, scale a service, turn a feature flag off. Anything that changes a tenant's
data needs a second person on the call.

## Handover

At the end of the week, write three lines: what paged, what you did, what is still open. The next person reads them
before they read anything else.
`,
  },
  {
    id: "ar-restore",
    name: "Restore drill procedure",
    slug: "restore-drill-procedure",
    summary: "The monthly restore of the previous night's backup onto a scratch database, timed, and what counts as a pass.",
    tags: ["backups", "compliance", "platform"],
    authorId: "u2",
    updatedAt: day(2026, 9, 3),
    body: `# Restore drill procedure

First Monday of the month, before 09:00, so a failure has a whole working day in front of it.

## Steps

1. Take the most recent nightly backup of each service's tables.
2. Restore into a scratch database on the staging cluster, one service at a time.
3. Start each service against the scratch database and call its readiness route.
4. Run the reconciliation query for the last day of data and compare to the production figure recorded that night.
5. Record start and finish times per service in the drill log.

## What counts as a pass

Every service ready against the restored data within 30 minutes of starting its restore, and the reconciliation
within 0.1%. A restore that takes longer is a **finding**, not a failure: open an issue, and it goes in the quarter's
control evidence either way.

## Known slow part

The documents service's files volume is copied file by file. Snapshotting the volume instead is the standing
improvement; until then, plan for it to take the longest.
`,
  },
  {
    id: "ar-tax",
    name: "Tax rounding policy",
    slug: "tax-rounding-policy",
    summary: "Per line, not per order, from the November release, and why both were ever possible.",
    tags: ["tax", "finance", "policy"],
    authorId: "u8",
    updatedAt: day(2026, 9, 17),
    body: `# Tax rounding policy

From the November release, tax is rounded **per line** on every tenant. Per-order rounding is kept only for tenants
that ask for it in writing and is marked as such in the tenant's configuration.

## Why there were two

The previous system rounded per line. Order desk rounded per order, because it is what the tax engine did by
default and nobody asked. On a large order the two differ by a few cents, which is nothing until a customer's
finance team reconciles an invoice against a purchase order and the totals do not match.

## What changes for a rollout

The reconciliation in wave 1 compares totals per day. A tenant being migrated from the previous system will show a
small, consistent difference until the rounding mode is set. Set it before the mirror starts, not after.
`,
  },
  {
    id: "ar-access",
    name: "Access review procedure",
    slug: "access-review-procedure",
    summary: "Quarterly: export who has access to what, have each team lead confirm their people, revoke the rest.",
    tags: ["security", "compliance", "access"],
    authorId: "u11",
    updatedAt: day(2026, 9, 12),
    body: `# Access review procedure

Once a quarter, in the second week of the last month.

1. Export the list of accounts and their roles from the identity provider, and the list of people from HR.
2. Anyone on the first list and not the second is a leaver: revoke the same day and note it in the review.
3. Send each team lead the accounts in their team. They confirm, or they name what to remove, within five working
   days.
4. Apply the removals, attach the export and the confirmations to the quarter's control evidence.

Leavers are found in every review. That is the review working, not a failure; what would be a failure is a leaver
found by anyone else.
`,
  },
  {
    id: "ar-postmortem",
    name: "Post-mortem template",
    slug: "post-mortem-template",
    summary: "The five headings every incident write-up has, and the one question each is answering.",
    tags: ["incidents", "engineering", "template"],
    authorId: "u1",
    updatedAt: day(2026, 8, 20),
    body: `# Post-mortem template

Written by the person who was on call, within three working days, and read by everyone at the next engineering
meeting. Blameless: the write-up names systems and decisions, never people.

## Summary
What broke, for whom, for how long. Two sentences.

## Timeline
Every time is UTC. Every entry is something someone saw or did, not what they thought.

## What made it possible
Not the trigger — the trigger is in the timeline. The condition that let the trigger become an incident.

## What made it worse
What slowed detection, diagnosis or recovery. This is where the useful actions come from.

## Actions
Each with an owner and a date. An action without both is a wish.
`,
  },
  {
    id: "ar-northwind",
    name: "Northwind tenant notes",
    slug: "northwind-tenant-notes",
    summary: "What is particular about the Northwind rollout: two tenants, two rounding modes, and a busy 11:00 batch.",
    tags: ["rollout", "northwind", "customers"],
    authorId: "u5",
    updatedAt: day(2026, 9, 19),
    body: `# Northwind tenant notes

Northwind Traders runs two legal entities on one previous system, so they get two tenants and the reconciliation is
run per entity.

## Things to know

- Their 11:00 batch is a third of the day's orders in ten minutes. The mirror lags during it; the target is under
  a minute before wave 2.
- The two entities round tax differently today. Both are being set to per line before the mirror starts.
- Their finance team reconciles invoices to purchase orders line by line. The tax rounding policy exists because
  of them.
- The revised agreement changes only the data clause. Legal has the draft; the customer's signatory is available
  Tuesdays.

## Contacts

The customer's named decision maker is their head of operations. Everything goes through them; the IT contact is
for access and nothing else.
`,
  },
  {
    id: "ar-pricing",
    name: "How we price a migration",
    slug: "how-we-price-a-migration",
    summary: "Three inputs and a table: records, systems, and whether the customer has a test environment.",
    tags: ["services", "sales", "pricing"],
    authorId: "u12",
    updatedAt: day(2026, 7, 28),
    body: `# How we price a migration

A migration is priced from three things, and the account executive can quote it without asking engineering.

| Input | Where it comes from |
|---|---|
| Records | Customers plus catalogue entries plus open orders, from the previous system's own counts |
| Source systems | One, or more than one. More than one is the second row of the table |
| Test environment | Whether the customer can give us a copy of their data before the contract is signed |

Under 50,000 records from one system with a test copy is the list price. Every other combination is list price plus
the surcharge in the table, and anything over 500,000 records is a conversation with the head of services first.

What is never done: pricing a migration without a record count. A customer who cannot give one has a project we do
not yet understand.
`,
  },
  {
    id: "ar-release",
    name: "Release notes — October",
    slug: "release-notes-october",
    summary: "Per-line tax rounding on every tenant, the returns inspection screen, and the EDI connector waitlist.",
    tags: ["releases", "product"],
    authorId: "u3",
    updatedAt: day(2026, 9, 20),
    body: `# Release notes — October

## Tax rounding
Per-line rounding is the default on every tenant. Tenants on per-order rounding keep it and are listed in the
tenant's configuration; see the tax rounding policy.

## Returns inspection
The returns module gains an inspection screen: outcome, photos, and the refund proposed from the outcome. Refunds
still need a second person to approve above the tenant's limit.

## EDI connector
The connector is on a waitlist while the first three trading-partner mappings are finished with the customers
who asked for them. Sales can quote it; the delivery date is set with the head of services.

## Smaller changes
- Invoice export includes the purchase order reference on every line.
- The sandbox tenant can be reset by the customer's administrator without a ticket.
- The back office remembers the last filter on the orders list.
`,
  },
  {
    id: "ar-expenses",
    name: "Expense policy",
    slug: "expense-policy",
    summary: "What is claimed, how, and the two things that are never claimed.",
    tags: ["finance", "policy", "people"],
    authorId: "u8",
    updatedAt: day(2026, 6, 15),
    body: `# Expense policy

Claim within the month, with the receipt, in the finance system. Your manager approves; finance pays with the next
payroll.

## Travel
Economy for anything under six hours; the cheapest sensible fare, booked at least a week ahead where the trip is
known that far in advance. Hotels at the company rate where we have one, otherwise up to the city limit in the
finance system.

## On site with a customer
Meals with the customer are claimed as customer entertainment and need the customer's name on the claim.

## Never claimed
Fines of any kind, and anything for a family member travelling with you.
`,
  },
];

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const list = (xs: string[]): string => `array[${xs.map(q).join(", ")}]::text[]`;

export const SEED = `
  insert into products (id, name, sku, summary, category, price, availability, updated_at) values
    ${PRODUCTS.map((p) => `(${q(p.id)}, ${q(p.name)}, ${q(p.sku)}, ${q(p.summary)}, ${q(p.category)}, ${p.price}, ${q(p.availability)}, ${p.updatedAt})`).join(",\n    ")}
  on conflict (id) do nothing;

  -- what each costs us, from its price: the rows the insert above just made, and any kept from before the column
  update products set cost = case category when 'Services' then price * 62 / 100 when 'Platform' then price * 28 / 100 else price * 35 / 100 end where cost is null;

  insert into people (id, name, title, department, email, location, updated_at) values
    ${PEOPLE.map((p) => `(${q(p.id)}, ${q(p.name)}, ${q(p.title)}, ${q(p.department)}, ${q(p.email)}, ${q(p.location)}, ${p.updatedAt})`).join(",\n    ")}
  on conflict (id) do nothing;

  insert into articles (id, name, slug, summary, tags, author_id, body, version, updated_at) values
    ${ARTICLES.map((a) => `(${q(a.id)}, ${q(a.name)}, ${q(a.slug)}, ${q(a.summary)}, ${list(a.tags)}, ${q(a.authorId)}, ${q(a.body)}, 1, ${a.updatedAt})`).join(",\n    ")}
  on conflict (id) do nothing;
`;

/** How many of each the seed holds, for a test that counts. */
export const SEEDED = { products: PRODUCTS.length, people: PEOPLE.length, articles: ARTICLES.length };

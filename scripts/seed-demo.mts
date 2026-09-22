/**
 * Fills a fresh fleet with a team's first week of work, through the front door.
 *
 * Nothing here writes to a table. Four people upload files, open issues, hand them over, comment and move them,
 * using the same operations the front ends use — so what a demo shows is what the product does, and a change that
 * breaks a real workflow breaks this too. Run it once against an empty environment; a project that already has
 * work on it is left alone.
 *
 *   npx tsx scripts/seed-demo.mts                       # the dev fleet on :4001 / :4002
 *   DOCUMENTS_URL=… WORKSPACE_URL=… npx tsx scripts/seed-demo.mts
 */
import { RayfoldClient, createFetchTransport } from "@rayfold/client";
import { pdf } from "../e2e/pdf.ts";

const DOCUMENTS_URL = (process.env["DOCUMENTS_URL"] ?? "http://localhost:4001").replace(/\/$/, "");
const WORKSPACE_URL = (process.env["WORKSPACE_URL"] ?? "http://localhost:4002").replace(/\/$/, "");

type Handle = "ada" | "grace" | "noor" | "tomas";
const MEMBER: Record<Handle, string> = { ada: "u1", grace: "u2", noor: "u3", tomas: "u4" };

function client(base: string, who: Handle): RayfoldClient {
  return new RayfoldClient({
    transport: createFetchTransport({ url: `${base}/rayfold`, headers: () => ({ authorization: `Bearer ${who}` }) }),
    client: "seed-demo/0.1.0",
  });
}

interface Issue {
  id: string;
  version: number;
}

/** One person's hands on both services. */
class Person {
  readonly documents: RayfoldClient;
  readonly workspace: RayfoldClient;
  constructor(readonly who: Handle) {
    this.documents = client(DOCUMENTS_URL, who);
    this.workspace = client(WORKSPACE_URL, who);
  }

  async upload(projectId: string, name: string, type: string, bytes: Uint8Array): Promise<void> {
    const res = await fetch(`${DOCUMENTS_URL}/rayfold/uploads`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", authorization: `Bearer ${this.who}`, "rayfold-upload-type": type, "rayfold-upload-name": name },
      body: bytes as BodyInit,
    });
    if (res.status !== 201) throw new Error(`upload of ${name} failed: ${res.status} ${await res.text()}`);
    const { id } = (await res.json()) as { id: string };
    await this.documents.command("createDocument", { upload: id, name, projectId }, { shape: "{ id }" });
    console.log(`  ${this.who} added ${name}`);
  }

  async open(projectId: string, title: string, assignee?: Handle, more: { priority?: "low" | "normal" | "high" | "urgent"; labels?: string[]; dueOn?: string; description?: string } = {}): Promise<Issue> {
    const issue = await this.workspace.command<Issue>("createIssue", { projectId, title, assigneeId: assignee ? MEMBER[assignee] : null, ...more }, { shape: "{ id version }" });
    console.log(`  ${this.who} opened "${title}"${assignee ? ` for ${assignee}` : ""}`);
    return issue;
  }

  async edit(issue: Issue, changes: { priority?: "low" | "normal" | "high" | "urgent"; labels?: string[]; dueOn?: string | null; description?: string | null }): Promise<Issue> {
    const next = await this.workspace.command<Issue>("updateIssue", { id: issue.id, changes }, { shape: "{ id version }", ifVersion: issue.version });
    console.log(`  ${this.who} changed an issue: ${Object.keys(changes).join(", ")}`);
    return next;
  }

  async handOver(issue: Issue, to: Handle): Promise<Issue> {
    const next = await this.workspace.command<Issue>("assignIssue", { id: issue.id, assigneeId: MEMBER[to] }, { shape: "{ id version }", ifVersion: issue.version });
    console.log(`  ${this.who} handed an issue to ${to}`);
    return next;
  }

  async move(issue: Issue, to: "open" | "doing" | "done"): Promise<Issue> {
    const next = await this.workspace.command<Issue>("moveIssue", { id: issue.id, to }, { shape: "{ id version }", ifVersion: issue.version });
    console.log(`  ${this.who} moved an issue to ${to}`);
    return next;
  }

  async say(issue: Issue, body: string): Promise<void> {
    await this.workspace.command("addComment", { issueId: issue.id, body }, { shape: "{ id }" });
    console.log(`  ${this.who}: "${body}"`);
  }
}

const text = (s: string) => new TextEncoder().encode(s);

async function alreadySeeded(projectId: string): Promise<boolean> {
  const page = await client(WORKSPACE_URL, "ada").query<{ total: number }>("issues", { projectId }, { shape: "{ total }" });
  return page.total > 0;
}

async function northwind(): Promise<void> {
  const p = "p1";
  const ada = new Person("ada");
  const grace = new Person("grace");
  const noor = new Person("noor");
  const tomas = new Person("tomas");

  await noor.upload(p, "Rollout plan.md", "text/markdown", text(`# Northwind rollout

Cut over the Northwind tenant from the legacy order desk to Keel in three waves.

| Wave | Scope | Owner | Date |
|---|---|---|---|
| 1 | Read-only mirror, no writes | Grace | 6 Oct |
| 2 | Orders and returns | Ada | 20 Oct |
| 3 | Invoicing, legacy switched off | Ada | 3 Nov |

## Go / no-go

- All wave-1 reconciliations within 0.1% for five consecutive days
- Legal sign-off on the revised MSA (Tomás)
- On-call rota covered through the first fortnight after wave 3
`));
  await grace.upload(p, "Cutover checklist.csv", "text/csv", text(`step,owner,status,notes
Freeze legacy price list,Grace,done,frozen 18 Sep
Mirror orders to Keel,Grace,in progress,lagging 4 min at peak
Verify tax rounding,Ada,todo,two tenants round differently
Switch webhooks,Ada,todo,
Disable legacy writes,Ada,todo,wave 3 only
`));
  await tomas.upload(
    p,
    "Master services agreement v3.pdf",
    "application/pdf",
    pdf("Master services agreement", [
      "Northwind Traders and Keel, draft 3",
      "",
      "1. Term: 36 months from the wave-3 cutover date.",
      "2. Availability: 99.9% measured monthly, excluding announced maintenance.",
      "3. Data: hosted in the customer's region; exportable at any time in open formats.",
      "4. Liability: capped at fees paid in the preceding twelve months.",
      "",
      "Changes from draft 2 are in section 3 only.",
    ]),
  );

  const mirror = await grace.open(p, "Order mirror lags at peak", "grace", {
    priority: "high",
    labels: ["wave-1", "platform"],
    dueOn: "2026-10-03",
    description: "The read-only mirror falls behind during the 11:00 batch. Wave 2 writes through it, so it has to be under a minute by then.",
  });
  await grace.say(mirror, "Peaks at about four minutes behind during the 11:00 batch. Looking at the relay's fan-out.");
  const inProgress = await grace.move(mirror, "doing");
  await ada.say(inProgress, "If it is the batch size, wave 2 needs it under a minute. Happy to pair.");

  const rounding = await ada.open(p, "Tax rounding differs between the two tenants", undefined, { labels: ["finance", "wave-2"], dueOn: "2026-10-15" });
  await ada.say(rounding, "Legacy rounds per line, we round per order. Finance wants per line.");
  const roundingForNoor = await ada.handOver(rounding, "noor");
  await noor.say(roundingForNoor, "Per line it is. I will write it up in the plan.");
  await noor.edit(roundingForNoor, { description: "Decision: round per line, as the legacy desk does. Update the plan and tell finance." });

  const msa = await tomas.open(p, "Sign the revised MSA", "tomas", { priority: "urgent", labels: ["legal"], dueOn: "2026-09-18" });
  await tomas.say(msa, "Draft 3 is up. Only section 3 changed. Need Ada's read on the export clause by Friday.");
  await ada.say(msa, "Read it. Clause 3 works for us as written.");
  const msaDone = await tomas.move(msa, "doing");
  await tomas.move(msaDone, "done");

  const rota = await ada.open(p, "On-call rota for the fortnight after wave 3", undefined, { labels: ["ops"], dueOn: "2026-11-01" });
  await ada.handOver(rota, "grace");

  const freeze = await grace.open(p, "Freeze the legacy price list", "grace", { labels: ["wave-1"] });
  await grace.move(await grace.move(freeze, "doing"), "done");

  await noor.open(p, "Customer comms for wave 2", "noor", { priority: "high", labels: ["wave-2", "comms"], dueOn: "2026-10-13", description: "Announcement, FAQ and the in-app banner. Legal reads the announcement first." });
  // overdue and untouched: the one thing on the board that is red
  await ada.open(p, "Rehearse the wave two cutover", undefined, { priority: "urgent", labels: ["wave-2", "ops"], dueOn: "2026-09-19" });
}

async function compliance(): Promise<void> {
  const p = "p2";
  const ada = new Person("ada");
  const grace = new Person("grace");
  const noor = new Person("noor");
  const tomas = new Person("tomas");

  await tomas.upload(p, "Q3 control evidence.md", "text/markdown", text(`# Q3 control evidence

What the auditors asked for, and where it lives.

- **Access reviews** — quarterly export from the identity provider, reviewed by team leads. Q3 review: 12 Sep.
- **Change management** — every production change is a reviewed pull request; the deploy log links each one.
- **Backups** — nightly, restored on the first Monday of each month; last restore drill 1 Sep, 41 minutes.
- **Incident log** — two P2s in Q3, both with post-mortems attached.
`));
  await grace.upload(p, "Restore drill Sep.csv", "text/csv", text(`database,started,finished,minutes,verified by
workspace,2026-09-01 06:00,2026-09-01 06:23,23,Grace
documents,2026-09-01 06:05,2026-09-01 06:41,36,Grace
`));
  await tomas.upload(
    p,
    "Data processing addendum.pdf",
    "application/pdf",
    pdf("Data processing addendum", [
      "Between Keel and its customers, effective Q3 2026.",
      "",
      "Sub-processors are listed at the address in annex 1 and customers are told",
      "thirty days before one is added. Personal data is kept in the customer's",
      "region and deleted within ninety days of the end of the agreement.",
    ]),
  );

  const evidence = await tomas.open(p, "Collect Q3 control evidence", "tomas", { priority: "high", labels: ["audit"], dueOn: "2026-09-30" });
  await tomas.say(evidence, "Everything except the access review export is in the folder.");
  const evidenceDoing = await tomas.move(evidence, "doing");
  await grace.say(evidenceDoing, "Export is running now, will attach it here.");

  const access = await grace.open(p, "Q3 access review", "grace");
  await grace.say(access, "Three leavers still had read access to the documents service. Revoked; noting it in the review.");
  await grace.move(await grace.move(access, "doing"), "done");

  const drill = await grace.open(p, "Restore drill took longer than the target", "grace", { labels: ["backups", "audit"], description: "Target is 30 minutes end to end. The documents restore alone took 36." });
  await grace.say(drill, "Documents restore was 36 minutes against a 30 minute target. The files volume is the slow part.");
  await ada.say(drill, "Snapshot the volume instead of copying it; that should halve it.");
  await grace.move(drill, "doing");

  const dpa = await tomas.open(p, "Publish the updated DPA", undefined, { labels: ["legal", "comms"], dueOn: "2026-10-06" });
  await tomas.handOver(dpa, "noor");
  await noor.say(dpa, "Goes out with the October release notes.");

  await ada.open(p, "Post-mortem for the 14 Sep P2", "ada", { priority: "low", labels: ["incident"], dueOn: "2026-09-28" });
}

for (const [name, projectId, run] of [
  ["Northwind rollout", "p1", northwind],
  ["Q3 compliance", "p2", compliance],
] as const) {
  if (await alreadySeeded(projectId)) {
    console.log(`${name}: already has work on it, leaving it alone`);
    continue;
  }
  console.log(`${name}:`);
  await run();
}
console.log("done");

# SupplyDesk

Vendor operations and accounts payable, built as a FeltKit reference application.

A small company uses SupplyDesk to manage suppliers, purchase orders, goods receipts,
invoices and payments. The interesting part is what happens when the paperwork doesn't
match. When a vendor bills $12,400 against a $10,000 purchase order, SupplyDesk:

1. records the invoice and reconciles it against the PO, the receipts and prior billing, in the same transaction;
2. detects each discrepancy with deterministic rules, without a model (`feltkit/_rules.ts`);
3. opens an exception that holds the variance, meaning the amount payment would exceed what is authorized;
4. lets a clerk or an agent investigate it, attach evidence and propose a resolution;
5. routes the proposal to the approvers whose delegated authority covers the variance;
6. lets **only a person** decide it, and checks that person's authority, refusing and recording any attempt beyond it;
7. tracks payment from scheduled to paid;
8. records every transition in an append-only audit trail, each entry linked to the AppPort request that caused it.

The application owns the business rules and the authoritative state. An agent can do
everything a clerk can, through the same capabilities, but it can't approve anything.

Scaffolded with `npm create feltkit@latest` (create-feltkit 0.3.10, `tasks` template).

## Run it

```bash
npm install
```

```bash
npm run dev
```

Open the app URL it prints. Switch identities from the top bar:

| Dev user | Role | Can |
|---|---|---|
| Ada Lovelace | `controller` (+ `admin`) | everything; approval authority **$50,000** |
| Barbara Liskov | `approver` | decide exceptions; approval authority **$1,000** |
| Grace Hopper | `ap_clerk` | vendors, POs, receipts, invoices; investigate and propose |
| Katherine Johnson | `auditor` | read everything, including the audit trail |
| AP Agent (`ap-agent`, type agent) | `agent` | submit and re-match invoices; investigate, add evidence, propose; **never** decide, pay or delegate |

### The demo, in four steps

1. As **Ada**, use **Dashboard → Load demo data**. This creates three vendors (Globex is on hold), PO-1001 for $10,000 of pallet racking (fully received), PO-1002 for fasteners (partly received), approval authority for Ada and Barbara, and one invoice that matches cleanly and is approved by rule.
2. As **Grace**, go to **Invoices → Receive an invoice → "Northwind $12,400 vs PO $10,000" → Submit and reconcile**. The result is an exception with two findings (`line_not_on_po` for the expedited freight, `amount_over_po`) and a $2,400 variance.
3. Work it as the agent, over MCP:

   ```bash
   npm run agent
   ```

   The agent discovers what it may do, investigates, records evidence, proposes an override with its rationale, and then tries to decide the exception itself. It gets `FORBIDDEN`.
4. As **Barbara**, try **Approve override**. SupplyDesk refuses, because $2,400 exceeds her $1,000 authority, and records the refusal. As **Ada**, approve it, then on the invoice **Schedule payment** and **Record payment**. Finish with the **Audit trail**.

`npm run agent` is a scripted, deterministic agent. Any MCP client can do the same work. See
**AppPort console → Connect an agent**, or:

```bash
npx feltkit session create --id ap-agent --role agent --type agent
```

```bash
claude mcp add --transport http --scope local supplydesk http://localhost:3000/mcp --header "Authorization: Bearer <token>"
```

## How authority works

Approval is decided by the application, not by a model or a UI. `exceptions:decide` (`feltkit/exceptions.ts`) checks these in order:

| Check | Enforced by |
|---|---|
| The caller holds `exceptions.decide` | FeltKit, before the handler runs (roles in `feltkit/app.ts`) |
| The caller is a person, not an agent or service, even when a role grants the permission | SupplyDesk |
| The caller did not propose this resolution | SupplyDesk (four eyes) |
| The caller did not submit the invoice | SupplyDesk (four eyes) |
| The caller has delegated authority (`approvalAuthority`), and to approve, it is at least the variance | SupplyDesk |

Failing the first check is an error, which FeltKit's activity log records. Failing any of the
others returns `status: "refused"` with the reason, and the refusal is **committed to the audit
trail** as evidence that the attempt happened. Nothing else changes. An override can't be
proposed without citing evidence, and nobody may change their own authority.

## Where everything lives

| Concern | Implementation |
|---|---|
| State | FeltDB collections in `feltkit/app.ts`: `vendors`, `purchaseOrders`, `invoices`, `exceptions`, `evidence`, `approvalAuthority`, `events` |
| Business rules | `feltkit/_rules.ts`: pure functions, unit-tested, no I/O, no model |
| Process | `feltkit/_invoicing.ts` (receive, reconcile, settle), `exceptions.ts`, `payments.ts`, `authority.ts` |
| Capabilities | 25 AppPort capabilities (`vendors.*`, `purchasing.*`, `invoices.*`, `exceptions.*`, `evidence.*`, `payments.*`, `authority.*`, `audit.list`, `dashboard.summary`), with output contracts in `feltkit/_views.ts` |
| Audit | `feltkit/_audit.ts`: one event per transition, inserted in the same transaction as the change, carrying `ctx.requestId` |
| AppPort Services | Files (evidence documents), Notifications (approval routing, decision notices), Configuration (`PRICE_TOLERANCE_BPS`, `AMOUNT_TOLERANCE_BPS`, default 0), Webhooks (`invoice.*`, `exception.*`, `payment.*` for ERP and bank integrations), Jobs (`invoices.rematch-open`) |
| Agent access | `/mcp` and `/appport`, served by FeltKit. No agent-only API exists. |
| UI | `src/`: dashboard, vendors & POs, invoices, exceptions, audit trail, and an AppPort console that discovers and invokes capabilities over MCP as the signed-in person |

The app adds no infrastructure of its own: no extra database, queue, service or API beyond FeltDB, AppPort and AppPort Services.

## Test

```bash
npm test
```

16 tests:

- the reconciliation rules (`tests/rules.test.ts`);
- the process end to end against a fresh FeltDB per test (`tests/process.test.ts`): the full $12,400 scenario with the exact audit sequence, agent and over-granted-agent refusal, four-eyes checks, authority limits, override-needs-evidence, receipt-then-re-match clearing an exception, duplicates and vendors on hold, approval routing, atomic failure, and state surviving a restart.

## Portable artifact

```bash
npm run build:app
```

```bash
npm run verify:app
```

`build:app` compiles `supply-desk.app` (`manifest.json`, `module.wasm` that imports nothing, and the frontend). FeltKit refuses the build if the backend uses anything an artifact can't provide. That's why SupplyDesk uses neither `ctx.agent` nor `app.integration`.

`verify:app` runs `scripts/verify-artifact.mjs`. It loads **only** the `.app` directory and drives
the whole exception scenario through the compiled module, playing the host with an in-memory
store. It passes from a directory containing nothing but the artifact and the script.

What has **not** been verified: running under AppBoundry itself. The AppBoundry CLI on npm
(`@appport/appboundry@1.1.1`) has no `run` command and doesn't read FeltKit 0.3.10's
`appboundry.app/1` format. `verify-artifact.mjs` is a reference host for checking the artifact,
not AppBoundry. It doesn't reproduce AppBoundry's storage, sessions, service implementations or
independent schema checks. Under AppBoundry, Studio, `/mcp`, API keys, schedules and webhook
*delivery* aren't available (FeltKit lists these as omitted when it builds).

## Known limits

- **Service effects commit separately.** Notifications and webhook emits are separate from the mutation's FeltDB transaction (a FeltKit property). The handlers emit last, but a commit conflict after an emit could leave a notification for a change that didn't commit.
- **Demo scale.** List queries use `find`, which is capped; paging with `query` + cursor would be needed for real volumes.
- **Payments are recorded, not executed.** SupplyDesk tracks scheduled and paid, and emits `payment.*` webhooks for a bank integration to act on. It moves no money.
- **Event ordering** uses a per-process monotonic timestamp. With several servers, events in the same millisecond from different processes have no defined order.
- **New self-service accounts** get the read-only `auditor` role. Real roles are assigned by an operator.

## FeltKit commands

`npm run dev`, `npm test`, `npm run build`, `npm start`, `npm run deploy`, `npm run inspect` and
`npm run typecheck` work as in any FeltKit app. See the FeltKit documentation at
<https://github.com/rkendel1/feltkit#readme>. `npx feltkit skills install` added the FeltKit skills for
coding agents to `.claude/skills/`.

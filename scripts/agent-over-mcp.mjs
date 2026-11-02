#!/usr/bin/env node
/**
 * A scripted AP agent that operates SupplyDesk only through its MCP endpoint: the same
 * AppPort capabilities, authorization and audit as every other client. It has no database
 * access and no special API. Any MCP-capable agent (Claude Code, for one) can do the same.
 *
 *   npm run dev                              # in another terminal
 *   node scripts/agent-over-mcp.mjs          # development: signs in as the dev user "ap-agent"
 *
 *   SUPPLYDESK_URL=https://… SUPPLYDESK_TOKEN=… node scripts/agent-over-mcp.mjs
 *     # anywhere else: a session from `npx feltkit session create --id ap-agent --role agent --type agent`
 *
 * What it does, deterministically:
 *   1. Discovers its capabilities and which of them it may use (feltkit_context).
 *   2. If there is no open exception, submits Northwind's $12,400 invoice against PO-1001.
 *   3. Takes the first open exception, reads everything about it, records evidence, and
 *      proposes a resolution with its rationale.
 *   4. Tries to decide it — and is refused, because deciding belongs to an authorized person.
 */
const base = (process.env.SUPPLYDESK_URL ?? "http://localhost:3000").replace(/\/$/, "");

async function token() {
  if (process.env.SUPPLYDESK_TOKEN) return process.env.SUPPLYDESK_TOKEN;
  const response = await fetch(`${base}/api/auth/dev`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: "ap-agent" }) });
  if (!response.ok) throw new Error(`No SUPPLYDESK_TOKEN, and development sign-in failed (${response.status}). Is \`npm run dev\` running?`);
  return (await response.json()).token;
}

const bearer = await token();
let rpc = 0;
async function mcp(method, params) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method, ...(params ? { params } : {}) }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
/** Call a capability as a tool. Returns { ok, value } or { ok: false, error }. */
async function tool(name, args = {}) {
  const result = await mcp("tools/call", { name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) return { ok: false, error: text };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: true, value: text };
  }
}
async function must(name, args) {
  const r = await tool(name, args);
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  return r.value;
}
const say = (s) => console.log(s);
const money = (c) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

// 1. Discover.
const context = await must("feltkit_context");
const mine = context.tools.filter((t) => t.allowed && t.source !== "services").map((t) => t.name);
const notMine = context.tools.filter((t) => !t.allowed && t.source !== "services").map((t) => t.name);
say(`Connected to ${context.application} (${context.environment}) as ap-agent.`);
say(`  May use:     ${mine.join(", ")}`);
say(`  May not use: ${notMine.join(", ")}\n`);

// 2. Make sure there is work.
let open = [...(await must("exceptions_list", { status: "open" })), ...(await must("exceptions_list", { status: "investigating" }))];
if (!open.length) {
  const vendors = await must("vendors_list");
  const northwind = vendors.find((v) => v.name.startsWith("Northwind"));
  if (!northwind) throw new Error("No Northwind vendor. Load the demo data first (Dashboard → Load demo data, as Ada).");
  const n = (await must("invoices_list", { vendorId: northwind.id })).length + 1;
  const submitted = await must("invoices_submit", {
    vendorId: northwind.id,
    invoiceNumber: `NW-${7780 + n}`,
    poNumber: "PO-1001",
    lines: [
      { sku: "PALLET-STD", description: "Standard 48x40 pallet racking unit", quantity: 100, unitPriceCents: 10_000 },
      { sku: "FREIGHT-EXP", description: "Expedited freight", quantity: 1, unitPriceCents: 240_000 },
    ],
    totalCents: 1_240_000,
    invoiceDate: new Date().toISOString().slice(0, 10),
  });
  say(`Submitted NW-${7780 + n} for $12,400.00 → ${submitted.status}${submitted.findings.length ? `: ${submitted.findings.map((f) => f.code).join(", ")}` : ""}`);
  open = await must("exceptions_list", { status: "open" });
}
if (!open.length) {
  say("No open exception to work on.");
  process.exit(0);
}

// 3. Investigate.
const target = open[0];
await must("exceptions_investigate", { id: target.id });
const detail = await must("exceptions_get", { id: target.id });
const { exception, invoice, vendor, purchaseOrder, vendorHistory } = detail;
say(`\nInvestigating ${invoice.invoiceNumber} from ${vendor.name}: variance ${money(exception.varianceCents)}`);
for (const f of exception.findings) say(`  • ${f.code}: ${f.message}`);

const facts = [];
if (purchaseOrder?.notes) facts.push(await must("evidence_add", { exceptionId: target.id, kind: "po_snapshot", summary: `${purchaseOrder.number} notes: "${purchaseOrder.notes}"`, source: `purchasing_get ${purchaseOrder.number}` }));
facts.push(await must("evidence_add", {
  exceptionId: target.id,
  kind: "vendor_history",
  summary: `${vendor.name}: ${vendorHistory.invoices} invoice(s), ${vendorHistory.exceptions} exception(s), ${vendorHistory.overridesApproved} override(s) approved, ${vendorHistory.rejected} rejected. Status ${vendor.status}.`,
  source: "exceptions_get",
}));
say(`Recorded ${facts.length} piece(s) of evidence.`);

// A rule a person would recognise, not a model's guess: overrides only for an active vendor whose
// receipts are complete, when the extra charge is the only discrepancy and the PO anticipated it.
const codes = new Set(exception.findings.map((f) => f.code));
const onlyExtraCharge = [...codes].every((c) => c === "line_not_on_po" || c === "amount_over_po");
const anticipated = /expedit|freight/i.test(purchaseOrder?.notes ?? "");
const override = vendor.status === "active" && onlyExtraCharge && anticipated;
const rationale = override
  ? `The only discrepancy is an extra charge not on ${purchaseOrder.number} (${money(exception.varianceCents)}); goods were received in full at the PO price, and the PO notes anticipate expedited freight. Recommend paying as billed, subject to confirmation that operations requested it.`
  : `Discrepancies (${[...codes].join(", ")}) are not explained by the purchase order or receipts. Recommend rejecting and asking the vendor for a corrected invoice or credit note.`;
await must("exceptions_propose", { id: target.id, resolution: override ? "override" : "reject", rationale, evidenceIds: facts.map((f) => f.id) });
say(`Proposed: ${override ? "override" : "reject"}.\n  ${rationale}`);

// 4. The agent cannot make the decision, however it asks.
const attempt = await tool("exceptions_decide", { id: target.id, outcome: override ? "approve" : "reject", note: "Agent attempting to decide its own proposal." });
say(`\nTried to decide it myself → ${attempt.ok ? JSON.stringify(attempt.value) : attempt.error}`);
say(`Waiting for a person with enough delegated authority (variance ${money(exception.varianceCents)}). See Exceptions in the app, and the audit trail.`);

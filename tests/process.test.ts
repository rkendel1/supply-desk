/**
 * The SupplyDesk process end to end, through the same functions every client uses.
 * Each createTestApp() is a fresh FeltDB instance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";

const AGENT = { id: "ap-agent", type: "agent" as const, roles: ["agent"] };
const today = new Date().toISOString().slice(0, 10);

async function seeded() {
  const t = await createTestApp();
  await t.as("ada").mutation(api.demo.seed, {});
  const vendors = await t.as("ada").query(api.vendors.list, {});
  const id = (name: string) => vendors.find((v) => v.name.startsWith(name))!.id;
  return { t, northwind: id("Northwind"), acme: id("Acme"), globex: id("Globex") };
}

const northwind12400 = (vendorId: string, invoiceNumber = "NW-7781") => ({
  vendorId,
  invoiceNumber,
  poNumber: "PO-1001",
  lines: [
    { sku: "PALLET-STD", description: "Standard 48x40 pallet racking unit", quantity: 100, unitPriceCents: 10_000 },
    { sku: "FREIGHT-EXP", description: "Expedited freight", quantity: 1, unitPriceCents: 240_000 },
  ],
  totalCents: 1_240_000,
  invoiceDate: today,
});

async function proposedOverride(t: TestApp, vendorId: string) {
  const agent = t.as(AGENT);
  const result = await agent.mutation(api.invoices.submit, northwind12400(vendorId));
  const exceptionId = result.exceptionId!;
  await agent.mutation(api.exceptions.investigate, { id: exceptionId });
  const ev = await agent.mutation(api.exceptions.addEvidence, { exceptionId, kind: "communication", summary: "Operations asked Northwind for expedited delivery to meet the Warehouse B opening.", source: "e-mail from ops, Oct 28", content: "Please expedite PO-1001, we will cover freight. — Ops" });
  await agent.mutation(api.exceptions.propose, { id: exceptionId, resolution: "override", rationale: "Expedited freight was requested by operations; goods were received in full at the PO price.", evidenceIds: [ev.id] });
  return { result, exceptionId };
}

test("the demo company loads, and a clean three-way match is approved by rule", async () => {
  const { t } = await seeded();
  try {
    const [invoice] = await t.as("katherine").query(api.invoices.list, {});
    assert.equal(invoice!.status, "approved");
    assert.equal(invoice!.approvalBasis, "three_way_match");
    await assert.rejects(t.as("ada").mutation(api.demo.seed, {}), { code: "CONFLICT" }, "seeding is for an empty environment only");
  } finally {
    await t.close();
  }
});

test("the $12,400 invoice: detected, investigated by the agent, refused beyond authority, approved by the controller, paid, audited", async () => {
  const { t, northwind } = await seeded();
  try {
    const { result, exceptionId } = await proposedOverride(t, northwind);
    assert.equal(result.status, "exception");
    assert.deepEqual(result.findings.map((f) => f.code).sort(), ["amount_over_po", "line_not_on_po"]);
    assert.equal(result.varianceCents, 240_000);

    // The agent cannot decide: it does not hold the permission.
    await assert.rejects(t.as(AGENT).mutation(api.exceptions.decide, { id: exceptionId, outcome: "approve", note: "Approving as billed." }), { code: "FORBIDDEN" });

    // Barbara may decide, but her authority is $1,000: the application refuses and records it.
    const refused = await t.as("barbara").mutation(api.exceptions.decide, { id: exceptionId, outcome: "approve", note: "Looks fine." });
    assert.equal(refused.status, "refused");
    assert.match(refused.reason!, /exceeds barbara's authority of \$1,000\.00/);
    assert.equal((await t.as("ada").query(api.exceptions.get, { id: exceptionId })).exception.status, "proposed", "a refusal changes nothing");

    // Ada's authority covers it.
    const decided = await t.as("ada").mutation(api.exceptions.decide, { id: exceptionId, outcome: "approve", note: "Freight was requested by ops; approve as billed." });
    assert.equal(decided.status, "approved");
    const invoice = await t.as("ada").query(api.invoices.get, { id: result.invoiceId });
    assert.deepEqual([invoice.status, invoice.approvalBasis, invoice.approvedBy], ["approved", "override", "ada"]);

    await t.as("ada").mutation(api.payments.schedule, { invoiceId: result.invoiceId });
    await t.as("ada").mutation(api.payments.recordPayment, { invoiceId: result.invoiceId, reference: "ACH-20261102-0042" });

    const trail = (await t.as("katherine").query(api.audit.list, { invoiceId: result.invoiceId })).reverse();
    assert.deepEqual(trail.map((e) => [e.type, e.actor]), [
      ["invoice.received", "ap-agent"],
      ["invoice.reconciled", "ap-agent"],
      ["exception.opened", "ap-agent"],
      ["exception.investigating", "ap-agent"],
      ["evidence.added", "ap-agent"],
      ["exception.proposed", "ap-agent"],
      ["decision.refused", "barbara"],
      ["exception.approved", "ada"],
      ["invoice.approved", "ada"],
      ["payment.scheduled", "ada"],
      ["payment.recorded", "ada"],
    ]);
    assert.ok(trail.every((e) => e.requestId), "every event names the AppPort request that caused it");
    assert.equal(trail.find((e) => e.type === "exception.proposed")!.actorType, "agent");
    const approval = trail.find((e) => e.type === "exception.approved")!;
    assert.deepEqual([approval.data!.varianceCents, approval.data!.authorityLimitCents, approval.data!.followedProposal], [240_000, 5_000_000, true]);

    // FeltKit's own activity log has the agent's denied attempt as well.
    const denied = await t.runtime.activity.list({ name: "exceptions:decide" });
    assert.ok(denied.some((a) => a.principal?.id === "ap-agent" && a.error?.code === "FORBIDDEN"));

    await t.restart();
    assert.equal((await t.as("ada").query(api.invoices.get, { id: result.invoiceId })).status, "paid", "state survives a restart");
  } finally {
    await t.close();
  }
});

test("only people decide: an agent principal is refused even when a role grants exceptions.decide", async () => {
  const { t, northwind } = await seeded();
  try {
    const { exceptionId } = await proposedOverride(t, northwind);
    const overGranted = t.as({ id: "rogue-bot", type: "agent", roles: ["controller"] });
    const r = await overGranted.mutation(api.exceptions.decide, { id: exceptionId, outcome: "approve", note: "auto" });
    assert.equal(r.status, "refused");
    assert.match(r.reason!, /Only a person may decide/);
  } finally {
    await t.close();
  }
});

test("four eyes: neither the proposer nor the invoice's submitter may decide", async () => {
  const { t, northwind } = await seeded();
  try {
    const ada = t.as("ada");
    const submitted = await ada.mutation(api.invoices.submit, northwind12400(northwind, "NW-7782"));
    const ev = await t.as("grace").mutation(api.exceptions.addEvidence, { exceptionId: submitted.exceptionId!, kind: "note", summary: "Freight confirmed by phone." });
    await t.as("grace").mutation(api.exceptions.propose, { id: submitted.exceptionId!, resolution: "override", rationale: "Freight confirmed with the warehouse.", evidenceIds: [ev.id] });
    const r = await ada.mutation(api.exceptions.decide, { id: submitted.exceptionId!, outcome: "approve", note: "self-approve" });
    assert.equal(r.status, "refused");
    assert.match(r.reason!, /submitted the invoice/);
  } finally {
    await t.close();
  }
});

test("an override must cite evidence; clerks, auditors and agents cannot decide, submit or pay beyond their roles", async () => {
  const { t, northwind } = await seeded();
  try {
    const r = await t.as(AGENT).mutation(api.invoices.submit, northwind12400(northwind));
    await assert.rejects(t.as(AGENT).mutation(api.exceptions.propose, { id: r.exceptionId!, resolution: "override", rationale: "Trust me, it is fine." }), { code: "INVALID_ARGUMENT" });
    await assert.rejects(t.as("grace").mutation(api.exceptions.decide, { id: r.exceptionId!, outcome: "reject", note: "Rejecting." }), { code: "FORBIDDEN" });
    await assert.rejects(t.as("katherine").mutation(api.invoices.submit, northwind12400(northwind, "X")), { code: "FORBIDDEN" });
    await assert.rejects(t.as(AGENT).mutation(api.payments.schedule, { invoiceId: r.invoiceId }), { code: "FORBIDDEN" });
  } finally {
    await t.close();
  }
});

test("billing ahead of receipt opens an exception that clears once the goods arrive", async () => {
  const { t, acme } = await seeded();
  try {
    // PO-1002: 50 boxes of bolts ordered, 30 received and already billed (AF-5520).
    const r = await t.as("grace").mutation(api.invoices.submit, { vendorId: acme, invoiceNumber: "AF-5601", poNumber: "PO-1002", lines: [{ sku: "BOLT-M8", description: "M8 hex bolt, zinc, box of 100", quantity: 20, unitPriceCents: 4_200 }], totalCents: 84_000, invoiceDate: today });
    assert.deepEqual(r.findings.map((f) => f.code), ["quantity_not_received"]);
    assert.equal(r.varianceCents, 84_000);
    await t.as("grace").mutation(api.purchasing.receive, { number: "PO-1002", receipts: [{ sku: "BOLT-M8", quantity: 20 }] });
    const again = await t.as(AGENT).mutation(api.invoices.reconcile, { id: r.invoiceId });
    assert.equal(again.status, "approved");
    const ex = await t.as("ada").query(api.exceptions.get, { id: r.exceptionId! });
    assert.equal(ex.exception.status, "cleared");
  } finally {
    await t.close();
  }
});

test("duplicates and vendors on hold put the whole invoice at risk; rejecting needs no limit", async () => {
  const { t, acme, globex } = await seeded();
  try {
    const dup = await t.as("grace").mutation(api.invoices.submit, { vendorId: acme, invoiceNumber: "AF-5520", poNumber: "PO-1002", lines: [{ sku: "NUT-M8", description: "M8 nut", quantity: 1, unitPriceCents: 1_800 }], totalCents: 1_800, invoiceDate: today });
    assert.ok(dup.findings.some((f) => f.code === "duplicate_invoice"));
    assert.equal(dup.varianceCents, 1_800);
    const held = await t.as("grace").mutation(api.invoices.submit, { vendorId: globex, invoiceNumber: "GX-1", lines: [{ sku: "FRT", description: "Freight", quantity: 1, unitPriceCents: 50_000 }], totalCents: 50_000, invoiceDate: today });
    assert.deepEqual(held.findings.map((f) => f.code).sort(), ["po_not_found", "vendor_on_hold"]);
    await t.as(AGENT).mutation(api.exceptions.propose, { id: held.exceptionId!, resolution: "reject", rationale: "Vendor is on hold pending a bank-details verification call." });
    const r = await t.as("barbara").mutation(api.exceptions.decide, { id: held.exceptionId!, outcome: "reject", note: "Rejected until the vendor is verified." });
    assert.equal(r.status, "rejected");
    assert.equal((await t.as("ada").query(api.invoices.get, { id: held.invoiceId })).status, "rejected");
  } finally {
    await t.close();
  }
});

test("routing: a proposal notifies only approvers whose authority covers the variance", async () => {
  const { t, northwind } = await seeded();
  try {
    await proposedOverride(t, northwind);
    const ada = await t.as("ada").query(api.inbox.list, { unread: true });
    const barbara = await t.as("barbara").query(api.inbox.list, { unread: true });
    assert.deepEqual(ada.map((n) => n.type), ["exception.awaiting_decision"]);
    assert.deepEqual(barbara, []);
  } finally {
    await t.close();
  }
});

test("a submission that fails writes nothing; delegation cannot be self-granted", async () => {
  const { t } = await seeded();
  try {
    const before = (await t.as("ada").query(api.audit.list, {})).length;
    await assert.rejects(t.as("grace").mutation(api.invoices.submit, { ...northwind12400("no-such-vendor") }), { code: "NOT_FOUND" });
    assert.equal((await t.as("ada").query(api.audit.list, {})).length, before);
    await assert.rejects(t.as("ada").mutation(api.authority.grant, { principalId: "ada", limitCents: 1 }), { code: "FORBIDDEN" });
    await t.as("ada").mutation(api.authority.grant, { principalId: "barbara", limitCents: 300_000 });
    assert.equal((await t.as("barbara").query(api.authority.list, {})).find((a) => a.principalId === "barbara")!.limitCents, 300_000);
  } finally {
    await t.close();
  }
});

/** The reconciliation rules alone: deterministic, no database. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, type ReconcileInput } from "../feltkit/_rules.js";

const po = { id: "po1", number: "PO-1001", vendorId: "v1", status: "open", paymentTermsDays: 30, totalCents: 1_000_000, lines: [{ sku: "PALLET", description: "Pallet", quantity: 100, unitPriceCents: 10_000, receivedQuantity: 100 }] };
const base = (over: Partial<ReconcileInput["invoice"]> = {}, rest: Partial<ReconcileInput> = {}): ReconcileInput => ({
  invoice: { vendorId: "v1", totalCents: 1_000_000, paymentTermsDays: 30, lines: [{ sku: "PALLET", description: "Pallet", quantity: 100, unitPriceCents: 10_000 }], ...over },
  vendor: { status: "active", name: "Northwind" },
  po,
  poNumber: "PO-1001",
  priorOnPo: [],
  duplicates: 0,
  tolerance: { priceBps: 0, amountBps: 0 },
  ...rest,
});
const codes = (r: { findings: Array<{ code: string }> }) => r.findings.map((f) => f.code).sort();

test("a clean three-way match has no findings and no variance", () => {
  const r = reconcile(base());
  assert.deepEqual(r.findings, []);
  assert.equal(r.varianceCents, 0);
  assert.equal(r.authorizedCents, 1_000_000);
});

test("$12,400 billed against a $10,000 PO: unlisted freight line and amount over PO; variance $2,400", () => {
  const r = reconcile(base({ totalCents: 1_240_000, lines: [{ sku: "PALLET", description: "Pallet", quantity: 100, unitPriceCents: 10_000 }, { sku: "FREIGHT-EXP", description: "Expedited freight", quantity: 1, unitPriceCents: 240_000 }] }));
  assert.deepEqual(codes(r), ["amount_over_po", "line_not_on_po"]);
  assert.equal(r.varianceCents, 240_000);
});

test("price variance is measured per unit, and tolerance absorbs small differences", () => {
  const over = base({ totalCents: 1_010_000, lines: [{ sku: "PALLET", description: "Pallet", quantity: 100, unitPriceCents: 10_100 }] });
  assert.deepEqual(codes(reconcile(over)), ["amount_over_po", "price_variance"]);
  assert.equal(reconcile(over).varianceCents, 10_000);
  assert.deepEqual(reconcile({ ...over, tolerance: { priceBps: 100, amountBps: 100 } }).findings, [], "1% tolerance covers a 1% difference");
});

test("billing for goods not yet received, and beyond what was ordered", () => {
  const notReceived = reconcile(base({}, { po: { ...po, lines: [{ ...po.lines[0]!, receivedQuantity: 60 }] } }));
  assert.deepEqual(codes(notReceived), ["quantity_not_received"]);
  assert.equal(notReceived.varianceCents, 400_000);
  const twice = reconcile(base({}, { priorOnPo: [{ totalCents: 1_000_000, lines: [{ sku: "PALLET", description: "Pallet", quantity: 100, unitPriceCents: 10_000 }] }] }));
  assert.deepEqual(codes(twice), ["amount_over_po", "quantity_over_ordered"]);
  assert.equal(twice.varianceCents, 1_000_000);
});

test("vendor on hold, duplicate, missing PO, and wrong vendor authorize nothing", () => {
  assert.equal(reconcile(base({}, { vendor: { status: "on_hold", name: "N" } })).varianceCents, 1_000_000);
  assert.deepEqual(codes(reconcile(base({}, { duplicates: 1 }))), ["duplicate_invoice"]);
  assert.equal(reconcile(base({}, { duplicates: 1 })).varianceCents, 1_000_000);
  assert.deepEqual(codes(reconcile(base({}, { po: null }))), ["po_not_found"]);
  assert.deepEqual(codes(reconcile(base({ vendorId: "other" }))), ["po_vendor_mismatch"]);
});

test("shorter payment terms than agreed and lines that do not add up", () => {
  const terms = reconcile(base({ paymentTermsDays: 10 }));
  assert.deepEqual(codes(terms), ["terms_mismatch"]);
  assert.equal(terms.varianceCents, 0, "a terms change has no monetary variance");
  assert.deepEqual(codes(reconcile(base({ totalCents: 1_000_500 }))), ["amount_over_po", "total_mismatch"]);
});

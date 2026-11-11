/**
 * The SupplyDesk exception scenario against the compiled AppBoundry artifact alone (`supply-desk.app`:
 * manifest.json + module.wasm), run by FeltKit's reference host (createArtifactTestApp). It replaces the
 * hand-written host SupplyDesk kept in scripts/verify-artifact.mjs before FeltKit 0.3.24.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createArtifactTestApp, type ArtifactTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";

const root = fileURLToPath(new URL("..", import.meta.url));
let t: ArtifactTestApp;

before(async () => {
  execFileSync("npx", ["feltkit", "build", "--target", "appboundry"], { cwd: root, stdio: "ignore" });
  t = await createArtifactTestApp(`${root}/supply-desk.app`);
});
after(() => t?.close());

test("the artifact carries the whole exception process", async () => {
  await t.as("ada").mutation(api.demo.seed, {});
  const northwind = (await t.as("ada").query(api.vendors.list, {})).find((v) => v.name.startsWith("Northwind"))!.id;
  assert.equal((await t.as("ada").query(api.invoices.list, {}))[0]?.approvalBasis, "three_way_match", "the clean Acme invoice is approved by three-way match");

  const submitted = await t.as("ap-agent").mutation(api.invoices.submit, {
    vendorId: northwind,
    invoiceNumber: "NW-7781",
    poNumber: "PO-1001",
    lines: [
      { sku: "PALLET-STD", description: "Standard 48x40 pallet racking unit", quantity: 100, unitPriceCents: 10_000 },
      { sku: "FREIGHT-EXP", description: "Expedited freight", quantity: 1, unitPriceCents: 240_000 },
    ],
    totalCents: 1_240_000,
    invoiceDate: new Date().toISOString().slice(0, 10),
  });
  assert.equal(submitted.status, "exception");
  assert.equal(submitted.varianceCents, 240_000);
  const exceptionId = submitted.exceptionId!;

  await t.as("ap-agent").mutation(api.exceptions.investigate, { id: exceptionId });
  const ev = await t.as("ap-agent").mutation(api.exceptions.addEvidence, { exceptionId, kind: "communication", summary: "Operations requested expedited freight.", content: "Please expedite PO-1001. — Ops" });
  await t.as("ap-agent").mutation(api.exceptions.propose, { id: exceptionId, resolution: "override", rationale: "Freight was requested by operations; goods received in full.", evidenceIds: [ev.id] });
  assert.equal((await t.as("ada").query(api.exceptions.get, { id: exceptionId })).exception.status, "proposed");

  await assert.rejects(t.as("ap-agent").mutation(api.exceptions.decide, { id: exceptionId, outcome: "approve", note: "Approve as billed." }), { code: "FORBIDDEN" }, "the agent cannot decide");
  const refused = await t.as("barbara").mutation(api.exceptions.decide, { id: exceptionId, outcome: "approve", note: "Looks fine." });
  assert.equal(refused.status, "refused", "barbara's authority does not cover $2,400");
  assert.equal((await t.as("ada").mutation(api.exceptions.decide, { id: exceptionId, outcome: "approve", note: "Requested by ops." })).status, "approved");

  await t.as("ada").mutation(api.payments.schedule, { invoiceId: submitted.invoiceId });
  await t.as("ada").mutation(api.payments.recordPayment, { invoiceId: submitted.invoiceId, reference: "ACH-0042" });
  assert.equal((await t.as("katherine").query(api.invoices.get, { id: submitted.invoiceId })).status, "paid");

  const trail = (await t.as("katherine").query(api.audit.list, { invoiceId: submitted.invoiceId })).reverse().map((e) => `${e.type}:${e.actor}`);
  assert.equal(trail.join(" "), "invoice.received:ap-agent invoice.reconciled:ap-agent exception.opened:ap-agent exception.investigating:ap-agent evidence.added:ap-agent exception.proposed:ap-agent decision.refused:barbara exception.approved:ada invoice.approved:ada payment.scheduled:ada payment.recorded:ada");
});

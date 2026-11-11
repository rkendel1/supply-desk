/**
 * The invoice process, shared by the functions that drive it. Each helper runs inside the
 * caller's mutation, so its writes (state and audit events) commit together with the
 * caller's, or not at all.
 */
import { fail, type MutationCtx } from "@feltdb/feltkit";
import { exceptions, invoices, purchaseOrders, vendors } from "./app.js";
import { configInt, record } from "./_audit.js";
import { addDays, money, reconcile, type LineInput, type ReconcileResult } from "./_rules.js";

export type Invoice = NonNullable<(typeof invoices)["$doc"]>;

/** Reconcile an invoice against its PO, receipts, and everything billed before it. Reads only. */
export async function evaluate(ctx: MutationCtx, invoice: Invoice): Promise<ReconcileResult & { poId?: string }> {
  const vendor = await ctx.db.get(vendors, invoice.vendorId);
  if (!vendor) fail("NOT_FOUND", `No vendor ${invoice.vendorId}.`);
  const po = invoice.poNumber ? ((await ctx.db.find(purchaseOrders, { number: invoice.poNumber }))[0] ?? null) : null;
  // Only invoices submitted before this one count against it, so a later invoice never
  // changes how an earlier one was judged.
  const earlier = (other: { id: string; submittedAt: number; status: string }) =>
    other.id !== invoice.id && other.status !== "rejected" && (other.submittedAt < invoice.submittedAt || (other.submittedAt === invoice.submittedAt && other.id < invoice.id));
  const priorOnPo = po ? (await ctx.db.find(invoices, { poId: po.id })).filter(earlier) : [];
  const duplicates = (await ctx.db.find(invoices, { vendorId: invoice.vendorId, invoiceNumber: invoice.invoiceNumber })).filter(earlier).length;
  const result = reconcile({
    invoice,
    vendor,
    po,
    ...(invoice.poNumber ? { poNumber: invoice.poNumber } : {}),
    priorOnPo,
    duplicates,
    tolerance: { priceBps: await configInt(ctx, "PRICE_TOLERANCE_BPS", 0), amountBps: await configInt(ctx, "AMOUNT_TOLERANCE_BPS", 0) },
  });
  return { ...result, ...(po ? { poId: po.id } : {}) };
}

export interface SubmitInput {
  vendorId: string;
  invoiceNumber: string;
  poNumber?: string;
  lines: LineInput[];
  totalCents: number;
  paymentTermsDays?: number;
  invoiceDate: string;
}

/** Receive an invoice and reconcile it in the same transaction. */
export async function submitInvoice(ctx: MutationCtx, input: SubmitInput) {
  const who = ctx.auth.requirePrincipal();
  const vendor = await ctx.db.get(vendors, input.vendorId);
  if (!vendor) fail("NOT_FOUND", `No vendor ${input.vendorId}.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.invoiceDate) || Number.isNaN(Date.parse(input.invoiceDate))) fail("INVALID_ARGUMENT", "invoiceDate must be a date (YYYY-MM-DD).");
  const po = input.poNumber ? (await ctx.db.find(purchaseOrders, { number: input.poNumber.trim() }))[0] : undefined;
  const terms = input.paymentTermsDays ?? vendor.paymentTermsDays;
  const now = Date.now();
  const fields = {
    vendorId: input.vendorId,
    invoiceNumber: input.invoiceNumber.trim(),
    ...(input.poNumber?.trim() ? { poNumber: input.poNumber.trim() } : {}),
    ...(po ? { poId: po.id } : {}),
    lines: input.lines,
    totalCents: input.totalCents,
    paymentTermsDays: terms,
    invoiceDate: input.invoiceDate,
    dueDate: addDays(input.invoiceDate, terms),
    status: "received" as const,
    submittedAt: now,
    submittedBy: who.id,
  };
  const id = await ctx.db.insert(invoices, fields);
  await record(ctx, "invoice", id, "invoice.received", { vendor: vendor.name, invoiceNumber: fields.invoiceNumber, poNumber: fields.poNumber ?? null, total: money(input.totalCents) });
  const outcome = await settle(ctx, { ...fields, id, __version: 0 });
  ctx.afterCommit.webhooks.emit("invoice.received", { invoiceId: id, vendorId: input.vendorId, invoiceNumber: fields.invoiceNumber, totalCents: input.totalCents });
  return { invoiceId: id, ...outcome };
}

/**
 * Apply a reconciliation result: approve on a clean three-way match, or open (or update) the
 * invoice's exception. An exception that no longer has findings is cleared.
 */
export async function settle(ctx: MutationCtx, invoice: Invoice) {
  const result = await evaluate(ctx, invoice);
  await record(ctx, "invoice", invoice.id, "invoice.reconciled", { findings: result.findings.map((f) => f.code), varianceCents: result.varianceCents, authorizedCents: result.authorizedCents });

  const existing = invoice.exceptionId ? await ctx.db.get(exceptions, invoice.exceptionId) : null;
  if (!result.findings.length) {
    await ctx.db.patch(invoices, invoice.id, { status: "approved", approvedBy: "rule:three-way-match", approvalBasis: "three_way_match" });
    if (existing) {
      await ctx.db.patch(exceptions, existing.id, { status: "cleared", findings: [], varianceCents: 0, closedAt: Date.now() });
      await record(ctx, "exception", existing.id, "exception.cleared", { reason: "The invoice now matches its purchase order and receipts." }, invoice.id);
    }
    await record(ctx, "invoice", invoice.id, "invoice.approved", { basis: "three_way_match", by: "rule:three-way-match" });
    ctx.afterCommit.webhooks.emit("invoice.approved", { invoiceId: invoice.id, basis: "three_way_match", totalCents: invoice.totalCents });
    return { status: "approved" as const, findings: result.findings, varianceCents: 0, exceptionId: existing?.id ?? null };
  }

  if (existing) {
    await ctx.db.patch(exceptions, existing.id, { findings: result.findings, varianceCents: result.varianceCents });
    await record(ctx, "exception", existing.id, "exception.rematched", { findings: result.findings.map((f) => f.code), varianceCents: result.varianceCents }, invoice.id);
    return { status: "exception" as const, findings: result.findings, varianceCents: result.varianceCents, exceptionId: existing.id };
  }

  const exceptionId = await ctx.db.insert(exceptions, {
    invoiceId: invoice.id,
    vendorId: invoice.vendorId,
    ...(result.poId ? { poId: result.poId } : {}),
    status: "open",
    findings: result.findings,
    varianceCents: result.varianceCents,
    openedAt: Date.now(),
  });
  await ctx.db.patch(invoices, invoice.id, { status: "exception", exceptionId });
  await record(ctx, "exception", exceptionId, "exception.opened", { findings: result.findings.map((f) => ({ code: f.code, message: f.message })), varianceCents: result.varianceCents }, invoice.id);
  ctx.afterCommit.webhooks.emit("exception.opened", { exceptionId, invoiceId: invoice.id, varianceCents: result.varianceCents, findings: result.findings.map((f) => f.code) });
  return { status: "exception" as const, findings: result.findings, varianceCents: result.varianceCents, exceptionId };
}

import { fail, s } from "@feltdb/feltkit";
import { app, exceptions, invoices } from "./app.js";
import { settle, submitInvoice } from "./_invoicing.js";

const InvoiceLine = s.object({ sku: s.string(), description: s.string(), quantity: s.integer(), unitPriceCents: s.integer() });
export const InvoiceView = s.object({
  id: s.string(),
  vendorId: s.string(),
  invoiceNumber: s.string(),
  poNumber: s.optional(s.string()),
  lines: s.array(InvoiceLine),
  totalCents: s.integer(),
  paymentTermsDays: s.integer(),
  invoiceDate: s.string(),
  dueDate: s.string(),
  status: s.enum(["received", "exception", "approved", "rejected", "scheduled", "paid"]),
  approvalBasis: s.optional(s.enum(["three_way_match", "override"])),
  exceptionId: s.optional(s.string()),
}, { additionalProperties: true });

const Finding = s.object({ code: s.string(), message: s.string(), varianceCents: s.integer() }, { additionalProperties: true });
const Reconciliation = s.object({
  invoiceId: s.string(),
  status: s.enum(["approved", "exception"]),
  findings: s.array(Finding),
  varianceCents: s.integer(),
  exceptionId: s.nullable(s.string()),
});

export const list = app.query({
  access: "invoices.read",
  args: { status: s.optional(s.enum(["received", "exception", "approved", "rejected", "scheduled", "paid"])), vendorId: s.optional(s.string()) },
  returns: s.array(InvoiceView),
  capability: { name: "invoices.list", description: "List invoices, newest first, optionally by status or vendor." },
  handler: (ctx, { status, vendorId }) =>
    ctx.db.find(invoices, { ...(status ? { status } : {}), ...(vendorId ? { vendorId } : {}) }, { orderBy: [{ field: "submittedAt", direction: "desc" }] }),
});

export const get = app.query({
  access: "invoices.read",
  args: { id: s.string() },
  returns: InvoiceView,
  capability: { name: "invoices.get", description: "Read one invoice: its lines, terms, due date, status, and how it was approved." },
  handler: async (ctx, { id }) => (await ctx.db.get(invoices, id)) ?? fail("NOT_FOUND", `No invoice ${id}.`),
});

export const submit = app.mutation({
  access: "invoices.submit",
  args: {
    vendorId: s.string(),
    invoiceNumber: s.string({ minLength: 1, maxLength: 60 }),
    poNumber: s.optional(s.string({ maxLength: 40 })),
    lines: s.array(InvoiceLine, { minItems: 1, maxItems: 100 }),
    totalCents: s.integer({ minimum: 0 }),
    paymentTermsDays: s.optional(s.integer({ minimum: 0, maximum: 180 })),
    invoiceDate: s.string({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  },
  returns: Reconciliation,
  capability: {
    name: "invoices.submit",
    description: "Receive a vendor invoice (amounts in cents). SupplyDesk reconciles it against its purchase order, receipts and prior billing in the same transaction: a clean three-way match is approved for payment; anything else opens an exception.",
  },
  handler: (ctx, input) => submitInvoice(ctx, input),
});

export const reconcile = app.mutation({
  access: "invoices.reconcile",
  args: { id: s.string() },
  returns: Reconciliation,
  capability: { name: "invoices.reconcile", description: "Re-run matching for an invoice with an undecided exception (e.g. after goods were received). Clears the exception if it now matches." },
  handler: async (ctx, { id }) => {
    const invoice = await ctx.db.get(invoices, id);
    if (!invoice) fail("NOT_FOUND", `No invoice ${id}.`);
    if (invoice.status !== "exception") fail("CONFLICT", `Invoice ${invoice.invoiceNumber} is ${invoice.status}; only an invoice with an open exception can be re-matched.`);
    return { invoiceId: id, ...(await settle(ctx, invoice)) };
  },
});

/** Job "invoices.rematch-open": re-match every invoice whose exception is still undecided. */
export const rematchOpen = app.mutation({
  access: "invoices.reconcile",
  returns: s.object({ examined: s.integer(), cleared: s.integer() }),
  handler: async (ctx) => {
    const pending = await ctx.db.find(invoices, { status: "exception" });
    let cleared = 0;
    for (const invoice of pending) {
      const exception = invoice.exceptionId ? await ctx.db.get(exceptions, invoice.exceptionId) : null;
      if (exception && exception.decision) continue;
      if ((await settle(ctx, invoice)).status === "approved") cleared++;
    }
    return { examined: pending.length, cleared };
  },
});

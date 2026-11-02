import { fail, s } from "@feltdb/feltkit";
import { app, invoices } from "./app.js";
import { record } from "./_audit.js";
import { money } from "./_rules.js";

const PaymentResult = s.object({ invoiceId: s.string(), status: s.enum(["scheduled", "paid"]), scheduledFor: s.string(), reference: s.optional(s.string()) });

export const schedule = app.mutation({
  access: "payments.write",
  args: { invoiceId: s.string(), scheduledFor: s.optional(s.string({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })) },
  returns: PaymentResult,
  capability: { name: "payments.schedule", description: "Schedule payment of an approved invoice, on its due date unless another date is given." },
  handler: async (ctx, { invoiceId, scheduledFor }) => {
    const who = ctx.auth.requirePrincipal();
    const invoice = await ctx.db.get(invoices, invoiceId);
    if (!invoice) fail("NOT_FOUND", `No invoice ${invoiceId}.`);
    if (invoice.status !== "approved") fail("CONFLICT", `Invoice ${invoice.invoiceNumber} is ${invoice.status}; only an approved invoice can be scheduled for payment.`);
    const date = scheduledFor ?? invoice.dueDate;
    await ctx.db.patch(invoices, invoiceId, { status: "scheduled", payment: { scheduledFor: date, scheduledBy: who.id } });
    await record(ctx, "invoice", invoiceId, "payment.scheduled", { scheduledFor: date, amount: money(invoice.totalCents), dueDate: invoice.dueDate });
    await ctx.services.webhooks?.emit("payment.scheduled", { invoiceId, vendorId: invoice.vendorId, amountCents: invoice.totalCents, scheduledFor: date });
    return { invoiceId, status: "scheduled" as const, scheduledFor: date };
  },
});

export const recordPayment = app.mutation({
  access: "payments.write",
  args: { invoiceId: s.string(), reference: s.string({ minLength: 1, maxLength: 120 }) },
  returns: PaymentResult,
  capability: { name: "payments.record", description: "Record that a scheduled payment was made, with the bank or remittance reference." },
  handler: async (ctx, { invoiceId, reference }) => {
    const who = ctx.auth.requirePrincipal();
    const invoice = await ctx.db.get(invoices, invoiceId);
    if (!invoice) fail("NOT_FOUND", `No invoice ${invoiceId}.`);
    if (invoice.status !== "scheduled" || !invoice.payment) fail("CONFLICT", `Invoice ${invoice.invoiceNumber} is ${invoice.status}; only a scheduled payment can be recorded as paid.`);
    const payment = { ...invoice.payment, paidAt: Date.now(), reference: reference.trim(), recordedBy: who.id };
    await ctx.db.patch(invoices, invoiceId, { status: "paid", payment });
    await record(ctx, "invoice", invoiceId, "payment.recorded", { reference: payment.reference, amount: money(invoice.totalCents) });
    await ctx.services.webhooks?.emit("payment.recorded", { invoiceId, vendorId: invoice.vendorId, amountCents: invoice.totalCents, reference: payment.reference });
    return { invoiceId, status: "paid" as const, scheduledFor: payment.scheduledFor, reference: payment.reference };
  },
});

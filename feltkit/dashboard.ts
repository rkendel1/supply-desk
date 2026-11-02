import { s } from "@feltdb/feltkit";
import { app, events, exceptions, invoices, vendors } from "./app.js";

export const summary = app.query({
  access: "invoices.read",
  returns: s.object({
    invoices: s.record(s.integer()),
    outstandingCents: s.integer(),
    paidCents: s.integer(),
    openExceptions: s.integer(),
    awaitingDecision: s.integer(),
    openVarianceCents: s.integer(),
    vendors: s.array(s.object({ id: s.string(), name: s.string(), status: s.string(), invoices: s.integer(), openExceptions: s.integer(), outstandingCents: s.integer() })),
    recent: s.array(s.object({ id: s.string(), type: s.string(), actor: s.string(), actorType: s.string(), at: s.number(), invoiceId: s.optional(s.string()) }, { additionalProperties: true })),
  }),
  capability: { name: "dashboard.summary", description: "Accounts-payable at a glance: invoices by status, money outstanding and paid, exceptions open and awaiting decision, per-vendor activity, and the latest events." },
  handler: async (ctx) => {
    const [allInvoices, allExceptions, allVendors, recent] = await Promise.all([
      ctx.db.find(invoices),
      ctx.db.find(exceptions),
      ctx.db.find(vendors, {}, { orderBy: [{ field: "name", direction: "asc" }] }),
      ctx.db.find(events, {}, { orderBy: [{ field: "at", direction: "desc" }], limit: 12 }),
    ]);
    const byStatus: Record<string, number> = { received: 0, exception: 0, approved: 0, rejected: 0, scheduled: 0, paid: 0 };
    for (const i of allInvoices) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
    const outstanding = (i: { status: string }) => i.status === "approved" || i.status === "scheduled" || i.status === "exception";
    const open = allExceptions.filter((e) => e.status === "open" || e.status === "investigating" || e.status === "proposed");
    return {
      invoices: byStatus,
      outstandingCents: allInvoices.filter(outstanding).reduce((n, i) => n + i.totalCents, 0),
      paidCents: allInvoices.filter((i) => i.status === "paid").reduce((n, i) => n + i.totalCents, 0),
      openExceptions: open.length,
      awaitingDecision: open.filter((e) => e.status === "proposed").length,
      openVarianceCents: open.reduce((n, e) => n + e.varianceCents, 0),
      vendors: allVendors.map((v) => {
        const mine = allInvoices.filter((i) => i.vendorId === v.id);
        return { id: v.id, name: v.name, status: v.status, invoices: mine.length, openExceptions: open.filter((e) => e.vendorId === v.id).length, outstandingCents: mine.filter(outstanding).reduce((n, i) => n + i.totalCents, 0) };
      }),
      recent: recent.map((e) => ({ id: e.id, type: e.type, actor: e.actor, actorType: e.actorType, at: e.at, ...(e.invoiceId ? { invoiceId: e.invoiceId } : {}) })),
    };
  },
});

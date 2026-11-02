import { fail, s } from "@feltdb/feltkit";
import { app, purchaseOrders, vendors } from "./app.js";
import { record } from "./_audit.js";
import { PurchaseOrderView } from "./_views.js";
import { lineTotal, money } from "./_rules.js";

const PurchaseOrder = PurchaseOrderView;

export const list = app.query({
  access: "purchasing.read",
  args: { vendorId: s.optional(s.string()) },
  returns: s.array(PurchaseOrder),
  capability: { name: "purchasing.list", description: "List purchase orders, optionally for one vendor, with ordered and received quantities per line." },
  handler: (ctx, { vendorId }) => ctx.db.find(purchaseOrders, vendorId ? { vendorId } : {}, { orderBy: [{ field: "createdAt", direction: "desc" }] }),
});

export const get = app.query({
  access: "purchasing.read",
  args: { number: s.string() },
  returns: PurchaseOrder,
  capability: { name: "purchasing.get", description: "Read a purchase order by its number (e.g. PO-1001): what was authorized and what was received." },
  handler: async (ctx, { number }) => (await ctx.db.find(purchaseOrders, { number }))[0] ?? fail("NOT_FOUND", `No purchase order ${number}.`),
});

export const create = app.mutation({
  access: "purchasing.write",
  args: {
    number: s.string({ minLength: 1, maxLength: 40 }),
    vendorId: s.string(),
    lines: s.array(s.object({ sku: s.string({ minLength: 1, maxLength: 40 }), description: s.string({ minLength: 1, maxLength: 200 }), quantity: s.integer({ minimum: 1 }), unitPriceCents: s.integer({ minimum: 0 }) }), { minItems: 1, maxItems: 100 }),
    paymentTermsDays: s.optional(s.integer({ minimum: 0, maximum: 180 })),
    notes: s.optional(s.string({ maxLength: 2000 })),
  },
  returns: s.string(),
  capability: { name: "purchasing.create", description: "Issue a purchase order to a vendor. Payment terms default to the vendor's." },
  handler: async (ctx, { number, vendorId, lines, paymentTermsDays, notes }) => {
    const vendor = await ctx.db.get(vendors, vendorId);
    if (!vendor) fail("NOT_FOUND", `No vendor ${vendorId}.`);
    const trimmed = number.trim();
    if ((await ctx.db.find(purchaseOrders, { number: trimmed })).length) fail("CONFLICT", `Purchase order ${trimmed} already exists.`);
    const skus = new Set(lines.map((l) => l.sku));
    if (skus.size !== lines.length) fail("INVALID_ARGUMENT", "Each SKU may appear on a purchase order once.");
    const totalCents = lineTotal(lines);
    const id = await ctx.db.insert(purchaseOrders, {
      number: trimmed,
      vendorId,
      status: "open",
      lines: lines.map((l) => ({ ...l, receivedQuantity: 0 })),
      totalCents,
      paymentTermsDays: paymentTermsDays ?? vendor.paymentTermsDays,
      ...(notes?.trim() ? { notes: notes.trim() } : {}),
      createdAt: Date.now(),
      createdBy: ctx.auth.requirePrincipal().id,
    });
    await record(ctx, "purchaseOrder", id, "po.issued", { number: trimmed, vendor: vendor.name, total: money(totalCents) });
    return id;
  },
});

export const receive = app.mutation({
  access: "purchasing.write",
  args: { number: s.string(), receipts: s.array(s.object({ sku: s.string(), quantity: s.integer({ minimum: 1 }) }), { minItems: 1 }) },
  returns: PurchaseOrder,
  capability: { name: "purchasing.receive", description: "Record goods received against a purchase order. Quantities add to what was already received." },
  handler: async (ctx, { number, receipts }) => {
    const po = (await ctx.db.find(purchaseOrders, { number }))[0];
    if (!po) fail("NOT_FOUND", `No purchase order ${number}.`);
    if (po.status !== "open") fail("CONFLICT", `${number} is ${po.status}; receipts can only be recorded on an open purchase order.`);
    const lines = po.lines.map((l) => ({ ...l }));
    for (const r of receipts) {
      const line = lines.find((l) => l.sku === r.sku);
      if (!line) fail("INVALID_ARGUMENT", `${r.sku} is not on ${number}.`);
      if (line.receivedQuantity + r.quantity > line.quantity) fail("INVALID_ARGUMENT", `${r.sku}: receiving ${r.quantity} would exceed the ${line.quantity} ordered (${line.receivedQuantity} already received).`);
      line.receivedQuantity += r.quantity;
    }
    const updated = await ctx.db.patch(purchaseOrders, po.id, { lines });
    await record(ctx, "purchaseOrder", po.id, "po.received", { number, receipts });
    return updated;
  },
});

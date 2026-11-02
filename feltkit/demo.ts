import { fail, s } from "@feltdb/feltkit";
import { app, approvalAuthority, purchaseOrders, vendors } from "./app.js";
import { record } from "./_audit.js";
import { lineTotal } from "./_rules.js";
import { submitInvoice } from "./_invoicing.js";

/**
 * Load the demo company: three vendors, two purchase orders with receipts, delegated
 * authority for the controller and an approver, and one invoice that matches cleanly.
 * The exception scenario (Northwind's $12,400 invoice against a $10,000 PO) is left for you
 * to submit, so you can watch reconciliation happen. Runs only on an empty environment.
 */
export const seed = app.mutation({
  access: "demo.seed",
  returns: s.object({ vendors: s.integer(), purchaseOrders: s.integer(), invoices: s.integer() }),
  handler: async (ctx) => {
    const who = ctx.auth.requirePrincipal();
    if (await ctx.db.count(vendors, {})) fail("CONFLICT", "This environment already has data; demo data loads only into an empty one.");
    const now = Date.now();
    const day = 86_400_000;

    const vendor = async (name: string, paymentTermsDays: number, contactEmail: string, hold?: string) => {
      const id = await ctx.db.insert(vendors, { name, status: hold ? "on_hold" : "active", paymentTermsDays, contactEmail, ...(hold ? { holdReason: hold } : {}), createdAt: now, createdBy: who.id });
      await record(ctx, "vendor", id, "vendor.created", { name, paymentTermsDays, seeded: true });
      return id;
    };
    const northwind = await vendor("Northwind Industrial Supply", 30, "ar@northwind.example");
    const acme = await vendor("Acme Fasteners", 45, "billing@acme-fasteners.example");
    await vendor("Globex Logistics", 30, "accounts@globex.example", "Bank details changed by e-mail; awaiting verification call.");

    const po = async (number: string, vendorId: string, terms: number, lines: Array<{ sku: string; description: string; quantity: number; unitPriceCents: number; receivedQuantity: number }>, notes: string) => {
      const id = await ctx.db.insert(purchaseOrders, { number, vendorId, status: "open", lines, totalCents: lineTotal(lines), paymentTermsDays: terms, notes, createdAt: now - 20 * day, createdBy: who.id });
      await record(ctx, "purchaseOrder", id, "po.issued", { number, seeded: true });
      return id;
    };
    await po("PO-1001", northwind, 30, [{ sku: "PALLET-STD", description: "Standard 48x40 pallet racking unit", quantity: 100, unitPriceCents: 10_000, receivedQuantity: 100 }], "Warehouse B expansion. Delivery requested by the 15th; operations may ask for expedited freight.");
    await po("PO-1002", acme, 45, [
      { sku: "BOLT-M8", description: "M8 hex bolt, zinc, box of 100", quantity: 50, unitPriceCents: 4_200, receivedQuantity: 30 },
      { sku: "NUT-M8", description: "M8 hex nut, zinc, box of 100", quantity: 20, unitPriceCents: 1_800, receivedQuantity: 20 },
    ], "Quarterly fastener restock.");

    for (const [principalId, limitCents] of [["ada", 5_000_000], ["barbara", 100_000]] as const) {
      const id = await ctx.db.insert(approvalAuthority, { principalId, limitCents, grantedBy: who.id, grantedAt: now });
      await record(ctx, "authority", id, "authority.granted", { principalId, limitCents, seeded: true });
    }

    // A clean three-way match: billed what was ordered, at the agreed price, and received.
    const today = new Date(now).toISOString().slice(0, 10);
    await submitInvoice(ctx, {
      vendorId: acme,
      invoiceNumber: "AF-5520",
      poNumber: "PO-1002",
      lines: [
        { sku: "BOLT-M8", description: "M8 hex bolt, zinc, box of 100", quantity: 30, unitPriceCents: 4_200 },
        { sku: "NUT-M8", description: "M8 hex nut, zinc, box of 100", quantity: 20, unitPriceCents: 1_800 },
      ],
      totalCents: 30 * 4_200 + 20 * 1_800,
      invoiceDate: today,
    });
    return { vendors: 3, purchaseOrders: 2, invoices: 1 };
  },
});

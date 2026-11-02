import { fail, s } from "@feltdb/feltkit";
import { app, vendors } from "./app.js";
import { VendorView } from "./_views.js";
import { record } from "./_audit.js";

const Vendor = VendorView;

export const list = app.query({
  access: "vendors.read",
  returns: s.array(Vendor),
  capability: { name: "vendors.list", description: "List vendors with their status (active or on hold) and standard payment terms." },
  handler: (ctx) => ctx.db.find(vendors, {}, { orderBy: [{ field: "name", direction: "asc" }] }),
});

export const get = app.query({
  access: "vendors.read",
  args: { id: s.string() },
  returns: Vendor,
  capability: { name: "vendors.get", description: "Read one vendor." },
  handler: async (ctx, { id }) => (await ctx.db.get(vendors, id)) ?? fail("NOT_FOUND", `No vendor ${id}.`),
});

export const create = app.mutation({
  access: "vendors.write",
  args: { name: s.string({ minLength: 1, maxLength: 120 }), paymentTermsDays: s.integer({ minimum: 0, maximum: 180 }), contactEmail: s.optional(s.string({ maxLength: 200 })) },
  returns: s.string(),
  capability: { name: "vendors.create", description: "Add a vendor with its standard payment terms (net days)." },
  handler: async (ctx, { name, paymentTermsDays, contactEmail }) => {
    const trimmed = name.trim();
    if (!trimmed) fail("INVALID_ARGUMENT", "A vendor needs a name.");
    if ((await ctx.db.find(vendors, { name: trimmed })).length) fail("CONFLICT", `There is already a vendor called "${trimmed}".`);
    const id = await ctx.db.insert(vendors, { name: trimmed, status: "active", paymentTermsDays, ...(contactEmail?.trim() ? { contactEmail: contactEmail.trim() } : {}), createdAt: Date.now(), createdBy: ctx.auth.requirePrincipal().id });
    await record(ctx, "vendor", id, "vendor.created", { name: trimmed, paymentTermsDays });
    return id;
  },
});

export const setStatus = app.mutation({
  access: "vendors.write",
  args: { id: s.string(), status: s.enum(["active", "on_hold"]), reason: s.optional(s.string({ maxLength: 500 })) },
  returns: Vendor,
  capability: { name: "vendors.setstatus", description: "Put a vendor on hold (with a reason) or reactivate it. Invoices from a vendor on hold always raise an exception." },
  handler: async (ctx, { id, status, reason }) => {
    const vendor = await ctx.db.get(vendors, id);
    if (!vendor) fail("NOT_FOUND", `No vendor ${id}.`);
    if (status === "on_hold" && !reason?.trim()) fail("INVALID_ARGUMENT", "Putting a vendor on hold needs a reason.");
    const updated = await ctx.db.patch(vendors, id, { status, holdReason: status === "on_hold" ? reason!.trim() : undefined });
    await record(ctx, "vendor", id, status === "on_hold" ? "vendor.held" : "vendor.reactivated", { from: vendor.status, to: status, ...(reason ? { reason } : {}) });
    return updated;
  },
});

import { fail, s } from "@feltdb/feltkit";
import { app, approvalAuthority } from "./app.js";
import { record } from "./_audit.js";
import { money } from "./_rules.js";

const Authority = s.object({ principalId: s.string(), limitCents: s.integer(), grantedBy: s.string(), grantedAt: s.number() }, { additionalProperties: true });

export const list = app.query({
  access: "authority.read",
  returns: s.array(Authority),
  capability: { name: "authority.list", description: "Delegated approval authority: the largest exception variance each person may approve." },
  handler: (ctx) => ctx.db.find(approvalAuthority, {}, { orderBy: [{ field: "limitCents", direction: "desc" }] }),
});

export const grant = app.mutation({
  access: "authority.write",
  args: { principalId: s.string({ minLength: 1 }), limitCents: s.integer({ minimum: 0 }) },
  returns: Authority,
  capability: { name: "authority.grant", description: "Set a person's delegated approval limit (0 lets them reject but not approve variances). Nobody may set their own." },
  handler: async (ctx, { principalId, limitCents }) => {
    const who = ctx.auth.requirePrincipal();
    if (who.type !== "user") fail("FORBIDDEN", "Only a person may delegate approval authority.");
    if (principalId === who.id) fail("FORBIDDEN", "Nobody may change their own approval authority.");
    const existing = (await ctx.db.find(approvalAuthority, { principalId }))[0];
    const fields = { principalId, limitCents, grantedBy: who.id, grantedAt: Date.now() };
    const id = existing ? (await ctx.db.replace(approvalAuthority, existing.id, fields)).id : await ctx.db.insert(approvalAuthority, fields);
    await record(ctx, "authority", id, "authority.granted", { principalId, limit: money(limitCents), previous: existing ? money(existing.limitCents) : null });
    return { id, ...fields };
  },
});

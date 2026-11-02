import { s } from "@feltdb/feltkit";
import { app, events } from "./app.js";

const Event = s.object({
  id: s.string(),
  subjectType: s.string(),
  subjectId: s.string(),
  invoiceId: s.optional(s.string()),
  type: s.string(),
  actor: s.string(),
  actorType: s.string(),
  at: s.number(),
  requestId: s.string(),
  data: s.optional(s.record(s.unknown())),
}, { additionalProperties: true });

export const list = app.query({
  access: "audit.read",
  args: { invoiceId: s.optional(s.string()), subjectId: s.optional(s.string()), limit: s.optional(s.integer({ minimum: 1, maximum: 500 })) },
  returns: s.array(Event),
  capability: { name: "audit.list", description: "The business audit trail, newest first: every transition, who caused it (person or agent), and the AppPort request id that links it to FeltKit's activity record. Filter by invoice or subject." },
  handler: async (ctx, { invoiceId, subjectId, limit }) =>
    ctx.db.find(events, { ...(invoiceId ? { invoiceId } : {}), ...(subjectId ? { subjectId } : {}) }, { orderBy: [{ field: "at", direction: "desc" }], limit: limit ?? 100 }),
});

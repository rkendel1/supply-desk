/**
 * The business audit trail. Every state change records an event in the same transaction as
 * the change itself, so the trail cannot disagree with the state: both commit, or neither.
 * Each event carries the AppPort request id, which links it to FeltKit's activity log
 * (Studio → Activity): the capability invoked, the authorization decision, and the writes
 * FeltDB committed.
 *
 * Order: `seq` is a FeltDB sequence per invoice (or per subject, for events outside an invoice),
 * allocated in the writing transaction, so an invoice's history is ordered by the database, across
 * instances and restarts. `at` is wall-clock time, for display and the company-wide feed.
 */
import type { MutationCtx } from "@feltdb/feltkit";
import { events } from "./app.js";

type Subject = "vendor" | "purchaseOrder" | "invoice" | "exception" | "authority";

export async function record(ctx: MutationCtx, subjectType: Subject, subjectId: string, type: string, data?: Record<string, unknown>, invoiceId?: string) {
  const who = ctx.auth.requirePrincipal();
  await ctx.db.insert(events, {
    subjectType,
    subjectId,
    ...(invoiceId ? { invoiceId } : subjectType === "invoice" ? { invoiceId: subjectId } : {}),
    type,
    actor: who.id,
    actorType: who.type,
    at: Date.now(),
    seq: await ctx.db.sequence(`audit:${invoiceId ?? (subjectType === "invoice" ? subjectId : `${subjectType}:${subjectId}`)}`),
    requestId: ctx.requestId,
    ...(data ? { data } : {}),
  });
}

/** Read a numeric configuration value (AppPort Services Configuration), with a default. */
export async function configInt(ctx: Pick<MutationCtx, "services">, name: string, fallback: number): Promise<number> {
  const raw = await ctx.services.configuration.get(name);
  const n = raw === null || raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

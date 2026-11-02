import { fail, s } from "@feltdb/feltkit";
import { app, approvalAuthority, events, evidence, exceptions, invoices, purchaseOrders, vendors } from "./app.js";
import { record } from "./_audit.js";
import { money } from "./_rules.js";

const STATUS = ["open", "investigating", "proposed", "approved", "rejected", "cleared"] as const;
const CLOSED = new Set(["approved", "rejected", "cleared"]);

const ExceptionView = s.object({
  id: s.string(),
  invoiceId: s.string(),
  vendorId: s.string(),
  status: s.enum(STATUS),
  findings: s.array(s.object({ code: s.string(), message: s.string(), varianceCents: s.integer() }, { additionalProperties: true })),
  varianceCents: s.integer(),
  assignee: s.optional(s.string()),
}, { additionalProperties: true });
const Loose = s.object({}, { additionalProperties: true });

export const list = app.query({
  access: "exceptions.read",
  args: { status: s.optional(s.enum(STATUS)) },
  returns: s.array(ExceptionView),
  capability: { name: "exceptions.list", description: "List invoice exceptions, newest first, optionally by status (open, investigating, proposed, approved, rejected, cleared)." },
  handler: (ctx, { status }) => ctx.db.find(exceptions, status ? { status } : {}, { orderBy: [{ field: "openedAt", direction: "desc" }] }),
});

export const get = app.query({
  access: "exceptions.read",
  args: { id: s.string() },
  returns: s.object({
    exception: ExceptionView,
    invoice: Loose,
    vendor: Loose,
    purchaseOrder: s.nullable(Loose),
    evidence: s.array(Loose),
    history: s.array(Loose),
    vendorHistory: s.object({ invoices: s.integer(), exceptions: s.integer(), overridesApproved: s.integer(), rejected: s.integer() }),
  }),
  capability: { name: "exceptions.get", description: "Everything needed to investigate an exception: the findings, the invoice, its vendor and purchase order, gathered evidence, the vendor's track record, and the exception's history." },
  handler: async (ctx, { id }) => {
    const exception = await ctx.db.get(exceptions, id);
    if (!exception) fail("NOT_FOUND", `No exception ${id}.`);
    const [invoice, vendor, po, ev, history, vendorInvoices, vendorExceptions] = await Promise.all([
      ctx.db.get(invoices, exception.invoiceId),
      ctx.db.get(vendors, exception.vendorId),
      exception.poId ? ctx.db.get(purchaseOrders, exception.poId) : Promise.resolve(null),
      ctx.db.find(evidence, { exceptionId: id }, { orderBy: [{ field: "addedAt", direction: "asc" }] }),
      ctx.db.find(events, { invoiceId: exception.invoiceId }, { orderBy: [{ field: "at", direction: "asc" }] }),
      ctx.db.count(invoices, { vendorId: exception.vendorId }),
      ctx.db.find(exceptions, { vendorId: exception.vendorId }),
    ]);
    return {
      exception,
      invoice: invoice ?? {},
      vendor: vendor ?? {},
      purchaseOrder: po,
      evidence: ev,
      history,
      vendorHistory: {
        invoices: vendorInvoices,
        exceptions: vendorExceptions.length,
        overridesApproved: vendorExceptions.filter((e) => e.status === "approved").length,
        rejected: vendorExceptions.filter((e) => e.status === "rejected").length,
      },
    };
  },
});

export const investigate = app.mutation({
  access: "exceptions.investigate",
  args: { id: s.string() },
  returns: ExceptionView,
  capability: { name: "exceptions.investigate", description: "Take an open exception: it becomes yours to investigate (status investigating)." },
  handler: async (ctx, { id }) => {
    const who = ctx.auth.requirePrincipal();
    const exception = await ctx.db.get(exceptions, id);
    if (!exception) fail("NOT_FOUND", `No exception ${id}.`);
    if (exception.status !== "open" && exception.status !== "investigating") fail("CONFLICT", `The exception is ${exception.status}; only an open exception can be taken.`);
    const updated = await ctx.db.patch(exceptions, id, { status: "investigating", assignee: who.id });
    await record(ctx, "exception", id, "exception.investigating", { assignee: who.id, previousAssignee: exception.assignee ?? null }, exception.invoiceId);
    return updated;
  },
});

export const addEvidence = app.mutation({
  access: "evidence.write",
  args: {
    exceptionId: s.string(),
    kind: s.enum(["note", "document", "vendor_history", "po_snapshot", "communication"]),
    summary: s.string({ minLength: 1, maxLength: 1000 }),
    source: s.optional(s.string({ maxLength: 300 })),
    content: s.optional(s.string({ maxLength: 20000 })),
  },
  returns: s.object({ id: s.string(), fileId: s.nullable(s.string()) }),
  capability: { name: "evidence.add", description: "Attach evidence to an exception: a summary, where it came from, and optionally the full text (stored with AppPort Services Files)." },
  handler: async (ctx, { exceptionId, kind, summary, source, content }) => {
    const who = ctx.auth.requirePrincipal();
    const exception = await ctx.db.get(exceptions, exceptionId);
    if (!exception) fail("NOT_FOUND", `No exception ${exceptionId}.`);
    if (CLOSED.has(exception.status)) fail("CONFLICT", `The exception is ${exception.status}; evidence can only be added while it is undecided.`);
    const file = content?.trim()
      ? await ctx.services.files.upload({ name: `evidence-${kind}.txt`, contentType: "text/plain", content: content.trim(), metadata: { exceptionId, kind } })
      : null;
    const id = await ctx.db.insert(evidence, {
      exceptionId,
      kind,
      summary: summary.trim(),
      ...(source?.trim() ? { source: source.trim() } : {}),
      ...(file ? { fileId: file.id } : {}),
      addedBy: who.id,
      addedByType: who.type,
      addedAt: Date.now(),
    });
    await record(ctx, "exception", exceptionId, "evidence.added", { evidenceId: id, kind, summary: summary.trim(), ...(file ? { fileId: file.id } : {}) }, exception.invoiceId);
    return { id, fileId: file?.id ?? null };
  },
});

export const readEvidence = app.query({
  access: "exceptions.read",
  args: { id: s.string() },
  returns: s.object({ id: s.string(), summary: s.string(), text: s.nullable(s.string()) }),
  capability: { name: "evidence.read", description: "Read one piece of evidence, including its full text when it has one." },
  handler: async (ctx, { id }) => {
    const item = await ctx.db.get(evidence, id);
    if (!item) fail("NOT_FOUND", `No evidence ${id}.`);
    return { id, summary: item.summary, text: item.fileId ? (await ctx.services.files.read(item.fileId)).text() : null };
  },
});

export const propose = app.mutation({
  access: "exceptions.propose",
  args: {
    id: s.string(),
    resolution: s.enum(["override", "reject"]),
    rationale: s.string({ minLength: 10, maxLength: 4000 }),
    evidenceIds: s.optional(s.array(s.string())),
  },
  returns: ExceptionView,
  capability: {
    name: "exceptions.propose",
    description: "Propose how to resolve an exception: override (pay as billed) or reject. An override must cite evidence. A proposal decides nothing: an authorized person decides, and SupplyDesk checks their authority.",
  },
  handler: async (ctx, { id, resolution, rationale, evidenceIds = [] }) => {
    const who = ctx.auth.requirePrincipal();
    const exception = await ctx.db.get(exceptions, id);
    if (!exception) fail("NOT_FOUND", `No exception ${id}.`);
    if (exception.status !== "open" && exception.status !== "investigating" && exception.status !== "proposed") fail("CONFLICT", `The exception is ${exception.status}.`);
    const mine = new Set((await ctx.db.find(evidence, { exceptionId: id })).map((e) => e.id));
    const unknown = evidenceIds.filter((e) => !mine.has(e));
    if (unknown.length) fail("INVALID_ARGUMENT", `Not evidence on this exception: ${unknown.join(", ")}.`);
    if (resolution === "override" && !evidenceIds.length) fail("INVALID_ARGUMENT", "An override must cite at least one piece of evidence. Add it with evidence.add first.");
    const proposal = { resolution, rationale: rationale.trim(), evidenceIds, proposedBy: who.id, proposedByType: who.type, proposedAt: Date.now() };
    const updated = await ctx.db.patch(exceptions, id, { status: "proposed", proposal });
    await record(ctx, "exception", id, "exception.proposed", { resolution, rationale: proposal.rationale, evidenceIds, varianceCents: exception.varianceCents, replaces: exception.proposal ? exception.proposal.proposedBy : null }, exception.invoiceId);

    // Route to everyone whose delegated authority covers the variance.
    const invoice = await ctx.db.get(invoices, exception.invoiceId);
    const approvers = (await ctx.db.find(approvalAuthority, {})).filter((a) => a.limitCents >= exception.varianceCents && a.principalId !== who.id && a.principalId !== invoice?.submittedBy);
    for (const a of approvers) {
      await ctx.services.notifications.send({
        recipient: a.principalId,
        type: "exception.awaiting_decision",
        title: `Decision needed: ${resolution} ${invoice?.invoiceNumber ?? "invoice"} (${money(exception.varianceCents)} variance)`,
        data: { exceptionId: id, invoiceId: exception.invoiceId },
        priority: "high",
        idempotencyKey: `exception.awaiting:${id}:${proposal.proposedAt}:${a.principalId}`,
      });
    }
    await ctx.services.webhooks?.emit("exception.proposed", { exceptionId: id, resolution, proposedBy: who.id, varianceCents: exception.varianceCents });
    return updated;
  },
});

const DecisionResult = s.object({
  status: s.enum(["approved", "rejected", "refused"]),
  reason: s.optional(s.string()),
  exceptionId: s.string(),
  invoiceStatus: s.optional(s.string()),
});

/**
 * The decision. Holding `exceptions.decide` is necessary but not sufficient: SupplyDesk
 * itself decides whether this person may approve this variance. A refusal is not an error:
 * it is committed to the audit trail as evidence of the attempt, and nothing else changes.
 */
export const decide = app.mutation({
  access: "exceptions.decide",
  args: { id: s.string(), outcome: s.enum(["approve", "reject"]), note: s.string({ minLength: 3, maxLength: 2000 }) },
  returns: DecisionResult,
  capability: {
    name: "exceptions.decide",
    description: "Approve (pay as billed) or reject a proposed exception resolution. Only a person may decide; approving needs delegated authority at least the variance; the proposer and the invoice's submitter may not decide it.",
  },
  handler: async (ctx, { id, outcome, note }) => {
    const who = ctx.auth.requirePrincipal();
    const exception = await ctx.db.get(exceptions, id);
    if (!exception) fail("NOT_FOUND", `No exception ${id}.`);
    if (exception.status !== "proposed" || !exception.proposal) fail("CONFLICT", `The exception is ${exception.status}; only a proposed resolution can be decided.`);
    const invoice = await ctx.db.get(invoices, exception.invoiceId);
    if (!invoice) fail("NOT_FOUND", `No invoice ${exception.invoiceId}.`);
    const authority = (await ctx.db.find(approvalAuthority, { principalId: who.id }))[0];
    const limit = authority?.limitCents ?? 0;

    const refusal =
      who.type !== "user" ? `Only a person may decide an exception; ${who.id} is ${who.type === "agent" ? "an agent" : `a ${who.type}`}.`
      : who.id === exception.proposal.proposedBy ? "The person who proposed a resolution may not decide it."
      : who.id === invoice.submittedBy ? "The person who submitted the invoice may not decide its exception."
      : !authority ? `${who.id} has no delegated approval authority.`
      : outcome === "approve" && exception.varianceCents > limit ? `Approving a ${money(exception.varianceCents)} variance exceeds ${who.id}'s authority of ${money(limit)}.`
      : null;
    if (refusal) {
      await record(ctx, "exception", id, "decision.refused", { attempted: outcome, reason: refusal, varianceCents: exception.varianceCents, authorityLimitCents: limit }, invoice.id);
      return { status: "refused" as const, reason: refusal, exceptionId: id };
    }

    const now = Date.now();
    const approved = outcome === "approve";
    await ctx.db.patch(exceptions, id, {
      status: approved ? "approved" : "rejected",
      decision: { outcome: approved ? "approved" : "rejected", note: note.trim(), decidedBy: who.id, decidedAt: now, authorityLimitCents: limit, varianceCents: exception.varianceCents },
      closedAt: now,
    });
    await ctx.db.patch(invoices, invoice.id, approved ? { status: "approved", approvedBy: who.id, approvalBasis: "override" } : { status: "rejected" });
    await record(ctx, "exception", id, approved ? "exception.approved" : "exception.rejected", {
      note: note.trim(),
      proposal: exception.proposal.resolution,
      proposedBy: exception.proposal.proposedBy,
      followedProposal: (approved ? "override" : "reject") === exception.proposal.resolution,
      varianceCents: exception.varianceCents,
      authorityLimitCents: limit,
    }, invoice.id);
    await record(ctx, "invoice", invoice.id, approved ? "invoice.approved" : "invoice.rejected", approved ? { basis: "override", by: who.id, exceptionId: id } : { by: who.id, exceptionId: id });

    if (exception.proposal.proposedBy !== who.id) {
      await ctx.services.notifications.send({ recipient: exception.proposal.proposedBy, type: "exception.decided", title: `${who.id} ${approved ? "approved" : "rejected"} ${invoice.invoiceNumber}`, data: { exceptionId: id, invoiceId: invoice.id }, idempotencyKey: `exception.decided:${id}` });
    }
    await ctx.services.webhooks?.emit("exception.decided", { exceptionId: id, invoiceId: invoice.id, outcome: approved ? "approved" : "rejected", decidedBy: who.id });
    await ctx.services.webhooks?.emit(approved ? "invoice.approved" : "invoice.rejected", { invoiceId: invoice.id, basis: approved ? "override" : undefined, totalCents: invoice.totalCents });
    return { status: approved ? ("approved" as const) : ("rejected" as const), exceptionId: id, invoiceStatus: approved ? "approved" : "rejected" };
  },
});

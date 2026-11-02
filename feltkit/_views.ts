/**
 * Output schemas: the published AppPort contract for what SupplyDesk's capabilities return.
 * They list every field a client may rely on; records may carry more (e.g. __version).
 */
import { s } from "@feltdb/feltkit";

const open = { additionalProperties: true } as const;
const Line = s.object({ sku: s.string(), description: s.string(), quantity: s.integer(), unitPriceCents: s.integer() });
const Finding = s.object({ code: s.string(), message: s.string(), sku: s.optional(s.string()), expected: s.optional(s.number()), actual: s.optional(s.number()), varianceCents: s.integer() });

export const VendorView = s.object({
  id: s.string(),
  name: s.string(),
  status: s.enum(["active", "on_hold"]),
  paymentTermsDays: s.integer(),
  contactEmail: s.optional(s.string()),
  holdReason: s.optional(s.string()),
  createdAt: s.number(),
  createdBy: s.string(),
}, open);

export const PurchaseOrderView = s.object({
  id: s.string(),
  number: s.string(),
  vendorId: s.string(),
  status: s.enum(["open", "closed", "cancelled"]),
  lines: s.array(s.object({ sku: s.string(), description: s.string(), quantity: s.integer(), unitPriceCents: s.integer(), receivedQuantity: s.integer() })),
  totalCents: s.integer(),
  paymentTermsDays: s.integer(),
  notes: s.optional(s.string()),
  createdAt: s.number(),
  createdBy: s.string(),
}, open);

export const InvoiceView = s.object({
  id: s.string(),
  vendorId: s.string(),
  invoiceNumber: s.string(),
  poNumber: s.optional(s.string()),
  poId: s.optional(s.string()),
  lines: s.array(Line),
  totalCents: s.integer(),
  paymentTermsDays: s.integer(),
  invoiceDate: s.string(),
  dueDate: s.string(),
  status: s.enum(["received", "exception", "approved", "rejected", "scheduled", "paid"]),
  approvedBy: s.optional(s.string()),
  approvalBasis: s.optional(s.enum(["three_way_match", "override"])),
  exceptionId: s.optional(s.string()),
  payment: s.optional(s.object({ scheduledFor: s.string(), scheduledBy: s.string(), paidAt: s.optional(s.number()), reference: s.optional(s.string()), recordedBy: s.optional(s.string()) })),
  submittedAt: s.number(),
  submittedBy: s.string(),
}, open);

export const ExceptionView = s.object({
  id: s.string(),
  invoiceId: s.string(),
  vendorId: s.string(),
  poId: s.optional(s.string()),
  status: s.enum(["open", "investigating", "proposed", "approved", "rejected", "cleared"]),
  findings: s.array(Finding),
  varianceCents: s.integer(),
  assignee: s.optional(s.string()),
  proposal: s.optional(s.object({ resolution: s.enum(["override", "reject"]), rationale: s.string(), evidenceIds: s.array(s.string()), proposedBy: s.string(), proposedByType: s.string(), proposedAt: s.number() })),
  decision: s.optional(s.object({ outcome: s.enum(["approved", "rejected"]), note: s.string(), decidedBy: s.string(), decidedAt: s.number(), authorityLimitCents: s.integer(), varianceCents: s.integer() })),
  openedAt: s.number(),
  closedAt: s.optional(s.number()),
}, open);

export const EvidenceView = s.object({
  id: s.string(),
  exceptionId: s.string(),
  kind: s.string(),
  summary: s.string(),
  source: s.optional(s.string()),
  fileId: s.optional(s.string()),
  addedBy: s.string(),
  addedByType: s.string(),
  addedAt: s.number(),
}, open);

export const EventView = s.object({
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
}, open);

export const ReconciliationView = s.object({
  invoiceId: s.string(),
  status: s.enum(["approved", "exception"]),
  findings: s.array(Finding),
  varianceCents: s.integer(),
  exceptionId: s.nullable(s.string()),
});

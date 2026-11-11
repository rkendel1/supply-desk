/**
 * SupplyDesk: vendor operations and accounts payable on FeltKit.
 *
 * The application owns the business rules and the authoritative state. People and agents
 * operate it through the same AppPort capabilities; roles decide what each may do, and the
 * application decides — on every call — whether an approval is within the caller's authority.
 *
 * Everything lives in one FeltDB instance per environment. Money is stored in integer cents.
 */
import { feltkit, s } from "@feltdb/feltkit";

const READ = ["vendors.read", "purchasing.read", "invoices.read", "exceptions.read", "payments.read", "audit.read", "authority.read", "configuration.read"];
const SERVICES_USER = ["files.read", "files.write", "notifications.*", "webhooks.emit", "webhooks.deliver"];

export const app = feltkit({
  name: "supply-desk",
  version: "0.1.0",
  description: "Vendor operations and accounts payable: purchase orders, three-way matching, exceptions, delegated approval, and payment tracking.",
  roles: {
    // Accounts-payable clerks keep vendor and purchasing records, submit invoices, and work
    // exceptions up to a proposal. They cannot decide one or release a payment.
    ap_clerk: [...READ, ...SERVICES_USER, "vendors.write", "purchasing.write", "invoices.submit", "invoices.reconcile", "exceptions.investigate", "exceptions.propose", "evidence.write", "feltkit.agent.*"],
    // Approvers decide exceptions, within the authority the application records for them.
    approver: [...READ, ...SERVICES_USER, "exceptions.decide", "evidence.write", "feltkit.agent.*"],
    // Controllers do everything in the process: decide, pay, delegate authority, load demo data.
    controller: [...READ, ...SERVICES_USER, "vendors.write", "purchasing.write", "invoices.submit", "invoices.reconcile", "exceptions.investigate", "exceptions.propose", "exceptions.decide", "evidence.write", "payments.write", "authority.write", "demo.seed", "feltkit.agent.*"],
    // The AP agent may receive invoices, investigate, gather evidence and propose. It holds
    // no decide, payment or authority permission, and the application refuses decisions from
    // any non-person principal regardless of role.
    agent: [...READ, "invoices.submit", "invoices.reconcile", "exceptions.investigate", "exceptions.propose", "evidence.write", "files.read", "files.write", "notifications.read", "notifications.send", "webhooks.emit", "webhooks.deliver", "feltkit.agent.*"],
    // Auditors read everything, including the audit trail.
    auditor: [...READ, "files.read", "notifications.read", "feltkit.agent.read"],
    // Platform administration in Studio → Services (not part of the AP process).
    admin: ["intelligence.*", "credential.*", "configuration.*", "apikeys.*", "webhooks.*", "jobs.*", "schedules.*", "feltkit.operations.*"],
  },
  // New self-service accounts can read; a controller's operator assigns real roles.
  auth: { accounts: { roles: ["auditor"] } },
  dev: {
    users: [
      { id: "ada", name: "Ada Lovelace (Controller)", roles: ["controller", "admin"] },
      { id: "barbara", name: "Barbara Liskov (Approver)", roles: ["approver"] },
      { id: "grace", name: "Grace Hopper (AP clerk)", roles: ["ap_clerk"] },
      { id: "katherine", name: "Katherine Johnson (Auditor)", roles: ["auditor"] },
      { id: "ap-agent", name: "AP Agent", roles: ["agent"], type: "agent" },
    ],
  },
  services: {
    files: true,
    notifications: { types: ["exception.awaiting_decision", "exception.decided"] },
    // PRICE_TOLERANCE_BPS / AMOUNT_TOLERANCE_BPS: matching tolerances in basis points (default 0).
    configuration: true,
    apiKeys: { roles: ["agent"] },
    // Downstream systems (ERP, bank, vendor portal) subscribe to these in Studio → Services → Webhooks.
    webhooks: { events: ["invoice.received", "invoice.approved", "invoice.rejected", "exception.opened", "exception.proposed", "exception.decided", "payment.scheduled", "payment.recorded"] },
    jobs: { handlers: { "invoices.rematch-open": "invoices:rematchOpen" } },
    schedules: true,
    intelligence: true,
  },
});

const Line = s.object({
  sku: s.string({ minLength: 1, maxLength: 40 }),
  description: s.string({ minLength: 1, maxLength: 200 }),
  quantity: s.integer({ minimum: 0 }),
  unitPriceCents: s.integer({ minimum: 0 }),
});

export const vendors = app.collection("vendors", {
  name: s.string({ minLength: 1, maxLength: 120 }),
  status: s.enum(["active", "on_hold"]),
  paymentTermsDays: s.integer({ minimum: 0, maximum: 180 }),
  contactEmail: s.optional(s.string({ maxLength: 200 })),
  holdReason: s.optional(s.string({ maxLength: 500 })),
  createdAt: s.number(),
  createdBy: s.string(),
}, { description: "Suppliers and their standard payment terms." });

export const purchaseOrders = app.collection("purchaseOrders", {
  number: s.string({ minLength: 1, maxLength: 40 }),
  vendorId: s.string(),
  status: s.enum(["open", "closed", "cancelled"]),
  lines: s.array(s.object({
    sku: s.string(),
    description: s.string(),
    quantity: s.integer({ minimum: 0 }),
    unitPriceCents: s.integer({ minimum: 0 }),
    receivedQuantity: s.integer({ minimum: 0 }),
  })),
  totalCents: s.integer({ minimum: 0 }),
  paymentTermsDays: s.integer({ minimum: 0 }),
  notes: s.optional(s.string({ maxLength: 2000 })),
  createdAt: s.number(),
  createdBy: s.string(),
}, { description: "What the company authorized buying, and what has been received." });

export const invoices = app.collection("invoices", {
  vendorId: s.string(),
  invoiceNumber: s.string({ minLength: 1, maxLength: 60 }),
  poNumber: s.optional(s.string()),
  poId: s.optional(s.string()),
  lines: s.array(Line),
  totalCents: s.integer({ minimum: 0 }),
  paymentTermsDays: s.integer({ minimum: 0 }),
  invoiceDate: s.string(),
  dueDate: s.string(),
  status: s.enum(["received", "exception", "approved", "rejected", "scheduled", "paid"]),
  approvedBy: s.optional(s.string()),
  approvalBasis: s.optional(s.enum(["three_way_match", "override"])),
  exceptionId: s.optional(s.string()),
  payment: s.optional(s.object({
    scheduledFor: s.string(),
    scheduledBy: s.string(),
    paidAt: s.optional(s.number()),
    reference: s.optional(s.string()),
    recordedBy: s.optional(s.string()),
  })),
  submittedAt: s.number(),
  submittedBy: s.string(),
}, { description: "Vendor invoices and where each is in the process." });

export const Finding = s.object({
  code: s.enum(["vendor_on_hold", "po_not_found", "po_vendor_mismatch", "po_not_open", "duplicate_invoice", "line_not_on_po", "price_variance", "quantity_over_ordered", "quantity_not_received", "amount_over_po", "terms_mismatch", "total_mismatch"]),
  message: s.string(),
  sku: s.optional(s.string()),
  expected: s.optional(s.number()),
  actual: s.optional(s.number()),
  varianceCents: s.integer(),
});

export const exceptions = app.collection("exceptions", {
  invoiceId: s.string(),
  vendorId: s.string(),
  poId: s.optional(s.string()),
  status: s.enum(["open", "investigating", "proposed", "approved", "rejected", "cleared"]),
  findings: s.array(Finding),
  varianceCents: s.integer({ minimum: 0 }),
  assignee: s.optional(s.string()),
  proposal: s.optional(s.object({
    resolution: s.enum(["override", "reject"]),
    rationale: s.string(),
    evidenceIds: s.array(s.string()),
    proposedBy: s.string(),
    proposedByType: s.string(),
    proposedAt: s.number(),
  })),
  decision: s.optional(s.object({
    outcome: s.enum(["approved", "rejected"]),
    note: s.string(),
    decidedBy: s.string(),
    decidedAt: s.number(),
    authorityLimitCents: s.integer(),
    varianceCents: s.integer(),
  })),
  openedAt: s.number(),
  closedAt: s.optional(s.number()),
}, { description: "Discrepancies between an invoice and what was authorized, and how each was resolved." });

export const evidence = app.collection("evidence", {
  exceptionId: s.string(),
  kind: s.enum(["note", "document", "vendor_history", "po_snapshot", "communication"]),
  summary: s.string({ minLength: 1, maxLength: 1000 }),
  source: s.optional(s.string({ maxLength: 300 })),
  fileId: s.optional(s.string()),
  addedBy: s.string(),
  addedByType: s.string(),
  addedAt: s.number(),
}, { description: "What was gathered to support a resolution, by whom." });

export const approvalAuthority = app.collection("approvalAuthority", {
  principalId: s.string(),
  limitCents: s.integer({ minimum: 0 }),
  grantedBy: s.string(),
  grantedAt: s.number(),
}, { description: "Delegated authority: the largest variance each person may approve." });

export const events = app.collection("events", {
  subjectType: s.enum(["vendor", "purchaseOrder", "invoice", "exception", "authority"]),
  subjectId: s.string(),
  invoiceId: s.optional(s.string()),
  type: s.string(),
  actor: s.string(),
  actorType: s.string(),
  at: s.number(),
  /** Order within the invoice (or subject): a FeltDB sequence. Absent on events recorded before it existed. */
  seq: s.optional(s.integer({ minimum: 1 })),
  requestId: s.string(),
  data: s.optional(s.record(s.unknown())),
}, { description: "Append-only business audit trail; each event names the AppPort request that caused it.", indexes: [{ fields: ["invoiceId", "seq"] }] });

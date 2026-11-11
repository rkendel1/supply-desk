/**
 * Output schemas: the published AppPort contract for what SupplyDesk's capabilities return.
 * Stored records are derived from their collections (s.doc), so the contract can't drift from the
 * schema; only computed results are stated here.
 */
import { s } from "@feltdb/feltkit";
import { vendors, purchaseOrders, invoices, exceptions, evidence, events } from "./app.js";

const Finding = s.object({ code: s.string(), message: s.string(), sku: s.optional(s.string()), expected: s.optional(s.number()), actual: s.optional(s.number()), varianceCents: s.integer() });

// A stored record, stated once in feltkit/app.ts (s.doc: its declared fields plus id and __version).
export const VendorView = s.doc(vendors);
export const PurchaseOrderView = s.doc(purchaseOrders);
export const InvoiceView = s.doc(invoices);
export const ExceptionView = s.doc(exceptions);
export const EvidenceView = s.doc(evidence);
export const EventView = s.doc(events);

export const ReconciliationView = s.object({
  invoiceId: s.string(),
  status: s.enum(["approved", "exception"]),
  findings: s.array(Finding),
  varianceCents: s.integer(),
  exceptionId: s.nullable(s.string()),
});

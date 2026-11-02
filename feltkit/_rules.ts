/**
 * Invoice reconciliation: deterministic business rules, no I/O.
 *
 * Given an invoice and what the company authorized (the purchase order), what it has
 * received, and what it has already been billed, return every discrepancy and the amount
 * that payment would exceed what is authorized. The same inputs always give the same answer;
 * no model is involved. Files starting with "_" are helpers, not FeltKit function modules.
 */

export interface LineInput {
  sku: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
}

export interface PoLine extends LineInput {
  receivedQuantity: number;
}

export type FindingCode =
  | "vendor_on_hold"
  | "po_not_found"
  | "po_vendor_mismatch"
  | "po_not_open"
  | "duplicate_invoice"
  | "line_not_on_po"
  | "price_variance"
  | "quantity_over_ordered"
  | "quantity_not_received"
  | "amount_over_po"
  | "terms_mismatch"
  | "total_mismatch";

export interface Finding {
  code: FindingCode;
  message: string;
  sku?: string;
  expected?: number;
  actual?: number;
  varianceCents: number;
}

export interface ReconcileInput {
  invoice: { vendorId: string; lines: LineInput[]; totalCents: number; paymentTermsDays: number };
  vendor: { status: "active" | "on_hold"; name: string; holdReason?: string };
  /** null when the invoice cites no PO or the PO number does not exist. */
  po: { id: string; number: string; vendorId: string; status: string; lines: PoLine[]; totalCents: number; paymentTermsDays: number } | null;
  poNumber?: string;
  /** Other invoices already billed against the same PO (not rejected). */
  priorOnPo: Array<{ lines: LineInput[]; totalCents: number }>;
  /** Other invoices from the same vendor with the same invoice number (not rejected). */
  duplicates: number;
  /** Tolerances in basis points (100 bps = 1%). */
  tolerance: { priceBps: number; amountBps: number };
}

export interface ReconcileResult {
  findings: Finding[];
  /** What payment would exceed what the PO and receipts authorize. 0 when clean. */
  varianceCents: number;
  /** The part of the invoice the PO and receipts do authorize. */
  authorizedCents: number;
}

/** "$12,400.00". Formatted by hand: the AppBoundry guest engine has no Intl, so toLocaleString differs there. */
export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}
const withTolerance = (cents: number, bps: number) => Math.floor((cents * (10_000 + bps)) / 10_000);

export function lineTotal(lines: LineInput[]): number {
  return lines.reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0);
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const { invoice, vendor, po, priorOnPo, duplicates, tolerance } = input;
  const findings: Finding[] = [];
  const total = invoice.totalCents;

  if (vendor.status === "on_hold") {
    findings.push({ code: "vendor_on_hold", message: `${vendor.name} is on hold${vendor.holdReason ? `: ${vendor.holdReason}` : ""}.`, varianceCents: total });
  }
  if (duplicates > 0) {
    findings.push({ code: "duplicate_invoice", message: `The vendor already submitted ${duplicates === 1 ? "an invoice" : `${duplicates} invoices`} with this number.`, varianceCents: total });
  }
  const linesSum = lineTotal(invoice.lines);
  if (linesSum !== total) {
    findings.push({ code: "total_mismatch", message: `Lines add up to ${money(linesSum)}, but the invoice total is ${money(total)}.`, expected: linesSum, actual: total, varianceCents: Math.max(0, total - linesSum) });
  }

  if (!po) {
    findings.push({ code: "po_not_found", message: input.poNumber ? `No purchase order ${input.poNumber}.` : "The invoice cites no purchase order.", varianceCents: total });
    return finish(findings, total, 0, vendor.status === "on_hold" || duplicates > 0);
  }
  if (po.vendorId !== invoice.vendorId) {
    findings.push({ code: "po_vendor_mismatch", message: `${po.number} was issued to a different vendor.`, varianceCents: total });
    return finish(findings, total, 0, true);
  }
  if (po.status !== "open") {
    findings.push({ code: "po_not_open", message: `${po.number} is ${po.status}.`, varianceCents: total });
  }

  // Quantities already billed per SKU on this PO.
  const billed = new Map<string, number>();
  for (const prior of priorOnPo) for (const l of prior.lines) billed.set(l.sku, (billed.get(l.sku) ?? 0) + l.quantity);

  let authorized = 0;
  for (const line of invoice.lines) {
    const poLine = po.lines.find((p) => p.sku === line.sku);
    const value = line.quantity * line.unitPriceCents;
    if (!poLine) {
      findings.push({ code: "line_not_on_po", message: `${line.sku} (${line.description}, ${money(value)}) is not on ${po.number}.`, sku: line.sku, actual: value, varianceCents: value });
      continue;
    }
    const maxPrice = withTolerance(poLine.unitPriceCents, tolerance.priceBps);
    if (line.unitPriceCents > maxPrice) {
      const over = (line.unitPriceCents - poLine.unitPriceCents) * line.quantity;
      findings.push({ code: "price_variance", message: `${line.sku} billed at ${money(line.unitPriceCents)} per unit; ${po.number} authorizes ${money(poLine.unitPriceCents)}.`, sku: line.sku, expected: poLine.unitPriceCents, actual: line.unitPriceCents, varianceCents: over });
    }
    const already = billed.get(line.sku) ?? 0;
    const cumulative = already + line.quantity;
    if (cumulative > poLine.quantity) {
      findings.push({ code: "quantity_over_ordered", message: `${line.sku}: ${cumulative} billed in total against ${poLine.quantity} ordered.`, sku: line.sku, expected: poLine.quantity, actual: cumulative, varianceCents: (cumulative - poLine.quantity) * Math.min(line.unitPriceCents, poLine.unitPriceCents) });
    } else if (cumulative > poLine.receivedQuantity) {
      findings.push({ code: "quantity_not_received", message: `${line.sku}: ${cumulative} billed in total, ${poLine.receivedQuantity} received.`, sku: line.sku, expected: poLine.receivedQuantity, actual: cumulative, varianceCents: (cumulative - poLine.receivedQuantity) * Math.min(line.unitPriceCents, poLine.unitPriceCents) });
    }
    const payableQty = Math.max(0, Math.min(line.quantity, Math.min(poLine.quantity, poLine.receivedQuantity) - already));
    authorized += payableQty * Math.min(line.unitPriceCents, maxPrice);
  }

  const priorTotal = priorOnPo.reduce((sum, p) => sum + p.totalCents, 0);
  const ceiling = withTolerance(po.totalCents, tolerance.amountBps);
  if (priorTotal + total > ceiling) {
    findings.push({ code: "amount_over_po", message: `Billed against ${po.number}: ${money(priorTotal + total)}; it authorizes ${money(po.totalCents)}.`, expected: po.totalCents, actual: priorTotal + total, varianceCents: priorTotal + total - po.totalCents });
  }
  if (invoice.paymentTermsDays < po.paymentTermsDays) {
    findings.push({ code: "terms_mismatch", message: `Invoice asks for net ${invoice.paymentTermsDays}; ${po.number} agreed net ${po.paymentTermsDays}.`, expected: po.paymentTermsDays, actual: invoice.paymentTermsDays, varianceCents: 0 });
  }

  // Nothing is authorized when the vendor is on hold, the PO is not open, or it is a duplicate.
  const blocked = vendor.status === "on_hold" || duplicates > 0 || po.status !== "open";
  return finish(findings, total, Math.min(authorized, ceiling - priorTotal), blocked);
}

function finish(findings: Finding[], total: number, authorized: number, blocked: boolean): ReconcileResult {
  const authorizedCents = blocked ? 0 : Math.max(0, Math.min(total, authorized));
  return { findings, varianceCents: findings.length ? total - authorizedCents : 0, authorizedCents };
}

/** Add `days` to an ISO date (YYYY-MM-DD). */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

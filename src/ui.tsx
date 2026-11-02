/** Small shared pieces: formatting, status badges, permissions, navigation. */
import { createContext, useContext, type ReactNode } from "react";

export const money = (cents: number | undefined | null) =>
  cents === undefined || cents === null ? "—" : (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

export const when = (ms: number) => {
  const d = new Date(ms);
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

/** Same matching rule as AppPort: exact, "ns.*", or "*". A UI hint only: the server decides. */
export function can(granted: readonly string[], permission: string): boolean {
  return granted.some((g) => g === "*" || g === permission || (g.endsWith(".*") && permission.startsWith(g.slice(0, -1))));
}

const TONE: Record<string, string> = {
  approved: "good",
  paid: "good",
  cleared: "good",
  active: "good",
  scheduled: "info",
  received: "info",
  investigating: "info",
  proposed: "warn",
  open: "warn",
  exception: "warn",
  on_hold: "bad",
  rejected: "bad",
  refused: "bad",
  closed: "muted",
  cancelled: "muted",
};
export function Badge({ status, label }: { status: string; label?: string }) {
  return <span className={`badge ${TONE[status] ?? "muted"} ${label ? "" : "cap"}`}>{label ?? status.replace(/_/g, " ")}</span>;
}

export function Actor({ id, type }: { id: string; type?: string }) {
  return (
    <span className={`actor ${type === "agent" ? "agent" : ""}`} title={type ? `${type}: ${id}` : id}>
      {type === "agent" ? "◆ " : ""}
      {id}
    </span>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className ?? ""}`}>
      {(title || actions) && (
        <header className="panel-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty-row muted">{children}</div>;
}

export function Loading() {
  return <div className="empty-row muted">Loading…</div>;
}

/** Hash routes: #/invoices/abc → ["invoices", "abc"]. */
export const go = (path: string) => {
  window.location.hash = `#/${path}`;
};

export interface AppContext {
  principal: { id: string; type: string; roles: string[] };
  permissions: string[];
  report: (error: unknown) => void;
  info: (text: string) => void;
}
export const Ctx = createContext<AppContext | null>(null);
export const useApp = () => useContext(Ctx)!;

/** Run an action, reporting a failure instead of throwing. Returns the result or undefined. */
export async function attempt<T>(app: AppContext, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    app.report(error);
    return undefined;
  }
}

export const EVENT_LABEL: Record<string, string> = {
  "vendor.created": "Vendor added",
  "vendor.held": "Vendor put on hold",
  "vendor.reactivated": "Vendor reactivated",
  "po.issued": "Purchase order issued",
  "po.received": "Goods received",
  "invoice.received": "Invoice received",
  "invoice.reconciled": "Reconciled against PO and receipts",
  "invoice.approved": "Invoice approved for payment",
  "invoice.rejected": "Invoice rejected",
  "exception.opened": "Exception opened",
  "exception.investigating": "Investigation started",
  "exception.rematched": "Re-matched",
  "exception.cleared": "Exception cleared by re-match",
  "evidence.added": "Evidence added",
  "exception.proposed": "Resolution proposed",
  "decision.refused": "Decision refused",
  "exception.approved": "Override approved",
  "exception.rejected": "Exception rejected",
  "payment.scheduled": "Payment scheduled",
  "payment.recorded": "Payment recorded",
  "authority.granted": "Approval authority set",
};

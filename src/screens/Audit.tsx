import { useState } from "react";
import { useQuery } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { Actor, Card, Empty, EVENT_LABEL, Loading, money } from "../ui";

type Event = { id: string; type: string; actor: string; actorType: string; at: number; requestId: string; subjectType?: string; invoiceId?: string; data?: Record<string, unknown> };

export function Audit() {
  const [limit, setLimit] = useState(100);
  const events = useQuery(api.audit.list, { limit });
  if (!events) return <Loading />;
  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>Audit trail</h1>
          <p className="muted">
            Every business transition, written in the same transaction as the change it describes. Each names who caused it — person or <span className="actor agent">◆ agent</span> — and the AppPort request id, which finds the capability call, its authorization decision, and FeltDB's committed writes in Studio → Activity.
          </p>
        </div>
      </div>
      <Card title={`Newest first (${events.length})`}>
        <Timeline events={events} newestFirst />
        {events.length === limit && (
          <button className="secondary" onClick={() => setLimit((l) => Math.min(500, l + 100))}>
            Show more
          </button>
        )}
      </Card>
    </div>
  );
}

/** Data fields worth showing inline, formatted. */
function details(e: Event): string[] {
  const d = e.data ?? {};
  const out: string[] = [];
  const cents = (k: string) => (typeof d[k] === "number" ? money(d[k] as number) : null);
  if (Array.isArray(d.findings)) out.push(`findings: ${(d.findings as Array<string | { code: string }>).map((f) => (typeof f === "string" ? f : f.code)).join(", ") || "none"}`);
  if (cents("varianceCents")) out.push(`variance ${cents("varianceCents")}`);
  if (cents("authorityLimitCents") && e.type !== "exception.opened") out.push(`authority ${cents("authorityLimitCents")}`);
  for (const k of ["total", "amount", "resolution", "basis", "reason", "note", "reference", "scheduledFor", "kind", "summary", "limit", "principalId", "number", "assignee"]) {
    if (d[k] !== undefined && d[k] !== null && typeof d[k] !== "object") out.push(`${k}: ${String(d[k])}`);
  }
  if (d.followedProposal === false) out.push("decided against the proposal");
  return out;
}

export function Timeline({ events, newestFirst }: { events: Event[]; newestFirst?: boolean }) {
  if (!events.length) return <Empty>No events yet.</Empty>;
  return (
    <ol className={`timeline ${newestFirst ? "desc" : ""}`}>
      {events.map((e) => (
        <li key={e.id} className={`t-${e.type.replace(/\./g, "-")}`}>
          <div className="t-head">
            <strong>{EVENT_LABEL[e.type] ?? e.type}</strong>
            {e.invoiceId && newestFirst && (
              <a className="small" href={`#/invoices/${e.invoiceId}`}>
                invoice →
              </a>
            )}
          </div>
          <div className="small muted">
            <Actor id={e.actor} type={e.actorType} /> · {new Date(e.at).toLocaleString()} · <code title="AppPort request id: find it in Studio → Activity">{e.requestId.slice(0, 16)}…</code>
          </div>
          {details(e).length > 0 && <div className="t-data small">{details(e).join(" · ")}</div>}
        </li>
      ))}
    </ol>
  );
}

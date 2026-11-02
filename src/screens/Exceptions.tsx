import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { Actor, attempt, Badge, can, Card, Empty, go, Loading, money, useApp, when } from "../ui";
import { Timeline } from "./Audit";

const STATUSES = ["open", "investigating", "proposed", "approved", "rejected", "cleared"] as const;
type Status = (typeof STATUSES)[number];

export function Exceptions() {
  const [status, setStatus] = useState<Status | "">("");
  const list = useQuery(api.exceptions.list, status ? { status } : {});
  const vendors = useQuery(api.vendors.list, {});
  const invoices = useQuery(api.invoices.list, {});
  if (!list || !vendors || !invoices) return <Loading />;
  const vendorName = (id: string) => vendors.find((v) => v.id === id)?.name ?? id;
  const invoiceNo = (id: string) => invoices.find((i) => i.id === id)?.invoiceNumber ?? id;

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>Exceptions</h1>
          <p className="muted">Where an invoice and what was authorized disagree. Anyone with the role may investigate and propose; only a person with enough delegated authority may decide.</p>
        </div>
      </div>
      <Card
        actions={
          <div className="filters">
            {(["", ...STATUSES] as const).map((s) => (
              <button key={s || "all"} className={`chip ${status === s ? "on" : ""}`} onClick={() => setStatus(s)}>
                {s || "all"}
              </button>
            ))}
          </div>
        }
        title="Queue"
      >
        {list.length ? (
          <table className="table clickable">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Vendor</th>
                <th>Findings</th>
                <th className="num">Variance</th>
                <th>Assignee</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.id} onClick={() => go(`exceptions/${e.id}`)}>
                  <td>
                    <a href={`#/exceptions/${e.id}`}>{invoiceNo(e.invoiceId)}</a>
                  </td>
                  <td>{vendorName(e.vendorId)}</td>
                  <td>
                    {e.findings.map((f) => (
                      <code key={f.code} className="tag">
                        {f.code}
                      </code>
                    ))}
                  </td>
                  <td className="num">{money(e.varianceCents)}</td>
                  <td>{e.assignee ?? <span className="muted">—</span>}</td>
                  <td>
                    <Badge status={e.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No exceptions{status ? ` with status ${status}` : ""}. Every invoice so far matched.</Empty>
        )}
      </Card>
    </div>
  );
}

export function ExceptionDetail({ id }: { id: string }) {
  const app = useApp();
  const detail = useQuery(api.exceptions.get, { id });
  const authority = useQuery(api.authority.list, {});
  const investigate = useMutation(api.exceptions.investigate);
  if (!detail || !authority) return <Loading />;
  const { exception, invoice, vendor, purchaseOrder, evidence, history, vendorHistory } = detail;
  const proposal = exception.proposal;
  const decision = exception.decision;
  const closed = ["approved", "rejected", "cleared"].includes(exception.status);
  const refusals = history.filter((h) => h.type === "decision.refused");

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <a className="back" href="#/exceptions">
            ← Exceptions
          </a>
          <h1>
            {invoice.invoiceNumber} · {vendor.name} <Badge status={exception.status} />
          </h1>
          <p className="muted">
            Billed {money(invoice.totalCents)}
            {purchaseOrder ? ` against ${purchaseOrder.number} (${money(purchaseOrder.totalCents)})` : ""} · <strong className="warn-text">{money(exception.varianceCents)} at variance</strong> · opened {when(exception.openedAt)}
            {exception.assignee ? ` · investigating: ${exception.assignee}` : ""}
          </p>
        </div>
        <div className="row">
          <a className="button secondary" href={`#/invoices/${invoice.id}`}>
            Invoice
          </a>
          {!closed && exception.status !== "proposed" && can(app.permissions, "exceptions.investigate") && exception.assignee !== app.principal.id && (
            <button className="secondary" onClick={() => void attempt(app, () => investigate({ id }))}>
              Take it
            </button>
          )}
        </div>
      </div>

      <div className="grid-2">
        <Card title="What does not match">
          <ul className="findings">
            {exception.findings.map((f, i) => (
              <li key={i}>
                <code>{f.code}</code> {f.message}
                {f.varianceCents > 0 && <span className="muted"> ({money(f.varianceCents)})</span>}
              </li>
            ))}
          </ul>
          <p className="small muted">Found by SupplyDesk's matching rules when the invoice was received — no model involved.</p>
        </Card>
        <Card title="Context">
          <dl className="facts">
            <dt>Vendor</dt>
            <dd>
              {vendor.name} <Badge status={vendor.status} />
              {vendor.holdReason && <div className="small muted">{vendor.holdReason}</div>}
            </dd>
            <dt>Track record</dt>
            <dd>
              {vendorHistory.invoices} invoice(s), {vendorHistory.exceptions} exception(s), {vendorHistory.overridesApproved} override(s) approved, {vendorHistory.rejected} rejected
            </dd>
            {purchaseOrder?.notes && (
              <>
                <dt>PO notes</dt>
                <dd>{purchaseOrder.notes}</dd>
              </>
            )}
          </dl>
        </Card>
      </div>

      <Card title={`Evidence (${evidence.length})`}>
        {evidence.length ? (
          <ul className="evidence">
            {evidence.map((e) => (
              <EvidenceItem key={e.id} item={e} cited={proposal?.evidenceIds.includes(e.id) ?? false} />
            ))}
          </ul>
        ) : (
          <Empty>No evidence yet. An override cannot be proposed without it.</Empty>
        )}
        {!closed && can(app.permissions, "evidence.write") && <AddEvidence exceptionId={id} />}
      </Card>

      {proposal && (
        <Card title="Proposed resolution" className={`proposal ${proposal.resolution}`}>
          <p>
            <Badge status={proposal.resolution === "override" ? "proposed" : "rejected"} label={proposal.resolution === "override" ? "override: pay as billed" : "reject"} /> by <Actor id={proposal.proposedBy} type={proposal.proposedByType} />, {when(proposal.proposedAt)}
          </p>
          <blockquote>{proposal.rationale}</blockquote>
          {proposal.evidenceIds.length > 0 && <p className="small muted">Cites {proposal.evidenceIds.length} piece(s) of evidence.</p>}
        </Card>
      )}

      {!closed && can(app.permissions, "exceptions.propose") && <Propose id={id} evidence={evidence} current={proposal?.resolution} />}

      {exception.status === "proposed" && <Decide id={id} variance={exception.varianceCents} authority={authority} proposedBy={proposal!.proposedBy} submittedBy={invoice.submittedBy} />}

      {refusals.length > 0 && (
        <Card title="Refused decision attempts">
          <ul className="findings">
            {refusals.map((r) => (
              <li key={r.id}>
                <Actor id={r.actor} type={r.actorType} /> tried to {String(r.data?.attempted)} — {String(r.data?.reason)} <span className="muted">({when(r.at)})</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {decision && (
        <Card title="Decision" className={`decision ${decision.outcome}`}>
          <p>
            <Badge status={decision.outcome} /> by <Actor id={decision.decidedBy} type="user" />, {when(decision.decidedAt)} · authority {money(decision.authorityLimitCents)} for a {money(exception.varianceCents)} variance
          </p>
          <blockquote>{decision.note}</blockquote>
        </Card>
      )}

      <Card title="History">
        <Timeline events={history} />
      </Card>
    </div>
  );
}

function EvidenceItem({ item, cited }: { item: { id: string; kind: string; summary: string; source?: string; fileId?: string; addedBy: string; addedByType: string; addedAt: number }; cited: boolean }) {
  const [open, setOpen] = useState(false);
  const full = useQuery(api.exceptions.readEvidence, open && item.fileId ? { id: item.id } : "skip");
  return (
    <li className={cited ? "cited" : ""}>
      <div>
        <span className="tag">{item.kind.replace(/_/g, " ")}</span> {item.summary}
        {cited && <span className="small accent-text"> · cited</span>}
      </div>
      <div className="small muted">
        <Actor id={item.addedBy} type={item.addedByType} /> · {when(item.addedAt)}
        {item.source && ` · ${item.source}`}
        {item.fileId && (
          <>
            {" · "}
            <button className="link" onClick={() => setOpen((o) => !o)}>
              {open ? "hide document" : "show document"}
            </button>
          </>
        )}
      </div>
      {open && full?.text && <pre className="doc">{full.text}</pre>}
    </li>
  );
}

function AddEvidence({ exceptionId }: { exceptionId: string }) {
  const app = useApp();
  const add = useMutation(api.exceptions.addEvidence);
  const [kind, setKind] = useState<"note" | "document" | "communication" | "vendor_history" | "po_snapshot">("note");
  const [summary, setSummary] = useState("");
  const [source, setSource] = useState("");
  const [content, setContent] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await attempt(app, () => add({ exceptionId, kind, summary, ...(source.trim() ? { source } : {}), ...(content.trim() ? { content } : {}) }));
    if (r) (setSummary(""), setSource(""), setContent(""));
  };
  return (
    <details className="disclosure">
      <summary>Add evidence</summary>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <label>
            Kind
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              {["note", "communication", "document", "vendor_history", "po_snapshot"].map((k) => (
                <option key={k} value={k}>
                  {k.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
          <label>
            Source
            <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. e-mail from ops, Oct 28" />
          </label>
        </div>
        <input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What it shows" aria-label="Summary" required />
        <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="Full text (optional; stored with AppPort Services Files)" rows={3} />
        <div>
          <button className="secondary" disabled={!summary.trim()}>
            Add evidence
          </button>
        </div>
      </form>
    </details>
  );
}

function Propose({ id, evidence, current }: { id: string; evidence: Array<{ id: string; summary: string }>; current?: string }) {
  const app = useApp();
  const propose = useMutation(api.exceptions.propose);
  const [resolution, setResolution] = useState<"override" | "reject">("override");
  const [rationale, setRationale] = useState("");
  const [cited, setCited] = useState<string[]>([]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await attempt(app, () => propose({ id, resolution, rationale, evidenceIds: cited }));
    if (r) (setRationale(""), app.info("Proposed. Approvers whose authority covers the variance were notified."));
  };
  return (
    <details className="disclosure panel" open={!current}>
      <summary>{current ? "Replace the proposal" : "Propose a resolution"}</summary>
      <form className="stack" onSubmit={submit}>
        <div className="row">
          <label className="radio">
            <input type="radio" checked={resolution === "override"} onChange={() => setResolution("override")} /> Override: pay as billed
          </label>
          <label className="radio">
            <input type="radio" checked={resolution === "reject"} onChange={() => setResolution("reject")} /> Reject
          </label>
        </div>
        <textarea value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Why (at least 10 characters)" rows={3} required />
        {evidence.length > 0 && (
          <fieldset className="cite">
            <legend className="small muted">Cite evidence {resolution === "override" && "(required for an override)"}</legend>
            {evidence.map((e) => (
              <label key={e.id} className="check">
                <input type="checkbox" checked={cited.includes(e.id)} onChange={(x) => setCited((c) => (x.target.checked ? [...c, e.id] : c.filter((y) => y !== e.id)))} /> {e.summary}
              </label>
            ))}
          </fieldset>
        )}
        <div>
          <button className="primary" disabled={rationale.trim().length < 10}>
            Propose
          </button>
        </div>
      </form>
    </details>
  );
}

function Decide({ id, variance, authority, proposedBy, submittedBy }: { id: string; variance: number; authority: Array<{ principalId: string; limitCents: number }>; proposedBy: string; submittedBy: string }) {
  const app = useApp();
  const decide = useMutation(api.exceptions.decide);
  const [note, setNote] = useState("");
  const [last, setLast] = useState<{ status: string; reason?: string } | null>(null);
  const mine = authority.find((a) => a.principalId === app.principal.id);
  const holds = can(app.permissions, "exceptions.decide");
  const run = async (outcome: "approve" | "reject") => {
    const r = await attempt(app, () => decide({ id, outcome, note }));
    if (r) setLast(r);
  };
  return (
    <Card title="Decision" className="decide">
      <p className="small muted">
        Variance {money(variance)}. Who may approve: {authority.filter((a) => a.limitCents >= variance && a.principalId !== proposedBy && a.principalId !== submittedBy).map((a) => `${a.principalId} (${money(a.limitCents)})`).join(", ") || "nobody yet"}.
        {" "}You are <strong>{app.principal.id}</strong>
        {mine ? ` with authority up to ${money(mine.limitCents)}` : " with no delegated authority"}
        {holds ? "." : ", and your role cannot decide."}
      </p>
      {holds ? (
        <div className="stack">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Decision note (recorded with the decision)" rows={2} />
          <div className="row">
            <button className="primary" disabled={note.trim().length < 3} onClick={() => void run("approve")}>
              Approve override
            </button>
            <button className="danger" disabled={note.trim().length < 3} onClick={() => void run("reject")}>
              Reject invoice
            </button>
          </div>
          <p className="small muted">SupplyDesk checks your authority, and that you neither proposed this nor submitted the invoice. A refusal is recorded in the audit trail.</p>
        </div>
      ) : null}
      {last?.status === "refused" && <div className="notice-inline error">Refused: {last.reason}</div>}
    </Card>
  );
}

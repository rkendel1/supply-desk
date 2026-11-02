import { useMutation, useQuery } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { Actor, attempt, Badge, can, Card, Empty, EVENT_LABEL, Loading, money, useApp, when } from "../ui";

export function Dashboard() {
  const app = useApp();
  const summary = useQuery(api.dashboard.summary);
  const seed = useMutation(api.demo.seed);
  if (!summary) return <Loading />;
  const empty = summary.vendors.length === 0;

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>Accounts payable</h1>
          <p className="muted">Invoices are matched against purchase orders and receipts by rule. Anything that does not match becomes an exception that a person decides.</p>
        </div>
      </div>

      {empty && (
        <Card title="Start with the demo company">
          <p className="muted">Three vendors (one on hold), two purchase orders with receipts, approval authority for Ada ($50,000) and Barbara ($1,000), and one invoice that matches cleanly.</p>
          {can(app.permissions, "demo.seed") ? (
            <button className="primary" onClick={() => void attempt(app, () => seed({})).then((r) => r && app.info("Demo company loaded."))}>
              Load demo data
            </button>
          ) : (
            <p className="muted">Switch to Ada (Controller) to load it.</p>
          )}
        </Card>
      )}

      <div className="tiles">
        <Tile label="Outstanding" value={money(summary.outstandingCents)} hint="approved, scheduled or in exception" />
        <Tile label="Open exceptions" value={String(summary.openExceptions)} hint={`${money(summary.openVarianceCents)} at variance`} tone={summary.openExceptions ? "warn" : undefined} href="#/exceptions" />
        <Tile label="Awaiting decision" value={String(summary.awaitingDecision)} hint="proposed, needs an approver" tone={summary.awaitingDecision ? "warn" : undefined} href="#/exceptions" />
        <Tile label="Paid" value={money(summary.paidCents)} hint={`${summary.invoices.paid ?? 0} invoice(s)`} />
      </div>

      <div className="grid-2">
        <Card title="Invoices by status" actions={<a href="#/invoices">All invoices →</a>}>
          <div className="status-bar">
            {Object.entries(summary.invoices).map(([status, n]) => (
              <a key={status} className="status-cell" href="#/invoices">
                <Badge status={status} />
                <strong>{n}</strong>
              </a>
            ))}
          </div>
        </Card>
        <Card title="Demo walkthrough">
          <ol className="steps">
            <li>
              As <b>Grace</b> (AP clerk) or the agent, open <a href="#/invoices">Invoices</a> → <i>Receive an invoice</i> → <i>Northwind $12,400 scenario</i>. Reconciliation runs in the same transaction.
            </li>
            <li>
              Work the exception: run <code>npm run agent</code> (an agent over MCP), or as Grace add evidence and propose an override.
            </li>
            <li>
              As <b>Barbara</b> try to approve: SupplyDesk refuses, her authority is $1,000. As <b>Ada</b> approve, then schedule and record the payment.
            </li>
            <li>
              Read the <a href="#/audit">audit trail</a>: every step, who did it, and the AppPort request behind it.
            </li>
          </ol>
        </Card>
      </div>

      <div className="grid-2">
        <Card title="Vendor activity" actions={<a href="#/vendors">Vendors →</a>}>
          {summary.vendors.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Status</th>
                  <th className="num">Invoices</th>
                  <th className="num">Exceptions</th>
                  <th className="num">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {summary.vendors.map((v) => (
                  <tr key={v.id}>
                    <td>{v.name}</td>
                    <td>
                      <Badge status={v.status} />
                    </td>
                    <td className="num">{v.invoices}</td>
                    <td className="num">{v.openExceptions || "—"}</td>
                    <td className="num">{money(v.outstandingCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No vendors yet.</Empty>
          )}
        </Card>
        <Card title="Latest activity" actions={<a href="#/audit">Audit trail →</a>}>
          {summary.recent.length ? (
            <ul className="feed">
              {summary.recent.map((e) => (
                <li key={e.id}>
                  <span className="feed-what">{e.invoiceId ? <a href={`#/invoices/${e.invoiceId}`}>{EVENT_LABEL[e.type] ?? e.type}</a> : (EVENT_LABEL[e.type] ?? e.type)}</span>
                  <span className="feed-meta">
                    <Actor id={e.actor} type={e.actorType} /> · {when(e.at)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing has happened yet.</Empty>
          )}
        </Card>
      </div>
    </div>
  );
}

function Tile({ label, value, hint, tone, href }: { label: string; value: string; hint: string; tone?: "warn"; href?: string }) {
  const body = (
    <>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      <span className="tile-hint">{hint}</span>
    </>
  );
  return href ? (
    <a className={`tile ${tone ?? ""}`} href={href}>
      {body}
    </a>
  ) : (
    <div className={`tile ${tone ?? ""}`}>{body}</div>
  );
}

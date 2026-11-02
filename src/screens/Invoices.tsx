import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { attempt, Badge, can, Card, Empty, go, Loading, money, useApp } from "../ui";
import { Timeline } from "./Audit";

const STATUSES = ["exception", "approved", "scheduled", "paid", "rejected"] as const;
type Status = (typeof STATUSES)[number];

export function Invoices() {
  const app = useApp();
  const [status, setStatus] = useState<Status | "">("");
  const invoices = useQuery(api.invoices.list, status ? { status } : {});
  const vendors = useQuery(api.vendors.list, {});
  const [receiving, setReceiving] = useState(false);
  if (!invoices || !vendors) return <Loading />;
  const vendorName = (id: string) => vendors.find((v) => v.id === id)?.name ?? id;

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>Invoices</h1>
          <p className="muted">Each invoice is reconciled when it arrives: a clean three-way match is approved by rule; anything else opens an exception.</p>
        </div>
        {can(app.permissions, "invoices.submit") && (
          <button className="primary" onClick={() => setReceiving((r) => !r)}>
            {receiving ? "Close" : "Receive an invoice"}
          </button>
        )}
      </div>

      {receiving && <SubmitInvoice vendors={vendors} onDone={() => setReceiving(false)} />}

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
        title="Received"
      >
        {invoices.length ? (
          <table className="table clickable">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Vendor</th>
                <th>PO</th>
                <th>Due</th>
                <th className="num">Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id} onClick={() => go(`invoices/${i.id}`)}>
                  <td>
                    <a href={`#/invoices/${i.id}`}>{i.invoiceNumber}</a>
                  </td>
                  <td>{vendorName(i.vendorId)}</td>
                  <td>{i.poNumber ?? <span className="muted">none</span>}</td>
                  <td>{i.dueDate}</td>
                  <td className="num">{money(i.totalCents)}</td>
                  <td>
                    <Badge status={i.status} />
                    {i.approvalBasis === "override" && <span className="small muted"> override</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No invoices{status ? ` with status ${status}` : ""}.</Empty>
        )}
      </Card>
    </div>
  );
}

type Line = { sku: string; description: string; quantity: string; price: string };
const blank: Line = { sku: "", description: "", quantity: "1", price: "" };

function SubmitInvoice({ vendors, onDone }: { vendors: Array<{ id: string; name: string; paymentTermsDays: number }>; onDone: () => void }) {
  const app = useApp();
  const submit = useMutation(api.invoices.submit);
  const today = new Date().toISOString().slice(0, 10);
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? "");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(today);
  const [terms, setTerms] = useState("");
  const [lines, setLines] = useState<Line[]>([{ ...blank }]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof submit>> | null>(null);
  const linesCents = lines.reduce((n, l) => n + Math.round(Number(l.price || 0) * 100) * Number(l.quantity || 0), 0);
  const [total, setTotal] = useState("");

  const scenario = (name: "northwind" | "acme") => {
    const v = vendors.find((x) => x.name.startsWith(name === "northwind" ? "Northwind" : "Acme"));
    if (!v) return app.report(new Error("Load the demo data first (Dashboard)."));
    setVendorId(v.id);
    setInvoiceDate(today);
    setTerms("");
    if (name === "northwind") {
      setInvoiceNumber(`NW-${7780 + Math.floor(Math.random() * 200)}`);
      setPoNumber("PO-1001");
      setLines([
        { sku: "PALLET-STD", description: "Standard 48x40 pallet racking unit", quantity: "100", price: "100.00" },
        { sku: "FREIGHT-EXP", description: "Expedited freight", quantity: "1", price: "2400.00" },
      ]);
      setTotal("12400.00");
    } else {
      setInvoiceNumber(`AF-${5600 + Math.floor(Math.random() * 300)}`);
      setPoNumber("PO-1002");
      setLines([{ sku: "BOLT-M8", description: "M8 hex bolt, zinc, box of 100", quantity: "20", price: "42.00" }]);
      setTotal("840.00");
    }
    setResult(null);
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await attempt(app, () =>
      submit({
        vendorId,
        invoiceNumber,
        ...(poNumber.trim() ? { poNumber: poNumber.trim() } : {}),
        lines: lines.map((l) => ({ sku: l.sku.trim(), description: l.description.trim(), quantity: Number(l.quantity), unitPriceCents: Math.round(Number(l.price) * 100) })),
        totalCents: total ? Math.round(Number(total) * 100) : linesCents,
        ...(terms ? { paymentTermsDays: Number(terms) } : {}),
        invoiceDate,
      }),
    );
    setBusy(false);
    if (r) setResult(r);
  };

  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <Card
      title="Receive an invoice"
      actions={
        <div className="filters">
          <span className="small muted">Scenarios:</span>
          <button className="chip" onClick={() => scenario("northwind")}>
            Northwind $12,400 vs PO $10,000
          </button>
          <button className="chip" onClick={() => scenario("acme")}>
            Acme: billed before received
          </button>
        </div>
      }
    >
      {result ? (
        <div className={`result ${result.status}`}>
          <h3>{result.status === "approved" ? "Matched and approved for payment" : `Exception opened: ${money(result.varianceCents)} at variance`}</h3>
          {result.findings.length > 0 && (
            <ul className="findings">
              {result.findings.map((f, i) => (
                <li key={i}>
                  <code>{f.code}</code> {f.message}
                </li>
              ))}
            </ul>
          )}
          <div className="row">
            <button className="primary" onClick={() => go(result.exceptionId && result.status === "exception" ? `exceptions/${result.exceptionId}` : `invoices/${result.invoiceId}`)}>
              {result.status === "exception" ? "Open the exception" : "Open the invoice"}
            </button>
            <button className="secondary" onClick={() => (setResult(null), setLines([{ ...blank }]), setInvoiceNumber(""), setTotal(""))}>
              Receive another
            </button>
            <button className="secondary" onClick={onDone}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <form className="stack" onSubmit={send}>
          <div className="form-grid">
            <label>
              Vendor
              <select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Invoice number
              <input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} required />
            </label>
            <label>
              PO number
              <input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} placeholder="PO-1001" />
            </label>
            <label>
              Invoice date
              <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} required />
            </label>
            <label>
              Terms (net days)
              <input type="number" min={0} max={180} value={terms} onChange={(e) => setTerms(e.target.value)} placeholder={`vendor's (${vendors.find((v) => v.id === vendorId)?.paymentTermsDays ?? "—"})`} />
            </label>
            <label>
              Invoice total ($)
              <input type="number" min={0} step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} placeholder={(linesCents / 100).toFixed(2)} />
            </label>
          </div>
          <table className="table compact">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Description</th>
                <th className="num">Qty</th>
                <th className="num">Unit price ($)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <input value={l.sku} onChange={(e) => set(i, { sku: e.target.value })} aria-label="SKU" required />
                  </td>
                  <td>
                    <input value={l.description} onChange={(e) => set(i, { description: e.target.value })} aria-label="Description" required />
                  </td>
                  <td className="num">
                    <input className="tiny" type="number" min={0} value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} aria-label="Quantity" />
                  </td>
                  <td className="num">
                    <input className="small-input" type="number" min={0} step="0.01" value={l.price} onChange={(e) => set(i, { price: e.target.value })} aria-label="Unit price" required />
                  </td>
                  <td>
                    {lines.length > 1 && (
                      <button type="button" className="ghost" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Remove line">
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row spread">
            <button type="button" className="secondary small" onClick={() => setLines((ls) => [...ls, { ...blank }])}>
              Add line
            </button>
            <span className="muted">Lines total {money(linesCents)}</span>
          </div>
          <div className="row">
            <button className="primary" disabled={busy || !vendorId || !invoiceNumber.trim()}>
              {busy ? "Reconciling…" : "Submit and reconcile"}
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

export function InvoiceDetail({ id }: { id: string }) {
  const app = useApp();
  const invoice = useQuery(api.invoices.get, { id });
  const vendors = useQuery(api.vendors.list, {});
  const po = useQuery(api.purchasing.get, invoice?.poNumber ? { number: invoice.poNumber } : "skip");
  const trail = useQuery(api.audit.list, { invoiceId: id });
  const schedule = useMutation(api.payments.schedule);
  const record = useMutation(api.payments.recordPayment);
  const reconcile = useMutation(api.invoices.reconcile);
  if (!invoice || !vendors || !trail) return <Loading />;
  const vendor = vendors.find((v) => v.id === invoice.vendorId);
  const payment = invoice.payment;
  const pay = can(app.permissions, "payments.write");

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <a className="back" href="#/invoices">
            ← Invoices
          </a>
          <h1>
            {invoice.invoiceNumber} <Badge status={invoice.status} />
          </h1>
          <p className="muted">
            {vendor?.name} · {money(invoice.totalCents)} · invoiced {invoice.invoiceDate}, net {invoice.paymentTermsDays}, due {invoice.dueDate}
            {invoice.approvalBasis && ` · approved by ${invoice.approvalBasis === "override" ? `override (${invoice.approvedBy})` : "three-way match"}`}
          </p>
        </div>
        <div className="row">
          {invoice.status === "exception" && invoice.exceptionId && (
            <a className="button primary" href={`#/exceptions/${invoice.exceptionId}`}>
              Open the exception
            </a>
          )}
          {invoice.status === "exception" && can(app.permissions, "invoices.reconcile") && (
            <button className="secondary" onClick={() => void attempt(app, () => reconcile({ id })).then((r) => r && app.info(r.status === "approved" ? "It matches now: approved and the exception cleared." : "Still does not match."))}>
              Re-match
            </button>
          )}
          {invoice.status === "approved" && pay && (
            <button className="primary" onClick={() => void attempt(app, () => schedule({ invoiceId: id }))}>
              Schedule payment for {invoice.dueDate}
            </button>
          )}
          {invoice.status === "scheduled" && pay && (
            <button
              className="primary"
              onClick={() => {
                const reference = window.prompt("Bank or remittance reference for this payment");
                if (reference?.trim()) void attempt(app, () => record({ invoiceId: id, reference: reference.trim() }));
              }}
            >
              Record payment
            </button>
          )}
        </div>
      </div>
      {payment && (
        <Card>
          <p>
            Payment {invoice.status === "paid" ? "made" : "scheduled"} for <strong>{payment.scheduledFor}</strong>
            {payment.reference && (
              <>
                {" "}
                · reference <code>{payment.reference}</code>
              </>
            )}
          </p>
        </Card>
      )}
      <Card title="Billed vs. authorized">
        <table className="table compact">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Description</th>
              <th className="num">Billed qty</th>
              <th className="num">Billed price</th>
              <th className="num">PO price</th>
              <th className="num">Ordered / received</th>
              <th className="num">Line total</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((l) => {
              const p = po?.lines.find((x) => x.sku === l.sku);
              return (
                <tr key={l.sku} className={!p ? "flag" : ""}>
                  <td>
                    <code>{l.sku}</code>
                  </td>
                  <td>{l.description}</td>
                  <td className="num">{l.quantity}</td>
                  <td className={`num ${p && l.unitPriceCents > p.unitPriceCents ? "warn-text" : ""}`}>{money(l.unitPriceCents)}</td>
                  <td className="num">{p ? money(p.unitPriceCents) : <span className="warn-text">not on PO</span>}</td>
                  <td className="num">{p ? `${p.quantity} / ${p.receivedQuantity}` : "—"}</td>
                  <td className="num">{money(l.quantity * l.unitPriceCents)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={6}>Invoice total{po ? ` · ${po.number} authorizes ${money(po.totalCents)}` : invoice.poNumber ? ` · ${invoice.poNumber} not found` : " · no PO cited"}</td>
              <td className="num">
                <strong>{money(invoice.totalCents)}</strong>
              </td>
            </tr>
          </tfoot>
        </table>
      </Card>
      <Card title="History">
        <Timeline events={[...trail].reverse()} />
      </Card>
    </div>
  );
}

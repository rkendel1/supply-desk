import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { attempt, Badge, can, Card, Empty, Loading, money, useApp } from "../ui";

export function Vendors() {
  const app = useApp();
  const vendors = useQuery(api.vendors.list, {});
  const pos = useQuery(api.purchasing.list, {});
  const setStatus = useMutation(api.vendors.setStatus);
  const writeVendors = can(app.permissions, "vendors.write");
  const writePurchasing = can(app.permissions, "purchasing.write");
  if (!vendors || !pos) return <Loading />;
  const vendorName = (id: string) => vendors.find((v) => v.id === id)?.name ?? id;

  const hold = async (id: string) => {
    const reason = window.prompt("Why is this vendor on hold? Every invoice from them will raise an exception.");
    if (reason?.trim()) await attempt(app, () => setStatus({ id, status: "on_hold", reason: reason.trim() }));
  };

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>Vendors & purchase orders</h1>
          <p className="muted">What the company agreed to buy, from whom, on what terms — and what actually arrived.</p>
        </div>
      </div>

      <Card title="Vendors">
        {vendors.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Terms</th>
                <th>Contact</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {vendors.map((v) => (
                <tr key={v.id}>
                  <td>
                    <strong>{v.name}</strong>
                    {v.holdReason && <div className="small muted">{v.holdReason}</div>}
                  </td>
                  <td>
                    <Badge status={v.status} />
                  </td>
                  <td>net {v.paymentTermsDays}</td>
                  <td className="muted">{v.contactEmail ?? "—"}</td>
                  <td className="row-actions">
                    {writeVendors &&
                      (v.status === "active" ? (
                        <button className="secondary small" onClick={() => void hold(v.id)}>
                          Put on hold
                        </button>
                      ) : (
                        <button className="secondary small" onClick={() => void attempt(app, () => setStatus({ id: v.id, status: "active" }))}>
                          Reactivate
                        </button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No vendors yet.</Empty>
        )}
        {writeVendors && <NewVendor />}
      </Card>

      <Card title="Purchase orders">
        {pos.length ? (
          <div className="stack">
            {pos.map((po) => (
              <div key={po.id} className="po">
                <div className="po-head">
                  <div>
                    <strong>{po.number}</strong> · {vendorName(po.vendorId)} <Badge status={po.status} />
                  </div>
                  <div className="muted">
                    {money(po.totalCents)} · net {po.paymentTermsDays}
                  </div>
                </div>
                {po.notes && <p className="small muted">{po.notes}</p>}
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Description</th>
                      <th className="num">Unit price</th>
                      <th className="num">Ordered</th>
                      <th className="num">Received</th>
                    </tr>
                  </thead>
                  <tbody>
                    {po.lines.map((l) => (
                      <tr key={l.sku}>
                        <td>
                          <code>{l.sku}</code>
                        </td>
                        <td>{l.description}</td>
                        <td className="num">{money(l.unitPriceCents)}</td>
                        <td className="num">{l.quantity}</td>
                        <td className={`num ${l.receivedQuantity < l.quantity ? "warn-text" : ""}`}>{l.receivedQuantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {writePurchasing && po.status === "open" && po.lines.some((l) => l.receivedQuantity < l.quantity) && <Receive number={po.number} lines={po.lines} />}
              </div>
            ))}
          </div>
        ) : (
          <Empty>No purchase orders yet.</Empty>
        )}
        {writePurchasing && vendors.length > 0 && <NewPo vendors={vendors} />}
      </Card>
    </div>
  );
}

function NewVendor() {
  const app = useApp();
  const create = useMutation(api.vendors.create);
  const [name, setName] = useState("");
  const [terms, setTerms] = useState("30");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if ((await attempt(app, () => create({ name, paymentTermsDays: Number(terms) }))) !== undefined) setName("");
  };
  return (
    <form className="inline-form" onSubmit={submit}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New vendor name" aria-label="Vendor name" />
      <label className="small muted">
        net <input className="tiny" type="number" min={0} max={180} value={terms} onChange={(e) => setTerms(e.target.value)} aria-label="Payment terms (days)" />
      </label>
      <button className="secondary" disabled={!name.trim()}>
        Add vendor
      </button>
    </form>
  );
}

function Receive({ number, lines }: { number: string; lines: Array<{ sku: string; quantity: number; receivedQuantity: number }> }) {
  const app = useApp();
  const receive = useMutation(api.purchasing.receive);
  const open = lines.filter((l) => l.receivedQuantity < l.quantity);
  const [sku, setSku] = useState(open[0]?.sku ?? "");
  const [qty, setQty] = useState("1");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await attempt(app, () => receive({ number, receipts: [{ sku, quantity: Number(qty) }] }));
    if (r) app.info(`Recorded receipt of ${qty} × ${sku} on ${number}. Invoices waiting on these goods can be re-matched.`);
  };
  return (
    <form className="inline-form" onSubmit={submit}>
      <span className="small muted">Record receipt:</span>
      <select value={sku} onChange={(e) => setSku(e.target.value)} aria-label="SKU">
        {open.map((l) => (
          <option key={l.sku} value={l.sku}>
            {l.sku} ({l.quantity - l.receivedQuantity} outstanding)
          </option>
        ))}
      </select>
      <input className="tiny" type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} aria-label="Quantity" />
      <button className="secondary small">Receive</button>
    </form>
  );
}

function NewPo({ vendors }: { vendors: Array<{ id: string; name: string }> }) {
  const app = useApp();
  const create = useMutation(api.purchasing.create);
  const [vendorId, setVendorId] = useState(vendors[0]!.id);
  const [number, setNumber] = useState("");
  const [sku, setSku] = useState("");
  const [description, setDescription] = useState("");
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await attempt(app, () => create({ number, vendorId, lines: [{ sku, description, quantity: Number(qty), unitPriceCents: Math.round(Number(price) * 100) }] }));
    if (r) (setNumber(""), setSku(""), setDescription(""), setPrice(""));
  };
  return (
    <details className="disclosure">
      <summary>Issue a purchase order</summary>
      <form className="form-grid" onSubmit={submit}>
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
          PO number
          <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="PO-1003" />
        </label>
        <label>
          SKU
          <input value={sku} onChange={(e) => setSku(e.target.value)} />
        </label>
        <label>
          Description
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Quantity
          <input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        <label>
          Unit price ($)
          <input type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <div className="form-actions">
          <button className="primary" disabled={!number.trim() || !sku.trim() || !description.trim() || !price}>
            Issue PO
          </button>
        </div>
      </form>
    </details>
  );
}

#!/usr/bin/env node
/**
 * Run the SupplyDesk exception scenario against the compiled artifact alone.
 *
 *   npm run build:app                    # writes supply-desk.app
 *   node scripts/verify-artifact.mjs supply-desk.app
 *
 * What this proves: the `.app` directory (manifest.json + module.wasm) carries the whole
 * business process. This script reads nothing from feltkit/, src/ or node_modules; it loads
 * module.wasm with plain WebAssembly, speaks the guest ABI (appboundry-guest/1), and plays
 * the host with an in-memory store.
 *
 * What this is NOT: AppBoundry. It is a minimal reference host for verification. It checks
 * function access against the manifest's roles and commits a mutation's writes only when the
 * handler returns, but it does not reproduce AppBoundry's storage, sessions, services or its
 * independent schema checks. Run the artifact under AppBoundry for that.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/verify-artifact.mjs <path/to/name.app>");
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const module = new WebAssembly.Module(readFileSync(join(dir, manifest.module.path)));
const x = new WebAssembly.Instance(module, {}).exports;
const enc = new TextEncoder();
const dec = new TextDecoder();
const put = (text) => {
  const bytes = enc.encode(text);
  const pointer = x.abg_alloc(bytes.length);
  new Uint8Array(x.memory.buffer, pointer, bytes.length).set(bytes);
  return [pointer, bytes.length];
};
const take = (packed) => {
  const p = BigInt(packed);
  return JSON.parse(dec.decode(new Uint8Array(x.memory.buffer, Number(p >> 32n), Number(p & 0xffffffffn)).slice()));
};

x.abg_clock(Date.now());
const program = WebAssembly.Module.customSections(module, manifest.module.program.section)[0];
const described = take(x.abg_init(...put(dec.decode(program))));
if (!described.ok) throw new Error(`program did not load: ${JSON.stringify(described)}`);

// ---- host: identity from the manifest -------------------------------------------------
const grants = (held, needed) => held.some((p) => p === "*" || p === needed || (p.endsWith(".*") && needed.startsWith(p.slice(0, -1))));
const functions = new Map(manifest.functions.map((f) => [f.name, f]));
const principal = (id) => {
  const dev = manifest.identity.devUsers.find((u) => u.id === id);
  if (!dev) throw new Error(`no dev user ${id} in the manifest`);
  return { principal: { id: dev.id, type: dev.type, roles: dev.roles }, permissions: dev.roles.flatMap((r) => manifest.identity.roles[r] ?? []) };
};

// ---- host: an in-memory store; a mutation works on a copy committed only on success ----
let state = Object.fromEntries(manifest.collections.map((c) => [c.name, new Map()]));
const services = { notifications: [], webhooks: [], files: new Map() };
let nextId = 1;
const clone = (s) => Object.fromEntries(Object.entries(s).map(([k, m]) => [k, new Map([...m].map(([id, r]) => [id, structuredClone(r)]))]));
const matches = (record, filter) => Object.entries(filter ?? {}).every(([k, v]) => JSON.stringify(record[k]) === JSON.stringify(v));
const ordered = (rows, orderBy = []) =>
  [...rows].sort((a, b) => {
    for (const { field, direction } of orderBy) {
      if (a[field] === b[field]) continue;
      return (a[field] < b[field] ? -1 : 1) * (direction === "desc" ? -1 : 1);
    }
    return 0;
  });

function perform(db, call) {
  const table = call.collection ? db[call.collection] : null;
  if (call.collection && !table) throw { code: "FORBIDDEN", message: `collection ${call.collection} is not in the manifest` };
  switch (call.op) {
    case "db.get": return table.get(call.key) ?? null;
    case "db.find": {
      const rows = ordered([...table.values()].filter((r) => matches(r, call.filter)), call.options?.orderBy);
      return call.options?.limit ? rows.slice(0, call.options.limit) : rows;
    }
    case "db.count": return [...table.values()].filter((r) => matches(r, call.filter)).length;
    case "db.insert": {
      const id = `r${nextId++}`;
      table.set(id, { ...call.value, id, __version: 1 });
      return id;
    }
    case "db.patch":
    case "db.replace": {
      const current = table.get(call.key);
      if (!current) throw { code: "NOT_FOUND", message: `no ${call.collection} ${call.key}` };
      const next = call.op === "db.patch" ? { ...current, ...call.fields } : { ...call.value, id: current.id };
      for (const k of call.unset ?? []) delete next[k];
      next.__version = current.__version + 1;
      table.set(call.key, next);
      return next;
    }
    case "db.delete": table.delete(call.key); return null;
    case "service": {
      const { service, method, input } = call;
      if (service === "configuration" && method === "list") return {};
      if (service === "notifications" && method === "send") { const n = { id: `n${nextId++}`, ...input }; services.notifications.push(n); return n; }
      if (service === "notifications" && method === "list") return [];
      if (service === "webhooks" && method === "emit") { services.webhooks.push(input.type); return { deliveries: 0 }; }
      if (service === "files" && method === "upload") { const f = { id: `f${nextId++}`, name: input.name, metadata: input.metadata ?? {} }; services.files.set(f.id, { file: f, content: input.content }); return f; }
      if (service === "files" && method === "read") { const f = services.files.get(input.id); return { file: f.file, content: f.content }; }
      throw { code: "UNAVAILABLE", message: `${service}.${method} is not implemented by this reference host` };
    }
    default: throw { code: "UNAVAILABLE", message: `${call.op} is not implemented by this reference host` };
  }
}

let request = 0;
function call(who, name, args = {}) {
  const fn = functions.get(name);
  if (!fn) throw new Error(`no function ${name} in the manifest`);
  const identity = principal(who);
  if (fn.access !== "public" && fn.access !== "authenticated" && !grants(identity.permissions, fn.access)) return { error: { code: "FORBIDDEN", message: `${who} lacks ${fn.access}` } };
  const db = fn.kind === "mutation" ? clone(state) : state;
  let status = take(x.abg_invoke(...put(JSON.stringify({ function: name, args, ...identity, requestId: `req-${++request}`, environment: { name: "verify", production: false } }))));
  while (status.state === "suspended") {
    const results = status.calls.map((c) => {
      try {
        return { id: c.id, ok: true, value: perform(db, c) };
      } catch (error) {
        return { id: c.id, ok: false, error: { code: error.code ?? "INTERNAL", message: error.message ?? String(error) } };
      }
    });
    status = take(x.abg_resume(...put(JSON.stringify(results))));
  }
  if (status.state === "failed") return { error: status.error };
  if (fn.kind === "mutation") state = db;
  return { value: status.value };
}
const ok = (who, name, args) => {
  const r = call(who, name, args);
  if (r.error) throw new Error(`${who} ${name}: ${r.error.code} ${r.error.message}`);
  return r.value;
};

// ---- the scenario ------------------------------------------------------------------------
const checks = [];
const check = (label, condition) => {
  checks.push([label, condition]);
  console.log(`${condition ? "✓" : "✗"} ${label}`);
};

console.log(`Artifact ${manifest.application.id} ${manifest.application.version} (${manifest.format}, ${manifest.functions.length} functions)\n`);
ok("ada", "demo:seed");
const northwind = ok("ada", "vendors:list").find((v) => v.name.startsWith("Northwind")).id;
check("demo data loads; the clean Acme invoice is approved by three-way match", ok("ada", "invoices:list")[0]?.approvalBasis === "three_way_match");

const submitted = ok("ap-agent", "invoices:submit", {
  vendorId: northwind,
  invoiceNumber: "NW-7781",
  poNumber: "PO-1001",
  lines: [
    { sku: "PALLET-STD", description: "Standard 48x40 pallet racking unit", quantity: 100, unitPriceCents: 10_000 },
    { sku: "FREIGHT-EXP", description: "Expedited freight", quantity: 1, unitPriceCents: 240_000 },
  ],
  totalCents: 1_240_000,
  invoiceDate: new Date().toISOString().slice(0, 10),
});
check("the agent submits $12,400 against a $10,000 PO: exception with a $2,400 variance", submitted.status === "exception" && submitted.varianceCents === 240_000);
const exceptionId = submitted.exceptionId;
ok("ap-agent", "exceptions:investigate", { id: exceptionId });
const ev = ok("ap-agent", "exceptions:addEvidence", { exceptionId, kind: "communication", summary: "Operations requested expedited freight.", content: "Please expedite PO-1001. — Ops" });
ok("ap-agent", "exceptions:propose", { id: exceptionId, resolution: "override", rationale: "Freight was requested by operations; goods received in full.", evidenceIds: [ev.id] });
check("the agent investigates, attaches evidence and proposes an override", ok("ada", "exceptions:get", { id: exceptionId }).exception.status === "proposed");
check("the agent cannot decide (no exceptions.decide in its role)", call("ap-agent", "exceptions:decide", { id: exceptionId, outcome: "approve", note: "Approve as billed." }).error?.code === "FORBIDDEN");
const refused = ok("barbara", "exceptions:decide", { id: exceptionId, outcome: "approve", note: "Looks fine." });
check(`barbara is refused by the application: ${refused.reason}`, refused.status === "refused");
check("ada, whose authority covers it, approves", ok("ada", "exceptions:decide", { id: exceptionId, outcome: "approve", note: "Requested by ops." }).status === "approved");
ok("ada", "payments:schedule", { invoiceId: submitted.invoiceId });
ok("ada", "payments:recordPayment", { invoiceId: submitted.invoiceId, reference: "ACH-0042" });
check("payment is scheduled and recorded", ok("katherine", "invoices:get", { id: submitted.invoiceId }).status === "paid");
const trail = ok("katherine", "audit:list", { invoiceId: submitted.invoiceId }).reverse().map((e) => `${e.type}:${e.actor}`);
check(`the audit trail has every step (${trail.length} events)`, trail.join(" ") === "invoice.received:ap-agent invoice.reconciled:ap-agent exception.opened:ap-agent exception.investigating:ap-agent evidence.added:ap-agent exception.proposed:ap-agent decision.refused:barbara exception.approved:ada invoice.approved:ada payment.scheduled:ada payment.recorded:ada");
check(`service effects requested of the host: ${services.webhooks.length} webhook events, ${services.notifications.length} notification(s)`, services.webhooks.includes("exception.decided") && services.notifications.some((n) => n.recipient === "ada"));

const failed = checks.filter(([, c]) => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed, using only ${dir}`);
process.exit(failed ? 1 : 0);

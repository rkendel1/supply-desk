import { useEffect, useMemo, useState } from "react";
import { useFeltKit } from "@feltdb/feltkit/react";
import { Badge, Card, Empty, useApp } from "../ui";

/**
 * Operate SupplyDesk the way an agent does: discover its AppPort capabilities over MCP and
 * invoke them as yourself. Nothing here is special to the browser — it is the same endpoint,
 * contract and authorization an agent gets (`npm run agent`, or any MCP client).
 */
type Tool = { name: string; description?: string; inputSchema?: { properties?: Record<string, { type?: string }>; required?: string[] } };
type Allowed = Record<string, { allowed: boolean; effect: string }>;

export function AgentConsole() {
  const app = useApp();
  const client = useFeltKit();
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [allowed, setAllowed] = useState<Allowed>({});
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("dashboard_summary");
  const [args, setArgs] = useState("{}");
  const [output, setOutput] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");

  const mcp = useMemo(() => {
    let id = 0;
    return async (method: string, params?: unknown) => {
      const token = client.tokens.get();
      const response = await fetch(`${client.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) }),
      });
      if (!response.ok) throw new Error(`The MCP endpoint answered ${response.status}.`);
      const body = await response.json();
      if (body.error) throw new Error(body.error.message);
      return body.result;
    };
  }, [client]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const list = (await mcp("tools/list")) as { tools: Tool[] };
        const ctx = await mcp("tools/call", { name: "feltkit_context", arguments: {} }).catch(() => null);
        if (!live) return;
        setTools(list.tools.filter((t) => !t.name.startsWith("feltkit_")));
        if (ctx && !ctx.isError) {
          const parsed = JSON.parse(ctx.content[0].text) as { tools: Array<{ name: string; allowed: boolean; effect: string; source: string }> };
          setAllowed(Object.fromEntries(parsed.tools.filter((t) => t.source === "application").map((t) => [t.name.replace(/\./g, "_"), { allowed: t.allowed, effect: t.effect }])));
        }
      } catch (error) {
        if (live) setUnavailable(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      live = false;
    };
  }, [mcp, app.principal.id]);

  const pick = (t: Tool) => {
    setSelected(t.name);
    const skeleton: Record<string, unknown> = {};
    for (const key of t.inputSchema?.required ?? []) {
      const type = t.inputSchema?.properties?.[key]?.type;
      skeleton[key] = type === "integer" || type === "number" ? 0 : type === "array" ? [] : type === "boolean" ? false : "";
    }
    setArgs(JSON.stringify(skeleton, null, 2));
    setOutput(null);
  };

  const invoke = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args || "{}");
    } catch {
      return setOutput({ ok: false, text: "Arguments must be JSON." });
    }
    setBusy(true);
    try {
      const result = await mcp("tools/call", { name: selected, arguments: parsed });
      const text = result.content?.[0]?.text ?? "";
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* plain text */
      }
      setOutput({ ok: !result.isError, text: pretty });
    } catch (error) {
      setOutput({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const tool = tools?.find((t) => t.name === selected);
  const shown = (tools ?? []).filter((t) => !filter || t.name.includes(filter));
  const origin = client.url || window.location.origin;

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>AppPort console</h1>
          <p className="muted">
            SupplyDesk's capabilities, discovered over MCP as <strong>{app.principal.id}</strong>. Discovery shows everything; authority is decided when you invoke. Agents get exactly this — the same endpoint, the same checks, the same audit trail — and nothing else.
          </p>
        </div>
      </div>

      {unavailable ? (
        <Card title="MCP is not available here">
          <p className="muted">{unavailable}</p>
          <p className="small muted">The MCP endpoint is served by a FeltKit server (`npm run dev`, or a deployment). An AppBoundry artifact exposes the same capabilities through AppBoundry instead.</p>
        </Card>
      ) : !tools ? (
        <Empty>Discovering capabilities…</Empty>
      ) : (
        <div className="console">
          <Card title={`Capabilities (${tools.length})`} className="console-list">
            <input className="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" aria-label="Filter capabilities" />
            <ul>
              {shown.map((t) => {
                const a = allowed[t.name];
                return (
                  <li key={t.name}>
                    <button className={`cap ${selected === t.name ? "on" : ""} ${a && !a.allowed ? "denied" : ""}`} onClick={() => pick(t)}>
                      <code>{t.name}</code>
                      {a && <span className="small muted">{a.allowed ? a.effect : "not allowed"}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>
          <div className="stack-lg">
            <Card
              title={
                <>
                  <code>{selected}</code> {allowed[selected] && <Badge status={allowed[selected]!.allowed ? "approved" : "refused"} label={allowed[selected]!.allowed ? "allowed for you" : "not allowed for you"} />}
                </>
              }
            >
              <p className="muted">{tool?.description}</p>
              <textarea className="code" rows={8} value={args} onChange={(e) => setArgs(e.target.value)} aria-label="Arguments (JSON)" spellCheck={false} />
              <div className="row">
                <button className="primary" disabled={busy} onClick={() => void invoke()}>
                  {busy ? "Invoking…" : "Invoke as " + app.principal.id}
                </button>
              </div>
              {output && <pre className={`output ${output.ok ? "" : "error"}`}>{output.text}</pre>}
            </Card>
            <Card title="Connect an agent">
              <ol className="steps">
                <li>
                  Create an agent session (it holds the <code>agent</code> role: investigate and propose, never decide or pay):
                  <pre className="doc">npx feltkit session create --id ap-agent --role agent --type agent</pre>
                </li>
                <li>
                  Point any MCP client at <code>{origin}/mcp</code> with <code>Authorization: Bearer &lt;token&gt;</code>. For Claude Code:
                  <pre className="doc">{`claude mcp add --transport http --scope local supplydesk ${origin}/mcp --header "Authorization: Bearer <token>"`}</pre>
                </li>
                <li>
                  Or run the scripted agent in development: <code>npm run agent</code>.
                </li>
              </ol>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useConnectionState, useFeltKit, useMutation, useQuery, useSession } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { ThemeToggle } from "./theme";
import { describe, ResetForm, SignedOut } from "./auth";
import { can, Ctx, useApp, type AppContext } from "./ui";
import { Dashboard } from "./screens/Dashboard";
import { Vendors } from "./screens/Vendors";
import { Invoices, InvoiceDetail } from "./screens/Invoices";
import { Exceptions, ExceptionDetail } from "./screens/Exceptions";
import { Audit } from "./screens/Audit";
import { AgentConsole } from "./screens/AgentConsole";

type Notice = { tone: "error" | "info"; text: string } | null;

function useRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

const NAV: Array<{ path: string; label: string }> = [
  { path: "dashboard", label: "Dashboard" },
  { path: "vendors", label: "Vendors & POs" },
  { path: "invoices", label: "Invoices" },
  { path: "exceptions", label: "Exceptions" },
  { path: "audit", label: "Audit trail" },
  { path: "agent", label: "AppPort console" },
];

export function App() {
  const { session, signInAsDevUser, signIn, signUp, signOut } = useSession();
  const live = useConnectionState();
  const [notice, setNotice] = useState<Notice>(null);
  const principal = session?.principal ?? null;

  // In development, sign in as the first dev user so the app works on first load.
  const tried = useRef(false);
  useEffect(() => {
    if (session && !principal && session.devUsers.length && !tried.current) {
      tried.current = true;
      void signInAsDevUser(session.devUsers[0]!.id);
    }
  }, [session, principal, signInAsDevUser]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 7000);
    return () => clearTimeout(timer);
  }, [notice]);

  const report = (error: unknown) => setNotice({ tone: "error", text: describe(error) });

  const client = useFeltKit();
  const [resetToken, setResetToken] = useState<string | null>(null);
  useEffect(() => {
    void client.handleRedirect().then((r) => {
      if (r?.kind === "reset") setResetToken(r.token);
      else if (r?.kind === "verified") setNotice({ tone: "info", text: `${r.email} is verified.` });
      else if (r?.kind === "error" || r?.kind === "verify-failed") setNotice({ tone: "error", text: r.message });
    });
  }, [client]);

  const ctx: AppContext | null = principal
    ? { principal, permissions: session?.permissions ?? [], report, info: (text) => setNotice({ tone: "info", text }) }
    : null;

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/dashboard">
          <span className="logo" aria-hidden>
            SD
          </span>
          <span className="brand-name">SupplyDesk</span>
          {session && !session.environment.production && <span className="env">{session.environment.name}</span>}
        </a>
        <div className="topbar-right">
          <span className={`live ${live ? "on" : ""}`} title={live ? "Live: changes from people, agents and services appear immediately" : "Connecting to the change stream…"}>
            <span className="dot" /> {live ? "Live" : "Connecting"}
          </span>
          {session && session.devUsers.length > 0 && (
            <label className="identity">
              <span className="sr-only">Acting as</span>
              <select value={principal?.id ?? ""} onChange={(e) => (e.target.value ? signInAsDevUser(e.target.value).catch(report) : signOut())} aria-label="Acting as">
                <option value="">Signed out</option>
                {session.devUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {principal && !session?.devUsers.length && (
            <button className="secondary small" onClick={() => void signOut().catch(report)} title={principal.displayName ?? principal.id}>
              Sign out
            </button>
          )}
          <ThemeToggle />
          {session?.dashboard && (
            <a className="dashboard-link" href={session.dashboard} target="_blank" rel="noreferrer">
              Studio ↗
            </a>
          )}
        </div>
      </header>

      {notice && (
        <div className={`notice ${notice.tone}`} role="status">
          {notice.text}
          <button className="ghost" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {!session ? (
        <div className="center muted">Connecting…</div>
      ) : resetToken ? (
        <div className="center">
          <div className="card narrow">
            <ResetForm token={resetToken} onDone={() => (setResetToken(null), setNotice({ tone: "info", text: "Your password is set. Other sessions were signed out." }))} />
          </div>
        </div>
      ) : !principal || !ctx ? (
        <SignedOut devUsers={session.devUsers} accounts={session.accounts ?? null} onDevSignIn={(id) => signInAsDevUser(id).catch(report)} onSignIn={signIn} onSignUp={signUp} />
      ) : (
        <Ctx.Provider value={ctx}>
          <Workspace />
        </Ctx.Provider>
      )}
    </div>
  );
}

function Workspace() {
  const route = useRoute();
  const [section = "dashboard", id] = route;
  const summary = useQuery(api.dashboard.summary);
  const badge: Record<string, number | undefined> = { exceptions: summary?.openExceptions, invoices: summary?.invoices.exception };
  return (
    <div className="workspace">
      <nav className="sidebar" aria-label="Sections">
        {NAV.map((n) => (
          <a key={n.path} href={`#/${n.path}`} className={`nav ${section === n.path ? "active" : ""}`}>
            <span>{n.label}</span>
            {badge[n.path] ? <span className="count">{badge[n.path]}</span> : null}
          </a>
        ))}
        <Inbox />
      </nav>
      <main className="main">
        {section === "dashboard" && <Dashboard />}
        {section === "vendors" && <Vendors />}
        {section === "invoices" && (id ? <InvoiceDetail id={id} /> : <Invoices />)}
        {section === "exceptions" && (id ? <ExceptionDetail id={id} /> : <Exceptions />)}
        {section === "audit" && <Audit />}
        {section === "agent" && <AgentConsole />}
      </main>
    </div>
  );
}

/** The signed-in person's notifications (AppPort Services Notifications). */
function Inbox() {
  const app = useApp();
  const items = useQuery(api.inbox.list, can(app.permissions, "notifications.read") ? { unread: true } : "skip");
  const markRead = useMutation(api.inbox.markRead);
  if (!items?.length) return null;
  return (
    <div className="inbox">
      <div className="sidebar-title">Inbox</div>
      {items.slice(0, 5).map((n) => (
        <a key={n.id} className="inbox-item" onClick={() => void markRead({ id: n.id }).catch(app.report)} href={n.data && typeof n.data === "object" && "exceptionId" in n.data ? `#/exceptions/${String((n.data as { exceptionId: string }).exceptionId)}` : "#/exceptions"}>
          {n.title}
        </a>
      ))}
    </div>
  );
}

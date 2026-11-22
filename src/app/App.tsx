import { useCallback, useEffect, useState } from "react";
import { STATE_LABEL } from "../kernel/evaluate";
import type { UnitSystem } from "../kernel/units";
import { type AuditEntry, type ChartRecord, type PlanSummary, type User, api } from "./api";
import { ChartsPage } from "./ChartsPage";
import { PlanEditor } from "./PlanEditor";
import { SelectField, TextField } from "./fields";

const UNITS_KEY = "sbp-lift-plan/units";

function storedUnits(): UnitSystem {
  try {
    return localStorage.getItem(UNITS_KEY) === "SI" ? "SI" : "US";
  } catch {
    return "US";
  }
}

function PasswordField({ label, value, onChange, autoComplete }: { label: string; value: string; onChange: (v: string) => void; autoComplete: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-input">
        <input type="password" aria-label={label} autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} />
      </span>
    </label>
  );
}

function SignIn({ signupOpen, onUser }: { signupOpen: boolean; onUser: (u: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [signupCode, setSignupCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { user } = mode === "login" ? await api.login(email, password) : await api.register({ email, name, password, signupCode });
      onUser(user);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign in.");
      setBusy(false);
    }
  };

  return (
    <div className="signin" onKeyDown={(e) => e.key === "Enter" && !busy && void submit()}>
      <section className="card">
        <h2>{mode === "login" ? "Sign in" : "Create an account"}</h2>
        <div className="stack">
          {mode === "register" && <TextField label="Your name" value={name} onChange={setName} hint="Shown on charts you enter and plans you review or approve." />}
          <TextField label="Email" value={email} onChange={setEmail} />
          <PasswordField label="Password" value={password} onChange={setPassword} autoComplete={mode === "login" ? "current-password" : "new-password"} />
          {mode === "register" && <TextField label="Sign-up code" value={signupCode} onChange={setSignupCode} hint="From whoever runs this server." />}
        </div>
        {error && <p className="banner bad top">{error}</p>}
        <div className="row">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
            {mode === "login" ? "Sign in" : "Create account"}
          </button>
          {signupOpen && (
            <button type="button" className="btn" onClick={() => setMode(mode === "login" ? "register" : "login")}>
              {mode === "login" ? "I need an account" : "I have an account"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function PlansPage({ plans, onOpen, onNew }: { plans: PlanSummary[]; onOpen: (id: string) => void; onNew: () => void }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Lift plans</h2>
        <button type="button" className="btn primary" onClick={onNew}>
          New lift plan
        </button>
      </div>
      {plans.length === 0 && <p className="muted">No plans yet.</p>}
      <ul className="list">
        {plans.map((p) => {
          const tone = p.approved ? "ok" : p.state === "WITHIN_LIMITS" ? "ok" : p.state === "REVIEW_REQUIRED" ? "warn" : p.state === "DRAFT" ? "draft" : "bad";
          return (
            <li key={p.id}>
              <button type="button" className="list-link" onClick={() => onOpen(p.id)}>
                <span className="list-main">
                  <strong>{p.name || "Unnamed lift"}</strong>
                  <span className="muted">{p.description}</span>
                  <span className="muted">
                    Rev {p.rev} · {p.author} · {new Date(p.updatedAt).toLocaleString()}
                  </span>
                </span>
                <span className="list-side">
                  <span className={`pill ${tone}`}>{p.approved ? "Approved" : STATE_LABEL[p.state]}</span>
                  {!p.approved && <span className="muted">{p.reviewed ? "Reviewed, not approved" : "Not reviewed"}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ActivityPage() {
  const [data, setData] = useState<{ entries: AuditEntry[]; firstBrokenSeq: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.audit().then(setData, (e: unknown) => setError(e instanceof Error ? e.message : "Could not load the activity log."));
  }, []);
  return (
    <section className="card">
      <h2>Activity log</h2>
      {error && <p className="banner bad">{error}</p>}
      {data && (data.firstBrokenSeq === null ? <p className="pill ok">Log chain verified</p> : <p className="banner bad">The log does not verify from entry {data.firstBrokenSeq}. Records may have been altered.</p>)}
      <div className="table-scroll">
        <table className="chart log">
          <thead>
            <tr>
              <th>#</th>
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {data?.entries.map((e) => (
              <tr key={e.seq}>
                <td>{e.seq}</td>
                <td>{new Date(e.at).toLocaleString()}</td>
                <td>{e.user ?? "—"}</td>
                <td>{e.action}</td>
                <td>{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type View = { page: "plans" } | { page: "charts" } | { page: "activity" } | { page: "editor"; planId: string | null; key: number };

export function App() {
  const [session, setSession] = useState<{ user: User | null; signupOpen: boolean } | "loading" | "offline">("loading");
  const [system, setSystem] = useState<UnitSystem>(storedUnits);
  const [view, setView] = useState<View>({ page: "plans" });
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [charts, setCharts] = useState<ChartRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.me().then(setSession, () => setSession("offline"));
  }, []);

  const user = typeof session === "object" ? session.user : null;

  const reload = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([api.plans(), api.charts()]);
      setPlans(p.plans);
      setCharts(c);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load data.");
    }
  }, []);

  useEffect(() => {
    if (user) void reload();
  }, [user, reload]);

  const changeUnits = (v: UnitSystem) => {
    setSystem(v);
    try {
      localStorage.setItem(UNITS_KEY, v);
    } catch {
      /* preference only */
    }
  };

  const go = (page: "plans" | "charts" | "activity") => {
    setView({ page });
    void reload();
  };

  return (
    <div className="page">
      <header className="masthead">
        <div>
          <h1>SteelBuild Pro Lift Plan</h1>
          <p>Single-crane pick plans — capacity, rigging, ground and wind checks</p>
        </div>
        {user && (
          <div className="row tight no-print">
            <nav className="tabs" aria-label="Sections">
              {(["plans", "charts", "activity"] as const).map((p) => (
                <button key={p} type="button" className={view.page === p || (p === "plans" && view.page === "editor") ? "tab active" : "tab"} onClick={() => go(p)}>
                  {p === "plans" ? "Plans" : p === "charts" ? "Charts" : "Activity"}
                </button>
              ))}
            </nav>
            <SelectField
              label="Units"
              value={system}
              onChange={changeUnits}
              options={[
                { value: "US", label: "US (lb, ft)" },
                { value: "SI", label: "SI (kg, m)" },
              ]}
            />
            <div className="who">
              <span>{user.name}</span>
              <button
                type="button"
                className="btn small"
                onClick={() =>
                  void api.logout().finally(() => {
                    setSession((s) => (typeof s === "object" ? { ...s, user: null } : s));
                    setView({ page: "plans" });
                  })
                }
              >
                Sign out
              </button>
            </div>
          </div>
        )}
      </header>

      {session === "loading" && <p className="muted pad">Loading…</p>}
      {session === "offline" && <p className="banner bad pad">Cannot reach the server. Reload the page to try again.</p>}
      {typeof session === "object" && !user && <SignIn signupOpen={session.signupOpen} onUser={(u) => setSession({ ...session, user: u })} />}

      {user && error && <p className="banner bad pad">{error}</p>}
      {user && view.page === "editor" && (
        <PlanEditor key={view.key} planId={view.planId} user={user} charts={charts} system={system} onBack={() => go("plans")} onSaved={() => void reload()} />
      )}
      {user && view.page !== "editor" && (
        <main className="single">
          {view.page === "plans" && <PlansPage plans={plans} onNew={() => setView({ page: "editor", planId: null, key: Date.now() })} onOpen={(id) => setView({ page: "editor", planId: id, key: Date.now() })} />}
          {view.page === "charts" && <ChartsPage charts={charts} user={user} system={system} reload={reload} />}
          {view.page === "activity" && <ActivityPage />}
        </main>
      )}
    </div>
  );
}

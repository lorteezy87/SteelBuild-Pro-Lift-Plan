import { type ChangeEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { fingerprintInput, sha256Hex } from "../kernel/approval";
import { type Check, type Evaluation, type LiftPlan, type ResultState, STATE_LABEL, type WeightEvidence, deductionLedger, emptyPlan, evaluatePlan } from "../kernel/evaluate";
import { boomGeometry } from "../kernel/mechanics";
import { type CoverStatus, type CraneCover, type Member, type MemberType, type PlanSite, type SiteCrane, type SiteModel, bestCover, coverMember, maxRatedRadiusM, memberCentre, memberLengthM, memberMass, sampleModel } from "../kernel/site";
import { STANDARD_GRAVITY, type UnitSystem } from "../kernel/units";
import { type ChartRecord, type HistoryEntry, type ModelSummary, type Revision, type User, api } from "./api";
import { type LayerKey, Scene3D, type SceneCrane, TYPE_COLOR, type ViewName } from "./Scene3D";
import { NumField, SelectField, TextField, formatQuantity } from "./fields";

const STATE_CLASS: Record<ResultState, string> = {
  WITHIN_LIMITS: "ok",
  REVIEW_REQUIRED: "warn",
  LIMIT_EXCEEDED: "bad",
  DRAFT: "draft",
  UNSUPPORTED: "bad",
  INVALID: "bad",
};

function CheckCard({ check, system }: { check: Check; system: UnitSystem }) {
  return (
    <div className={`check ${STATE_CLASS[check.state]}`}>
      <div className="check-head">
        <h3>{check.title}</h3>
        <span className={`pill ${STATE_CLASS[check.state]}`}>{STATE_LABEL[check.state]}</span>
      </div>
      {check.metrics.length > 0 && (
        <dl className="metrics">
          {check.metrics.map((m) => (
            <div key={m.label}>
              <dt>{m.label}</dt>
              <dd>{formatQuantity(m.kind, m.value, system)}</dd>
            </div>
          ))}
        </dl>
      )}
      {check.notes.length > 0 && (
        <ul className="notes">
          {check.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const EVIDENCE: Array<{ value: WeightEvidence; label: string }> = [
  { value: "weighed", label: "Weighed" },
  { value: "manufacturer", label: "Manufacturer / shipping weight" },
  { value: "calculated", label: "Calculated from dimensions" },
  { value: "estimated", label: "Estimated" },
];

/** A collapsible panel section that stays how the person left it. */
function Group({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className="group" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{title}</summary>
      {children}
    </details>
  );
}

const CRANE_COLORS = ["#e0a100", "#7a4fb5", "#1f8a9e", "#c2410c", "#3f7d3a", "#b0306a"];
const STATUS_COLOR: Record<CoverStatus, string> = { ok: "#2e9d5b", over: "#d23b30", "no-weight": "#6b7fd1", "reach-only": "#1f8a9e", unrated: "#aab3ba", out: "#aab3ba" };
const STATUS_LABEL: Record<CoverStatus, string> = {
  ok: "Within chart",
  over: "Over capacity",
  "no-weight": "In chart, weight unknown",
  "reach-only": "In swing radius, capacity not checked",
  unrated: "Not rated here",
  out: "Out of reach",
};
const TYPE_LABEL: Record<MemberType, string> = { column: "Columns", beam: "Beams & girders", brace: "Bracing", joist: "Joists" };
const TYPE_ONE: Record<MemberType, string> = { column: "Column", beam: "Beam / girder", brace: "Brace", joist: "Joist" };
type ColorMode = "capacity" | "crane" | "type";
type Selection = { kind: "member"; id: string } | { kind: "crane"; id: string } | null;

function nearest(lines: { name: string; pos: number }[], v: number) {
  let best: { name: string; pos: number } | null = null;
  for (const g of lines) if (!best || Math.abs(v - g.pos) < Math.abs(v - best.pos)) best = g;
  return best;
}

function locate(model: SiteModel | null, x: number, z: number, system: UnitSystem): string {
  const gx = model && nearest(model.gridsX, x);
  const gz = model && nearest(model.gridsZ, z);
  if (!gx || !gz) return `E ${formatQuantity("length", x, system)} · S ${formatQuantity("length", z, system)}`;
  return `${formatQuantity("length", Math.abs(x - gx.pos), system)} ${x >= gx.pos ? "E" : "W"} of ${gx.name} · ${formatQuantity("length", Math.abs(z - gz.pos), system)} ${z >= gz.pos ? "S" : "N"} of ${gz.name}`;
}

interface Props {
  planId: string | null;
  user: User;
  charts: ChartRecord[];
  system: UnitSystem;
  onBack: () => void;
  onSaved: (planId: string) => void;
}

export function PlanEditor({ planId, user, charts, system, onBack, onSaved }: Props) {
  const [plan, setPlanState] = useState<LiftPlan>(emptyPlan);
  const [datasetId, setDatasetId] = useState<string>("");
  const [saved, setSaved] = useState<Revision | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(planId !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputsHash, setInputsHash] = useState<string | null>(null);

  const [models, setModels] = useState<ModelSummary[]>([]);
  const [model, setModel] = useState<SiteModel | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection>(null);
  const [mode, setMode] = useState<ColorMode>("capacity");
  const [hidden, setHidden] = useState<Set<LayerKey>>(() => new Set());
  const [view, setView] = useState<{ name: ViewName; n: number }>({ name: "iso", n: 0 });

  useEffect(() => {
    api.models().then((r) => setModels(r.models), () => undefined);
  }, []);

  useEffect(() => {
    if (!planId) return;
    let live = true;
    api
      .plan(planId)
      .then(({ latest, history: h }) => {
        if (!live) return;
        setSaved(latest);
        setHistory(h);
        setPlanState(latest.plan);
        setDatasetId(latest.dataset?.id ?? "");
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : "Could not load the plan.");
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [planId]);

  const modelId = plan.site.modelId;
  useEffect(() => {
    if (!modelId) return setModel(null);
    let live = true;
    api.model(modelId).then(
      (r) => live && setModel(r.model),
      (e: unknown) => live && setModelError(e instanceof Error ? e.message : "Could not load the steel model."),
    );
    return () => {
      live = false;
    };
  }, [modelId]);

  const chartById = useMemo(() => new Map(charts.map((c) => [c.dataset.id, c.dataset])), [charts]);
  const dataset = chartById.get(datasetId) ?? null;
  const evaluation = useMemo(() => evaluatePlan(plan, dataset, STANDARD_GRAVITY), [plan, dataset]);

  useEffect(() => {
    let live = true;
    setInputsHash(null);
    void sha256Hex(fingerprintInput(plan, dataset, STANDARD_GRAVITY)).then((h) => {
      if (live) setInputsHash(h);
    });
    return () => {
      live = false;
    };
  }, [plan, dataset]);

  const setPlan = (patch: Partial<LiftPlan>) => setPlanState((p) => ({ ...p, ...patch }));
  const setSite = (patch: Partial<PlanSite>) => setPlanState((p) => ({ ...p, site: { ...p.site, ...patch } }));
  const setCrane = (id: string, patch: Partial<SiteCrane>) => setPlanState((p) => ({ ...p, site: { ...p.site, cranes: p.site.cranes.map((c) => (c.id === id ? { ...c, ...patch } : c)) } }));

  // "Dirty" also covers a chart that was approved after the revision was saved: the fingerprint includes it.
  const dirty = saved === null || inputsHash === null || inputsHash !== saved.inputsHash;
  const pristine = saved === null && datasetId === "" && JSON.stringify(plan) === JSON.stringify(emptyPlan());
  const released = !dirty && saved?.approval != null;
  const shown: Evaluation = !dirty && saved ? saved.evaluation : evaluation;

  // ── Coverage of every piece by every crane ─────────────────────────────
  const cranes = plan.site.cranes;
  const ledger = useMemo(() => deductionLedger(plan.deductions), [plan.deductions]);
  const coverage = useMemo(() => {
    const opts = {
      swingRadiusM: plan.site.swingRadiusM,
      allowanceRel: plan.load.uncertaintyRel,
      deductionsKg: ledger.ok && plan.deductions.length > 0 ? ledger.totalKg : null,
      radiusAllowanceM: plan.crane.radiusAllowanceM,
    };
    const map = new Map<string, { all: CraneCover[]; best: CraneCover | null }>();
    for (const m of model?.members ?? []) {
      const all = cranes.map((c) => coverMember(m, c, (c.datasetId && chartById.get(c.datasetId)) || null, opts));
      map.set(m.id, { all, best: bestCover(all) });
    }
    return map;
  }, [model, cranes, chartById, plan.site.swingRadiusM, plan.load.uncertaintyRel, plan.crane.radiusAllowanceM, plan.deductions.length, ledger]);

  const craneColor = (id: string) => CRANE_COLORS[Math.max(0, cranes.findIndex((c) => c.id === id)) % CRANE_COLORS.length]!;
  const reached = (s: CoverStatus) => s === "ok" || s === "no-weight" || s === "reach-only" || s === "over";

  const colors = useMemo(() => {
    if (mode === "type" || cranes.length === 0) return null;
    const map = new Map<string, string>();
    for (const [id, c] of coverage) {
      if (!c.best) continue;
      if (mode === "capacity") map.set(id, STATUS_COLOR[c.best.status]);
      else if (reached(c.best.status)) map.set(id, c.best.status === "over" ? STATUS_COLOR.over : craneColor(c.best.craneId));
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverage, mode, cranes]);

  const tally = useMemo(() => {
    const byCrane = new Map<string, number>(cranes.map((c) => [c.id, 0]));
    const byStatus: Record<CoverStatus, number> = { ok: 0, over: 0, "no-weight": 0, "reach-only": 0, unrated: 0, out: 0 };
    for (const c of coverage.values()) {
      const s = c.best?.status ?? "out";
      byStatus[s]++;
      if (c.best && reached(s)) byCrane.set(c.best.craneId, (byCrane.get(c.best.craneId) ?? 0) + 1);
    }
    return { byCrane, byStatus };
  }, [coverage, cranes]);

  const sceneCranes: SceneCrane[] = useMemo(
    () =>
      cranes.map((c, i) => {
        const ds = (c.datasetId && chartById.get(c.datasetId)) || null;
        const rated = ds?.reviewState === "approved" ? maxRatedRadiusM(ds, c.boomLengthM) : null;
        return { id: c.id, label: String(i + 1), x: c.x, z: c.z, color: CRANE_COLORS[i % CRANE_COLORS.length]!, ringM: rated ?? plan.site.swingRadiusM };
      }),
    [cranes, chartById, plan.site.swingRadiusM],
  );

  const selMember: Member | null = sel?.kind === "member" ? (model?.members.find((m) => m.id === sel.id) ?? null) : null;
  const selCover = selMember ? coverage.get(selMember.id) : undefined;
  const selCrane = sel?.kind === "crane" ? cranes.find((c) => c.id === sel.id) : undefined;

  const boom = useMemo(() => {
    const best = selCover?.best;
    if (!selMember || !best || !reached(best.status)) return null;
    const crane = cranes.find((c) => c.id === best.craneId);
    const top: [number, number, number] = memberCentre(selMember);
    const geo = crane?.boomLengthM ? boomGeometry(crane.boomLengthM, Math.max(best.radiusM, 0.1)) : null;
    return { craneId: best.craneId, target: top, tipHeightM: geo && Number.isFinite(geo.tipHeightM) ? geo.tipHeightM : top[1] + 6 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selMember, selCover, cranes]);

  const typeCounts = useMemo(() => {
    const n: Record<MemberType, number> = { column: 0, beam: 0, brace: 0, joist: 0 };
    for (const m of model?.members ?? []) n[m.type]++;
    return n;
  }, [model]);

  const addCrane = () => {
    const xs = model?.members.flatMap((m) => [m.a[0], m.b[0]]) ?? [0];
    const zs = model?.members.flatMap((m) => [m.a[2], m.b[2]]) ?? [0];
    const n = cranes.length;
    const crane: SiteCrane = {
      id: `c${Date.now().toString(36)}`,
      name: `Crane ${n + 1}`,
      x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2 + (n % 2 === 0 ? -0.25 : 0.25) * (Math.max(...xs) - Math.min(...xs))),
      z: Math.round(Math.min(...zs) - 6),
      datasetId: charts.find((c) => c.dataset.reviewState === "approved")?.dataset.id ?? null,
      boomLengthM: null,
    };
    setSite({ cranes: [...cranes, crane] });
    setSel({ kind: "crane", id: crane.id });
  };

  const usePick = (m: Member, cover: CraneCover) => {
    const crane = cranes.find((c) => c.id === cover.craneId);
    if (!crane) return;
    const mass = memberMass(m);
    setPlanState((p) => ({
      ...p,
      name: p.name || `${m.mark || m.size} — ${crane.name}`,
      liftDescription: p.liftDescription || `${TYPE_ONE[m.type]} ${m.mark} ${m.size}`.trim(),
      load: { ...p.load, massKg: mass ? mass.massKg : p.load.massKg, evidence: mass?.basis === "designation" ? "calculated" : p.load.evidence },
      crane: { ...p.crane, radiusM: cover.radiusM, boomLengthM: crane.boomLengthM ?? p.crane.boomLengthM },
      site: { ...p.site, pickMemberId: m.id, pickCraneId: crane.id },
    }));
    setDatasetId(crane.datasetId ?? "");
  };

  const importModel = async (raw: unknown) => {
    setModelError(null);
    try {
      const { id, model: m } = await api.createModel(raw);
      setModels((await api.models()).models);
      setModel(m);
      setSite({ modelId: id, pickMemberId: null });
      setSel(null);
    } catch (e) {
      setModelError(e instanceof Error ? e.message : "Could not import the model.");
    }
  };
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      await importModel(JSON.parse(await file.text()));
    } catch {
      setModelError("That file is not a model file this app can read (JSON expected).");
    }
  };

  const act = async (fn: () => Promise<{ revision: Revision }>) => {
    setBusy(true);
    setError(null);
    try {
      const { revision } = await fn();
      setSaved(revision);
      setPlanState(revision.plan);
      setDatasetId(revision.dataset?.id ?? "");
      const fresh = await api.plan(revision.planId);
      setHistory(fresh.history);
      onSaved(revision.planId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const reviewBlock = !saved ? null : saved.author.id === user.id ? "You saved this revision, so someone else has to review it." : null;
  const approveBlock = !saved
    ? null
    : !saved.review
      ? "Waiting for review."
      : saved.author.id === user.id || saved.review.by.id === user.id
        ? "The approver must be a third person — not the author or the reviewer."
        : saved.evaluation.synthetic
          ? "The chart is synthetic demo data and cannot support an approved plan."
          : saved.evaluation.state !== "WITHIN_LIMITS"
            ? "Every check must be within stated limits, with nothing left for review."
            : null;

  const exportJson = () => {
    if (!saved || dirty) return;
    const pkg = {
      schema: "lift-package/0.3",
      exportedAt: new Date().toISOString(),
      status: saved.approval ? "APPROVED_FOR_DOCUMENTED_SCOPE_AND_REVISION" : saved.evaluation.state,
      limitations: "Planning record only. Not an engineering certification, regulatory approval, operator qualification or authorization to lift.",
      revision: saved,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(plan.name || "lift-plan").replace(/[^\w.-]+/g, "_")}-rev${saved.rev}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleLayer = (k: LayerKey) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  if (loading) return <p className="muted pad">Loading plan…</p>;

  const fmt = (kind: "mass" | "length" | "ratio", v: number) => formatQuantity(kind, v, system);
  const chartOptions = [{ value: "", label: "— no chart —" }, ...charts.map((c) => ({ value: c.dataset.id, label: `${c.dataset.label || "Untitled chart"}${c.dataset.reviewState === "approved" ? "" : " (not reviewed)"}` }))];
  const legend: Array<[string, string, number | null]> =
    cranes.length === 0 || mode === "type"
      ? (Object.keys(TYPE_LABEL) as MemberType[]).map((t) => [TYPE_COLOR[t], TYPE_LABEL[t], typeCounts[t]])
      : mode === "crane"
        ? [...cranes.map((c, i): [string, string, number | null] => [CRANE_COLORS[i % CRANE_COLORS.length]!, c.name, tally.byCrane.get(c.id) ?? 0]), [STATUS_COLOR.over, "Over capacity", tally.byStatus.over], [STATUS_COLOR.out, "Out of reach", tally.byStatus.out + tally.byStatus.unrated]]
        : [
            [STATUS_COLOR.ok, "Within chart", tally.byStatus.ok],
            [STATUS_COLOR["no-weight"], "Weight unknown", tally.byStatus["no-weight"]],
            [STATUS_COLOR["reach-only"], "Reach only", tally.byStatus["reach-only"]],
            [STATUS_COLOR.over, "Over capacity", tally.byStatus.over],
            [STATUS_COLOR.out, "Out of reach", tally.byStatus.out + tally.byStatus.unrated],
          ];

  return (
    <main className="workspace">
      <div className="stage">
        <Scene3D
          model={model}
          cranes={sceneCranes}
          colors={colors}
          selectedId={selMember?.id ?? null}
          hiddenLayers={hidden}
          boom={boom}
          view={view}
          onSelect={setSel}
          onMoveCrane={(id, x, z) => setCrane(id, { x, z })}
        />
        <div className="stage-top no-print">
          <button
            type="button"
            className="chip"
            onClick={() => {
              if (!dirty || pristine || window.confirm("Leave without saving? Changes since the last saved revision will be lost.")) onBack();
            }}
          >
            ← Plans
          </button>
          <span className="spacer" />
          {(["iso", "plan", "sw", "ne"] as ViewName[]).map((v) => (
            <button key={v} type="button" className="chip" onClick={() => setView({ name: v, n: view.n + 1 })}>
              {v === "iso" ? "Iso" : v === "plan" ? "Plan" : v === "sw" ? "From SW" : "From NE"}
            </button>
          ))}
        </div>
        {model && (
          <ul className="legend">
            {legend
              .filter(([, , n]) => n === null || n > 0 || cranes.length > 0)
              .map(([color, label, n]) => (
                <li key={label}>
                  <span className="sw" style={{ background: color }} />
                  {label}
                  {n !== null && <b>{n}</b>}
                </li>
              ))}
          </ul>
        )}
        {!model && (
          <div className="stage-empty">
            <p>No steel model on this plan yet.</p>
            <p className="muted">Open “Steel model” in the panel to load one. You can still plan a single pick without it.</p>
          </div>
        )}
        <p className="stage-hint no-print">Drag to orbit · two fingers or right-drag to pan · pinch or scroll to zoom · tap a piece · drag a crane to move it</p>
      </div>

      <aside className="panel">
        <section className={`verdict ${released ? "ok" : STATE_CLASS[shown.state]}`}>
          <div>
            <span className="eyebrow">{plan.name || "Unnamed lift"}</span>
            <strong>{released ? "Approved for the documented scope and revision" : STATE_LABEL[shown.state]}</strong>
          </div>
          <span className="muted">{saved ? `Rev ${saved.rev}${dirty ? " · unsaved changes" : ""}` : "Not saved"}</span>
        </section>

        <Group title="Selected" defaultOpen>
          {!selMember && !selCrane && <p className="muted">Tap a column, beam, brace or joist to see its mark, size, weight and which crane can set it. Tap a crane to edit it.</p>}
          {selMember && (
            <div className="selected">
              <div className="mark">{selMember.mark && selMember.mark !== "J" && selMember.mark !== "—" ? selMember.mark : selMember.size}</div>
              <dl className="facts">
                <dt>Type</dt>
                <dd>{TYPE_ONE[selMember.type]}</dd>
                <dt>Size</dt>
                <dd>{selMember.size || "—"}</dd>
                <dt>Length</dt>
                <dd>{fmt("length", memberLengthM(selMember))}</dd>
                <dt>Weight</dt>
                <dd>
                  {(() => {
                    const mass = memberMass(selMember);
                    return mass ? `${fmt("mass", mass.massKg)} (${mass.basis === "given" ? "from model" : "from designation × length"})` : "Not known — enter it in the pick check";
                  })()}
                </dd>
                {selMember.elevationNote && (
                  <>
                    <dt>Elevation</dt>
                    <dd>{selMember.elevationNote}</dd>
                  </>
                )}
                {selMember.sheet && (
                  <>
                    <dt>Sheet</dt>
                    <dd>{selMember.sheet}</dd>
                  </>
                )}
              </dl>
              {cranes.length === 0 && <p className="muted top">Add a crane to see whether it can set this piece.</p>}
              {selCover?.all.map((c) => {
                const crane = cranes.find((k) => k.id === c.craneId)!;
                return (
                  <div className="cover" key={c.craneId} style={{ borderLeftColor: craneColor(c.craneId) }}>
                    <div className="cover-head">
                      <strong>{crane.name}</strong>
                      <span className="pill" style={{ background: STATUS_COLOR[c.status], color: "#fff" }}>
                        {STATUS_LABEL[c.status]}
                      </span>
                    </div>
                    <dl className="metrics">
                      <div>
                        <dt>Set radius</dt>
                        <dd>{fmt("length", c.radiusM)}</dd>
                      </div>
                      {c.capacityKg !== null && (
                        <div>
                          <dt>Chart capacity</dt>
                          <dd>{fmt("mass", c.capacityKg)}</dd>
                        </div>
                      )}
                      {c.utilization !== null && (
                        <div>
                          <dt>Of capacity</dt>
                          <dd>{fmt("ratio", c.utilization)}</dd>
                        </div>
                      )}
                    </dl>
                    <p className="muted">{c.reason}</p>
                    <button type="button" className="btn small" onClick={() => usePick(selMember, c)}>
                      Check this pick with {crane.name}
                    </button>
                  </div>
                );
              })}
              {plan.site.pickMemberId === selMember.id && <p className="pill ok top">The pick check below is filled in from this piece</p>}
            </div>
          )}
          {selCrane && (
            <div className="selected">
              <div className="mark" style={{ color: craneColor(selCrane.id) }}>
                {selCrane.name}
              </div>
              <p className="muted">{locate(model, selCrane.x, selCrane.z, system)}</p>
              <div className="stack top">
                <TextField label="Name" value={selCrane.name} onChange={(name) => setCrane(selCrane.id, { name })} />
                <SelectField label="Load chart" value={selCrane.datasetId ?? ""} options={chartOptions} onChange={(v) => setCrane(selCrane.id, { datasetId: v || null })} />
                <NumField label="Boom length" kind="length" system={system} value={selCrane.boomLengthM} onChange={(boomLengthM) => setCrane(selCrane.id, { boomLengthM })} hint="Coverage is read from the chart at this boom length." />
              </div>
              <div className="row">
                <button
                  type="button"
                  className="btn small danger"
                  onClick={() => {
                    setSite({ cranes: cranes.filter((c) => c.id !== selCrane.id) });
                    setSel(null);
                  }}
                >
                  Remove crane
                </button>
              </div>
            </div>
          )}
        </Group>

        <Group title="Cranes & coverage" defaultOpen>
          {cranes.length === 0 && <p className="muted">Add a crane, then drag it in the model. Steel is colored by what the crane's load chart allows at each piece's set position.</p>}
          <ul className="crane-list">
            {cranes.map((c, i) => (
              <li key={c.id}>
                <button type="button" className="crane-row" onClick={() => setSel({ kind: "crane", id: c.id })}>
                  <span className="sw" style={{ background: CRANE_COLORS[i % CRANE_COLORS.length] }} />
                  <span className="grow">
                    <strong>{c.name}</strong>
                    <span className="muted">
                      {c.datasetId ? (chartById.get(c.datasetId)?.label ?? "Chart removed") : "No chart"} · {c.boomLengthM ? `${fmt("length", c.boomLengthM)} boom` : "no boom length"}
                    </span>
                    <span className="muted">{locate(model, c.x, c.z, system)}</span>
                  </span>
                  <b className="count">{tally.byCrane.get(c.id) ?? 0}</b>
                </button>
              </li>
            ))}
          </ul>
          <div className="row tight">
            <button type="button" className="btn small primary" onClick={addCrane} disabled={cranes.length >= 6}>
              Add crane
            </button>
          </div>
          <div className="stack top">
            <SelectField
              label="Color steel by"
              value={mode}
              onChange={setMode}
              options={[
                { value: "capacity", label: "Chart capacity" },
                { value: "crane", label: "Covering crane" },
                { value: "type", label: "Member type" },
              ]}
            />
            <NumField label="Swing radius for cranes without a chart" kind="length" system={system} value={plan.site.swingRadiusM} onChange={(swingRadiusM) => setSite({ swingRadiusM })} hint="A plain circle. It shows reach only, never capacity." />
          </div>
          {cranes.length > 0 && (plan.deductions.length === 0 || !ledger.ok) && <p className="banner warn top">Add the hook block and rigging weights under “Crane set-up” to get percent of capacity. Until then pieces show as “weight unknown”.</p>}
          <p className="fineprint">
            Coverage uses each piece's center at its set position against the chart. It does not check hook height, boom clearance to the structure, the pick-up radius, rigging or the
            ground, and it is not part of what gets approved.
          </p>
        </Group>

        <Group title="Steel model" defaultOpen>
          <div className="stack">
            <SelectField label="Model" value={modelId ?? ""} onChange={(v) => setSite({ modelId: v || null, pickMemberId: null })} options={[{ value: "", label: "— none —" }, ...models.map((m) => ({ value: m.id, label: `${m.name} (${m.memberCount})` }))]} />
          </div>
          {model?.note && <p className="muted top">{model.note}</p>}
          {modelError && <p className="banner bad top">{modelError}</p>}
          <div className="row">
            <label className="btn small">
              Import model file
              <input type="file" accept=".json,application/json" hidden onChange={(e) => void onFile(e)} />
            </label>
            <button type="button" className="btn small" onClick={() => void importModel(sampleModel())}>
              Load sample frame
            </button>
          </div>
          {model && (
            <div className="layers top">
              {(Object.keys(TYPE_LABEL) as MemberType[]).map((t) => (
                <label key={t}>
                  <input type="checkbox" checked={!hidden.has(t)} onChange={() => toggleLayer(t)} />
                  <span className="sw" style={{ background: TYPE_COLOR[t] }} />
                  {TYPE_LABEL[t]}
                  <b className="count">{typeCounts[t]}</b>
                </label>
              ))}
              {(
                [
                  ["grid", "Grids"],
                  ["walls", "Walls (context)"],
                  ["cranes", "Cranes"],
                ] as Array<[LayerKey, string]>
              ).map(([k, label]) => (
                <label key={k}>
                  <input type="checkbox" checked={!hidden.has(k)} onChange={() => toggleLayer(k)} />
                  {label}
                </label>
              ))}
            </div>
          )}
        </Group>

        <h2 className="panel-title">Pick check</h2>
        <Group title="Load chart for the check">
          <SelectField label="Chart for this crane configuration" value={datasetId} onChange={setDatasetId} options={chartOptions} />
          {dataset && (
            <p className="muted top">
              {dataset.configurationKey} · {dataset.sourceDocument} rev {dataset.revision} · {dataset.convention} capacities
            </p>
          )}
          {dataset?.synthetic && <p className="banner warn">SYNTHETIC — NOT OEM DATA. A plan using this chart cannot be approved.</p>}
          {dataset && dataset.reviewState !== "approved" && <p className="banner warn">This chart has not been checked by a second person, so it cannot give a result yet.</p>}
        </Group>
        <Group title="Lift">
          <div className="grid">
            <TextField label="Lift number / name" value={plan.name} onChange={(name) => setPlan({ name })} />
            <TextField label="What is being lifted, and where" value={plan.liftDescription} onChange={(liftDescription) => setPlan({ liftDescription })} />
            <NumField label="Load weight" kind="mass" system={system} value={plan.load.massKg} onChange={(massKg) => setPlan({ load: { ...plan.load, massKg } })} />
            <SelectField label="How the weight is known" value={plan.load.evidence} options={EVIDENCE} onChange={(evidence) => setPlan({ load: { ...plan.load, evidence } })} />
            <NumField
              label="Weight allowance"
              kind="ratio"
              system={system}
              value={plan.load.uncertaintyRel}
              onChange={(uncertaintyRel) => setPlan({ load: { ...plan.load, uncertaintyRel } })}
              hint="Added to the load. Leave empty if not stated — that is flagged, not treated as zero."
            />
          </div>
        </Group>

        <Group title="Crane set-up">
          <div className="grid">
            <NumField label="Boom length" kind="length" system={system} value={plan.crane.boomLengthM} onChange={(boomLengthM) => setPlan({ crane: { ...plan.crane, boomLengthM } })} />
            <NumField label="Planned radius" kind="length" system={system} value={plan.crane.radiusM} onChange={(radiusM) => setPlan({ crane: { ...plan.crane, radiusM } })} hint="Slew centre to hook, at the farthest point of the lift." />
            <NumField
              label="Radius growth under load"
              kind="length"
              system={system}
              value={plan.crane.radiusAllowanceM}
              onChange={(radiusAllowanceM) => setPlan({ crane: { ...plan.crane, radiusAllowanceM } })}
              hint="Boom deflection is not modelled. Enter an allowance; enter 0 only if confirmed."
            />
            <NumField label="Parts of line" kind="count" system={system} value={plan.crane.partsOfLine} onChange={(partsOfLine) => setPlan({ crane: { ...plan.crane, partsOfLine } })} />
            <NumField label="Permissible single-line pull" kind="mass" system={system} value={plan.crane.singleLinePullKg} onChange={(singleLinePullKg) => setPlan({ crane: { ...plan.crane, singleLinePullKg } })} />
          </div>

          <h3>Everything else on the hook</h3>
          <p className="muted">Hook block, slings, shackles, spreader, stowed jib, load line beyond the chart's allowance. Each item once.</p>
          {plan.deductions.map((d, i) => (
            <div className="grid deduction" key={d.id}>
              <TextField label="Item" value={d.label} onChange={(label) => setPlan({ deductions: plan.deductions.map((x, k) => (k === i ? { ...x, label } : x)) })} />
              <NumField label="Weight" kind="mass" system={system} value={d.massKg} onChange={(massKg) => setPlan({ deductions: plan.deductions.map((x, k) => (k === i ? { ...x, massKg } : x)) })} />
              <button type="button" className="btn small" onClick={() => setPlan({ deductions: plan.deductions.filter((_, k) => k !== i) })}>
                Remove
              </button>
            </div>
          ))}
          <div className="row">
            <button type="button" className="btn" onClick={() => setPlan({ deductions: [...plan.deductions, { id: `d-${Date.now().toString(36)}`, label: "", massKg: null }] })}>
              Add item
            </button>
          </div>
        </Group>

        <Group title="Rigging">
          <label className="checkbox">
            <input type="checkbox" checked={plan.rigging.enabled} onChange={(e) => setPlan({ rigging: { ...plan.rigging, enabled: e.target.checked } })} />
            Check a two-leg sling arrangement
          </label>
          {plan.rigging.enabled && (
            <div className="grid">
              <NumField label="Leg 1 angle from horizontal" kind="angle" system={system} value={plan.rigging.angle1Deg} onChange={(angle1Deg) => setPlan({ rigging: { ...plan.rigging, angle1Deg } })} />
              <NumField label="Leg 2 angle from horizontal" kind="angle" system={system} value={plan.rigging.angle2Deg} onChange={(angle2Deg) => setPlan({ rigging: { ...plan.rigging, angle2Deg } })} />
              <NumField label="Leg 1 rated WLL as rigged" kind="mass" system={system} value={plan.rigging.wll1Kg} onChange={(wll1Kg) => setPlan({ rigging: { ...plan.rigging, wll1Kg } })} hint="Lowest of sling (for its hitch) and hardware." />
              <NumField label="Leg 2 rated WLL as rigged" kind="mass" system={system} value={plan.rigging.wll2Kg} onChange={(wll2Kg) => setPlan({ rigging: { ...plan.rigging, wll2Kg } })} />
              <TextField
                label="Lift-point adequacy — evidence reference"
                value={plan.rigging.liftPointEvidenceRef}
                onChange={(liftPointEvidenceRef) => setPlan({ rigging: { ...plan.rigging, liftPointEvidenceRef } })}
                hint="Calc, drawing or engineer's letter for the lugs / lifting device."
              />
            </div>
          )}
        </Group>

        <Group title="Ground">
          <div className="grid">
            <NumField label="Maximum outrigger / track reaction" kind="force" system={system} value={plan.ground.reactionN} onChange={(reactionN) => setPlan({ ground: { ...plan.ground, reactionN } })} hint="Worst single support over the swing of the lift." />
            <TextField label="Where the reaction comes from" value={plan.ground.reactionSource} onChange={(reactionSource) => setPlan({ ground: { ...plan.ground, reactionSource } })} placeholder="OEM outrigger-load table, engineer's calc" />
            <NumField label="Mat length" kind="length" system={system} value={plan.ground.matLengthM} onChange={(matLengthM) => setPlan({ ground: { ...plan.ground, matLengthM } })} />
            <NumField label="Mat width" kind="length" system={system} value={plan.ground.matWidthM} onChange={(matWidthM) => setPlan({ ground: { ...plan.ground, matWidthM } })} />
            <NumField label="Mat weight" kind="mass" system={system} value={plan.ground.matMassKg} onChange={(matMassKg) => setPlan({ ground: { ...plan.ground, matMassKg } })} />
            <NumField label="Allowable bearing pressure" kind="pressure" system={system} value={plan.ground.allowableBearingPa} onChange={(allowableBearingPa) => setPlan({ ground: { ...plan.ground, allowableBearingPa } })} />
            <TextField label="Source of the allowable" value={plan.ground.allowableSource} onChange={(allowableSource) => setPlan({ ground: { ...plan.ground, allowableSource } })} placeholder="Geotechnical report, engineer's letter" />
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={plan.ground.fullAreaAttested} onChange={(e) => setPlan({ ground: { ...plan.ground, fullAreaAttested: e.target.checked } })} />
            An engineer has confirmed the mat spreads load over its full footprint
          </label>
        </Group>

        <Group title="Wind and project limits">
          <div className="grid">
            <NumField label="Gust speed for the lift" kind="speed" system={system} value={plan.wind.gustMs} onChange={(gustMs) => setPlan({ wind: { ...plan.wind, gustMs } })} />
            <SelectField
              label="Wind figure is"
              value={plan.wind.source}
              onChange={(source) => setPlan({ wind: { ...plan.wind, source } })}
              options={[
                { value: "forecast", label: "Forecast" },
                { value: "measured", label: "Measured at site" },
              ]}
            />
            <NumField label="Project wind limit (if lower than OEM)" kind="speed" system={system} value={plan.thresholds.projectWindLimitMs} onChange={(projectWindLimitMs) => setPlan({ thresholds: { ...plan.thresholds, projectWindLimitMs } })} />
            <NumField
              label="Chart utilization needing review"
              kind="ratio"
              system={system}
              value={plan.thresholds.reviewUtilization}
              onChange={(reviewUtilization) => setPlan({ thresholds: { ...plan.thresholds, reviewUtilization } })}
              hint="Your project's critical-lift line. None is built in."
            />
            <NumField label="Minimum sling angle from horizontal" kind="angle" system={system} value={plan.thresholds.minSlingAngleDeg} onChange={(minSlingAngleDeg) => setPlan({ thresholds: { ...plan.thresholds, minSlingAngleDeg } })} hint="From your rigging procedure. None is built in." />
          </div>
        </Group>

        <h2 className="panel-title">Result</h2>
        <section className="group flat">
          <div className="print-only">
            <h2>{plan.name || "Lift plan"}</h2>
            <p>{plan.liftDescription}</p>
            <p>{dataset ? `Chart: ${dataset.label} — ${dataset.configurationKey} (${dataset.sourceDocument}, rev ${dataset.revision})` : "No chart selected"}</p>
          </div>
          {shown.synthetic && <p className="banner warn">SYNTHETIC — NOT OEM DATA. Demonstration only.</p>}
          <div className="revision">
            {saved ? (
              <p>
                <strong>Revision {saved.rev}</strong> saved by {saved.author.name}, {new Date(saved.createdAt).toLocaleString()}
                <br />
                {saved.review ? `Reviewed by ${saved.review.by.name}` : "Not reviewed"} · {saved.approval ? `Approved by ${saved.approval.by.name}` : "Not approved"}
              </p>
            ) : (
              <p>Not saved yet.</p>
            )}
            {saved && dirty && inputsHash !== null && (
              <p className="banner bad">
                {saved.approval || saved.review ? `Changed since revision ${saved.rev}. Its review and approval do not cover what is on screen — save a new revision.` : `Changed since revision ${saved.rev}. Save to record it.`}
              </p>
            )}
            {error && <p className="banner bad">{error}</p>}
            <div className="row tight no-print">
              <button type="button" className="btn primary" disabled={busy || !dirty || inputsHash === null} onClick={() => void act(() => api.saveRevision(saved?.planId ?? null, plan, datasetId || null))}>
                {saved ? "Save as new revision" : "Save plan"}
              </button>
              {saved && !dirty && !saved.review && (
                <button type="button" className="btn" disabled={busy || reviewBlock !== null} onClick={() => void act(() => api.review(saved.id))}>
                  Mark reviewed
                </button>
              )}
              {saved && !dirty && saved.review && !saved.approval && (
                <button type="button" className="btn" disabled={busy || approveBlock !== null} onClick={() => void act(() => api.approve(saved.id))}>
                  Approve this revision
                </button>
              )}
            </div>
            {saved && !dirty && !saved.review && reviewBlock && <p className="muted top no-print">{reviewBlock}</p>}
            {saved && !dirty && !saved.approval && approveBlock && <p className="muted top no-print">{approveBlock}</p>}
          </div>
          {shown.checks.map((c) => (
            <CheckCard key={c.id} check={c} system={system} />
          ))}
          <p className="fineprint">
            This is a planning record. It is not an engineering certification, a regulatory approval, an operator qualification or authorization to lift. The crane manufacturer's manual
            and load chart govern. Fingerprint: <code>{inputsHash ? inputsHash.slice(0, 16) : "…"}</code> · kernel {shown.kernelVersion}
          </p>
          <div className="row tight no-print">
            <button type="button" className="btn small" disabled={dirty} onClick={() => window.print()}>
              Print lift package
            </button>
            <button type="button" className="btn small" disabled={dirty} onClick={exportJson}>
              Export JSON
            </button>
          </div>
          {dirty && <p className="muted top no-print">Save the plan to print or export it.</p>}
          {history.length > 1 && (
            <details className="history no-print">
              <summary>Revision history ({history.length})</summary>
              <ul className="notes">
                {history.map((h) => (
                  <li key={h.rev}>
                    Rev {h.rev} — {h.author}, {new Date(h.createdAt).toLocaleString()}
                    {h.reviewedBy ? ` · reviewed by ${h.reviewedBy}` : ""}
                    {h.approvedBy ? ` · approved by ${h.approvedBy}` : ""}
                    {h.rev < (saved?.rev ?? 0) ? " · superseded" : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      </aside>
    </main>
  );
}

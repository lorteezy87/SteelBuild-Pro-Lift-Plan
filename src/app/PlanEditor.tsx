import { useEffect, useMemo, useState } from "react";
import { fingerprintInput, sha256Hex } from "../kernel/approval";
import { type Check, type Evaluation, type LiftPlan, type ResultState, STATE_LABEL, type WeightEvidence, emptyPlan, evaluatePlan } from "../kernel/evaluate";
import { STANDARD_GRAVITY, type UnitSystem } from "../kernel/units";
import { type ChartRecord, type HistoryEntry, type Revision, type User, api } from "./api";
import { ChartTable } from "./ChartsPage";
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

function Sketch({ evaluation, system }: { evaluation: Evaluation; system: UnitSystem }) {
  const s = evaluation.sketch;
  if (!s) return null;
  const w = 360;
  const h = 240;
  const pad = 30;
  const scale = Math.min((w - 2 * pad) / Math.max(s.loadedRadiusM, 1), (h - 2 * pad) / Math.max(s.tipHeightM, 1));
  const x0 = pad;
  const y0 = h - pad;
  const tx = x0 + s.loadedRadiusM * scale;
  const ty = y0 - s.tipHeightM * scale;
  const hookY = y0 - Math.max(s.tipHeightM * scale * 0.35, 18);
  return (
    <figure className="sketch">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Elevation sketch of boom, radius and load">
        <line x1={8} y1={y0} x2={w - 8} y2={y0} className="sk-ground" />
        <rect x={x0 - 22} y={y0 - 14} width={44} height={14} className="sk-body" />
        <line x1={x0} y1={y0 - 14} x2={tx} y2={ty} className="sk-boom" />
        <line x1={tx} y1={ty} x2={tx} y2={hookY} className="sk-line" />
        <rect x={tx - 12} y={hookY} width={24} height={16} className="sk-load" />
        <line x1={x0} y1={y0 + 12} x2={tx} y2={y0 + 12} className="sk-dim" />
        <text x={(x0 + tx) / 2} y={y0 + 25} textAnchor="middle" className="sk-text">
          {formatQuantity("length", s.loadedRadiusM, system)}
        </text>
        <text x={x0 + 30} y={y0 - 22} className="sk-text">
          {s.boomAngleDeg.toFixed(1)}°
        </text>
      </svg>
      <figcaption>Not to scale in detail. Boom drawn rigid from the slew axis; heel-pin offset and deflection are not shown.</figcaption>
    </figure>
  );
}

const EVIDENCE: Array<{ value: WeightEvidence; label: string }> = [
  { value: "weighed", label: "Weighed" },
  { value: "manufacturer", label: "Manufacturer / shipping weight" },
  { value: "calculated", label: "Calculated from dimensions" },
  { value: "estimated", label: "Estimated" },
];

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

  const dataset = charts.find((c) => c.dataset.id === datasetId)?.dataset ?? null;
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
  // "Dirty" also covers a chart that was approved after the revision was saved: the fingerprint includes it.
  const dirty = saved === null || inputsHash === null || inputsHash !== saved.inputsHash;
  const pristine = saved === null && datasetId === "" && JSON.stringify(plan) === JSON.stringify(emptyPlan());
  const released = !dirty && saved?.approval != null;
  const shown: Evaluation = !dirty && saved ? saved.evaluation : evaluation;

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
      schema: "lift-package/0.2",
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

  if (loading) return <p className="muted pad">Loading plan…</p>;

  return (
    <main className="layout">
      <div className="inputs no-print">
        <div className="row tight">
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (!dirty || pristine || window.confirm("Leave without saving? Changes since the last saved revision will be lost.")) onBack();
            }}
          >
            ← All plans
          </button>
        </div>

        <section className="card">
          <h2>1. Load chart</h2>
          {charts.length === 0 ? (
            <p className="muted">No charts have been entered yet. Add one under “Charts”.</p>
          ) : (
            <SelectField
              label="Chart for this crane configuration"
              value={datasetId}
              onChange={setDatasetId}
              options={[{ value: "", label: "— select a chart —" }, ...charts.map((c) => ({ value: c.dataset.id, label: `${c.dataset.label || "Untitled chart"}${c.dataset.reviewState === "approved" ? "" : " (not reviewed)"}` }))]}
            />
          )}
          {dataset && (
            <>
              <p className="muted top">
                {dataset.configurationKey} · {dataset.sourceDocument} rev {dataset.revision} · {dataset.convention} capacities
              </p>
              {dataset.synthetic && <p className="banner warn">SYNTHETIC — NOT OEM DATA. Invented numbers for demonstration. A plan using this chart cannot be approved.</p>}
              {dataset.reviewState !== "approved" && <p className="banner warn">This chart has not been checked by a second person, so it cannot give a result yet.</p>}
              <ChartTable dataset={dataset} system={system} />
            </>
          )}
        </section>

        <section className="card">
          <h2>2. Lift</h2>
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
        </section>

        <section className="card">
          <h2>3. Crane set-up</h2>
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
        </section>

        <section className="card">
          <h2>4. Rigging</h2>
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
        </section>

        <section className="card">
          <h2>5. Ground</h2>
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
        </section>

        <section className="card">
          <h2>6. Wind and project limits</h2>
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
        </section>
      </div>

      <aside className="results">
        <section className="card">
          <div className="print-only">
            <h2>{plan.name || "Lift plan"}</h2>
            <p>{plan.liftDescription}</p>
            <p>{dataset ? `Chart: ${dataset.label} — ${dataset.configurationKey} (${dataset.sourceDocument}, rev ${dataset.revision})` : "No chart selected"}</p>
          </div>
          <h2>Result</h2>
          <p className={`status ${released ? "ok" : STATE_CLASS[shown.state]}`}>{released ? "Approved for the documented scope and revision" : STATE_LABEL[shown.state]}</p>
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

          <Sketch evaluation={shown} system={system} />
          {shown.checks.map((c) => (
            <CheckCard key={c.id} check={c} system={system} />
          ))}
          <p className="fineprint">
            This is a planning record. It is not an engineering certification, a regulatory approval, an operator qualification or authorization to lift. The crane
            manufacturer's manual and load chart govern. Fingerprint: <code>{inputsHash ? inputsHash.slice(0, 16) : "…"}</code> · kernel {shown.kernelVersion}
          </p>
          <div className="row tight no-print">
            <button type="button" className="btn" disabled={dirty} onClick={() => window.print()}>
              Print lift package
            </button>
            <button type="button" className="btn" disabled={dirty} onClick={exportJson}>
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

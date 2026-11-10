/**
 * evaluate.ts — evaluate one lift step and return a result state per check.
 *
 * Rules that hold for every check:
 *   - A missing input is DRAFT, never zero.
 *   - Something outside the data is UNSUPPORTED, never a pass.
 *   - A threshold nobody set is "not evaluated" and needs review, never a pass.
 *   - No safety limit is compiled in here except 100% of rated capacity /
 *     rated working load limit. Everything else comes from `thresholds`.
 */
import { type ChartDataset, lookupCapacity } from "./chart";
import { averagePressure, boomGeometry, twoLegTensions } from "./mechanics";
import { type PlanSite, emptySite } from "./site";
import { type QuantityKind, STANDARD_GRAVITY } from "./units";

export const KERNEL_VERSION = "0.3.0";

export type ResultState = "WITHIN_LIMITS" | "REVIEW_REQUIRED" | "LIMIT_EXCEEDED" | "DRAFT" | "UNSUPPORTED" | "INVALID";

/** Worst last. A plan's state is the worst of its checks. */
const SEVERITY: ResultState[] = ["WITHIN_LIMITS", "REVIEW_REQUIRED", "LIMIT_EXCEEDED", "DRAFT", "UNSUPPORTED", "INVALID"];

export function worstState(states: ResultState[]): ResultState {
  let worst = 0;
  for (const s of states) worst = Math.max(worst, SEVERITY.indexOf(s));
  return SEVERITY[worst]!;
}

export const STATE_LABEL: Record<ResultState, string> = {
  WITHIN_LIMITS: "Calculated within stated limits",
  REVIEW_REQUIRED: "Review required",
  LIMIT_EXCEEDED: "Limit exceeded",
  DRAFT: "Draft — incomplete",
  UNSUPPORTED: "Unsupported",
  INVALID: "Invalid input",
};

export type WeightEvidence = "weighed" | "manufacturer" | "calculated" | "estimated";

export interface Deduction {
  id: string;
  label: string;
  massKg: number | null;
}

export interface LiftPlan {
  name: string;
  liftDescription: string;
  load: {
    massKg: number | null;
    evidence: WeightEvidence;
    /** Relative uncertainty on the load weight, e.g. 0.03. null = not stated (not zero). */
    uncertaintyRel: number | null;
  };
  crane: {
    boomLengthM: number | null;
    /** Planned hook radius before deflection. */
    radiusM: number | null;
    /** Engineer-entered radius growth under load. null = not addressed; 0 must be entered deliberately. */
    radiusAllowanceM: number | null;
    partsOfLine: number | null;
    /** Permissible single-line pull, expressed as mass per part of line. */
    singleLinePullKg: number | null;
  };
  /** Everything else hanging from the boom tip: hook block, rigging, stowed jib, etc. */
  deductions: Deduction[];
  rigging: {
    enabled: boolean;
    /** Leg angles measured from horizontal. */
    angle1Deg: number | null;
    angle2Deg: number | null;
    /** Rated working load limit of each leg as configured (hitch and hardware included). */
    wll1Kg: number | null;
    wll2Kg: number | null;
    /** Reference to the evidence that the lift points / below-the-hook device are adequate. */
    liftPointEvidenceRef: string;
  };
  ground: {
    /** Maximum single-support reaction over the slew range, from OEM data or an engineer. */
    reactionN: number | null;
    reactionSource: string;
    matMassKg: number | null;
    matLengthM: number | null;
    matWidthM: number | null;
    /** An engineer has confirmed the mat spreads load over its whole footprint. */
    fullAreaAttested: boolean;
    allowableBearingPa: number | null;
    allowableSource: string;
  };
  wind: {
    gustMs: number | null;
    source: "forecast" | "measured";
  };
  thresholds: {
    /** Chart utilization above which the lift needs review (e.g. a project "critical lift" line). */
    reviewUtilization: number | null;
    /** Minimum sling angle from horizontal. */
    minSlingAngleDeg: number | null;
    /** Project wind limit, if lower than the OEM limit. */
    projectWindLimitMs: number | null;
  };
  /** Steel model, crane positions and which piece the check above was filled in from. */
  site: PlanSite;
}

export interface Metric {
  label: string;
  value: number;
  kind: QuantityKind;
}

export interface Check {
  id: "chart" | "line-pull" | "rigging" | "ground" | "wind";
  title: string;
  state: ResultState;
  metrics: Metric[];
  /** Plain statements: reasons, sources, limits of applicability, items not evaluated. */
  notes: string[];
}

export interface Evaluation {
  kernelVersion: string;
  gravity: number;
  state: ResultState;
  checks: Check[];
  synthetic: boolean;
  sketch: { boomAngleDeg: number; tipHeightM: number; loadedRadiusM: number } | null;
}

function isNum(x: number | null | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

interface Ledger {
  ok: boolean;
  totalKg: number;
  problems: string[];
}

/** Each suspended item counts exactly once and must have a mass. */
export function deductionLedger(items: Deduction[]): Ledger {
  const problems: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const d of items) {
    const key = d.label.trim().toLowerCase();
    if (key === "") problems.push("A suspended item has no description.");
    else if (seen.has(key)) problems.push(`'${d.label}' is listed more than once.`);
    seen.add(key);
    if (!isNum(d.massKg) || d.massKg < 0) problems.push(`'${d.label || "item"}' has no weight.`);
    else total += d.massKg;
  }
  return { ok: problems.length === 0, totalKg: total, problems };
}

interface Demand {
  state: ResultState;
  notes: string[];
  loadUpperKg: number;
  hookLoadKg: number;
  ledger: Ledger;
}

function demand(plan: LiftPlan): Demand {
  const notes: string[] = [];
  const ledger = deductionLedger(plan.deductions);
  const base: Demand = { state: "WITHIN_LIMITS", notes, loadUpperKg: NaN, hookLoadKg: NaN, ledger };
  const { massKg, uncertaintyRel, evidence } = plan.load;
  if (!isNum(massKg)) return { ...base, state: "DRAFT", notes: ["Load weight has not been entered."] };
  if (massKg <= 0) return { ...base, state: "INVALID", notes: ["Load weight must be greater than zero."] };
  if (isNum(uncertaintyRel) && (uncertaintyRel < 0 || uncertaintyRel > 1)) {
    return { ...base, state: "INVALID", notes: ["Weight uncertainty must be between 0% and 100%."] };
  }
  if (!ledger.ok) return { ...base, state: "INVALID", notes: ledger.problems };
  let state: ResultState = "WITHIN_LIMITS";
  if (!isNum(uncertaintyRel)) {
    state = "REVIEW_REQUIRED";
    notes.push("Weight uncertainty not stated; no allowance has been added to the load.");
  }
  if (evidence === "estimated") {
    state = "REVIEW_REQUIRED";
    notes.push("Load weight is an estimate. Confirm it from a recognized source before the lift.");
  }
  const loadUpperKg = massKg * (1 + (isNum(uncertaintyRel) ? uncertaintyRel : 0));
  return { state, notes, loadUpperKg, hookLoadKg: loadUpperKg + ledger.totalKg, ledger };
}

function chartCheck(plan: LiftPlan, dataset: ChartDataset | null, d: Demand): { check: Check; loadedRadiusM: number } {
  const check: Check = { id: "chart", title: "Crane capacity (load chart)", state: d.state, metrics: [], notes: [...d.notes] };
  const out = (state: ResultState, note?: string, loadedRadiusM = NaN) => {
    check.state = worstState([check.state, state]);
    if (note) check.notes.push(note);
    return { check, loadedRadiusM };
  };
  const { boomLengthM, radiusM, radiusAllowanceM } = plan.crane;
  if (!isNum(boomLengthM) || !isNum(radiusM)) return out("DRAFT", "Boom length and radius have not been entered.");
  if (!isNum(radiusAllowanceM)) {
    return out("DRAFT", "Radius growth under load (boom deflection) is not modelled. Enter an allowance — 0 if an engineer has confirmed none is needed.");
  }
  if (radiusAllowanceM < 0) return out("INVALID", "Radius allowance cannot be negative.");
  const loadedRadiusM = radiusM + radiusAllowanceM;
  check.metrics.push({ label: "Loaded radius", value: loadedRadiusM, kind: "length" });

  const lookup = lookupCapacity(dataset, boomLengthM, loadedRadiusM);
  if (!lookup.ok) {
    const state: ResultState = lookup.code === "INVALID_INPUT" ? "INVALID" : "UNSUPPORTED";
    return out(state, lookup.message, loadedRadiusM);
  }
  check.metrics.push({ label: "Chart capacity", value: lookup.capacityKg, kind: "mass" });
  check.notes.push(
    lookup.rule === "exact"
      ? "Capacity read at a tabulated chart entry."
      : "Between chart entries: the lowest of the bracketing capacities is used.",
  );
  check.notes.push(`Source: ${dataset!.sourceDocument}, revision ${dataset!.revision} (${dataset!.convention} capacities).`);
  if (!Number.isFinite(d.hookLoadKg)) return out(d.state, undefined, loadedRadiusM);

  // A gross chart rates everything on the hook; a net chart already excludes the listed deductions.
  const demandKg = dataset!.convention === "gross" ? d.hookLoadKg : d.loadUpperKg;
  check.metrics.push({ label: "Load incl. allowance", value: d.loadUpperKg, kind: "mass" });
  if (dataset!.convention === "gross") {
    check.metrics.push({ label: "Deductions", value: d.ledger.totalKg, kind: "mass" });
    if (plan.deductions.length === 0) {
      check.state = worstState([check.state, "REVIEW_REQUIRED"]);
      check.notes.push("Nothing is listed on the hook besides the load. A gross chart also carries the hook block and rigging — add them.");
    }
  }
  else check.notes.push("Net chart: suspended items are not deducted again here. Confirm the chart's own deductions cover them.");
  check.metrics.push({ label: "Demand", value: demandKg, kind: "mass" });
  const utilization = demandKg / lookup.capacityKg;
  check.metrics.push({ label: "Utilization", value: utilization, kind: "ratio" });

  if (utilization > 1) return out("LIMIT_EXCEEDED", "Demand exceeds the rated capacity for this configuration.", loadedRadiusM);
  const review = plan.thresholds.reviewUtilization;
  if (!isNum(review)) return out("REVIEW_REQUIRED", "No review threshold is set for chart utilization (project critical-lift line not defined).", loadedRadiusM);
  if (utilization > review) return out("REVIEW_REQUIRED", "Utilization is above the project review threshold.", loadedRadiusM);
  return out("WITHIN_LIMITS", undefined, loadedRadiusM);
}

function linePullCheck(plan: LiftPlan, d: Demand): Check {
  const check: Check = { id: "line-pull", title: "Hoist line pull", state: "WITHIN_LIMITS", metrics: [], notes: [] };
  const { partsOfLine, singleLinePullKg } = plan.crane;
  if (!isNum(partsOfLine) || !isNum(singleLinePullKg)) {
    check.state = "DRAFT";
    check.notes.push("Parts of line and permissible single-line pull have not been entered.");
    return check;
  }
  if (partsOfLine < 1 || !Number.isInteger(partsOfLine) || singleLinePullKg <= 0) {
    check.state = "INVALID";
    check.notes.push("Parts of line must be a whole number of 1 or more, and line pull must be positive.");
    return check;
  }
  const capacityKg = partsOfLine * singleLinePullKg;
  check.metrics.push({ label: "Reeving capacity", value: capacityKg, kind: "mass" });
  check.notes.push("Sheave friction and block rating are not included; use the OEM reeving table value where it is lower.");
  if (!Number.isFinite(d.hookLoadKg)) {
    check.state = d.state === "INVALID" ? "INVALID" : "DRAFT";
    return check;
  }
  const utilization = d.hookLoadKg / capacityKg;
  check.metrics.push({ label: "Hook load", value: d.hookLoadKg, kind: "mass" }, { label: "Utilization", value: utilization, kind: "ratio" });
  if (utilization > 1) {
    check.state = "LIMIT_EXCEEDED";
    check.notes.push("Hook load exceeds the reeving capacity.");
  }
  return check;
}

function riggingCheck(plan: LiftPlan, d: Demand, g: number): Check | null {
  const r = plan.rigging;
  if (!r.enabled) return null;
  const check: Check = { id: "rigging", title: "Rigging (two-leg sling)", state: "WITHIN_LIMITS", metrics: [], notes: [] };
  const escalate = (s: ResultState, note: string) => {
    check.state = worstState([check.state, s]);
    check.notes.push(note);
  };
  if (!isNum(r.angle1Deg) || !isNum(r.angle2Deg)) {
    escalate("DRAFT", "Sling angles (from horizontal) have not been entered.");
    return check;
  }
  if (!Number.isFinite(d.loadUpperKg)) {
    escalate(d.state === "INVALID" ? "INVALID" : "DRAFT", "Load weight is needed to resolve sling tensions.");
    return check;
  }
  if (r.angle1Deg >= 90 && r.angle2Deg >= 90) {
    escalate("UNSUPPORTED", "Two vertical legs: the share depends on where the CG sits between the lift points, which this check is not given.");
    return check;
  }
  const { t1, t2 } = twoLegTensions(d.loadUpperKg * g, r.angle1Deg, r.angle2Deg);
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) {
    escalate("INVALID", "Sling angles must be greater than 0° and no more than 90° from horizontal.");
    return check;
  }
  check.metrics.push({ label: "Leg 1 tension", value: t1, kind: "force" }, { label: "Leg 2 tension", value: t2, kind: "force" });
  check.notes.push("Static, legs coplanar with the hook, CG under the hook; sling self-weight neglected. Not for 3- or 4-leg bridles.");

  const legs: Array<[number, number | null, number]> = [
    [t1, r.wll1Kg, 1],
    [t2, r.wll2Kg, 2],
  ];
  for (const [tension, wllKg, n] of legs) {
    if (!isNum(wllKg) || wllKg <= 0) {
      escalate("DRAFT", `Leg ${n} has no rated working load limit entered.`);
      continue;
    }
    const u = tension / (wllKg * g);
    check.metrics.push({ label: `Leg ${n} utilization`, value: u, kind: "ratio" });
    if (u > 1) escalate("LIMIT_EXCEEDED", `Leg ${n} tension exceeds its working load limit.`);
  }
  const minAngle = plan.thresholds.minSlingAngleDeg;
  if (!isNum(minAngle)) escalate("REVIEW_REQUIRED", "No minimum sling angle is set; sling angle not evaluated against a limit.");
  else if (Math.min(r.angle1Deg, r.angle2Deg) < minAngle) escalate("LIMIT_EXCEEDED", "A sling angle is below the minimum set for this project.");
  if (!r.liftPointEvidenceRef.trim()) {
    escalate("REVIEW_REQUIRED", "No evidence reference for lift-point / below-the-hook adequacy. Sling forces do not establish it.");
  }
  return check;
}

function groundCheck(plan: LiftPlan, g: number): Check {
  const gr = plan.ground;
  const check: Check = { id: "ground", title: "Ground bearing (average pressure)", state: "WITHIN_LIMITS", metrics: [], notes: [] };
  const escalate = (s: ResultState, note: string) => {
    check.state = worstState([check.state, s]);
    check.notes.push(note);
  };
  if (!isNum(gr.reactionN)) {
    escalate("DRAFT", "Maximum support reaction has not been entered. It comes from OEM outrigger-load data or an engineer — it is not crane weight divided by four.");
    return check;
  }
  if (!gr.reactionSource.trim()) escalate("DRAFT", "The source of the support reaction has not been recorded.");
  if (!isNum(gr.matLengthM) || !isNum(gr.matWidthM) || !isNum(gr.matMassKg)) {
    escalate("DRAFT", "Mat dimensions and weight have not been entered.");
    return check;
  }
  const area = gr.matLengthM * gr.matWidthM;
  const p = averagePressure(gr.reactionN + gr.matMassKg * g, area);
  if (!Number.isFinite(p)) {
    escalate("INVALID", "Reaction, mat weight and mat dimensions must be positive.");
    return check;
  }
  check.metrics.push({ label: "Average pressure", value: p, kind: "pressure" });
  check.notes.push("Average pressure only. It does not establish peak pressure, settlement, mat strength or soil capacity.");
  if (!gr.fullAreaAttested) escalate("REVIEW_REQUIRED", "Full mat footprint assumed to bear; not confirmed by an engineer.");
  if (!isNum(gr.allowableBearingPa) || gr.allowableBearingPa <= 0) {
    escalate("DRAFT", "Allowable bearing pressure has not been entered.");
    return check;
  }
  if (!gr.allowableSource.trim()) escalate("DRAFT", "Allowable bearing needs a source (geotechnical report, engineer's letter, owner specification).");
  const u = p / gr.allowableBearingPa;
  check.metrics.push({ label: "Allowable", value: gr.allowableBearingPa, kind: "pressure" }, { label: "Utilization", value: u, kind: "ratio" });
  if (u > 1) escalate("LIMIT_EXCEEDED", "Average pressure exceeds the allowable bearing pressure.");
  return check;
}

function windCheck(plan: LiftPlan, dataset: ChartDataset | null): Check {
  const check: Check = { id: "wind", title: "Wind", state: "WITHIN_LIMITS", metrics: [], notes: [] };
  const escalate = (s: ResultState, note: string) => {
    check.state = worstState([check.state, s]);
    check.notes.push(note);
  };
  const limits: number[] = [];
  const oem = dataset?.windLimitMs;
  if (isNum(oem)) limits.push(oem);
  else escalate("REVIEW_REQUIRED", "No OEM wind limit is recorded in the chart dataset. That is not the same as no limit.");
  const project = plan.thresholds.projectWindLimitMs;
  if (isNum(project)) limits.push(project);
  if (limits.length > 0) check.metrics.push({ label: "Governing limit", value: Math.min(...limits), kind: "speed" });
  const gust = plan.wind.gustMs;
  if (!isNum(gust)) {
    escalate("REVIEW_REQUIRED", "No wind speed entered for the lift.");
    return check;
  }
  if (gust < 0) {
    escalate("INVALID", "Wind speed cannot be negative.");
    return check;
  }
  check.metrics.push({ label: `Gust (${plan.wind.source})`, value: gust, kind: "speed" });
  if (plan.wind.source === "forecast") escalate("REVIEW_REQUIRED", "Forecast wind only. Confirm against wind measured at site before lifting.");
  check.notes.push("Compared directly with the limit; no height adjustment or load sail-area reduction is applied.");
  if (limits.length > 0 && gust > Math.min(...limits)) escalate("LIMIT_EXCEEDED", "Wind speed exceeds the governing limit.");
  return check;
}

export function evaluatePlan(plan: LiftPlan, dataset: ChartDataset | null, g: number = STANDARD_GRAVITY): Evaluation {
  const d = demand(plan);
  const { check: chart, loadedRadiusM } = chartCheck(plan, dataset, d);
  const checks: Check[] = [chart, linePullCheck(plan, d)];
  const rig = riggingCheck(plan, d, g);
  if (rig) checks.push(rig);
  checks.push(groundCheck(plan, g), windCheck(plan, dataset));

  let sketch: Evaluation["sketch"] = null;
  if (isNum(plan.crane.boomLengthM) && Number.isFinite(loadedRadiusM)) {
    const geo = boomGeometry(plan.crane.boomLengthM, loadedRadiusM);
    if (Number.isFinite(geo.angleDeg)) sketch = { boomAngleDeg: geo.angleDeg, tipHeightM: geo.tipHeightM, loadedRadiusM };
  }
  return {
    kernelVersion: KERNEL_VERSION,
    gravity: g,
    state: worstState(checks.map((c) => c.state)),
    checks,
    synthetic: dataset?.synthetic ?? false,
    sketch,
  };
}

export function emptyPlan(): LiftPlan {
  return {
    name: "",
    liftDescription: "",
    load: { massKg: null, evidence: "calculated", uncertaintyRel: null },
    crane: { boomLengthM: null, radiusM: null, radiusAllowanceM: null, partsOfLine: null, singleLinePullKg: null },
    deductions: [],
    rigging: { enabled: true, angle1Deg: null, angle2Deg: null, wll1Kg: null, wll2Kg: null, liftPointEvidenceRef: "" },
    ground: { reactionN: null, reactionSource: "", matMassKg: null, matLengthM: null, matWidthM: null, fullAreaAttested: false, allowableBearingPa: null, allowableSource: "" },
    wind: { gustMs: null, source: "forecast" },
    thresholds: { reviewUtilization: null, minSlingAngleDeg: null, projectWindLimitMs: null },
    site: emptySite(),
  };
}

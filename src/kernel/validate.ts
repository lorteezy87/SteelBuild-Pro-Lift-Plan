/**
 * validate.ts — turn untrusted JSON into a LiftPlan or ChartDataset.
 *
 * Used at every trust boundary: the server's request bodies and the browser's
 * stored drafts. A number that is not finite becomes null (unknown), never 0.
 * Server-owned dataset fields (who entered it, who checked it, review state)
 * are NOT taken from input — see `sanitizeDatasetContent`.
 */
import type { ChartCell, ChartDataset } from "./chart";
import { type Deduction, type LiftPlan, type WeightEvidence, emptyPlan } from "./evaluate";

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 300): string => (typeof v === "string" ? v.slice(0, max) : "");
const bool = (v: unknown): boolean => v === true;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);

const EVIDENCE: readonly WeightEvidence[] = ["weighed", "manufacturer", "calculated", "estimated"];
const MAX_DEDUCTIONS = 40;
const MAX_AXIS = 60;

export function sanitizePlan(input: unknown): LiftPlan {
  const base = emptyPlan();
  const p = obj(input);
  const load = obj(p.load);
  const crane = obj(p.crane);
  const rigging = obj(p.rigging);
  const ground = obj(p.ground);
  const wind = obj(p.wind);
  const thresholds = obj(p.thresholds);
  const deductions: Deduction[] = (Array.isArray(p.deductions) ? p.deductions : []).slice(0, MAX_DEDUCTIONS).map((d, i) => {
    const o = obj(d);
    return { id: str(o.id, 60) || `d-${i}`, label: str(o.label, 120), massKg: num(o.massKg) };
  });
  return {
    name: str(p.name, 120),
    liftDescription: str(p.liftDescription, 500),
    load: { massKg: num(load.massKg), evidence: oneOf(load.evidence, EVIDENCE, base.load.evidence), uncertaintyRel: num(load.uncertaintyRel) },
    crane: {
      boomLengthM: num(crane.boomLengthM),
      radiusM: num(crane.radiusM),
      radiusAllowanceM: num(crane.radiusAllowanceM),
      partsOfLine: num(crane.partsOfLine),
      singleLinePullKg: num(crane.singleLinePullKg),
    },
    deductions,
    rigging: {
      enabled: rigging.enabled === undefined ? base.rigging.enabled : bool(rigging.enabled),
      angle1Deg: num(rigging.angle1Deg),
      angle2Deg: num(rigging.angle2Deg),
      wll1Kg: num(rigging.wll1Kg),
      wll2Kg: num(rigging.wll2Kg),
      liftPointEvidenceRef: str(rigging.liftPointEvidenceRef),
    },
    ground: {
      reactionN: num(ground.reactionN),
      reactionSource: str(ground.reactionSource),
      matMassKg: num(ground.matMassKg),
      matLengthM: num(ground.matLengthM),
      matWidthM: num(ground.matWidthM),
      fullAreaAttested: bool(ground.fullAreaAttested),
      allowableBearingPa: num(ground.allowableBearingPa),
      allowableSource: str(ground.allowableSource),
    },
    wind: { gustMs: num(wind.gustMs), source: oneOf(wind.source, ["forecast", "measured"] as const, "forecast") },
    thresholds: {
      reviewUtilization: num(thresholds.reviewUtilization),
      minSlingAngleDeg: num(thresholds.minSlingAngleDeg),
      projectWindLimitMs: num(thresholds.projectWindLimitMs),
    },
  };
}

/** The part of a dataset a person enters. Review state and names are owned by the server. */
export type DatasetContent = Omit<ChartDataset, "id" | "reviewState" | "importedBy" | "reviewedBy" | "synthetic">;

export type DatasetParse = { ok: true; content: DatasetContent } | { ok: false; message: string };

function axis(v: unknown, name: string): number[] | string {
  if (!Array.isArray(v) || v.length > MAX_AXIS) return `${name} must be a list of at most ${MAX_AXIS} values.`;
  const out: number[] = [];
  for (const x of v) {
    const n = num(x);
    if (n === null || n <= 0) return `${name} must be positive numbers.`;
    if (out.length > 0 && n <= out[out.length - 1]!) return `${name} must be strictly increasing.`;
    out.push(n);
  }
  return out;
}

export function sanitizeDatasetContent(input: unknown): DatasetParse {
  const d = obj(input);
  const booms = axis(d.boomLengthsM, "Boom lengths");
  if (typeof booms === "string") return { ok: false, message: booms };
  const radii = axis(d.radiiM, "Radii");
  if (typeof radii === "string") return { ok: false, message: radii };
  const rows = Array.isArray(d.capacitiesKg) ? d.capacitiesKg : [];
  if (rows.length !== booms.length) return { ok: false, message: "The chart needs one row of capacities per boom length." };
  const capacities: ChartCell[][] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== radii.length) return { ok: false, message: "Each chart row needs one cell per radius." };
    const cells: ChartCell[] = [];
    for (const c of row) {
      if (c === "not_rated") cells.push("not_rated");
      else {
        const n = num(c);
        if (n === null || n <= 0) return { ok: false, message: "A chart cell must be a positive capacity or 'not_rated'." };
        cells.push(n);
      }
    }
    capacities.push(cells);
  }
  const wind = num(d.windLimitMs);
  return {
    ok: true,
    content: {
      label: str(d.label, 160),
      configurationKey: str(d.configurationKey),
      sourceDocument: str(d.sourceDocument),
      revision: str(d.revision, 60),
      licenseRef: str(d.licenseRef),
      boomType: oneOf(d.boomType, ["telescopic", "lattice"] as const, "telescopic"),
      convention: oneOf(d.convention, ["gross", "net"] as const, "gross"),
      lookupRule: oneOf(d.lookupRule, ["conservative-bracket", "exact-only"] as const, "conservative-bracket"),
      boomLengthsM: booms,
      radiiM: radii,
      capacitiesKg: capacities,
      windLimitMs: wind !== null && wind > 0 ? wind : null,
    },
  };
}

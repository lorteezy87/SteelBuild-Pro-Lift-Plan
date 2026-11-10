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
import type { ContextWall, GridLine, Member, MemberType, PlanSite, SiteCrane, SiteModel, Vec3 } from "./site";

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
    site: sanitizeSite(p.site),
  };
}

const MAX_CRANES = 6;

function sanitizeSite(input: unknown): PlanSite {
  const s = obj(input);
  const cranes: SiteCrane[] = (Array.isArray(s.cranes) ? s.cranes : []).slice(0, MAX_CRANES).map((c, i) => {
    const o = obj(c);
    const boom = num(o.boomLengthM);
    return {
      id: str(o.id, 40) || `crane-${i + 1}`,
      name: str(o.name, 60) || `Crane ${i + 1}`,
      x: num(o.x) ?? 0,
      z: num(o.z) ?? 0,
      datasetId: str(o.datasetId, 60) || null,
      boomLengthM: boom !== null && boom > 0 ? boom : null,
    };
  });
  const swing = num(s.swingRadiusM);
  return {
    modelId: str(s.modelId, 60) || null,
    cranes,
    swingRadiusM: swing !== null && swing > 0 ? swing : null,
    pickMemberId: str(s.pickMemberId, 60) || null,
    pickCraneId: str(s.pickCraneId, 40) || null,
  };
}

const MAX_MEMBERS = 5000;
const MEMBER_TYPES: readonly MemberType[] = ["column", "beam", "brace", "joist"];
export type ModelParse = { ok: true; model: SiteModel } | { ok: false; message: string };

function vec3(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const [x, y, z] = v.map(num);
  if (x == null || y == null || z == null) return null;
  if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) > 1e5) return null;
  return [x, y, z];
}

function gridLines(v: unknown): GridLine[] {
  return (Array.isArray(v) ? v : []).slice(0, 200).flatMap((g) => {
    const o = obj(g);
    const pos = num(o.pos);
    return pos === null ? [] : [{ name: str(o.name, 12), pos }];
  });
}

/** Accepts a model file: coordinates in metres, X east, Z south, Y elevation. */
export function sanitizeModel(input: unknown): ModelParse {
  const m = obj(input);
  const raw = Array.isArray(m.members) ? m.members : [];
  if (raw.length === 0) return { ok: false, message: "The model has no members." };
  if (raw.length > MAX_MEMBERS) return { ok: false, message: `A model can hold at most ${MAX_MEMBERS} members.` };
  const members: Member[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const o = obj(raw[i]);
    const a = vec3(o.a);
    const b = vec3(o.b);
    if (!a || !b) return { ok: false, message: `Member ${i + 1} needs two end points [x, y, z] in metres.` };
    if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) return { ok: false, message: `Member ${i + 1} has zero length.` };
    const type = oneOf(o.type, MEMBER_TYPES, "beam");
    let id = str(o.id, 60) || `m${i + 1}`;
    if (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const mass = num(o.massKg);
    const width = num(o.widthM);
    const depth = num(o.depthM);
    members.push({
      id,
      mark: str(o.mark, 40),
      type,
      size: str(o.size, 80),
      a,
      b,
      ref: oneOf(o.ref, ["top", "center"] as const, type === "column" || type === "brace" ? "center" : "top"),
      widthM: width !== null && width > 0 && width < 5 ? width : 0.15,
      depthM: depth !== null && depth > 0 && depth < 5 ? depth : 0.3,
      massKg: mass !== null && mass > 0 ? mass : null,
      elevationNote: str(o.elevationNote, 200),
      sheet: str(o.sheet, 200),
    });
  }
  const walls: ContextWall[] = (Array.isArray(m.walls) ? m.walls : []).slice(0, 500).flatMap((w) => {
    const o = obj(w);
    const a = Array.isArray(o.a) ? o.a.map(num) : [];
    const b = Array.isArray(o.b) ? o.b.map(num) : [];
    const y0 = num(o.y0);
    const y1 = num(o.y1);
    if (a.length !== 2 || b.length !== 2 || a.includes(null) || b.includes(null) || y0 === null || y1 === null || y1 <= y0) return [];
    return [{ a: [a[0]!, a[1]!], b: [b[0]!, b[1]!], y0, y1 }];
  });
  return { ok: true, model: { name: str(m.name, 120) || "Untitled model", note: str(m.note, 500), members, gridsX: gridLines(m.gridsX), gridsZ: gridLines(m.gridsZ), walls } };
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

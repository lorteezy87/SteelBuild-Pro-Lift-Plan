/**
 * site.ts — steel model, crane positions and per-piece coverage.
 *
 * Coordinates are metres: X east, Z south, Y elevation.
 *
 * Coverage answers one question per piece and crane: at the piece's SET
 * position, is it inside the crane's load chart, and what share of the chart
 * capacity does it use? It is a planning map. It does not check hook height,
 * boom clearance to the structure, the pick-up radius, rigging or the ground,
 * and it is never an approval.
 *
 * Absent data stays absent: a piece with no known weight is "no-weight", not
 * zero, and a crane with no chart can only say "inside the swing radius".
 */
import { type ChartDataset, lookupCapacity } from "./chart";
import { KG_PER_LB, M_PER_FT } from "./units";

export type MemberType = "column" | "beam" | "brace" | "joist";
export type Vec3 = [number, number, number];

export interface Member {
  id: string;
  mark: string;
  type: MemberType;
  /** Section designation as on the drawings, e.g. "W24X68", "HSS5X5X1/2", "26K". */
  size: string;
  a: Vec3;
  b: Vec3;
  /** Whether a→b runs along the top of steel (beams, joists) or the centreline (columns, braces). */
  ref: "top" | "center";
  widthM: number;
  depthM: number;
  /** Weight from the drawings or a shipping list, if known. null = derive from the designation if possible. */
  massKg: number | null;
  elevationNote: string;
  sheet: string;
}

export interface GridLine {
  name: string;
  pos: number;
}

export interface ContextWall {
  a: [number, number];
  b: [number, number];
  y0: number;
  y1: number;
}

export interface SiteModel {
  name: string;
  note: string;
  members: Member[];
  gridsX: GridLine[];
  gridsZ: GridLine[];
  walls: ContextWall[];
}

export interface SiteCrane {
  id: string;
  name: string;
  x: number;
  z: number;
  datasetId: string | null;
  boomLengthM: number | null;
}

export interface PlanSite {
  modelId: string | null;
  cranes: SiteCrane[];
  /** Used only for cranes that have no chart: a plain swing circle. */
  swingRadiusM: number | null;
  /** The piece and crane the detailed pick check was filled in from. */
  pickMemberId: string | null;
  pickCraneId: string | null;
}

export function emptySite(): PlanSite {
  return { modelId: null, cranes: [], swingRadiusM: null, pickMemberId: null, pickCraneId: null };
}

export function memberLengthM(m: Member): number {
  return Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1], m.b[2] - m.a[2]);
}

export function memberCentre(m: Member): Vec3 {
  return [(m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2, (m.a[2] + m.b[2]) / 2];
}

const KG_M_PER_LB_FT = KG_PER_LB / M_PER_FT;
/** Steel at 490 lb/ft³ is 3.4028 lb/ft per square inch of section. */
const LB_FT_PER_SQIN = 490 / 144;

function inches(text: string): number | null {
  const m = /^(\d+)?(?:[-\s]?(\d+)\/(\d+))?$/.exec(text.trim());
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const whole = m[1] ? Number(m[1]) : 0;
  const frac = m[2] && m[3] ? Number(m[2]) / Number(m[3]) : 0;
  const v = whole + frac;
  return v > 0 ? v : null;
}

/**
 * Weight per metre from a section designation, or null when the designation
 * does not carry it.
 *   - Rolled shapes (W, M, S, HP, C, MC, WT…): the number after the X is lb/ft.
 *   - Square / rectangular HSS: from the wall geometry at nominal thickness,
 *     with rounded corners (outside radius 2t), which reproduces the tabulated
 *     nominal weights to within about 1%.
 * Open-web joists ("26K", "32LH") have no weight in the designation: null.
 * Connection material, bolts and paint are never included.
 */
export function unitMassKgPerM(size: string): number | null {
  const s = size.trim().toUpperCase();
  const rolled = /^(?:W|M|S|HP|C|MC|WT|MT|ST)\s*\d+(?:\.\d+)?\s*X\s*(\d+(?:\.\d+)?)(?![\dX/])/.exec(s);
  if (rolled) return Number(rolled[1]) * KG_M_PER_LB_FT;
  const hss = /^HSS\s*(\d+(?:\.\d+)?)\s*X\s*(\d+(?:\.\d+)?)\s*X\s*(\d+\/\d+|\d+(?:\.\d+)?)/.exec(s);
  if (hss) {
    const b = Number(hss[1]);
    const h = Number(hss[2]);
    const t = hss[3]!.includes("/") ? inches(hss[3]!) : Number(hss[3]);
    if (!t || !(t > 0) || 2 * t >= Math.min(b, h)) return null;
    const area = 2 * t * (b + h - 2 * t) - (4 - Math.PI) * 3 * t * t;
    return area * LB_FT_PER_SQIN * KG_M_PER_LB_FT;
  }
  return null;
}

export type MassBasis = "given" | "designation";

export function memberMass(m: Member): { massKg: number; basis: MassBasis } | null {
  if (m.massKg !== null && Number.isFinite(m.massKg) && m.massKg > 0) return { massKg: m.massKg, basis: "given" };
  const unit = unitMassKgPerM(m.size);
  const len = memberLengthM(m);
  if (unit === null || !(len > 0)) return null;
  return { massKg: unit * len, basis: "designation" };
}

/** Farthest radius at which the chart gives a capacity for this boom length, or null if none. */
export function maxRatedRadiusM(dataset: ChartDataset | null, boomLengthM: number | null): number | null {
  if (!dataset || boomLengthM === null) return null;
  for (let j = dataset.radiiM.length - 1; j >= 0; j--) {
    if (lookupCapacity(dataset, boomLengthM, dataset.radiiM[j]!).ok) return dataset.radiiM[j]!;
  }
  return null;
}

export type CoverStatus = "ok" | "over" | "no-weight" | "reach-only" | "unrated" | "out";

export interface CraneCover {
  craneId: string;
  radiusM: number;
  status: CoverStatus;
  capacityKg: number | null;
  demandKg: number | null;
  utilization: number | null;
  reason: string;
}

export interface CoverOptions {
  swingRadiusM: number | null;
  /** Relative allowance added to each piece weight. null = none stated. */
  allowanceRel: number | null;
  /** Hook block, rigging and other suspended items. null = not yet entered, so demand is unknown. */
  deductionsKg: number | null;
  /** Radius growth under load. null = not addressed (treated as 0 here and flagged by the pick check). */
  radiusAllowanceM: number | null;
}

export function coverMember(member: Member, crane: SiteCrane, dataset: ChartDataset | null, opts: CoverOptions): CraneCover {
  const c = memberCentre(member);
  const radiusM = Math.hypot(c[0] - crane.x, c[2] - crane.z);
  const base = { craneId: crane.id, radiusM, capacityKg: null, demandKg: null, utilization: null };

  if (!dataset || dataset.reviewState !== "approved" || crane.boomLengthM === null) {
    const why = !dataset ? "No chart selected for this crane" : dataset.reviewState !== "approved" ? "Chart not yet reviewed" : "No boom length set";
    if (opts.swingRadiusM !== null && radiusM <= opts.swingRadiusM) return { ...base, status: "reach-only", reason: `${why}: inside the swing radius, capacity not checked.` };
    return { ...base, status: "out", reason: opts.swingRadiusM === null ? `${why}.` : `${why}: outside the swing radius.` };
  }

  const lookup = lookupCapacity(dataset, crane.boomLengthM, radiusM + (opts.radiusAllowanceM ?? 0));
  if (!lookup.ok) return { ...base, status: lookup.code === "OUTSIDE_COVERAGE" ? "out" : "unrated", reason: lookup.message };

  const mass = memberMass(member);
  if (!mass) return { ...base, status: "no-weight", capacityKg: lookup.capacityKg, reason: "Inside the chart, but the piece weight is not known." };
  if (dataset.convention === "gross" && opts.deductionsKg === null) {
    return { ...base, status: "no-weight", capacityKg: lookup.capacityKg, reason: "Inside the chart, but hook block and rigging weights are incomplete." };
  }
  const demandKg = mass.massKg * (1 + (opts.allowanceRel ?? 0)) + (dataset.convention === "gross" ? (opts.deductionsKg ?? 0) : 0);
  const utilization = demandKg / lookup.capacityKg;
  return {
    ...base,
    status: utilization > 1 ? "over" : "ok",
    capacityKg: lookup.capacityKg,
    demandKg,
    utilization,
    reason: utilization > 1 ? "Exceeds chart capacity at the set radius." : "Within chart capacity at the set radius.",
  };
}

const RANK: Record<CoverStatus, number> = { ok: 0, "no-weight": 1, "reach-only": 2, over: 3, unrated: 4, out: 5 };

/** The crane best placed to set a piece: a rated pick at the lowest utilization, then weaker answers. */
export function bestCover(covers: CraneCover[]): CraneCover | null {
  let best: CraneCover | null = null;
  for (const c of covers) {
    if (!best || RANK[c.status] < RANK[best.status] || (RANK[c.status] === RANK[best.status] && (c.utilization ?? c.radiusM) < (best.utilization ?? best.radiusM))) best = c;
  }
  return best;
}

/** A small invented two-bay frame, for trying the workspace without a real model. */
export function sampleModel(): SiteModel {
  const ft = (v: number) => v * M_PER_FT;
  const inch = (v: number) => (v / 12) * M_PER_FT;
  const members: Member[] = [];
  const xs = [0, 30, 60];
  const zs = [0, 25, 50];
  const top = 16;
  let n = 0;
  const add = (m: Omit<Member, "id" | "massKg">) => members.push({ ...m, id: `m${++n}`, massKg: null });
  xs.forEach((x, i) =>
    zs.forEach((z, k) =>
      add({ mark: `C${i + 1}${k + 1}`, type: "column", size: "HSS8X8X3/8", a: [ft(x), 0, ft(z)], b: [ft(x), ft(top), ft(z)], ref: "center", widthM: inch(8), depthM: inch(8), elevationNote: "T.O. steel 16'-0\"", sheet: "Sample" }),
    ),
  );
  zs.forEach((z, k) =>
    [0, 1].forEach((i) =>
      add({ mark: `G${k + 1}${i + 1}`, type: "beam", size: "W24X68", a: [ft(xs[i]!), ft(top), ft(z)], b: [ft(xs[i + 1]!), ft(top), ft(z)], ref: "top", widthM: inch(9), depthM: inch(23.7), elevationNote: "T.O. steel 16'-0\"", sheet: "Sample" }),
    ),
  );
  xs.forEach((x, i) =>
    [0, 1].forEach((k) =>
      add({ mark: `B${i + 1}${k + 1}`, type: "beam", size: "W18X40", a: [ft(x), ft(top), ft(zs[k]!)], b: [ft(x), ft(top), ft(zs[k + 1]!)], ref: "top", widthM: inch(6), depthM: inch(17.9), elevationNote: "T.O. steel 16'-0\"", sheet: "Sample" }),
    ),
  );
  [0, 1].forEach((k) =>
    [6, 12, 18, 24, 36, 42, 48, 54].forEach((x) =>
      add({ mark: "J", type: "joist", size: "26K", a: [ft(x), ft(top), ft(zs[k]!)], b: [ft(x), ft(top), ft(zs[k + 1]!)], ref: "top", widthM: inch(5), depthM: inch(26), elevationNote: "Bearing 16'-0\"", sheet: "Sample" }),
    ),
  );
  add({ mark: "VB1", type: "brace", size: "HSS5X5X3/8", a: [0, 0.2, 0], b: [0, ft(top) - 0.3, ft(25)], ref: "center", widthM: inch(5), depthM: inch(5), elevationNote: "Work points per sample", sheet: "Sample" });
  return {
    name: "Sample frame — invented",
    note: "Invented two-bay frame for demonstration. Not from any project.",
    members,
    gridsX: xs.map((x, i) => ({ name: String(i + 1), pos: ft(x) })),
    gridsZ: zs.map((z, k) => ({ name: "ABC"[k]!, pos: ft(z) })),
    walls: [],
  };
}

/**
 * chart.ts — rated-capacity chart datasets and lookup.
 *
 * Rated capacity comes only from a reviewed chart dataset for the exact
 * configuration. This module holds no manufacturer data. It refuses, with a
 * reason, anything it cannot read straight off the table:
 *
 *   - never extrapolates beyond chart coverage
 *   - between tabulated points returns the LOWEST bracketing cell, unless the
 *     dataset declares `exact-only`, in which case it refuses
 *   - a blank cell is `not_rated` — distinct from zero and from missing data —
 *     and any bracket touching one is refused
 *   - a lattice boom exists only at listed lengths
 *   - an unreviewed dataset cannot be used at all
 */
import { M_PER_FT, type MassUnit, massToKg, parseStrictNumber } from "./units";

export type ChartCell = number | "not_rated";
export type LookupRule = "exact-only" | "conservative-bracket";
export type DatasetReviewState = "imported-unreviewed" | "approved";

export interface ChartDataset {
  id: string;
  /** Manufacturer / model / configuration description, as on the source document. */
  label: string;
  /** Full configuration this chart applies to (counterweight, outriggers, sector…). */
  configurationKey: string;
  sourceDocument: string;
  revision: string;
  licenseRef: string;
  /** True for invented test data. Synthetic datasets can never support an approved plan. */
  synthetic: boolean;
  reviewState: DatasetReviewState;
  importedBy: string;
  reviewedBy: string;
  boomType: "telescopic" | "lattice";
  /** Whether chart values are gross (deductions come off) or net. Read from the source. */
  convention: "gross" | "net";
  lookupRule: LookupRule;
  boomLengthsM: number[];
  radiiM: number[];
  /** capacitiesKg[i][j] at boomLengthsM[i], radiiM[j]. */
  capacitiesKg: ChartCell[][];
  /** OEM in-service wind limit for this configuration, m/s. null = not in the dataset. */
  windLimitMs: number | null;
}

export type RefusalCode =
  | "NO_DATASET"
  | "DATASET_NOT_APPROVED"
  | "INVALID_INPUT"
  | "OUTSIDE_COVERAGE"
  | "NOT_RATED"
  | "UNLISTED_BOOM_LENGTH"
  | "NOT_TABULATED";

export type ChartLookup =
  | { ok: true; capacityKg: number; rule: "exact" | LookupRule; boomBracketM: [number, number]; radiusBracketM: [number, number] }
  | { ok: false; code: RefusalCode; message: string };

/** A value within 1 mm of a tabulated one is that tabulated value (unit conversion leaves hairs like 30.0003 m). */
const EPS = 1e-3;

function bracket(axis: number[], x: number): [number, number] | null {
  const first = axis[0];
  const last = axis[axis.length - 1];
  if (first === undefined || last === undefined) return null;
  if (x < first - EPS || x > last + EPS) return null;
  for (let i = 0; i < axis.length; i++) {
    const a = axis[i]!;
    if (Math.abs(a - x) <= EPS) return [i, i];
    const b = axis[i + 1];
    if (b !== undefined && x > a && x < b) return [i, i + 1];
  }
  return null;
}

export function lookupCapacity(dataset: ChartDataset | null, boomLengthM: number, radiusM: number): ChartLookup {
  if (!dataset) return { ok: false, code: "NO_DATASET", message: "No chart dataset is selected for this configuration." };
  if (dataset.reviewState !== "approved") {
    return { ok: false, code: "DATASET_NOT_APPROVED", message: "The chart dataset has not been independently reviewed and approved." };
  }
  if (!Number.isFinite(boomLengthM) || !Number.isFinite(radiusM) || boomLengthM <= 0 || radiusM <= 0) {
    return { ok: false, code: "INVALID_INPUT", message: "Boom length and radius must be positive numbers." };
  }
  const bi = bracket(dataset.boomLengthsM, boomLengthM);
  if (!bi) return { ok: false, code: "OUTSIDE_COVERAGE", message: "Boom length is outside the chart. The chart is not extrapolated." };
  if (bi[0] !== bi[1] && dataset.boomType === "lattice") {
    return { ok: false, code: "UNLISTED_BOOM_LENGTH", message: "A lattice boom is only rated at the lengths listed in the chart." };
  }
  const ri = bracket(dataset.radiiM, radiusM);
  if (!ri) return { ok: false, code: "OUTSIDE_COVERAGE", message: "Radius is outside the chart. The chart is not extrapolated." };

  const exact = bi[0] === bi[1] && ri[0] === ri[1];
  if (!exact && dataset.lookupRule === "exact-only") {
    return { ok: false, code: "NOT_TABULATED", message: "This dataset permits lookup only at tabulated points." };
  }

  let min = Infinity;
  for (const i of new Set(bi)) {
    for (const j of new Set(ri)) {
      const cell = dataset.capacitiesKg[i]?.[j];
      if (cell === undefined || cell === "not_rated") {
        return { ok: false, code: "NOT_RATED", message: "The chart is blank (not rated) at or beside this position." };
      }
      if (!Number.isFinite(cell) || cell <= 0) {
        return { ok: false, code: "INVALID_INPUT", message: "The chart dataset contains an invalid capacity value." };
      }
      min = Math.min(min, cell);
    }
  }
  return {
    ok: true,
    capacityKg: min,
    rule: exact ? "exact" : dataset.lookupRule,
    boomBracketM: [dataset.boomLengthsM[bi[0]]!, dataset.boomLengthsM[bi[1]]!],
    radiusBracketM: [dataset.radiiM[ri[0]]!, dataset.radiiM[ri[1]]!],
  };
}

export type ChartTable = Pick<ChartDataset, "boomLengthsM" | "radiiM" | "capacitiesKg">;
export type ChartParse = { ok: true; table: ChartTable } | { ok: false; message: string };

/**
 * Parse a pasted chart table. First row: a corner cell then the radii.
 * Each later row: boom length then one capacity per radius. A blank cell or
 * "-" is `not_rated`. Anything else that is not a clean number is an error —
 * a cell is never guessed.
 */
export function parseChartTable(text: string, lengthUnit: "m" | "ft", massUnit: MassUnit): ChartParse {
  // Tab or semicolon delimited tables may use thousands commas; a comma-delimited one cannot.
  const delimiter = text.includes("\t") ? "\t" : text.includes(";") ? ";" : ",";
  const rows = text
    .split(/\r?\n/)
    .filter((r) => r.trim() !== "")
    .map((r) => r.split(delimiter).map((c) => c.trim()));
  if (rows.length < 2) return { ok: false, message: "Need a header row of radii and at least one boom-length row." };
  const lengthFactor = lengthUnit === "ft" ? M_PER_FT : 1;
  const header = rows[0]!;
  const radii: number[] = [];
  for (const c of header.slice(1)) {
    const n = parseStrictNumber(c);
    if (n === null || n <= 0) return { ok: false, message: `Radius '${c}' is not a positive number.` };
    radii.push(n * lengthFactor);
  }
  if (radii.length === 0) return { ok: false, message: "No radii found in the header row." };
  for (let j = 1; j < radii.length; j++) {
    if (radii[j]! <= radii[j - 1]!) return { ok: false, message: "Radii must increase left to right." };
  }
  const boomLengths: number[] = [];
  const capacities: ChartCell[][] = [];
  for (const row of rows.slice(1)) {
    const b = parseStrictNumber(row[0] ?? "");
    if (b === null || b <= 0) return { ok: false, message: `Boom length '${row[0] ?? ""}' is not a positive number.` };
    const prev = boomLengths[boomLengths.length - 1];
    if (prev !== undefined && b * lengthFactor <= prev) return { ok: false, message: "Boom lengths must increase top to bottom." };
    boomLengths.push(b * lengthFactor);
    const cells: ChartCell[] = [];
    for (let j = 0; j < radii.length; j++) {
      const c = row[j + 1] ?? "";
      if (c === "" || c === "-") {
        cells.push("not_rated");
        continue;
      }
      const n = parseStrictNumber(c);
      if (n === null || n <= 0) return { ok: false, message: `Capacity '${c}' at boom ${row[0]} is not a positive number.` };
      cells.push(massToKg(n, massUnit));
    }
    if (row.length - 1 > radii.length) return { ok: false, message: `Boom ${row[0]} has more cells than there are radii.` };
    capacities.push(cells);
  }
  return { ok: true, table: { boomLengthsM: boomLengths, radiiM: radii, capacitiesKg: capacities } };
}

export interface ReviewCheck {
  ok: boolean;
  problems: string[];
}

/** A dataset may be approved only with its source recorded and a reviewer who is not the importer. */
export function canApproveDataset(d: Pick<ChartDataset, "licenseRef" | "sourceDocument" | "revision" | "importedBy" | "reviewedBy" | "configurationKey">): ReviewCheck {
  const problems: string[] = [];
  if (!d.sourceDocument.trim()) problems.push("Source document is required.");
  if (!d.revision.trim()) problems.push("Source revision is required.");
  if (!d.licenseRef.trim()) problems.push("License / authorization reference is required.");
  if (!d.configurationKey.trim()) problems.push("Configuration description is required.");
  if (!d.importedBy.trim()) problems.push("Name of the person who entered the chart is required.");
  if (!d.reviewedBy.trim()) problems.push("Name of the independent reviewer is required.");
  if (d.importedBy.trim() && d.importedBy.trim().toLowerCase() === d.reviewedBy.trim().toLowerCase()) {
    problems.push("The reviewer must be a different person from the one who entered the chart.");
  }
  return { ok: problems.length === 0, problems };
}

/** Invented numbers for demonstration and tests. Not from any manufacturer. */
export function syntheticDataset(): ChartDataset {
  const _ = "not_rated" as const;
  return {
    id: "synthetic-test-100",
    label: "SYNTHETIC — NOT OEM DATA · Test crane T-100",
    configurationKey: "Synthetic telescopic boom, full outriggers, 360°, invented counterweight",
    sourceDocument: "Synthetic test chart",
    revision: "A",
    licenseRef: "n/a (synthetic)",
    synthetic: true,
    reviewState: "approved",
    importedBy: "synthetic",
    reviewedBy: "synthetic-review",
    boomType: "telescopic",
    convention: "gross",
    lookupRule: "conservative-bracket",
    boomLengthsM: [12, 18, 24, 30],
    radiiM: [4, 6, 8, 10, 14, 18, 22],
    capacitiesKg: [
      [40000, 28000, 19000, 13500, _, _, _],
      [36000, 26500, 18500, 13200, 8200, _, _],
      [_, 24000, 17500, 12800, 8000, 5400, _],
      [_, _, 16000, 12000, 7600, 5100, 3600],
    ],
    windLimitMs: 9.8,
  };
}

/**
 * units.ts — the unit boundary.
 *
 * The kernel works in SI: length m, mass kg, force N, pressure Pa, speed m/s,
 * angles in degrees at the API surface. Mass and force are separate kinds and
 * are never stored in each other's fields. Conversion happens only here.
 *
 * All constants below are exact by definition.
 */

export const STANDARD_GRAVITY = 9.80665; // m/s²
export const KG_PER_LB = 0.45359237;
export const KG_PER_US_SHORT_TON = 907.18474;
export const KG_PER_TONNE = 1000;
export const KG_PER_UK_LONG_TON = 1016.0469088;
export const M_PER_FT = 0.3048;
export const N_PER_LBF = 4.4482216152605;
export const PA_PER_PSF = N_PER_LBF / (M_PER_FT * M_PER_FT);
export const MS_PER_MPH = 0.44704;

export type UnitSystem = "SI" | "US";
export type QuantityKind = "mass" | "length" | "force" | "pressure" | "speed" | "angle" | "ratio";

interface UnitDef {
  label: string;
  /** Multiply a display value by this to get the SI base value. */
  toBase: number;
}

const DISPLAY_UNITS: Record<UnitSystem, Record<QuantityKind, UnitDef>> = {
  SI: {
    mass: { label: "kg", toBase: 1 },
    length: { label: "m", toBase: 1 },
    force: { label: "kN", toBase: 1000 },
    pressure: { label: "kPa", toBase: 1000 },
    speed: { label: "m/s", toBase: 1 },
    angle: { label: "°", toBase: 1 },
    ratio: { label: "%", toBase: 0.01 },
  },
  US: {
    mass: { label: "lb", toBase: KG_PER_LB },
    length: { label: "ft", toBase: M_PER_FT },
    force: { label: "lbf", toBase: N_PER_LBF },
    pressure: { label: "psf", toBase: PA_PER_PSF },
    speed: { label: "mph", toBase: MS_PER_MPH },
    angle: { label: "°", toBase: 1 },
    ratio: { label: "%", toBase: 0.01 },
  },
};

export function unitLabel(kind: QuantityKind, system: UnitSystem): string {
  return DISPLAY_UNITS[system][kind].label;
}

export function toBase(kind: QuantityKind, displayValue: number, system: UnitSystem): number {
  return displayValue * DISPLAY_UNITS[system][kind].toBase;
}

export function fromBase(kind: QuantityKind, baseValue: number, system: UnitSystem): number {
  return baseValue / DISPLAY_UNITS[system][kind].toBase;
}

/** Mass units accepted on import. A bare "ton" is ambiguous and is not in this list on purpose. */
export type MassUnit = "kg" | "t" | "lb" | "ton_us" | "ton_uk";

const MASS_FACTORS: Record<MassUnit, number> = {
  kg: 1,
  t: KG_PER_TONNE,
  lb: KG_PER_LB,
  ton_us: KG_PER_US_SHORT_TON,
  ton_uk: KG_PER_UK_LONG_TON,
};

export type UnitParse<T extends string> = { ok: true; unit: T } | { ok: false; code: "UNIT_MISSING" | "UNIT_AMBIGUOUS" | "UNIT_UNKNOWN"; message: string };

export function parseMassUnit(raw: string | null | undefined): UnitParse<MassUnit> {
  const u = (raw ?? "").trim().toLowerCase();
  if (u === "") return { ok: false, code: "UNIT_MISSING", message: "A mass needs a unit." };
  if (u === "ton" || u === "tons") {
    return { ok: false, code: "UNIT_AMBIGUOUS", message: "Unit 'ton' is ambiguous; use 't' (metric tonne) or 'ton_us' (US short ton)." };
  }
  if (u in MASS_FACTORS) return { ok: true, unit: u as MassUnit };
  return { ok: false, code: "UNIT_UNKNOWN", message: `Unknown mass unit '${raw}'.` };
}

export function massToKg(value: number, unit: MassUnit): number {
  return value * MASS_FACTORS[unit];
}

export function weightN(massKg: number, g: number = STANDARD_GRAVITY): number {
  return massKg * g;
}

/**
 * Strict numeric parsing. Returns null for anything that is not unambiguously
 * one number: parseFloat("12,500") is 12 and parseFloat("12k") is 12, and a
 * weight wrong by 1000x is not a typo anyone notices on screen.
 *
 * A comma is accepted only as a US thousands separator ("12,500").
 */
const THOUSANDS = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/;
const PLAIN = /^[+-]?(\d+\.?\d*|\.\d+)$/;

export function parseStrictNumber(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return null;
  if (PLAIN.test(s)) return Number(s);
  if (THOUSANDS.test(s)) return Number(s.replace(/,/g, ""));
  return null;
}

/**
 * mechanics.ts — closed-form statics used by the plan evaluation.
 *
 * Each function states the assumptions it is valid under. They are checks of
 * specific sub-models, not a model of a crane. Functions return NaN for input
 * they cannot evaluate so callers gate on Number.isFinite.
 */

const RAD = Math.PI / 180;

/**
 * Two-leg sling, legs coplanar with the load line, CG under the apex, static.
 * Angles are measured FROM HORIZONTAL. Returns leg tensions in the unit of W.
 *   T1 = W·cos(a2) / sin(a1 + a2),  T2 = W·cos(a1) / sin(a1 + a2)
 * Two vertical legs (a1 = a2 = 90°) are not resolved here: the share then
 * depends on where the CG sits between them, which this function is not given.
 */
export function twoLegTensions(weight: number, angle1Deg: number, angle2Deg: number): { t1: number; t2: number } {
  const bad = { t1: NaN, t2: NaN };
  if (!(weight >= 0) || !(angle1Deg > 0 && angle1Deg <= 90) || !(angle2Deg > 0 && angle2Deg <= 90)) return bad;
  const s = Math.sin((angle1Deg + angle2Deg) * RAD);
  if (s < 1e-9) return bad;
  return { t1: (weight * Math.cos(angle2Deg * RAD)) / s, t2: (weight * Math.cos(angle1Deg * RAD)) / s };
}

/**
 * Two vertical supports on a rigid, level member; static and determinate.
 * Load W at `distanceFromA` along `span`. Used for a two-crane share with
 * vertical hoist lines and the CG at lift-point level.
 */
export function twoSupportReactions(weight: number, span: number, distanceFromA: number): { a: number; b: number } {
  if (!(weight >= 0) || !(span > 0) || !(distanceFromA >= 0) || distanceFromA > span) return { a: NaN, b: NaN };
  const b = (weight * distanceFromA) / span;
  return { a: weight - b, b };
}

/**
 * Average contact pressure = total vertical force / effective area.
 * This is an average only. It does not establish peak pressure under a float,
 * settlement, mat structural adequacy, or the soil's capacity.
 */
export function averagePressure(forceN: number, areaM2: number): number {
  if (!(forceN >= 0) || !(areaM2 > 0)) return NaN;
  return forceN / areaM2;
}

/**
 * Steady drag on a bluff body: F = ½·ρ·Cd·A·V². Assumes steady flow, drag only
 * (no lift), no dynamic response. It is not a crane wind rating.
 */
export function dragForceN(airDensity: number, dragCoefficient: number, areaM2: number, speedMs: number): number {
  if (!(airDensity > 0) || !(dragCoefficient > 0) || !(areaM2 >= 0) || !(speedMs >= 0)) return NaN;
  return 0.5 * airDensity * dragCoefficient * areaM2 * speedMs * speedMs;
}

/**
 * Rigid-boom geometry about the boom heel pin. The heel pin's offset from the
 * slew axis is NOT modelled, so this angle is for the sketch and for a sanity
 * check — it is not the operator's boom-angle indicator reading.
 */
export function boomGeometry(boomLengthM: number, radiusM: number): { angleDeg: number; tipHeightM: number } {
  if (!(boomLengthM > 0) || !(radiusM > 0) || radiusM > boomLengthM) return { angleDeg: NaN, tipHeightM: NaN };
  const angle = Math.acos(radiusM / boomLengthM);
  return { angleDeg: angle / RAD, tipHeightM: boomLengthM * Math.sin(angle) };
}

/** Small-angle period of a simple pendulum, s. */
export function pendulumPeriodS(lengthM: number, g: number): number {
  if (!(lengthM > 0) || !(g > 0)) return NaN;
  return 2 * Math.PI * Math.sqrt(lengthM / g);
}

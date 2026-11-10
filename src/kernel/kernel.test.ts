import { describe, expect, it } from "vitest";
import { approvalStatus, canApprove, fingerprintInput, sha256Hex } from "./approval";
import { type ChartDataset, canApproveDataset, lookupCapacity, parseChartTable, syntheticDataset } from "./chart";
import { type LiftPlan, deductionLedger, emptyPlan, evaluatePlan } from "./evaluate";
import { averagePressure, dragForceN, pendulumPeriodS, twoLegTensions, twoSupportReactions } from "./mechanics";
import { KG_PER_US_SHORT_TON, PA_PER_PSF, STANDARD_GRAVITY, massToKg, parseMassUnit, parseStrictNumber, weightN } from "./units";

// Test IDs refer to Appendix D of docs/crane-pick-plan-simulator-frd.md.

describe("analytical benchmarks (Appendix D.2)", () => {
  it("VT-14 symmetric two-leg sling: 100 kN at 60° gives 57.735 kN per leg", () => {
    const { t1, t2 } = twoLegTensions(100, 60, 60);
    expect(t1).toBeCloseTo(57.735, 3);
    expect(t2).toBeCloseTo(57.735, 3);
  });
  it("VT-15 asymmetric two-leg sling: 60° and 45° give 73.205 and 51.764 kN", () => {
    const { t1, t2 } = twoLegTensions(100, 60, 45);
    expect(t1).toBeCloseTo(73.205, 3);
    expect(t2).toBeCloseTo(51.764, 3);
  });
  it("VT-23 average bearing: 600 kN over 4 m² is 150 kPa", () => {
    expect(averagePressure(600_000, 4)).toBe(150_000);
  });
  it("VT-35 two supports: 200 kN at 4 m on a 10 m span gives 120 / 80 kN", () => {
    expect(twoSupportReactions(200, 10, 4)).toEqual({ a: 120, b: 80 });
  });
  it("VT-26 two-crane share: 200 kN, CG 5 m from A on 12 m gives 116.667 / 83.333 kN", () => {
    const r = twoSupportReactions(200, 12, 5);
    expect(r.a).toBeCloseTo(116.667, 3);
    expect(r.b).toBeCloseTo(83.333, 3);
  });
  it("VT-20a pendulum period: 20 m at standard gravity is 8.973 s", () => {
    expect(pendulumPeriodS(20, STANDARD_GRAVITY)).toBeCloseTo(8.973, 3);
  });
  it("VT-32 drag: ρ 1.225, Cd 1.2, 10 m², 10 m/s gives 735 N", () => {
    expect(dragForceN(1.225, 1.2, 10, 10)).toBeCloseTo(735, 6);
  });
});

describe("VT-34 / FT-26 units", () => {
  it("converts tons exactly and keeps mass and force apart", () => {
    expect(massToKg(100, "ton_us")).toBeCloseTo(90_718.474, 6);
    expect(weightN(massToKg(100, "ton_us")) / 1000).toBeCloseTo(889.644, 3);
    expect(weightN(massToKg(100, "t")) / 1000).toBeCloseTo(980.665, 6);
    expect(KG_PER_US_SHORT_TON).toBe(907.18474);
    expect(3000 * PA_PER_PSF).toBeCloseTo(143_640.777, 2);
  });
  it("rejects a bare 'ton' and a missing unit", () => {
    expect(parseMassUnit("ton")).toMatchObject({ ok: false, code: "UNIT_AMBIGUOUS" });
    expect(parseMassUnit("")).toMatchObject({ ok: false, code: "UNIT_MISSING" });
    expect(parseMassUnit("ton_us")).toEqual({ ok: true, unit: "ton_us" });
  });
  it("parses numbers strictly", () => {
    expect(parseStrictNumber("12,500")).toBe(12500);
    expect(parseStrictNumber("12,5")).toBeNull();
    expect(parseStrictNumber("12k")).toBeNull();
    expect(parseStrictNumber("")).toBeNull();
    expect(parseStrictNumber(" 3.25 ")).toBe(3.25);
  });
});

describe("VT-01 / VT-02 / FT-01 chart lookup", () => {
  const ds = syntheticDataset();
  it("returns every tabulated cell exactly", () => {
    ds.boomLengthsM.forEach((b, i) =>
      ds.radiiM.forEach((r, j) => {
        const cell = ds.capacitiesKg[i]![j]!;
        const res = lookupCapacity(ds, b, r);
        if (cell === "not_rated") expect(res).toMatchObject({ ok: false, code: "NOT_RATED" });
        else expect(res).toMatchObject({ ok: true, capacityKg: cell, rule: "exact" });
      }),
    );
  });
  it("uses the lowest bracketing cell between entries", () => {
    expect(lookupCapacity(ds, 18, 7)).toMatchObject({ ok: true, capacityKg: 18500, rule: "conservative-bracket" });
    expect(lookupCapacity(ds, 21, 9)).toMatchObject({ ok: true, capacityKg: 12800 });
  });
  it("never extrapolates", () => {
    expect(lookupCapacity(ds, 18, 23)).toMatchObject({ ok: false, code: "OUTSIDE_COVERAGE" });
    expect(lookupCapacity(ds, 18, 3.9)).toMatchObject({ ok: false, code: "OUTSIDE_COVERAGE" });
    expect(lookupCapacity(ds, 31, 10)).toMatchObject({ ok: false, code: "OUTSIDE_COVERAGE" });
  });
  it("refuses a bracket that touches a blank cell", () => {
    expect(lookupCapacity(ds, 12, 12)).toMatchObject({ ok: false, code: "NOT_RATED" });
    expect(lookupCapacity(ds, 21, 4)).toMatchObject({ ok: false, code: "NOT_RATED" });
  });
  it("refuses an unlisted lattice boom length and off-table points on exact-only data", () => {
    expect(lookupCapacity({ ...ds, boomType: "lattice" }, 21, 10)).toMatchObject({ ok: false, code: "UNLISTED_BOOM_LENGTH" });
    expect(lookupCapacity({ ...ds, lookupRule: "exact-only" }, 18, 7)).toMatchObject({ ok: false, code: "NOT_TABULATED" });
  });
  it("refuses a missing or unreviewed dataset", () => {
    expect(lookupCapacity(null, 18, 8)).toMatchObject({ ok: false, code: "NO_DATASET" });
    expect(lookupCapacity({ ...ds, reviewState: "imported-unreviewed" }, 18, 8)).toMatchObject({ ok: false, code: "DATASET_NOT_APPROVED" });
  });
});

describe("chart table import and dataset review", () => {
  it("parses a table, converting units and keeping blanks as not rated", () => {
    const res = parseChartTable("ft\t10\t20\n40\t80,000\t-\n60\t70,000\t30,000", "ft", "lb");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.table.radiiM[0]).toBeCloseTo(3.048, 6);
    expect(res.table.boomLengthsM[1]).toBeCloseTo(18.288, 6);
    expect(res.table.capacitiesKg[0]![1]).toBe("not_rated");
    expect(res.table.capacitiesKg[1]![1]).toBeCloseTo(13_607.771, 2);
  });
  it("rejects a cell it cannot read rather than guessing", () => {
    expect(parseChartTable("m,4,6\n12,40000,28k", "m", "kg").ok).toBe(false);
    expect(parseChartTable("m,6,4\n12,40000,28000", "m", "kg").ok).toBe(false);
  });
  it("FT-01a / IT-04 needs a source, a license reference and a second reviewer", () => {
    const base = { licenseRef: "L-1", sourceDocument: "Chart book", revision: "C", configurationKey: "cfg", importedBy: "Pat", reviewedBy: "Sam" };
    expect(canApproveDataset(base).ok).toBe(true);
    expect(canApproveDataset({ ...base, licenseRef: "" }).ok).toBe(false);
    expect(canApproveDataset({ ...base, reviewedBy: "pat " }).ok).toBe(false);
  });
});

function completePlan(): LiftPlan {
  const p = emptyPlan();
  p.name = "L-001";
  p.load = { massKg: 10_000, evidence: "calculated", uncertaintyRel: 0.03 };
  p.crane = { boomLengthM: 18, radiusM: 8, radiusAllowanceM: 0, partsOfLine: 4, singleLinePullKg: 5000 };
  p.deductions = [
    { id: "a", label: "Hook block", massKg: 450 },
    { id: "b", label: "Rigging", massKg: 310 },
  ];
  p.rigging = { enabled: true, angle1Deg: 60, angle2Deg: 60, wll1Kg: 8000, wll2Kg: 8000, liftPointEvidenceRef: "Calc C-12 rev 1" };
  p.ground = { reactionN: 400_000, reactionSource: "OEM outrigger load table", matMassKg: 900, matLengthM: 2, matWidthM: 2, fullAreaAttested: true, allowableBearingPa: 150_000, allowableSource: "Geotech report G-4" };
  p.wind = { gustMs: 6, source: "measured" };
  p.thresholds = { reviewUtilization: 0.75, minSlingAngleDeg: 45, projectWindLimitMs: null };
  return p;
}

const state = (plan: LiftPlan, ds: ChartDataset | null, id: string) => evaluatePlan(plan, ds).checks.find((c) => c.id === id)?.state;

describe("plan evaluation", () => {
  const ds = syntheticDataset();

  it("a complete plan inside every limit is calculated within stated limits", () => {
    const ev = evaluatePlan(completePlan(), ds);
    expect(ev.checks.map((c) => [c.id, c.state])).toEqual([
      ["chart", "WITHIN_LIMITS"],
      ["line-pull", "WITHIN_LIMITS"],
      ["rigging", "WITHIN_LIMITS"],
      ["ground", "WITHIN_LIMITS"],
      ["wind", "WITHIN_LIMITS"],
    ]);
    const chart = ev.checks[0]!;
    // VT-05: demand = 10 000 × 1.03 + 450 + 310 = 11 060 kg against 18 500 kg.
    expect(chart.metrics.find((m) => m.label === "Demand")?.value).toBeCloseTo(11_060, 6);
    expect(chart.metrics.find((m) => m.label === "Utilization")?.value).toBeCloseTo(11_060 / 18_500, 9);
  });

  it("FT-03 an empty plan is a draft and shows no utilization", () => {
    const ev = evaluatePlan(emptyPlan(), ds);
    expect(ev.state).toBe("DRAFT");
    expect(ev.checks.flatMap((c) => c.metrics).some((m) => m.label === "Utilization")).toBe(false);
  });

  it("FT-01 no chart coverage is unsupported, never a pass", () => {
    const p = completePlan();
    expect(state(p, null, "chart")).toBe("UNSUPPORTED");
    p.crane.radiusM = 30;
    expect(state(p, ds, "chart")).toBe("UNSUPPORTED");
    expect(evaluatePlan(p, ds).state).toBe("UNSUPPORTED");
  });

  it("KIN-002 radius growth must be addressed, and it is added to the radius", () => {
    const p = completePlan();
    p.crane.radiusAllowanceM = null;
    expect(state(p, ds, "chart")).toBe("DRAFT");
    p.crane.radiusAllowanceM = 0.5; // 8.5 m brackets 8 m and 10 m → 13 200 kg
    const chart = evaluatePlan(p, ds).checks[0]!;
    expect(chart.metrics.find((m) => m.label === "Chart capacity")?.value).toBe(13_200);
  });

  it("over capacity is a limit exceeded", () => {
    const p = completePlan();
    p.load.massKg = 19_000;
    expect(state(p, ds, "chart")).toBe("LIMIT_EXCEEDED");
  });

  it("FT-11 a threshold nobody set is review required, not a pass", () => {
    const p = completePlan();
    p.thresholds.reviewUtilization = null;
    expect(state(p, ds, "chart")).toBe("REVIEW_REQUIRED");
    const q = completePlan();
    expect(state(q, { ...ds, windLimitMs: null }, "wind")).toBe("REVIEW_REQUIRED");
    q.wind.source = "forecast";
    expect(state(q, ds, "wind")).toBe("REVIEW_REQUIRED");
  });

  it("estimated weight and unstated uncertainty need review", () => {
    const p = completePlan();
    p.load.evidence = "estimated";
    expect(state(p, ds, "chart")).toBe("REVIEW_REQUIRED");
    const q = completePlan();
    q.load.uncertaintyRel = null;
    expect(state(q, ds, "chart")).toBe("REVIEW_REQUIRED");
  });

  it("FT-02 deductions: a duplicate or a missing weight is invalid", () => {
    expect(deductionLedger([{ id: "1", label: "Hook block", massKg: 450 }, { id: "2", label: "hook block", massKg: 450 }]).ok).toBe(false);
    const p = completePlan();
    p.deductions.push({ id: "c", label: "Stowed jib", massKg: null });
    expect(state(p, ds, "chart")).toBe("INVALID");
  });

  it("a net chart does not take the deductions off twice", () => {
    const ev = evaluatePlan(completePlan(), { ...ds, convention: "net" });
    expect(ev.checks[0]!.metrics.find((m) => m.label === "Demand")?.value).toBeCloseTo(10_300, 6);
  });

  it("VT-06 line pull governs independently of the chart", () => {
    const p = completePlan();
    p.crane.partsOfLine = 2;
    expect(state(p, ds, "line-pull")).toBe("LIMIT_EXCEEDED");
    expect(state(p, ds, "chart")).toBe("WITHIN_LIMITS");
  });

  it("FT-06 / FT-07 rigging: missing rating, overload, low angle and missing lift-point evidence", () => {
    const p = completePlan();
    p.rigging.wll1Kg = null;
    expect(state(p, ds, "rigging")).toBe("DRAFT");
    p.rigging.wll1Kg = 5000; // 10 300 kg × g / (2 sin 60°) ≈ 58.3 kN > 49.0 kN
    expect(state(p, ds, "rigging")).toBe("LIMIT_EXCEEDED");
    const q = completePlan();
    q.rigging.angle1Deg = 30;
    q.rigging.angle2Deg = 30;
    q.rigging.wll1Kg = 20_000;
    q.rigging.wll2Kg = 20_000;
    expect(state(q, ds, "rigging")).toBe("LIMIT_EXCEEDED");
    const r = completePlan();
    r.rigging.liftPointEvidenceRef = "";
    expect(state(r, ds, "rigging")).toBe("REVIEW_REQUIRED");
    const v = completePlan();
    v.rigging.angle1Deg = 90;
    v.rigging.angle2Deg = 90;
    expect(state(v, ds, "rigging")).toBe("UNSUPPORTED");
  });

  it("FT-08 ground: missing reaction, source or allowable blocks; unattested area needs review", () => {
    const p = completePlan();
    p.ground.reactionN = null;
    expect(state(p, ds, "ground")).toBe("DRAFT");
    const q = completePlan();
    q.ground.allowableBearingPa = null;
    expect(state(q, ds, "ground")).toBe("DRAFT");
    const r = completePlan();
    r.ground.allowableSource = "";
    expect(state(r, ds, "ground")).toBe("DRAFT");
    const s = completePlan();
    s.ground.fullAreaAttested = false;
    expect(state(s, ds, "ground")).toBe("REVIEW_REQUIRED");
    const t = completePlan();
    t.ground.reactionN = 700_000;
    expect(state(t, ds, "ground")).toBe("LIMIT_EXCEEDED");
  });
});

describe("FT-09 / FT-21 / FT-28 approval", () => {
  const ds = syntheticDataset();
  const real: ChartDataset = { ...ds, synthetic: false, label: "Owner-entered chart" };
  const people = { author: "Pat", reviewer: "Sam", approver: "Lee" };

  it("needs every check within limits and three different people", () => {
    const ev = evaluatePlan(completePlan(), real);
    expect(canApprove(ev, people).ok).toBe(true);
    expect(canApprove(ev, { ...people, approver: "pat" }).ok).toBe(false);
    expect(canApprove(ev, { ...people, reviewer: "" }).ok).toBe(false);
    const review = completePlan();
    review.thresholds.reviewUtilization = null;
    expect(canApprove(evaluatePlan(review, real), people).ok).toBe(false);
  });

  it("a synthetic dataset can never support an approval", () => {
    expect(canApprove(evaluatePlan(completePlan(), ds), people).ok).toBe(false);
  });

  it("changing the plan or the dataset invalidates the approval; the same inputs reproduce the hash", async () => {
    const plan = completePlan();
    const hash = await sha256Hex(fingerprintInput(plan, real, STANDARD_GRAVITY));
    const approval = { ...people, inputsHash: hash, scope: "L-001", approvedAt: "2026-11-10T00:00:00Z" };
    expect(approvalStatus(approval, await sha256Hex(fingerprintInput(completePlan(), { ...real }, STANDARD_GRAVITY)))).toBe("current");
    plan.load.massKg = 10_001;
    expect(approvalStatus(approval, await sha256Hex(fingerprintInput(plan, real, STANDARD_GRAVITY)))).toBe("invalidated");
    const newRev = await sha256Hex(fingerprintInput(completePlan(), { ...real, revision: "B" }, STANDARD_GRAVITY));
    expect(approvalStatus(approval, newRev)).toBe("invalidated");
    expect(approvalStatus(null, hash)).toBe("none");
  });
});

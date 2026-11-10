import { beforeEach, describe, expect, it } from "vitest";
import { emptyPlan } from "../kernel/evaluate";
import { createApp } from "./app";
import { type Db, openDb, verifyAudit } from "./db";

// Test IDs refer to Appendix D of docs/crane-pick-plan-simulator-frd.md.

type App = ReturnType<typeof createApp>;
let db: Db;
let app: App;

async function call(cookie: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any, setCookie: res.headers.get("set-cookie") };
}

async function register(name: string) {
  const res = await call(null, "POST", "/api/auth/register", { email: `${name.toLowerCase()}@example.com`, name, password: "correct horse battery", signupCode: "letmein" });
  expect(res.status).toBe(200);
  return res.setCookie!.split(";")[0]!;
}

const chart = {
  label: "Owner crane",
  configurationKey: "Full outriggers, 360°",
  sourceDocument: "Chart book",
  revision: "C",
  licenseRef: "Owner copy",
  boomType: "telescopic",
  convention: "gross",
  lookupRule: "conservative-bracket",
  boomLengthsM: [12, 18],
  radiiM: [4, 8, 12],
  capacitiesKg: [
    [40000, 19000, "not_rated"],
    [36000, 18500, 9000],
  ],
  windLimitMs: 9.8,
};

function goodPlan() {
  const p = emptyPlan();
  p.name = "L-001";
  p.load = { massKg: 10_000, evidence: "calculated", uncertaintyRel: 0.03 };
  p.crane = { boomLengthM: 18, radiusM: 8, radiusAllowanceM: 0, partsOfLine: 4, singleLinePullKg: 5000 };
  p.deductions = [{ id: "hb", label: "Hook block", massKg: 450 }];
  p.rigging.enabled = false;
  p.ground = { reactionN: 400_000, reactionSource: "OEM table", matMassKg: 900, matLengthM: 2, matWidthM: 2, fullAreaAttested: true, allowableBearingPa: 150_000, allowableSource: "Geotech G-4" };
  p.wind = { gustMs: 6, source: "measured" };
  p.thresholds = { reviewUtilization: 0.75, minSlingAngleDeg: null, projectWindLimitMs: null };
  return p;
}

beforeEach(() => {
  db = openDb(":memory:");
  app = createApp(db, { signupCode: "letmein", secureCookies: false });
});

describe("accounts", () => {
  it("needs the sign-up code, and everything else needs a session", async () => {
    expect((await call(null, "POST", "/api/auth/register", { email: "a@example.com", name: "A", password: "correct horse battery", signupCode: "nope" })).status).toBe(403);
    expect((await call(null, "GET", "/api/plans")).status).toBe(401);
    const pat = await register("Pat");
    expect((await call(pat, "GET", "/api/me")).json.user.name).toBe("Pat");
    expect((await call(pat, "GET", "/api/plans")).status).toBe(200);
    expect((await call(null, "POST", "/api/auth/login", { email: "pat@example.com", password: "wrong" })).status).toBe(401);
    expect((await call(null, "POST", "/api/auth/login", { email: "pat@example.com", password: "correct horse battery" })).status).toBe(200);
  });

  it("closes sign-up when no code is configured and refuses cross-site writes", async () => {
    const closed = createApp(openDb(":memory:"), { signupCode: null, secureCookies: false });
    const res = await closed.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(403);
    const pat = await register("Pat");
    expect((await call(pat, "POST", "/api/plans", { plan: emptyPlan() }, { origin: "https://evil.example", host: "localhost" })).status).toBe(403);
    expect((await call(pat, "POST", "/api/plans", { plan: emptyPlan() }, { origin: "https://app.example", host: "localhost", "x-forwarded-host": "app.example" })).status).toBe(200);
  });

  it("locks sign-in after repeated failures", async () => {
    await register("Pat");
    for (let i = 0; i < 10; i++) await call(null, "POST", "/api/auth/login", { email: "pat@example.com", password: "wrong" });
    expect((await call(null, "POST", "/api/auth/login", { email: "pat@example.com", password: "correct horse battery" })).status).toBe(429);
  });
});

describe("IT-04 chart review", () => {
  it("the person who entered a chart cannot approve it; a second account can; then it is immutable", async () => {
    const pat = await register("Pat");
    const sam = await register("Sam");
    const created = await call(pat, "POST", "/api/datasets", { ...chart, reviewState: "approved", importedBy: "Someone Else", reviewedBy: "Boss" });
    expect(created.json.dataset).toMatchObject({ reviewState: "imported-unreviewed", importedBy: "Pat", reviewedBy: "" });
    const id = created.json.dataset.id;
    expect((await call(pat, "POST", `/api/datasets/${id}/approve`)).status).toBe(403);
    expect((await call(sam, "PUT", `/api/datasets/${id}`, chart)).status).toBe(403);
    const approved = await call(sam, "POST", `/api/datasets/${id}/approve`);
    expect(approved.json.dataset).toMatchObject({ reviewState: "approved", importedBy: "Pat", reviewedBy: "Sam" });
    expect((await call(pat, "PUT", `/api/datasets/${id}`, chart)).status).toBe(409);
  });

  it("rejects a malformed chart and one with no source recorded", async () => {
    const pat = await register("Pat");
    const sam = await register("Sam");
    expect((await call(pat, "POST", "/api/datasets", { ...chart, radiiM: [8, 4, 12] })).status).toBe(400);
    expect((await call(pat, "POST", "/api/datasets", { ...chart, capacitiesKg: [[1, 2, 3]] })).status).toBe(400);
    const noSource = await call(pat, "POST", "/api/datasets", { ...chart, licenseRef: "" });
    expect((await call(sam, "POST", `/api/datasets/${noSource.json.dataset.id}/approve`)).status).toBe(400);
  });
});

describe("FT-09 / FT-21 plan review and approval", () => {
  async function setup() {
    const pat = await register("Pat");
    const sam = await register("Sam");
    const lee = await register("Lee");
    const ds = await call(pat, "POST", "/api/datasets", chart);
    const datasetId = ds.json.dataset.id as string;
    await call(sam, "POST", `/api/datasets/${datasetId}/approve`);
    return { pat, sam, lee, datasetId };
  }

  it("author, reviewer and approver must be three accounts", async () => {
    const { pat, sam, lee, datasetId } = await setup();
    const saved = await call(pat, "POST", "/api/plans", { plan: goodPlan(), datasetId });
    const rev = saved.json.revision;
    expect(rev.evaluation.state).toBe("WITHIN_LIMITS");
    expect((await call(pat, "POST", `/api/revisions/${rev.id}/review`)).status).toBe(403);
    expect((await call(lee, "POST", `/api/revisions/${rev.id}/approve`)).json.code).toBe("NOT_REVIEWED");
    expect((await call(sam, "POST", `/api/revisions/${rev.id}/review`)).status).toBe(200);
    expect((await call(sam, "POST", `/api/revisions/${rev.id}/approve`)).status).toBe(403);
    expect((await call(pat, "POST", `/api/revisions/${rev.id}/approve`)).status).toBe(403);
    const approved = await call(lee, "POST", `/api/revisions/${rev.id}/approve`);
    expect(approved.json.revision.approval.by.name).toBe("Lee");
    const list = await call(pat, "GET", "/api/plans");
    expect(list.json.plans[0]).toMatchObject({ name: "L-001", rev: 1, approved: true });
  });

  it("a new revision is unapproved and the old one can no longer be acted on", async () => {
    const { pat, sam, lee, datasetId } = await setup();
    const r1 = (await call(pat, "POST", "/api/plans", { plan: goodPlan(), datasetId })).json.revision;
    await call(sam, "POST", `/api/revisions/${r1.id}/review`);
    const changed = goodPlan();
    changed.load.massKg = 10_500;
    const r2 = (await call(pat, "POST", `/api/plans/${r1.planId}/revisions`, { plan: changed, datasetId })).json.revision;
    expect(r2.rev).toBe(2);
    expect(r2.inputsHash).not.toBe(r1.inputsHash);
    expect((await call(lee, "POST", `/api/revisions/${r1.id}/approve`)).json.code).toBe("SUPERSEDED");
    const plan = await call(pat, "GET", `/api/plans/${r1.planId}`);
    expect(plan.json.latest).toMatchObject({ rev: 2, review: null, approval: null });
    expect(plan.json.history).toHaveLength(2);
  });

  it("FT-01 / FT-03 / FT-28 nothing that is not within limits on a reviewed real chart can be approved", async () => {
    const { pat, sam, lee, datasetId } = await setup();
    const cases: Array<[string, unknown]> = [];
    const over = goodPlan();
    over.load.massKg = 19_000;
    cases.push(["LIMIT_EXCEEDED", { plan: over, datasetId }]);
    cases.push(["DRAFT", { plan: emptyPlan(), datasetId }]);
    cases.push(["UNSUPPORTED", { plan: goodPlan() }]);
    for (const [state, payload] of cases) {
      const rev = (await call(pat, "POST", "/api/plans", payload)).json.revision;
      expect(rev.evaluation.state).toBe(state);
      await call(sam, "POST", `/api/revisions/${rev.id}/review`);
      expect((await call(lee, "POST", `/api/revisions/${rev.id}/approve`)).status).toBe(409);
    }
    const synthetic = (await call(pat, "POST", "/api/datasets/synthetic")).json.dataset;
    expect(synthetic.synthetic).toBe(true);
    const rev = (await call(pat, "POST", "/api/plans", { plan: goodPlan(), datasetId: synthetic.id })).json.revision;
    expect(rev.evaluation.state).toBe("WITHIN_LIMITS");
    await call(sam, "POST", `/api/revisions/${rev.id}/review`);
    expect((await call(lee, "POST", `/api/revisions/${rev.id}/approve`)).status).toBe(409);
  });

  it("a revision saved on an unreviewed chart stays unsupported after the chart is approved", async () => {
    const pat = await register("Pat");
    const sam = await register("Sam");
    const id = (await call(pat, "POST", "/api/datasets", chart)).json.dataset.id;
    const rev = (await call(pat, "POST", "/api/plans", { plan: goodPlan(), datasetId: id })).json.revision;
    expect(rev.evaluation.state).toBe("UNSUPPORTED");
    await call(sam, "POST", `/api/datasets/${id}/approve`);
    expect((await call(pat, "GET", `/api/plans/${rev.planId}`)).json.latest.evaluation.state).toBe("UNSUPPORTED");
  });
});

describe("FT-24 audit log", () => {
  it("chains every entry and detects tampering", async () => {
    const pat = await register("Pat");
    await call(pat, "POST", "/api/plans", { plan: goodPlan() });
    const log = await call(pat, "GET", "/api/audit");
    expect(log.json.firstBrokenSeq).toBeNull();
    expect(log.json.entries.length).toBeGreaterThanOrEqual(2);
    db.prepare("UPDATE audit SET detail = ? WHERE seq = 1").run('{"name":"Mallory"}');
    expect(verifyAudit(db)).toBe(1);
  });
});

describe("steel models", () => {
  it("stores a valid model for everyone signed in and rejects a broken one", async () => {
    const { sampleModel } = await import("../kernel/site");
    const pat = await register("Pat");
    const sam = await register("Sam");
    expect((await call(null, "GET", "/api/models")).status).toBe(401);
    expect((await call(pat, "POST", "/api/models", { name: "Bad", members: [] })).status).toBe(400);
    const created = await call(pat, "POST", "/api/models", sampleModel());
    expect(created.status).toBe(200);
    const list = await call(sam, "GET", "/api/models");
    expect(list.json.models[0]).toMatchObject({ id: created.json.id, createdBy: "Pat", memberCount: sampleModel().members.length });
    expect((await call(sam, "GET", `/api/models/${created.json.id}`)).json.model.members).toHaveLength(sampleModel().members.length);
  });

  it("crane positions are part of the revision fingerprint", async () => {
    const pat = await register("Pat");
    const plan = goodPlan();
    plan.site.cranes = [{ id: "c1", name: "Crane 1", x: 0, z: 0, datasetId: null, boomLengthM: 18 }];
    const r1 = (await call(pat, "POST", "/api/plans", { plan })).json.revision;
    plan.site.cranes[0]!.x = 1;
    const r2 = (await call(pat, "POST", `/api/plans/${r1.planId}/revisions`, { plan })).json.revision;
    expect(r2.plan.site.cranes[0].x).toBe(1);
    expect(r2.inputsHash).not.toBe(r1.inputsHash);
  });
});

/**
 * app.ts — HTTP API.
 *
 * The server is the authority for who did what: who entered a chart, who
 * checked it, who authored, reviewed and approved a revision. None of that is
 * taken from request bodies. Every result a decision rests on is recomputed
 * here with the same kernel the browser uses.
 */
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { canApprove, fingerprintInput, sha256Hex } from "../kernel/approval";
import { type ChartDataset, canApproveDataset, syntheticDataset } from "../kernel/chart";
import { evaluatePlan } from "../kernel/evaluate";
import { STANDARD_GRAVITY } from "../kernel/units";
import { type DatasetContent, sanitizeDatasetContent, sanitizePlan } from "../kernel/validate";
import { type Db, audit, verifyAudit } from "./db";

export interface AppOptions {
  /** Required to create an account. Without it, registration is closed. */
  signupCode: string | null;
  secureCookies: boolean;
}

interface User {
  id: string;
  email: string;
  name: string;
}

type Env = { Variables: { user: User } };

const SESSION_COOKIE = "sbplp_session";
const SESSION_DAYS = 14;
const MAX_LOGIN_FAILURES = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 64).toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

interface DatasetRow {
  id: string;
  content: string;
  synthetic: number;
  imported_by: string;
  reviewed_by: string | null;
  importer_name: string;
  reviewer_name: string | null;
}

const DATASET_SELECT = `SELECT d.id, d.content, d.synthetic, d.imported_by, d.reviewed_by, u.name AS importer_name, r.name AS reviewer_name
  FROM datasets d JOIN users u ON u.id = d.imported_by LEFT JOIN users r ON r.id = d.reviewed_by`;

function toDataset(row: DatasetRow): ChartDataset {
  const content = JSON.parse(row.content) as DatasetContent;
  const synthetic = row.synthetic === 1;
  return {
    ...content,
    id: row.id,
    synthetic,
    reviewState: synthetic || row.reviewed_by ? "approved" : "imported-unreviewed",
    importedBy: synthetic ? "synthetic" : row.importer_name,
    reviewedBy: synthetic ? "synthetic" : (row.reviewer_name ?? ""),
  };
}

interface RevisionRow {
  id: string;
  plan_id: string;
  rev: number;
  plan: string;
  dataset: string | null;
  inputs_hash: string;
  author_id: string;
  author_name: string;
  created_at: string;
  reviewer_id: string | null;
  reviewer_name: string | null;
  reviewed_at: string | null;
  approver_id: string | null;
  approver_name: string | null;
  approved_at: string | null;
  scope: string | null;
}

const REVISION_SELECT = `SELECT v.id, v.plan_id, v.rev, v.plan, v.dataset, v.inputs_hash, v.author_id, a.name AS author_name, v.created_at,
    rv.reviewer_id, ru.name AS reviewer_name, rv.reviewed_at, ap.approver_id, au.name AS approver_name, ap.approved_at, ap.scope
  FROM revisions v JOIN users a ON a.id = v.author_id
  LEFT JOIN reviews rv ON rv.revision_id = v.id LEFT JOIN users ru ON ru.id = rv.reviewer_id
  LEFT JOIN approvals ap ON ap.revision_id = v.id LEFT JOIN users au ON au.id = ap.approver_id`;

function toRevision(row: RevisionRow, latestRev: number) {
  const plan = sanitizePlan(JSON.parse(row.plan));
  const dataset = row.dataset ? (JSON.parse(row.dataset) as ChartDataset) : null;
  return {
    id: row.id,
    planId: row.plan_id,
    rev: row.rev,
    superseded: row.rev < latestRev,
    plan,
    dataset,
    inputsHash: row.inputs_hash,
    evaluation: evaluatePlan(plan, dataset, STANDARD_GRAVITY),
    author: { id: row.author_id, name: row.author_name },
    createdAt: row.created_at,
    review: row.reviewer_id ? { by: { id: row.reviewer_id, name: row.reviewer_name }, at: row.reviewed_at } : null,
    approval: row.approver_id ? { by: { id: row.approver_id, name: row.approver_name }, at: row.approved_at, scope: row.scope } : null,
  };
}

export function createApp(db: Db, options: AppOptions) {
  const app = new Hono<Env>();
  const failures = new Map<string, { count: number; until: number }>();

  const fail = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429, code: string, message: string) => c.json({ code, message }, status);

  async function body(c: Context): Promise<Record<string, unknown>> {
    try {
      const v: unknown = await c.req.json();
      return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  function startSession(c: Context, userId: string) {
    const token = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(token), userId, expires.toISOString());
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Strict", secure: options.secureCookies, path: "/", expires });
  }

  function currentUser(c: Context): User | null {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return null;
    const row = db
      .prepare("SELECT u.id, u.email, u.name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?")
      .get(sha256(token)) as (User & { expires_at: string }) | undefined;
    if (!row || row.expires_at < now()) return null;
    return { id: row.id, email: row.email, name: row.name };
  }

  // A browser sends Origin on cross-site writes; refuse any that is not this host.
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (origin) {
        let host = "";
        try {
          host = new URL(origin).host;
        } catch {
          /* malformed origin is refused below */
        }
        // Behind a reverse proxy the public host arrives in X-Forwarded-Host. A browser cannot set
        // that header on a cross-site request, so accepting it does not weaken the check.
        const own = [c.req.header("host"), c.req.header("x-forwarded-host")];
        if (host === "" || !own.includes(host)) return fail(c, 403, "BAD_ORIGIN", "Cross-site request refused.");
      }
    }
    await next();
  });

  app.post("/api/auth/register", async (c) => {
    const b = await body(c);
    const email = String(b.email ?? "").trim().toLowerCase();
    const name = String(b.name ?? "").trim().slice(0, 80);
    const password = String(b.password ?? "");
    if (!options.signupCode) return fail(c, 403, "SIGNUP_CLOSED", "Account creation is closed on this server.");
    const given = Buffer.from(sha256(String(b.signupCode ?? "")));
    if (!timingSafeEqual(given, Buffer.from(sha256(options.signupCode)))) return fail(c, 403, "BAD_SIGNUP_CODE", "The sign-up code is not correct.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return fail(c, 400, "VALIDATION_FAILED", "Enter a valid email address.");
    if (name === "") return fail(c, 400, "VALIDATION_FAILED", "Enter your name.");
    if (password.length < 10 || password.length > 200) return fail(c, 400, "VALIDATION_FAILED", "Password must be at least 10 characters.");
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) return fail(c, 409, "EMAIL_TAKEN", "An account with that email already exists.");
    const id = randomUUID();
    db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(id, email, name, hashPassword(password), now());
    audit(db, id, "user.registered", { name });
    startSession(c, id);
    return c.json({ user: { id, email, name } });
  });

  app.post("/api/auth/login", async (c) => {
    const b = await body(c);
    const email = String(b.email ?? "").trim().toLowerCase();
    const lock = failures.get(email);
    if (lock && lock.count >= MAX_LOGIN_FAILURES && lock.until > Date.now()) return fail(c, 429, "TOO_MANY_ATTEMPTS", "Too many failed sign-ins. Try again in 15 minutes.");
    const row = db.prepare("SELECT id, email, name, password_hash FROM users WHERE email = ?").get(email) as (User & { password_hash: string }) | undefined;
    if (!row || !verifyPassword(String(b.password ?? ""), row.password_hash)) {
      const prior = lock && lock.until > Date.now() ? lock.count : 0;
      failures.set(email, { count: prior + 1, until: Date.now() + LOCKOUT_MS });
      return fail(c, 401, "BAD_CREDENTIALS", "Email or password is not correct.");
    }
    failures.delete(email);
    startSession(c, row.id);
    return c.json({ user: { id: row.id, email: row.email, name: row.name } });
  });

  app.post("/api/auth/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/me", (c) => c.json({ user: currentUser(c), signupOpen: options.signupCode !== null }));

  // Everything below needs a signed-in user.
  app.use("/api/*", async (c, next) => {
    const user = currentUser(c);
    if (!user) return fail(c, 401, "NOT_SIGNED_IN", "Sign in to continue.");
    c.set("user", user);
    await next();
  });

  // ── Chart datasets ──────────────────────────────────────────────────────
  const getDataset = (id: string) => db.prepare(`${DATASET_SELECT} WHERE d.id = ?`).get(id) as DatasetRow | undefined;

  app.get("/api/datasets", (c) => {
    const rows = db.prepare(`${DATASET_SELECT} ORDER BY d.created_at DESC`).all() as unknown as DatasetRow[];
    return c.json({ datasets: rows.map((r) => ({ ...toDataset(r), importedById: r.imported_by })) });
  });

  app.post("/api/datasets", async (c) => {
    const user = c.get("user");
    const parsed = sanitizeDatasetContent(await body(c));
    if (!parsed.ok) return fail(c, 400, "VALIDATION_FAILED", parsed.message);
    const id = randomUUID();
    db.prepare("INSERT INTO datasets (id, content, synthetic, imported_by, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)").run(id, JSON.stringify(parsed.content), user.id, now(), now());
    audit(db, user.id, "dataset.created", { id, label: parsed.content.label });
    return c.json({ dataset: toDataset(getDataset(id)!) });
  });

  app.post("/api/datasets/synthetic", (c) => {
    const user = c.get("user");
    const existing = db.prepare("SELECT id FROM datasets WHERE synthetic = 1 LIMIT 1").get() as { id: string } | undefined;
    if (existing) return c.json({ dataset: toDataset(getDataset(existing.id)!) });
    const { id: _id, reviewState: _r, importedBy: _i, reviewedBy: _v, synthetic: _s, ...content } = syntheticDataset();
    const id = randomUUID();
    db.prepare("INSERT INTO datasets (id, content, synthetic, imported_by, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)").run(id, JSON.stringify(content), user.id, now(), now());
    audit(db, user.id, "dataset.synthetic_loaded", { id });
    return c.json({ dataset: toDataset(getDataset(id)!) });
  });

  app.put("/api/datasets/:id", async (c) => {
    const user = c.get("user");
    const row = getDataset(c.req.param("id"));
    if (!row) return fail(c, 404, "NOT_FOUND", "Chart not found.");
    if (row.synthetic === 1 || row.reviewed_by) return fail(c, 409, "DATASET_IMMUTABLE", "An approved chart cannot be changed. Enter a corrected chart as a new one.");
    if (row.imported_by !== user.id) return fail(c, 403, "NOT_AUTHORIZED", "Only the person who entered this chart can edit it.");
    const parsed = sanitizeDatasetContent(await body(c));
    if (!parsed.ok) return fail(c, 400, "VALIDATION_FAILED", parsed.message);
    db.prepare("UPDATE datasets SET content = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(parsed.content), now(), row.id);
    audit(db, user.id, "dataset.edited", { id: row.id });
    return c.json({ dataset: toDataset(getDataset(row.id)!) });
  });

  app.post("/api/datasets/:id/approve", (c) => {
    const user = c.get("user");
    const row = getDataset(c.req.param("id"));
    if (!row) return fail(c, 404, "NOT_FOUND", "Chart not found.");
    if (row.synthetic === 1 || row.reviewed_by) return fail(c, 409, "ALREADY_APPROVED", "This chart is already approved.");
    const content = JSON.parse(row.content) as DatasetContent;
    if (content.boomLengthsM.length === 0) return fail(c, 400, "VALIDATION_FAILED", "The chart table is empty.");
    // Identity is compared by account, not by display name.
    const check = canApproveDataset({ ...content, importedBy: row.imported_by, reviewedBy: user.id });
    if (!check.ok) return fail(c, row.imported_by === user.id ? 403 : 400, "CANNOT_APPROVE", check.problems.join(" "));
    db.prepare("UPDATE datasets SET reviewed_by = ?, reviewed_at = ? WHERE id = ? AND reviewed_by IS NULL").run(user.id, now(), row.id);
    audit(db, user.id, "dataset.approved", { id: row.id, contentHash: sha256(row.content) });
    return c.json({ dataset: toDataset(getDataset(row.id)!) });
  });

  // ── Plans and revisions ─────────────────────────────────────────────────
  const latestRev = (planId: string) => (db.prepare("SELECT MAX(rev) AS rev FROM revisions WHERE plan_id = ?").get(planId) as { rev: number | null }).rev ?? 0;
  const getRevision = (id: string) => db.prepare(`${REVISION_SELECT} WHERE v.id = ?`).get(id) as RevisionRow | undefined;

  async function saveRevision(c: Context<Env>, planId: string) {
    const user = c.get("user");
    const b = await body(c);
    const plan = sanitizePlan(b.plan);
    let dataset: ChartDataset | null = null;
    if (typeof b.datasetId === "string" && b.datasetId !== "") {
      const row = getDataset(b.datasetId);
      if (!row) return fail(c, 400, "VALIDATION_FAILED", "The selected chart does not exist.");
      dataset = toDataset(row);
    }
    const inputsHash = await sha256Hex(fingerprintInput(plan, dataset, STANDARD_GRAVITY));
    const id = randomUUID();
    const rev = latestRev(planId) + 1;
    db.prepare("INSERT INTO revisions (id, plan_id, rev, plan, dataset, inputs_hash, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      planId,
      rev,
      JSON.stringify(plan),
      dataset ? JSON.stringify(dataset) : null,
      inputsHash,
      user.id,
      now(),
    );
    audit(db, user.id, "revision.saved", { planId, rev, inputsHash });
    return c.json({ revision: toRevision(getRevision(id)!, rev) });
  }

  app.get("/api/plans", (c) => {
    const rows = db.prepare(`${REVISION_SELECT} WHERE v.rev = (SELECT MAX(rev) FROM revisions x WHERE x.plan_id = v.plan_id) ORDER BY v.created_at DESC`).all() as unknown as RevisionRow[];
    return c.json({
      plans: rows.map((r) => {
        const v = toRevision(r, r.rev);
        return { id: v.planId, name: v.plan.name, description: v.plan.liftDescription, rev: v.rev, state: v.evaluation.state, reviewed: v.review !== null, approved: v.approval !== null, author: v.author.name, updatedAt: v.createdAt };
      }),
    });
  });

  app.post("/api/plans", async (c) => {
    const id = randomUUID();
    db.prepare("INSERT INTO plans (id, created_by, created_at) VALUES (?, ?, ?)").run(id, c.get("user").id, now());
    return saveRevision(c, id);
  });

  app.post("/api/plans/:id/revisions", async (c) => {
    const planId = c.req.param("id");
    if (!db.prepare("SELECT 1 FROM plans WHERE id = ?").get(planId)) return fail(c, 404, "NOT_FOUND", "Plan not found.");
    return saveRevision(c, planId);
  });

  app.get("/api/plans/:id", (c) => {
    const planId = c.req.param("id");
    const rows = db.prepare(`${REVISION_SELECT} WHERE v.plan_id = ? ORDER BY v.rev DESC`).all(planId) as unknown as RevisionRow[];
    const first = rows[0];
    if (!first) return fail(c, 404, "NOT_FOUND", "Plan not found.");
    const latest = toRevision(first, first.rev);
    return c.json({
      latest,
      history: rows.map((r) => ({ rev: r.rev, author: r.author_name, createdAt: r.created_at, reviewedBy: r.reviewer_name, approvedBy: r.approver_name, inputsHash: r.inputs_hash })),
    });
  });

  function latestRevisionOr(c: Context<Env>): RevisionRow | Response {
    const row = getRevision(c.req.param("id") ?? "");
    if (!row) return fail(c, 404, "NOT_FOUND", "Revision not found.");
    if (row.rev < latestRev(row.plan_id)) return fail(c, 409, "SUPERSEDED", "A newer revision of this plan exists. Review and approve the latest one.");
    return row;
  }

  app.post("/api/revisions/:id/review", (c) => {
    const user = c.get("user");
    const row = latestRevisionOr(c);
    if (row instanceof Response) return row;
    if (row.reviewer_id) return fail(c, 409, "ALREADY_REVIEWED", "This revision has already been reviewed.");
    if (row.author_id === user.id) return fail(c, 403, "SEPARATION_OF_DUTIES", "The author cannot review their own revision.");
    db.prepare("INSERT INTO reviews (revision_id, reviewer_id, reviewed_at) VALUES (?, ?, ?)").run(row.id, user.id, now());
    audit(db, user.id, "revision.reviewed", { planId: row.plan_id, rev: row.rev, inputsHash: row.inputs_hash });
    return c.json({ revision: toRevision(getRevision(row.id)!, row.rev) });
  });

  app.post("/api/revisions/:id/approve", (c) => {
    const user = c.get("user");
    const row = latestRevisionOr(c);
    if (row instanceof Response) return row;
    if (row.approver_id) return fail(c, 409, "ALREADY_APPROVED", "This revision is already approved.");
    if (!row.reviewer_id) return fail(c, 409, "NOT_REVIEWED", "The revision must be reviewed before it can be approved.");
    const revision = toRevision(row, row.rev);
    const check = canApprove(revision.evaluation, { author: row.author_id, reviewer: row.reviewer_id, approver: user.id });
    if (!check.ok) {
      const duties = row.author_id === user.id || row.reviewer_id === user.id;
      return fail(c, duties ? 403 : 409, duties ? "SEPARATION_OF_DUTIES" : "CANNOT_APPROVE", check.problems.join(" "));
    }
    const scope = `${revision.plan.name || "Unnamed lift"} — revision ${row.rev}`;
    db.prepare("INSERT INTO approvals (revision_id, approver_id, approved_at, scope) VALUES (?, ?, ?, ?)").run(row.id, user.id, now(), scope);
    audit(db, user.id, "revision.approved", { planId: row.plan_id, rev: row.rev, inputsHash: row.inputs_hash });
    return c.json({ revision: toRevision(getRevision(row.id)!, row.rev) });
  });

  app.get("/api/audit", (c) => {
    const rows = db.prepare("SELECT a.seq, a.at, a.action, a.detail, a.hash, u.name AS user FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.seq DESC LIMIT 200").all();
    return c.json({ entries: rows, firstBrokenSeq: verifyAudit(db) });
  });

  app.all("/api/*", (c) => fail(c, 404, "NOT_FOUND", "No such endpoint."));
  return app;
}

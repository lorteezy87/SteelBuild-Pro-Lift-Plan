/**
 * main.ts — production entry: API plus the built client from ./dist.
 *
 * Environment:
 *   PORT          listen port (default 8787)
 *   DATA_DIR      directory for the SQLite file (default ./data) — put it on a persistent volume
 *   SIGNUP_CODE   code a person must give to create an account; unset = sign-up closed
 *   INSECURE_COOKIES=1   only for plain-http local use
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app";
import { openDb } from "./db";

const dataDir = process.env.DATA_DIR ?? "./data";
mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, "lift-plan.sqlite"));
const signupCode = process.env.SIGNUP_CODE?.trim() || null;
const app = createApp(db, { signupCode, secureCookies: process.env.INSECURE_COOKIES !== "1" });

app.get("/healthz", (c) => c.text("ok"));
app.use("/*", serveStatic({ root: "./dist" }));
app.get("/*", serveStatic({ path: "./dist/index.html" }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`SteelBuild Pro Lift Plan listening on :${port} (sign-up ${signupCode ? "open with code" : "closed"})`);
});

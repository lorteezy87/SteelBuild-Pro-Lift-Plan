# SteelBuild-Pro-Lift-Plan

Crane pick planning for structural steel erection: a deterministic calculation kernel, an API server and a web planning client.

## What works today (v0.2)

Single-crane lift planning, shared between signed-in users:

- **Accounts** — each person signs in. The server records who entered a chart, who checked it, and who authored, reviewed and approved each plan revision; none of that is typed in by hand.
- **Load chart** — enter the chart for your crane's exact configuration from the manufacturer's chart book. A second account must check and approve it before it can give a result; after that it cannot be edited. Lookup never extrapolates, uses the lowest neighbouring capacity between entries, and treats blank cells as not rated.
- **Capacity** — load plus weight allowance plus everything else on the hook, against the chart at the loaded radius.
- **Hoist line pull** — parts of line × permissible single-line pull.
- **Rigging** — two-leg sling tensions against each leg's working load limit.
- **Ground** — average bearing pressure under a mat against an allowable with a recorded source.
- **Wind** — gust against the OEM limit in the chart dataset and any lower project limit.
- **Revisions and approval** — every save is a new, permanent revision with a SHA-256 fingerprint of the plan and chart. Author, reviewer and approver must be three different accounts, and the server recomputes the result before accepting an approval. A newer revision supersedes the old one's review and approval.
- **Activity log** — hash-chained record of every chart and plan action, with a tamper check.
- **Output** — printable lift package and JSON export of a saved revision. US or SI units.

Every check returns one of: within limits, review required, limit exceeded, draft, unsupported, invalid. A missing input is never treated as zero, and a limit nobody set is never treated as a pass.

## What this is not

A planning record. It is not an engineering certification, a regulatory approval, an operator qualification or authorization to lift. The crane manufacturer's manual and load chart govern.

It ships with **no manufacturer data**. The built-in demo chart is invented and labeled synthetic; a plan using it cannot be approved.

## Not built yet

From the specification in `docs/crane-pick-plan-simulator-frd.md`: multiple companies on one server (one deployment is one workspace — everyone with an account sees every plan), per-project roles, password reset, tandem lifts, 3- and 4-leg rigging, outrigger-reaction solving, boom deflection, collision and clearance analysis against site models, power-line rule sets, the 3D training simulator, and telemetry integrations.

## Run it locally

```bash
npm install
```

Start the API (the sign-up code defaults to `dev`):

```bash
npm run dev:server
```

In a second terminal, start the client and open the address it prints:

```bash
npm run dev
```

```bash
npm test
```

## Deploy

One Node process (Node 22.13 or later) serves the API and the built client and keeps its data in a SQLite file.

```bash
npm run build
```

```bash
SIGNUP_CODE=choose-a-code DATA_DIR=/var/lib/lift-plan npm start
```

- `SIGNUP_CODE` — required to create an account. Leave it unset to close sign-up once your people have accounts.
- `DATA_DIR` — where the database file lives. Put it on a persistent, backed-up volume.
- `PORT` — defaults to 8787.
- Serve it over HTTPS; session cookies are marked Secure unless `INSECURE_COOKIES=1`.

A `Dockerfile` is included; mount a volume at `/data`. It declares no `VOLUME` because some hosts, Railway among them, refuse Dockerfiles that do.

## Layout

- `src/kernel/` — units, chart lookup, statics, plan evaluation, approval fingerprint, input sanitizers. No UI or server imports. Tests in `kernel.test.ts` carry the test IDs from Appendix D of the specification.
- `src/server/` — HTTP API, SQLite storage, sessions and audit log. Tests in `server.test.ts`.
- `src/app/` — React planning client.
- `docs/` — functional requirements and architecture specification.

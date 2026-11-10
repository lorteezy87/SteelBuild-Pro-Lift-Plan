# SteelBuild-Pro-Lift-Plan

Crane pick planning for structural steel erection: a deterministic calculation kernel plus a web planning client.

## What works today (v0.1)

Single-crane lift planning in the browser:

- **Load chart** — enter the chart for your crane's exact configuration from the manufacturer's chart book; a second person must check it before it can be used. Lookup never extrapolates, uses the lowest neighbouring capacity between entries, and treats blank cells as not rated.
- **Capacity** — load plus weight allowance plus everything else on the hook, against the chart at the loaded radius.
- **Hoist line pull** — parts of line × permissible single-line pull.
- **Rigging** — two-leg sling tensions against each leg's working load limit.
- **Ground** — average bearing pressure under a mat against an allowable with a recorded source.
- **Wind** — gust against the OEM limit in the chart dataset and any lower project limit.
- **Approval** — author, reviewer and approver must be three people; the approval is bound to a SHA-256 fingerprint of the plan and chart, so any later change invalidates it.
- **Output** — printable lift package and JSON export. US or SI units.

Every check returns one of: within limits, review required, limit exceeded, draft, unsupported, invalid. A missing input is never treated as zero, and a limit nobody set is never treated as a pass.

## What this is not

A planning record. It is not an engineering certification, a regulatory approval, an operator qualification or authorization to lift. The crane manufacturer's manual and load chart govern.

It ships with **no manufacturer data**. The built-in demo chart is invented and labeled synthetic; a plan using it cannot be approved.

## Not built yet

From the specification in `docs/crane-pick-plan-simulator-frd.md`: server, accounts and shared storage (plans are saved in this browser only), tandem lifts, 3- and 4-leg rigging, outrigger-reaction solving, boom deflection, collision and clearance analysis against site models, power-line rule sets, the 3D training simulator, and telemetry integrations.

## Run it

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run build
```

## Layout

- `src/kernel/` — units, chart lookup, statics, plan evaluation, approval fingerprint. No UI imports. Tests in `kernel.test.ts` carry the test IDs from Appendix D of the specification.
- `src/app/` — React planning client.
- `docs/` — functional requirements and architecture specification.

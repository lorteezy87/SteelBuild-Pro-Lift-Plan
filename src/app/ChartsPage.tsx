import { useState } from "react";
import { type ChartDataset, canApproveDataset, parseChartTable } from "../kernel/chart";
import type { UnitSystem } from "../kernel/units";
import type { DatasetContent } from "../kernel/validate";
import { type ChartRecord, type User, api } from "./api";
import { NumField, SelectField, TextField, formatQuantity } from "./fields";

function blankContent(): DatasetContent {
  return {
    label: "",
    configurationKey: "",
    sourceDocument: "",
    revision: "",
    licenseRef: "",
    boomType: "telescopic",
    convention: "gross",
    lookupRule: "conservative-bracket",
    boomLengthsM: [],
    radiiM: [],
    capacitiesKg: [],
    windLimitMs: null,
  };
}

function contentOf(d: ChartDataset): DatasetContent {
  const { id: _id, reviewState: _r, importedBy: _i, reviewedBy: _v, synthetic: _s, ...content } = d;
  return content;
}

export function ChartTable({ dataset, system }: { dataset: Pick<ChartDataset, "boomLengthsM" | "radiiM" | "capacitiesKg">; system: UnitSystem }) {
  if (dataset.boomLengthsM.length === 0) return null;
  return (
    <div className="table-scroll">
      <table className="chart">
        <thead>
          <tr>
            <th>Boom \ Radius</th>
            {dataset.radiiM.map((r) => (
              <th key={r}>{formatQuantity("length", r, system)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataset.boomLengthsM.map((b, i) => (
            <tr key={b}>
              <th>{formatQuantity("length", b, system)}</th>
              {dataset.radiiM.map((r, j) => {
                const c = dataset.capacitiesKg[i]?.[j];
                return <td key={r}>{typeof c === "number" ? formatQuantity("mass", c, system) : <span className="muted">not rated</span>}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface EditorProps {
  initial: DatasetContent;
  system: UnitSystem;
  onSave: (content: DatasetContent) => Promise<void>;
  onCancel: () => void;
}

function ChartEditor({ initial, system, onSave, onCancel }: EditorProps) {
  const [content, setContent] = useState(initial);
  const [tableText, setTableText] = useState("");
  const [tableUnits, setTableUnits] = useState<"us" | "si">(system === "US" ? "us" : "si");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const edit = (patch: Partial<DatasetContent>) => setContent((c) => ({ ...c, ...patch }));

  const readTable = () => {
    const res = parseChartTable(tableText, tableUnits === "us" ? "ft" : "m", tableUnits === "us" ? "lb" : "kg");
    if (!res.ok) return setError(res.message);
    setError(null);
    edit(res.table);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(content);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the chart.");
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Enter a load chart</h2>
      <p className="muted">One chart per crane configuration. Copy it from the manufacturer's chart book for your machine; a second person then checks it against the book.</p>
      <div className="grid">
        <TextField label="Crane and chart title" value={content.label} onChange={(label) => edit({ label })} placeholder="Make, model, serial" />
        <TextField label="Configuration this chart applies to" value={content.configurationKey} onChange={(configurationKey) => edit({ configurationKey })} hint="Counterweight, outrigger extension, slew sector, jib, boom mode." />
        <TextField label="Source document" value={content.sourceDocument} onChange={(sourceDocument) => edit({ sourceDocument })} placeholder="Chart book title / number" />
        <TextField label="Source revision" value={content.revision} onChange={(revision) => edit({ revision })} />
        <TextField label="License / authorization reference" value={content.licenseRef} onChange={(licenseRef) => edit({ licenseRef })} hint="How you are entitled to use this chart data." />
        <SelectField
          label="Boom type"
          value={content.boomType}
          onChange={(boomType) => edit({ boomType })}
          options={[
            { value: "telescopic", label: "Telescopic" },
            { value: "lattice", label: "Lattice (listed lengths only)" },
          ]}
        />
        <SelectField
          label="Chart values are"
          value={content.convention}
          onChange={(convention) => edit({ convention })}
          options={[
            { value: "gross", label: "Gross — hook block and rigging come off" },
            { value: "net", label: "Net — deductions already taken" },
          ]}
        />
        <SelectField
          label="Between chart entries"
          value={content.lookupRule}
          onChange={(lookupRule) => edit({ lookupRule })}
          options={[
            { value: "conservative-bracket", label: "Use the lowest neighbouring capacity" },
            { value: "exact-only", label: "Refuse — tabulated points only" },
          ]}
        />
        <NumField label="OEM wind limit for this configuration" kind="speed" system={system} value={content.windLimitMs} onChange={(windLimitMs) => edit({ windLimitMs })} hint="Leave empty if the manual does not give one." />
      </div>

      <h3>Chart table</h3>
      <p className="muted">Paste from a spreadsheet. First row: any corner cell, then the radii. Each row after: boom length, then one capacity per radius. Leave a cell empty or use “-” where the chart is blank.</p>
      <div className="row">
        <SelectField
          label="Units in the pasted table"
          value={tableUnits}
          onChange={setTableUnits}
          options={[
            { value: "us", label: "feet and pounds" },
            { value: "si", label: "metres and kilograms" },
          ]}
        />
        <button type="button" className="btn" onClick={readTable} disabled={tableText.trim() === ""}>
          Read table
        </button>
      </div>
      <textarea className="table-input" rows={6} aria-label="Chart table" value={tableText} onChange={(e) => setTableText(e.target.value)} placeholder={"ft\t10\t15\t20\n40\t80,000\t52,000\t-\n60\t70,000\t50,000\t33,000"} />
      <ChartTable dataset={content} system={system} />
      {error && <p className="banner bad">{error}</p>}
      <div className="row">
        <button type="button" className="btn primary" disabled={busy || content.boomLengthsM.length === 0} onClick={() => void save()}>
          Save chart for review
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

interface Props {
  charts: ChartRecord[];
  user: User;
  system: UnitSystem;
  reload: () => Promise<void>;
}

export function ChartsPage({ charts, user, system, reload }: Props) {
  const [editing, setEditing] = useState<{ id: string | null; content: DatasetContent } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
  };

  if (editing) {
    return (
      <ChartEditor
        initial={editing.content}
        system={system}
        onCancel={() => setEditing(null)}
        onSave={async (content) => {
          if (editing.id) await api.updateChart(editing.id, content);
          else await api.createChart(content);
          await reload();
          setEditing(null);
        }}
      />
    );
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Load charts</h2>
        <div className="row tight">
          <button type="button" className="btn primary" onClick={() => setEditing({ id: null, content: blankContent() })}>
            Enter a chart
          </button>
          {!charts.some((c) => c.dataset.synthetic) && (
            <button type="button" className="btn" onClick={() => void run(api.loadSyntheticChart)}>
              Load synthetic demo chart
            </button>
          )}
        </div>
      </div>
      {error && <p className="banner bad">{error}</p>}
      {charts.length === 0 && <p className="muted">No charts yet. Rated capacity comes only from the chart for your crane's exact configuration, so enter one before planning a lift.</p>}
      <ul className="list">
        {charts.map(({ dataset: d, importedById }) => {
          const approved = d.reviewState === "approved";
          const mine = importedById === user.id;
          const check = canApproveDataset({ ...d, importedBy: importedById, reviewedBy: user.id });
          return (
            <li key={d.id}>
              <div className="list-main">
                <strong>{d.label || "Untitled chart"}</strong>
                <span className="muted">
                  {d.configurationKey} · {d.sourceDocument} rev {d.revision}
                </span>
                <span className="muted">{d.synthetic ? "Invented numbers for demonstration" : approved ? `Entered by ${d.importedBy}, checked by ${d.reviewedBy}` : `Entered by ${d.importedBy} — waiting for a second person to check it`}</span>
              </div>
              <div className="list-side">
                <span className={`pill ${d.synthetic ? "warn" : approved ? "ok" : "draft"}`}>{d.synthetic ? "Synthetic — not OEM data" : approved ? "Reviewed" : "Not reviewed"}</span>
                <div className="row tight">
                  <button type="button" className="btn small" onClick={() => setOpen(open === d.id ? null : d.id)}>
                    {open === d.id ? "Hide table" : "Show table"}
                  </button>
                  {!approved && mine && (
                    <button type="button" className="btn small" onClick={() => setEditing({ id: d.id, content: contentOf(d) })}>
                      Edit
                    </button>
                  )}
                  {!approved && !mine && (
                    <button
                      type="button"
                      className="btn small primary"
                      disabled={!check.ok}
                      title={check.problems.join(" ")}
                      onClick={() => {
                        if (window.confirm("Confirm you have checked every cell and note of this chart against the manufacturer's chart book. Once approved it cannot be edited.")) void run(() => api.approveChart(d.id));
                      }}
                    >
                      I checked it — approve
                    </button>
                  )}
                </div>
              </div>
              {!approved && !mine && !check.ok && <p className="problems-inline">{check.problems.join(" ")}</p>}
              {open === d.id && <ChartTable dataset={d} system={system} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

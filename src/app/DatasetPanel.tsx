import { useState } from "react";
import { type ChartDataset, canApproveDataset, parseChartTable, syntheticDataset } from "../kernel/chart";
import type { UnitSystem } from "../kernel/units";
import { NumField, SelectField, TextField, formatQuantity } from "./fields";

function blankDataset(): ChartDataset {
  return {
    id: `ds-${Date.now().toString(36)}`,
    label: "",
    configurationKey: "",
    sourceDocument: "",
    revision: "",
    licenseRef: "",
    synthetic: false,
    reviewState: "imported-unreviewed",
    importedBy: "",
    reviewedBy: "",
    boomType: "telescopic",
    convention: "gross",
    lookupRule: "conservative-bracket",
    boomLengthsM: [],
    radiiM: [],
    capacitiesKg: [],
    windLimitMs: null,
  };
}

interface Props {
  dataset: ChartDataset | null;
  system: UnitSystem;
  onChange: (dataset: ChartDataset | null) => void;
}

export function DatasetPanel({ dataset, system, onChange }: Props) {
  const [tableText, setTableText] = useState("");
  const [tableUnits, setTableUnits] = useState<"us" | "si">(system === "US" ? "us" : "si");
  const [tableError, setTableError] = useState<string | null>(null);

  if (!dataset) {
    return (
      <section className="card">
        <h2>1. Load chart</h2>
        <p className="muted">
          Rated capacity comes only from the chart for your crane's exact configuration. Enter it from the manufacturer's chart book, then have a second
          person check it against the book.
        </p>
        <div className="row">
          <button type="button" className="btn primary" onClick={() => onChange(blankDataset())}>
            Enter a chart
          </button>
          <button type="button" className="btn" onClick={() => onChange(syntheticDataset())}>
            Load synthetic demo chart
          </button>
        </div>
      </section>
    );
  }

  // Any edit after approval sends the dataset back for review.
  const edit = (patch: Partial<ChartDataset>) => onChange({ ...dataset, ...patch, reviewState: "imported-unreviewed" });
  const review = canApproveDataset(dataset);
  const hasTable = dataset.boomLengthsM.length > 0;
  const locked = dataset.synthetic;

  const importTable = () => {
    const res = parseChartTable(tableText, tableUnits === "us" ? "ft" : "m", tableUnits === "us" ? "lb" : "kg");
    if (!res.ok) {
      setTableError(res.message);
      return;
    }
    setTableError(null);
    edit(res.table);
  };

  return (
    <section className="card">
      <h2>1. Load chart</h2>
      {dataset.synthetic && <p className="banner warn">SYNTHETIC — NOT OEM DATA. Invented numbers for demonstration. A plan using this chart cannot be approved.</p>}
      <p className={`pill ${dataset.reviewState === "approved" ? "ok" : "draft"}`}>
        {dataset.reviewState === "approved" ? `Reviewed and approved — entered by ${dataset.importedBy}, checked by ${dataset.reviewedBy}` : "Not yet reviewed — cannot be used for a result"}
      </p>

      {!locked && (
        <>
          <div className="grid">
            <TextField label="Crane and chart title" value={dataset.label} onChange={(label) => edit({ label })} placeholder="Make, model, serial" />
            <TextField
              label="Configuration this chart applies to"
              value={dataset.configurationKey}
              onChange={(configurationKey) => edit({ configurationKey })}
              hint="Counterweight, outrigger extension, slew sector, jib, boom mode."
            />
            <TextField label="Source document" value={dataset.sourceDocument} onChange={(sourceDocument) => edit({ sourceDocument })} placeholder="Chart book title / number" />
            <TextField label="Source revision" value={dataset.revision} onChange={(revision) => edit({ revision })} />
            <TextField label="License / authorization reference" value={dataset.licenseRef} onChange={(licenseRef) => edit({ licenseRef })} hint="How you are entitled to use this chart data." />
            <SelectField
              label="Boom type"
              value={dataset.boomType}
              onChange={(boomType) => edit({ boomType })}
              options={[
                { value: "telescopic", label: "Telescopic" },
                { value: "lattice", label: "Lattice (listed lengths only)" },
              ]}
            />
            <SelectField
              label="Chart values are"
              value={dataset.convention}
              onChange={(convention) => edit({ convention })}
              options={[
                { value: "gross", label: "Gross — hook block and rigging come off" },
                { value: "net", label: "Net — deductions already taken" },
              ]}
            />
            <SelectField
              label="Between chart entries"
              value={dataset.lookupRule}
              onChange={(lookupRule) => edit({ lookupRule })}
              options={[
                { value: "conservative-bracket", label: "Use the lowest neighbouring capacity" },
                { value: "exact-only", label: "Refuse — tabulated points only" },
              ]}
            />
            <NumField label="OEM wind limit for this configuration" kind="speed" system={system} value={dataset.windLimitMs} onChange={(windLimitMs) => edit({ windLimitMs })} hint="Leave empty if the manual does not give one." />
          </div>

          <h3>Chart table</h3>
          <p className="muted">
            Paste from a spreadsheet. First row: any corner cell, then the radii. Each row after: boom length, then one capacity per radius. Leave a cell empty or
            use “-” where the chart is blank.
          </p>
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
          </div>
          <textarea className="table-input" rows={6} value={tableText} onChange={(e) => setTableText(e.target.value)} placeholder={"ft\t10\t15\t20\n40\t80,000\t52,000\t-\n60\t70,000\t50,000\t33,000"} />
          {tableError && <p className="banner bad">{tableError}</p>}
          <div className="row">
            <button type="button" className="btn" onClick={importTable} disabled={tableText.trim() === ""}>
              Read table
            </button>
          </div>
        </>
      )}

      {hasTable && (
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
      )}

      {!locked && (
        <>
          <h3>Independent review</h3>
          <div className="grid">
            <TextField label="Entered by" value={dataset.importedBy} onChange={(importedBy) => edit({ importedBy })} />
            <TextField label="Checked against the chart book by" value={dataset.reviewedBy} onChange={(reviewedBy) => edit({ reviewedBy })} hint="Must be a different person." />
          </div>
          {dataset.reviewState !== "approved" && (!review.ok || !hasTable) && (
            <ul className="problems">
              {!hasTable && <li>The chart table has not been read in.</li>}
              {review.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div className="row">
            <button type="button" className="btn primary" disabled={!review.ok || !hasTable || dataset.reviewState === "approved"} onClick={() => onChange({ ...dataset, reviewState: "approved" })}>
              Mark chart reviewed and approved
            </button>
          </div>
        </>
      )}
      <div className="row">
        <button
          type="button"
          className="btn danger"
          onClick={() => {
            if (window.confirm("Remove this chart? Any approval that used it will no longer apply.")) onChange(null);
          }}
        >
          Remove chart
        </button>
      </div>
    </section>
  );
}

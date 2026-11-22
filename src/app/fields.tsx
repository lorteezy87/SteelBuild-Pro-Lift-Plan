import { useEffect, useId, useState } from "react";
import { type QuantityKind, type UnitSystem, fromBase, parseStrictNumber, toBase, unitLabel } from "../kernel/units";

function trim(n: number): string {
  return String(Number(n.toPrecision(7)));
}

interface NumFieldProps {
  label: string;
  kind: QuantityKind | "count";
  system: UnitSystem;
  value: number | null;
  onChange: (value: number | null) => void;
  hint?: string;
}

/**
 * Numeric input that stores SI and shows the chosen unit system. An empty box
 * is null (unknown), never zero. Text that is not one clean number is flagged
 * and stored as null rather than partly parsed.
 */
export function NumField({ label, kind, system, value, onChange, hint }: NumFieldProps) {
  const id = useId();
  const show = (v: number | null) => (v === null ? "" : trim(kind === "count" ? v : fromBase(kind, v, system)));
  const [text, setText] = useState(() => show(value));
  const [bad, setBad] = useState(false);

  useEffect(() => {
    const parsed = parseStrictNumber(text);
    const current = parsed === null ? null : kind === "count" ? parsed : toBase(kind, parsed, system);
    const same = current === null ? value === null : value !== null && Math.abs(current - value) <= Math.abs(value) * 1e-9 + 1e-12;
    if (!same && !bad) setText(show(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, system]);

  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <span className={`field-input${bad ? " is-bad" : ""}`}>
        <input
          aria-label={label}
          id={id}
          inputMode="decimal"
          autoComplete="off"
          value={text}
          aria-invalid={bad}
          onChange={(e) => {
            const t = e.target.value;
            setText(t);
            if (t.trim() === "") {
              setBad(false);
              onChange(null);
              return;
            }
            const n = parseStrictNumber(t);
            setBad(n === null);
            onChange(n === null ? null : kind === "count" ? n : toBase(kind, n, system));
          }}
        />
        {kind !== "count" && <span className="unit">{unitLabel(kind, system)}</span>}
      </span>
      {bad ? <span className="field-hint is-bad">Not a number — ignored until fixed.</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  placeholder?: string;
}

export function TextField({ label, value, onChange, hint, placeholder }: TextFieldProps) {
  const id = useId();
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <span className="field-input">
        <input id={id} aria-label={label} value={value} placeholder={placeholder} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
      </span>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

interface SelectFieldProps<T extends string> {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}

export function SelectField<T extends string>({ label, value, options, onChange }: SelectFieldProps<T>) {
  const id = useId();
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <span className="field-input">
        <select id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}

export function formatQuantity(kind: QuantityKind, baseValue: number, system: UnitSystem): string {
  const v = fromBase(kind, baseValue, system);
  const digits = kind === "ratio" ? 1 : Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 100 ? 1 : 2;
  return `${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${unitLabel(kind, system)}`;
}

import { useMemo, useState } from "react";
import { DitherAreaChart, DitherBarChart } from "./dither-kit/DitherChart.jsx";

const VISUALIZATION_LANGUAGES = new Set(["pixice-visual", "pixice-visualization"]);
const CONTROL_TYPES = new Set(["range", "select", "segmented", "toggle"]);
const CHART_TYPES = new Set(["area", "bar"]);
const SERIES_COLORS = new Set(["blue", "green", "purple", "pink", "orange", "red", "grey"]);
const SERIES_VARIANTS = new Set(["gradient", "dotted", "hatched", "solid"]);
const MAX_CONTROLS = 6;
const MAX_METRICS = 6;
const MAX_POINTS = 120;
const MAX_SERIES = 6;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function boundedText(value, maximum = 160) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, maximum) : "";
}

function normalizeOptions(options) {
  return (Array.isArray(options) ? options : []).slice(0, 12).map((option) => {
    if (typeof option === "string" || typeof option === "number") {
      return { label: String(option), value: String(option) };
    }
    return {
      label: boundedText(option?.label ?? option?.value, 60),
      value: String(option?.value ?? option?.label ?? "").slice(0, 80)
    };
  }).filter((option) => option.label && option.value);
}

function normalizeControl(control, index) {
  const type = CONTROL_TYPES.has(control?.type) ? control.type : null;
  const id = boundedText(control?.id, 48).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!type || !id) return null;
  const label = boundedText(control?.label, 80) || `Control ${index + 1}`;
  if (type === "range") {
    const minimum = finiteNumber(control.min, 0);
    const maximum = Math.max(minimum, finiteNumber(control.max, 100));
    const step = Math.max(Number.EPSILON, finiteNumber(control.step, 1));
    const value = Math.min(maximum, Math.max(minimum, finiteNumber(control.value, minimum)));
    return { id, type, label, min: minimum, max: maximum, step, value, format: boundedText(control.format, 20), unit: boundedText(control.unit, 20) };
  }
  if (type === "toggle") return { id, type, label, value: Boolean(control.value) };
  const options = normalizeOptions(control.options);
  if (!options.length) return null;
  const value = String(control.value ?? options[0].value);
  return { id, type, label, options, value: options.some((option) => option.value === value) ? value : options[0].value };
}

function normalizeSeries(series, index) {
  const key = boundedText(series?.key, 48).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!key) return null;
  return {
    key,
    label: boundedText(series?.label, 60) || key,
    color: SERIES_COLORS.has(series?.color) ? series.color : ["blue", "purple", "green", "orange", "pink", "red"][index % 6],
    variant: SERIES_VARIANTS.has(series?.variant) ? series.variant : undefined
  };
}

export function parseVisualizationSpec(source, language = "pixice-visualization") {
  if (!VISUALIZATION_LANGUAGES.has(String(language).toLowerCase())) return null;
  if (typeof source !== "string" || source.length > 200_000) return null;
  let input;
  try {
    input = JSON.parse(source);
  } catch {
    return null;
  }
  if (!input || typeof input !== "object" || Array.isArray(input) || finiteNumber(input.version, 1) !== 1) return null;
  const title = boundedText(input.title, 120);
  if (!title) return null;
  const controls = (Array.isArray(input.controls) ? input.controls : [])
    .slice(0, MAX_CONTROLS)
    .map(normalizeControl)
    .filter(Boolean);
  const seenControls = new Set();
  const uniqueControls = controls.filter((control) => {
    if (seenControls.has(control.id)) return false;
    seenControls.add(control.id);
    return true;
  });
  const metrics = (Array.isArray(input.metrics) ? input.metrics : []).slice(0, MAX_METRICS).map((metric) => ({
    label: boundedText(metric?.label, 80),
    value: metric?.value,
    format: boundedText(metric?.format, 20),
    unit: boundedText(metric?.unit, 20),
    detail: boundedText(metric?.detail, 100)
  })).filter((metric) => metric.label);
  let chart = null;
  if (input.chart && CHART_TYPES.has(input.chart.type)) {
    const series = (Array.isArray(input.chart.series) ? input.chart.series : [])
      .slice(0, MAX_SERIES)
      .map(normalizeSeries)
      .filter(Boolean);
    const data = (Array.isArray(input.chart.data) ? input.chart.data : [])
      .slice(0, MAX_POINTS)
      .filter((row) => row && typeof row === "object" && !Array.isArray(row));
    if (series.length && data.length) {
      chart = {
        type: input.chart.type,
        title: boundedText(input.chart.title, 100),
        xKey: boundedText(input.chart.xKey, 48).replace(/[^a-zA-Z0-9_-]/g, "") || "label",
        xLabel: boundedText(input.chart.xLabel, 60),
        yLabel: boundedText(input.chart.yLabel, 60),
        format: boundedText(input.chart.format, 20),
        unit: boundedText(input.chart.unit, 20),
        height: Math.min(300, Math.max(130, finiteNumber(input.chart.height, 210))),
        series,
        data
      };
    }
  }
  const segments = (Array.isArray(input.segments) ? input.segments : []).slice(0, 8).map((segment, index) => ({
    label: boundedText(segment?.label, 60),
    value: segment?.value,
    color: SERIES_COLORS.has(segment?.color) ? segment.color : ["blue", "purple", "green", "orange", "pink", "red"][index % 6]
  })).filter((segment) => segment.label);
  if (!metrics.length && !chart && !segments.length) return null;
  return {
    version: 1,
    title,
    description: boundedText(input.description, 240),
    controls: uniqueControls,
    metrics,
    chart,
    segments,
    note: boundedText(input.note, 180)
  };
}

function resolveValue(value, state, depth = 0) {
  if (depth > 5) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") return finiteNumber(value, 0);
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;

  let result = finiteNumber(value.base ?? value.value, 0);
  if (value.by && typeof value.by === "object") {
    for (const [controlId, choices] of Object.entries(value.by)) {
      if (!choices || typeof choices !== "object") continue;
      const selected = choices[String(state[controlId])];
      if (selected !== undefined) result = resolveValue(selected, state, depth + 1);
    }
  }
  if (value.add && typeof value.add === "object") {
    for (const [controlId, coefficient] of Object.entries(value.add)) {
      result += finiteNumber(state[controlId], 0) * finiteNumber(coefficient, 0);
    }
  }
  if (value.multiply && typeof value.multiply === "object") {
    for (const [controlId, choices] of Object.entries(value.multiply)) {
      if (!choices || typeof choices !== "object") continue;
      result *= finiteNumber(choices[String(state[controlId])], 1);
    }
  }
  return Number.isFinite(result) ? result : 0;
}

function controlDomain(control) {
  if (control.type === "range") return [control.min, control.max];
  if (control.type === "toggle") return [false, true];
  return control.options.map((option) => option.value);
}

function multiplyRanges(first, second) {
  const products = [first[0] * second[0], first[0] * second[1], first[1] * second[0], first[1] * second[1]];
  return [Math.min(...products), Math.max(...products)];
}

function resolveValueRange(value, controlsById, depth = 0) {
  if (depth > 5) return [0, 0];
  if (typeof value === "number" || typeof value === "string") {
    const number = finiteNumber(value, 0);
    return [number, number];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return [0, 0];

  const base = finiteNumber(value.base ?? value.value, 0);
  let range = [base, base];
  if (value.by && typeof value.by === "object") {
    for (const [controlId, choices] of Object.entries(value.by)) {
      if (!choices || typeof choices !== "object") continue;
      const domain = controlsById.get(controlId)?.domain ?? [];
      const possible = [];
      let preservesPriorValue = domain.length === 0;
      domain.forEach((choice) => {
        const selected = choices[String(choice)];
        if (selected === undefined) preservesPriorValue = true;
        else possible.push(resolveValueRange(selected, controlsById, depth + 1));
      });
      if (preservesPriorValue) possible.push(range);
      if (possible.length) range = [Math.min(...possible.map((entry) => entry[0])), Math.max(...possible.map((entry) => entry[1]))];
    }
  }
  if (value.add && typeof value.add === "object") {
    for (const [controlId, coefficientValue] of Object.entries(value.add)) {
      const coefficient = finiteNumber(coefficientValue, 0);
      const domain = controlsById.get(controlId)?.domain.map((entry) => finiteNumber(entry, 0)) ?? [0];
      const contribution = [Math.min(...domain) * coefficient, Math.max(...domain) * coefficient].sort((a, b) => a - b);
      range = [range[0] + contribution[0], range[1] + contribution[1]];
    }
  }
  if (value.multiply && typeof value.multiply === "object") {
    for (const [controlId, choices] of Object.entries(value.multiply)) {
      if (!choices || typeof choices !== "object") continue;
      const domain = controlsById.get(controlId)?.domain ?? [];
      const factors = domain.map((choice) => choices[String(choice)] === undefined ? 1 : finiteNumber(choices[String(choice)], 1));
      const factorRange = factors.length ? [Math.min(...factors), Math.max(...factors)] : [1, 1];
      range = multiplyRanges(range, factorRange);
    }
  }
  return range.every(Number.isFinite) ? range : [0, 0];
}

function formatValue(value, format, unit = "") {
  const number = finiteNumber(value, 0);
  const options = { maximumFractionDigits: Math.abs(number) < 10 ? 2 : 1 };
  let output;
  if (format === "compact") output = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(number);
  else if (format === "currency") output = new Intl.NumberFormat(undefined, { style: "currency", currency: unit || "USD", maximumFractionDigits: Math.abs(number) < 100 ? 2 : 0 }).format(number);
  else if (format === "percent") output = `${new Intl.NumberFormat(undefined, options).format(number)}%`;
  else output = new Intl.NumberFormat(undefined, options).format(number);
  return format === "currency" || !unit ? output : `${output}${unit}`;
}

export function visualizationChartMaximum(spec) {
  if (!spec.chart) return undefined;
  const controlsById = new Map(spec.controls.map((control) => [control.id, { domain: controlDomain(control) }]));
  const maxima = spec.chart.data.flatMap((row) => spec.chart.series.map((series) => resolveValueRange(row[series.key], controlsById)[1]));
  return Math.max(1, ...maxima.filter(Number.isFinite));
}

function VisualizationControl({ control, value, onChange }) {
  if (control.type === "range") {
    return (
      <label className="inline-viz-range">
        <span>{control.label}<strong>{formatValue(value, control.format, control.unit)}</strong></span>
        <input type="range" min={control.min} max={control.max} step={control.step} value={value} onChange={(event) => onChange(finiteNumber(event.target.value, control.value))} />
      </label>
    );
  }
  if (control.type === "toggle") {
    return (
      <button type="button" className="inline-viz-toggle" aria-pressed={Boolean(value)} onClick={() => onChange(!value)}>
        <i aria-hidden="true" /><span>{control.label}</span>
      </button>
    );
  }
  if (control.type === "segmented") {
    return (
      <fieldset className="inline-viz-segmented">
        <legend>{control.label}</legend>
        <div>{control.options.map((option) => <button type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)} key={option.value}>{option.label}</button>)}</div>
      </fieldset>
    );
  }
  return (
    <label className="inline-viz-select">
      <span>{control.label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>{control.options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
    </label>
  );
}

export function InlineVisualization({ spec }) {
  const initialState = useMemo(() => Object.fromEntries(spec.controls.map((control) => [control.id, control.value])), [spec]);
  const [state, setState] = useState(initialState);
  const chartData = useMemo(() => spec.chart?.data.map((row) => {
    const next = { [spec.chart.xKey]: boundedText(row[spec.chart.xKey], 80) };
    spec.chart.series.forEach((series) => { next[series.key] = resolveValue(row[series.key], state); });
    return next;
  }) ?? [], [spec.chart, state]);
  const chartScaleMaximum = useMemo(() => visualizationChartMaximum(spec), [spec.chart, spec.controls]);
  const setControl = (id, value) => setState((current) => ({ ...current, [id]: value }));
  const Chart = spec.chart?.type === "bar" ? DitherBarChart : DitherAreaChart;
  const segmentValues = spec.segments.map((segment) => Math.max(0, resolveValue(segment.value, state)));
  const segmentTotal = segmentValues.reduce((total, value) => total + value, 0);

  return (
    <section className="inline-visualization" aria-label={spec.title}>
      <header className="inline-viz-header">
        <span className="inline-viz-eyebrow">Interactive</span>
        <h2>{spec.title}</h2>
        {spec.description && <p>{spec.description}</p>}
      </header>
      {spec.controls.length > 0 && (
        <div className="inline-viz-controls">
          {spec.controls.map((control) => <VisualizationControl control={control} value={state[control.id]} onChange={(value) => setControl(control.id, value)} key={control.id} />)}
        </div>
      )}
      {spec.metrics.length > 0 && (
        <div className="inline-viz-metrics">
          {spec.metrics.map((metric, index) => (
            <article key={`${metric.label}-${index}`}>
              <span>{metric.label}</span>
              <strong>{formatValue(resolveValue(metric.value, state), metric.format, metric.unit)}</strong>
              {metric.detail && <small>{metric.detail}</small>}
            </article>
          ))}
        </div>
      )}
      {spec.chart && (
        <div className="inline-viz-chart">
          {(spec.chart.title || spec.chart.yLabel) && <div className="inline-viz-chart-heading"><h3>{spec.chart.title}</h3><span>{spec.chart.yLabel}</span></div>}
          <Chart
            data={chartData}
            series={spec.chart.series}
            labelKey={spec.chart.xKey}
            valueFormatter={(value) => formatValue(value, spec.chart.format, spec.chart.unit)}
            ariaLabel={`${spec.title}${spec.chart.title ? `: ${spec.chart.title}` : ""}`}
            emptyLabel="No values to plot."
            height={spec.chart.height}
            maxValue={chartScaleMaximum}
          />
          {spec.chart.xLabel && <div className="inline-viz-x-label">{spec.chart.xLabel}</div>}
        </div>
      )}
      {spec.segments.length > 0 && (
        <div className="inline-viz-allocation">
          <div className="inline-viz-allocation-labels">
            {spec.segments.map((segment, index) => <span key={`${segment.label}-${index}`}><i style={{ "--segment-color": `var(--dither-${segment.color})` }} />{segment.label}<strong>{formatValue(segmentValues[index], "number")}</strong></span>)}
          </div>
          <div className="inline-viz-allocation-track" aria-label="Allocation">
            {spec.segments.map((segment, index) => <i style={{ width: `${segmentTotal ? (segmentValues[index] / segmentTotal) * 100 : 0}%`, "--segment-color": `var(--dither-${segment.color})` }} key={`${segment.label}-${index}`} />)}
          </div>
        </div>
      )}
      {spec.note && <p className="inline-viz-note">{spec.note}</p>}
    </section>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";

// Source-adapted from Dither Kit's registry paint engine:
// https://tripwire.sh/r/core.json. Loom does not use Tailwind, so this keeps
// the kit's ordered-Bayer canvas treatment while using Loom-native markup.
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
].map((row) => row.map((value) => (value + 0.5) / 16));

const PALETTE = {
  green: [40, 210, 110],
  blue: [53, 143, 243],
  purple: [150, 110, 255],
  pink: [240, 90, 190],
  orange: [255, 150, 50],
  red: [240, 70, 70],
  grey: [92, 92, 100]
};

const CELL = 2;
const MAX_COLS = 520;
const MAX_ROWS = 200;

function rgba(color, alpha = 1) {
  const [red, green, blue] = PALETTE[color] ?? PALETTE.grey;
  return `rgba(${red},${green},${blue},${alpha})`;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function easeOutCubic(value) {
  return 1 - (1 - value) ** 3;
}

function paintColumn(context, x, top, floor, color, { variant = "gradient", intensity = 0, dim = 1 } = {}) {
  const start = Math.round(top);
  const end = Math.round(floor);
  const depth = end - start;
  if (depth <= 0) return;
  const bias = variant === "dotted" ? 0.12 : 0;
  for (let y = start; y < end; y += 1) {
    const density = (y - start) / depth;
    if (variant === "hatched" && ((x + y) & 3) >= 2) continue;
    const lit = variant === "solid" || density > BAYER[y & 3][x & 3] - 0.1 * intensity - bias;
    if (variant === "dotted" && !lit) continue;
    const strength = (0.3 + density * 0.7) * (1 + 0.22 * intensity);
    const alpha = clamp((lit ? strength : strength * 0.4) * dim, 0, 1);
    context.fillStyle = rgba(color, alpha);
    context.fillRect(x, y, 1, 1);
  }
  context.fillStyle = rgba(color, 0.74 * dim);
  context.fillRect(x, start, 1, 1);
  if (depth > 1) {
    context.fillStyle = rgba(color, 0.36 * dim);
    context.fillRect(x, start + 1, 1, 1);
  }
}

function resample(values, length) {
  if (!values.length) return new Array(length).fill(0);
  const output = new Array(length);
  const last = Math.max(values.length - 1, 1);
  for (let index = 0; index < length; index += 1) {
    const position = (index / Math.max(length - 1, 1)) * last;
    const lower = Math.floor(position);
    const mix = position - lower;
    const first = Number(values[lower]) || 0;
    const second = Number(values[Math.min(lower + 1, values.length - 1)]) || first;
    output[index] = first + (second - first) * mix;
  }
  return output;
}

function useChartSize(ref, height) {
  const [size, setSize] = useState({ width: 640, height });
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => {
      const width = Math.round(element.getBoundingClientRect().width || element.clientWidth || 640);
      setSize({ width: Math.max(240, width), height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [height, ref]);
  return size;
}

function defaultValue(value) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value ?? 0);
}

function DitherChart({
  type,
  data,
  series,
  height = 210,
  ariaLabel,
  labelKey = "label",
  valueFormatter = defaultValue,
  labelFormatter = (value) => value,
  emptyLabel = "Usage will appear after your next completed turn.",
  maxValue
}) {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);
  const bloomRef = useRef(null);
  const paintSignatureRef = useRef(null);
  const hasPaintedRef = useRef(false);
  const [hoverIndex, setHoverIndex] = useState(null);
  const size = useChartSize(hostRef, height);
  const hasValues = data.some((row) => series.some((item) => Number(row[item.key]) > 0));
  const tooltip = hoverIndex === null ? null : data[hoverIndex];
  const tickRows = useMemo(() => {
    if (data.length <= 5) return data.map((row, index) => ({ row, index }));
    return [0, Math.round((data.length - 1) / 4), Math.round((data.length - 1) / 2), Math.round(((data.length - 1) * 3) / 4), data.length - 1]
      .map((index) => ({ row: data[index], index }));
  }, [data]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const bloomCanvas = bloomRef.current;
    if (!canvas || !bloomCanvas || /jsdom/i.test(globalThis.navigator?.userAgent ?? "")) return undefined;
    const paintSignature = JSON.stringify({ data, height, hoverIndex, maxValue, series, width: size.width, type });
    if (paintSignatureRef.current === paintSignature) return undefined;

    const context = canvas.getContext?.("2d");
    const bloom = bloomCanvas.getContext?.("2d");
    if (!context || !bloom) return undefined;
    paintSignatureRef.current = paintSignature;

    const columns = Math.min(MAX_COLS, Math.max(8, Math.round(size.width / CELL)));
    const rows = Math.min(MAX_ROWS, Math.max(8, Math.round(height / CELL)));
    canvas.width = columns;
    canvas.height = rows;
    bloomCanvas.width = columns;
    bloomCanvas.height = rows;
    const plotTop = 7;
    const plotFloor = rows - 8;
    const values = data.flatMap((row) => series.map((item) => Number(row[item.key]) || 0));
    const maximum = Math.max(1, Number(maxValue) || 0, ...values) * 1.08;
    const hoveredColumn = hoverIndex === null || data.length < 2
      ? null
      : Math.round((hoverIndex / (data.length - 1)) * (columns - 1));

    const drawGrid = () => {
      context.fillStyle = "rgba(255,255,255,.07)";
      for (let step = 0; step <= 4; step += 1) {
        const y = Math.round(plotTop + ((plotFloor - plotTop) * step) / 4);
        for (let x = 0; x < columns; x += 4) context.fillRect(x, y, 1, 1);
      }
    };

    const drawArea = (reveal) => {
      const revealColumns = Math.ceil(columns * reveal);
      series.forEach((item, seriesIndex) => {
        const sampled = resample(data.map((row) => Number(row[item.key]) || 0), columns);
        for (let x = 0; x < revealColumns; x += 1) {
          const top = plotFloor - (sampled[x] / maximum) * (plotFloor - plotTop);
          paintColumn(context, x, top, plotFloor, item.color, {
            variant: item.variant ?? (seriesIndex ? "dotted" : "gradient"),
            intensity: hoveredColumn === null ? 0 : 0.75,
            dim: 1 - seriesIndex * 0.08
          });
        }
      });
    };

    const drawBars = (reveal) => {
      const slot = columns / Math.max(data.length, 1);
      const groupWidth = Math.max(2, Math.floor(slot * 0.68));
      const barWidth = Math.max(1, Math.floor(groupWidth / Math.max(series.length, 1)));
      data.forEach((row, dataIndex) => {
        series.forEach((item, seriesIndex) => {
          const value = Number(row[item.key]) || 0;
          const fullHeight = (value / maximum) * (plotFloor - plotTop);
          const barHeight = fullHeight * reveal;
          const center = Math.round(dataIndex * slot + slot / 2);
          const start = Math.round(center - groupWidth / 2 + seriesIndex * barWidth);
          const color = row.color ?? item.color;
          for (let x = start; x < start + barWidth - 1; x += 1) {
            paintColumn(context, x, plotFloor - barHeight, plotFloor, color, {
              variant: item.variant ?? "hatched",
              intensity: hoverIndex === dataIndex ? 1 : 0
            });
          }
        });
      });
    };

    const draw = (progress) => {
      context.clearRect(0, 0, columns, rows);
      drawGrid();
      if (type === "bar") drawBars(progress);
      else drawArea(progress);
      if (hoveredColumn !== null && type !== "bar") {
        context.fillStyle = "rgba(255,255,255,.22)";
        for (let y = plotTop; y <= plotFloor; y += 3) context.fillRect(hoveredColumn, y, 1, 1);
        series.forEach((item) => {
          const value = Number(data[hoverIndex]?.[item.key]) || 0;
          const y = Math.round(plotFloor - (value / maximum) * (plotFloor - plotTop));
          context.fillStyle = rgba(item.color, 1);
          context.fillRect(hoveredColumn - 1, y - 1, 3, 3);
        });
      }
      bloom.clearRect(0, 0, columns, rows);
      bloom.drawImage(canvas, 0, 0);
    };

    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const shouldAnimate = !hasPaintedRef.current;
    hasPaintedRef.current = true;

    if (reduceMotion || !shouldAnimate) {
      draw(1);
      return undefined;
    }
    let animationFrame = 0;
    const startedAt = performance.now();
    const animate = (now) => {
      const progress = easeOutCubic(clamp((now - startedAt) / 560, 0, 1));
      draw(progress);
      if (progress < 1) animationFrame = requestAnimationFrame(animate);
    };
    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, [data, height, hoverIndex, maxValue, series, size.width, type]);

  const move = (event) => {
    if (!data.length) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = clamp((event.clientX - bounds.left) / Math.max(bounds.width, 1), 0, 1);
    setHoverIndex(Math.round(ratio * Math.max(data.length - 1, 0)));
  };

  return (
    <div className="dither-chart" role="img" aria-label={ariaLabel}>
      <div className="dither-chart-legend" aria-hidden="true">
        {series.map((item) => <span key={item.key}><i style={{ "--series-color": rgba(item.color) }} />{item.label}</span>)}
      </div>
      <div ref={hostRef} className="dither-chart-plot" style={{ height }} onMouseMove={move} onMouseLeave={() => setHoverIndex(null)}>
        <canvas ref={bloomRef} className="dither-chart-canvas dither-chart-bloom" aria-hidden="true" />
        <canvas ref={canvasRef} className="dither-chart-canvas" aria-hidden="true" />
        {!hasValues && <span className="dither-chart-empty">{emptyLabel}</span>}
        {tooltip && hasValues && (
          <div className="dither-chart-tooltip" style={{ left: `${((hoverIndex + 0.5) / Math.max(data.length, 1)) * 100}%` }}>
            <strong>{labelFormatter(tooltip[labelKey])}</strong>
            {series.map((item) => <span key={item.key}><i style={{ "--series-color": rgba(item.color) }} />{item.label}<b>{valueFormatter(tooltip[item.key], item.key)}</b></span>)}
          </div>
        )}
      </div>
      <div className="dither-chart-axis" aria-hidden="true">
        {tickRows.map(({ row, index }) => <span key={`${index}:${row?.[labelKey]}`} style={{ left: `${(index / Math.max(data.length - 1, 1)) * 100}%` }}>{labelFormatter(row?.[labelKey])}</span>)}
      </div>
    </div>
  );
}

export function DitherAreaChart(props) {
  return <DitherChart {...props} type="area" />;
}

export function DitherBarChart(props) {
  return <DitherChart {...props} type="bar" />;
}

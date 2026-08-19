import { useMemo, useRef, useState } from "react";

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseLocalDate(value) {
  const [year, month, day] = String(value ?? "").split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function localDayKey(value) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function addDays(value, count) {
  const date = new Date(value);
  date.setDate(date.getDate() + count);
  return date;
}

function levelFor(value, maximum) {
  if (!(value > 0) || !(maximum > 0)) return 0;
  return Math.max(1, Math.min(5, Math.ceil(Math.sqrt(value / maximum) * 5)));
}

export function UsageHeatMap({ data = [], valueFormatter = (value) => String(value), ariaLabel = "Daily usage cost over the last year" }) {
  const shellRef = useRef(null);
  const [tooltip, setTooltip] = useState(null);
  const calendar = useMemo(() => {
    const values = new Map(data.map((item) => [item.date, item]));
    const first = data.length ? parseLocalDate(data[0].date) : addDays(new Date(), -364);
    const last = data.length ? parseLocalDate(data.at(-1).date) : new Date();
    const firstWeekday = (first.getDay() + 6) % 7;
    const gridStart = addDays(first, -firstWeekday);
    const lastWeekday = (last.getDay() + 6) % 7;
    const gridEnd = addDays(last, 6 - lastWeekday);
    const maximum = Math.max(0, ...data.map((item) => Number(item.costUsd) || 0));
    const weeks = [];
    const weekCount = Math.round((gridEnd - gridStart) / DAY_MS / 7) + 1;

    for (let weekIndex = 0; weekIndex < weekCount; weekIndex += 1) {
      const weekStart = addDays(gridStart, weekIndex * 7);
      const days = Array.from({ length: 7 }, (_, dayIndex) => {
        const date = addDays(weekStart, dayIndex);
        const key = localDayKey(date);
        const item = values.get(key) ?? { date: key, costUsd: 0, totalTokens: 0, events: 0 };
        const inRange = date >= first && date <= last;
        return { ...item, dateValue: date, inRange, level: inRange ? levelFor(Number(item.costUsd) || 0, maximum) : 0 };
      });
      const monthStart = days.find((item) => item.dateValue.getDate() === 1);
      weeks.push({
        key: localDayKey(weekStart),
        month: weekIndex === 0 ? MONTHS[first.getMonth()] : monthStart ? MONTHS[monthStart.dateValue.getMonth()] : "",
        days
      });
    }

    return { weeks, maximum };
  }, [data]);

  const showTooltip = (event, item) => {
    if (!item.inRange || !shellRef.current) return;
    const cell = event.currentTarget.getBoundingClientRect();
    const shell = shellRef.current.getBoundingClientRect();
    setTooltip({
      item,
      x: Math.max(76, Math.min(shell.width - 76, cell.left - shell.left + cell.width / 2)),
      y: cell.top - shell.top
    });
  };

  return (
    <div className="usage-heatmap" role="grid" aria-label={ariaLabel}>
      <div className="usage-heatmap-scroll">
        <div className="usage-heatmap-shell" ref={shellRef}>
          <div className="usage-heatmap-weekdays" aria-hidden="true">
            <span>M</span><span /><span>W</span><span /><span>F</span><span /><span />
          </div>
          <div className="usage-heatmap-weeks">
            {calendar.weeks.map((week) => (
              <div className="usage-heatmap-week" key={week.key}>
                <span className="usage-heatmap-month" aria-hidden="true">{week.month}</span>
                <div className="usage-heatmap-days">
                  {week.days.map((item) => {
                    const label = item.dateValue.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: "numeric" });
                    return (
                      <button
                        type="button"
                        role="gridcell"
                        className="usage-heatmap-cell"
                        data-level={item.level}
                        data-outside={!item.inRange || undefined}
                        aria-label={`${label}: ${valueFormatter(item.costUsd)}, ${(Number(item.totalTokens) || 0).toLocaleString()} tokens`}
                        tabIndex={item.inRange && item.level > 0 ? 0 : -1}
                        key={item.date}
                        onFocus={(event) => showTooltip(event, item)}
                        onBlur={() => setTooltip(null)}
                        onPointerEnter={(event) => showTooltip(event, item)}
                        onPointerLeave={() => setTooltip(null)}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          {tooltip && (
            <div className="usage-heatmap-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
              <strong>{valueFormatter(tooltip.item.costUsd)}</strong>
              <span>{tooltip.item.dateValue.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>
              <small>{(Number(tooltip.item.totalTokens) || 0).toLocaleString()} tokens</small>
            </div>
          )}
        </div>
      </div>
      <div className="usage-heatmap-legend" aria-hidden="true">
        <span>Less</span>{[0, 1, 2, 3, 4, 5].map((level) => <i data-level={level} key={level} />)}<span>More</span>
      </div>
    </div>
  );
}

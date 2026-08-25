import { useMemo, useState } from "react";
import { CaretLeft, CaretRight, X } from "./icons";

const DAY_MS = 86_400_000;
const STATUS_LABELS = {
  planned: "Planned",
  active: "Active",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled"
};

function parseDate(value) {
  if (typeof value !== "string" || !value) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const timestamp = Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    const date = new Date(timestamp);
    if (date.getUTCFullYear() !== Number(dateOnly[1]) || date.getUTCMonth() !== Number(dateOnly[2]) - 1 || date.getUTCDate() !== Number(dateOnly[3])) return null;
    return date;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function startOfDay(value) {
  const date = value instanceof Date ? value : parseDate(value);
  return date ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())) : null;
}

function addDays(value, amount) {
  return new Date(value.getTime() + amount * DAY_MS);
}

function addMonths(value, amount) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + amount, 1));
}

function dateKey(value) {
  return value.toISOString().slice(0, 10);
}

function formatDate(value, options = {}) {
  return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", ...options }).format(value);
}

function formatDateRange(start, end, includeTime = false) {
  if (!start) return "Date unavailable";
  const dateOptions = { month: "short", day: "numeric", year: "numeric" };
  const startLabel = formatDate(start, dateOptions);
  if (!end || start.getTime() === end.getTime()) return startLabel;
  const endLabel = formatDate(end, dateOptions);
  if (!includeTime) return `${startLabel} to ${endLabel}`;
  return `${startLabel} to ${endLabel}`;
}

function matchesWhen(when, state) {
  if (!when) return true;
  return Object.entries(when).every(([controlId, accepted]) => {
    const values = Array.isArray(accepted) ? accepted : [accepted];
    return values.some((value) => String(value) === String(state[controlId]));
  });
}

function itemColor(color) {
  return `var(--dither-${color || "blue"})`;
}

function statusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS.planned;
}

function temporalItemDates(item) {
  const start = startOfDay(item.start);
  const parsedEnd = startOfDay(item.end || item.start);
  const end = start && parsedEnd && parsedEnd >= start ? parsedEnd : start;
  return { start, end };
}

function packTimelineItems(items) {
  const levelEnds = [];
  return [...items]
    .sort((first, second) => first.start - second.start || first.end - second.end)
    .map((entry) => {
      let level = levelEnds.findIndex((end) => end < entry.start);
      if (level < 0) level = levelEnds.length;
      levelEnds[level] = entry.end;
      return { ...entry, level };
    });
}

function timelineTicks(start, end) {
  const spanDays = Math.max(1, Math.round((end - start) / DAY_MS));
  const count = Math.min(8, Math.max(2, spanDays + 1));
  return Array.from({ length: count }, (_, index) => {
    const ratio = index / (count - 1);
    const date = new Date(start.getTime() + ratio * (end.getTime() - start.getTime()));
    const options = spanDays > 365
      ? { month: "short", year: "2-digit" }
      : spanDays > 45
        ? { month: "short", day: "numeric" }
        : { month: "short", day: "numeric" };
    return { ratio, label: formatDate(date, options) };
  });
}

function TemporalDetail({ item, dependencyLabels = [], onClose }) {
  const { start, end } = temporalItemDates(item);
  return (
    <aside className="inline-viz-temporal-detail" aria-live="polite">
      <div className="inline-viz-temporal-detail-head">
        <span>
          <i style={{ "--temporal-color": itemColor(item.color) }} />
          <small>{statusLabel(item.status)}</small>
        </span>
        <button type="button" aria-label="Close details" onClick={onClose}><X size={13} /></button>
      </div>
      <strong>{item.label || item.title}</strong>
      <time>{formatDateRange(start, end)}</time>
      {item.owner && <span>Owner: {item.owner}</span>}
      {item.location && <span>Location: {item.location}</span>}
      {item.detail && <p>{item.detail}</p>}
      {dependencyLabels.length > 0 && <span>After: {dependencyLabels.join(", ")}</span>}
    </aside>
  );
}

export function TimelineVisualization({ timeline, state }) {
  const [selectedId, setSelectedId] = useState(null);
  const visibleItems = useMemo(() => timeline.items
    .filter((item) => matchesWhen(item.when, state))
    .map((item) => ({ ...item, ...temporalItemDates(item) }))
    .filter((item) => item.start), [timeline.items, state]);

  const groups = useMemo(() => {
    const known = new Map(timeline.groups.map((group) => [group.id, group.label]));
    visibleItems.forEach((item) => {
      const id = item.group || "schedule";
      if (!known.has(id)) known.set(id, id === "schedule" ? "Schedule" : id);
    });
    return [...known.entries()].map(([id, label]) => ({ id, label }));
  }, [timeline.groups, visibleItems]);

  const extent = useMemo(() => {
    const starts = visibleItems.map((item) => item.start.getTime());
    const ends = visibleItems.map((item) => item.end.getTime());
    const explicitStart = startOfDay(timeline.start)?.getTime();
    const explicitEnd = startOfDay(timeline.end)?.getTime();
    const start = new Date(Number.isFinite(explicitStart) ? explicitStart : Math.min(...starts));
    let end = new Date(Number.isFinite(explicitEnd) ? explicitEnd : Math.max(...ends));
    if (!Number.isFinite(start.getTime())) return null;
    if (!Number.isFinite(end.getTime()) || end <= start) end = addDays(start, 1);
    return { start, end, ticks: timelineTicks(start, end) };
  }, [timeline.end, timeline.start, visibleItems]);

  const selected = visibleItems.find((item) => item.id === selectedId) || null;
  const itemLabels = new Map(visibleItems.map((item) => [item.id, item.label]));
  const today = startOfDay(timeline.today || new Date().toISOString());
  const todayRatio = extent && today ? (today - extent.start) / (extent.end - extent.start) : -1;

  if (!extent || visibleItems.length === 0) return <div className="inline-viz-temporal-empty">No timeline items match the current view.</div>;

  return (
    <div className="inline-viz-temporal inline-viz-timeline">
      <div className="inline-viz-temporal-heading">
        <span><strong>{timeline.title || "Timeline"}</strong><small>{visibleItems.length} {visibleItems.length === 1 ? "item" : "items"}</small></span>
        <div className="inline-viz-status-legend">
          {[...new Set(visibleItems.map((item) => item.status))].map((status) => <span key={status} data-status={status}><i />{statusLabel(status)}</span>)}
        </div>
      </div>
      <div className="inline-viz-timeline-scroll">
        <div className="inline-viz-timeline-grid">
          <div className="inline-viz-timeline-corner" />
          <div className="inline-viz-timeline-axis">
            {extent.ticks.map((tick, index) => <span style={{ left: `${tick.ratio * 100}%` }} key={`${tick.label}-${index}`}>{tick.label}</span>)}
          </div>
          {groups.map((group) => {
            const packed = packTimelineItems(visibleItems.filter((item) => (item.group || "schedule") === group.id));
            const levels = Math.max(1, ...packed.map((item) => item.level + 1));
            return (
              <div className="inline-viz-timeline-row" style={{ "--timeline-levels": levels }} key={group.id}>
                <div className="inline-viz-timeline-lane"><strong>{group.label}</strong><small>{packed.length}</small></div>
                <div className="inline-viz-timeline-track">
                  {extent.ticks.map((tick, index) => <i className="inline-viz-timeline-line" style={{ left: `${tick.ratio * 100}%` }} key={index} />)}
                  {todayRatio >= 0 && todayRatio <= 1 && <i className="inline-viz-today-line" style={{ left: `${todayRatio * 100}%` }} title="Today" />}
                  {packed.map((item) => {
                    const left = Math.max(0, Math.min(1, (item.start - extent.start) / (extent.end - extent.start)));
                    const right = Math.max(left, Math.min(1, (item.end - extent.start) / (extent.end - extent.start)));
                    const isMilestone = item.type === "milestone" || item.start.getTime() === item.end.getTime();
                    return (
                      <button
                        type="button"
                        key={item.id}
                        className="inline-viz-timeline-item"
                        data-type={isMilestone ? "milestone" : "range"}
                        data-status={item.status}
                        aria-pressed={selectedId === item.id}
                        aria-label={`${item.label}, ${formatDateRange(item.start, item.end)}`}
                        onClick={() => setSelectedId((current) => current === item.id ? null : item.id)}
                        style={{
                          left: `${left * 100}%`,
                          top: `${item.level * 30 + 5}px`,
                          width: isMilestone ? "12px" : `max(12px, ${(right - left) * 100}%)`,
                          "--temporal-color": itemColor(item.color)
                        }}
                      >
                        {!isMilestone && <><span>{item.label}</span>{item.progress > 0 && <i style={{ width: `${Math.min(100, item.progress)}%` }} />}</>}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {selected && <TemporalDetail item={selected} dependencyLabels={selected.dependsOn.map((id) => itemLabels.get(id)).filter(Boolean)} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function calendarDays(cursor, weekStartsOn) {
  const monthStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1));
  const offset = (monthStart.getUTCDay() - weekStartsOn + 7) % 7;
  const gridStart = addDays(monthStart, -offset);
  return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
}

function eventIncludesDay(event, day) {
  const { start, end } = temporalItemDates(event);
  return start && end && day >= start && day <= end;
}

function CalendarEventButton({ event, selected, onClick }) {
  return (
    <button
      type="button"
      className="inline-viz-calendar-event"
      data-status={event.status}
      aria-pressed={selected}
      onClick={(clickEvent) => { clickEvent.stopPropagation(); onClick(); }}
      style={{ "--temporal-color": itemColor(event.color) }}
    >
      <i />
      <span>{event.title}</span>
    </button>
  );
}

export function CalendarVisualization({ calendar, state }) {
  const initialDate = startOfDay(calendar.date || calendar.events[0]?.start || new Date().toISOString()) || startOfDay(new Date().toISOString());
  const [view, setView] = useState(calendar.defaultView);
  const [cursor, setCursor] = useState(new Date(Date.UTC(initialDate.getUTCFullYear(), initialDate.getUTCMonth(), 1)));
  const [selectedId, setSelectedId] = useState(null);
  const [selectedDay, setSelectedDay] = useState(null);
  const visibleEvents = useMemo(() => calendar.events.filter((event) => matchesWhen(event.when, state)), [calendar.events, state]);
  const selected = visibleEvents.find((event) => event.id === selectedId) || null;
  const today = startOfDay(calendar.today || new Date().toISOString());
  const days = calendarDays(cursor, calendar.weekStartsOn);
  const weekdays = Array.from({ length: 7 }, (_, index) => addDays(new Date(Date.UTC(2026, 7, 2 + calendar.weekStartsOn)), index));
  const selectedDayEvents = selectedDay ? visibleEvents.filter((event) => eventIncludesDay(event, selectedDay)) : [];

  const chooseEvent = (id) => {
    setSelectedId((current) => current === id ? null : id);
    setSelectedDay(null);
  };

  return (
    <div className="inline-viz-temporal inline-viz-calendar">
      <div className="inline-viz-temporal-heading inline-viz-calendar-heading">
        <span><strong>{calendar.title || "Calendar"}</strong><small>{visibleEvents.length} {visibleEvents.length === 1 ? "event" : "events"}</small></span>
        {calendar.views.length > 1 && (
          <div className="inline-viz-view-switch" aria-label="Calendar view">
            {calendar.views.map((candidate) => <button type="button" aria-pressed={view === candidate} onClick={() => setView(candidate)} key={candidate}>{candidate === "month" ? "Month" : "Agenda"}</button>)}
          </div>
        )}
      </div>

      {view === "month" ? (
        <>
          <div className="inline-viz-calendar-nav">
            <button type="button" aria-label="Previous month" onClick={() => setCursor((current) => addMonths(current, -1))}><CaretLeft size={14} /></button>
            <strong>{formatDate(cursor, { month: "long", year: "numeric" })}</strong>
            <button type="button" className="inline-viz-calendar-today" onClick={() => setCursor(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)))}>Today</button>
            <button type="button" aria-label="Next month" onClick={() => setCursor((current) => addMonths(current, 1))}><CaretRight size={14} /></button>
          </div>
          <div className="inline-viz-calendar-scroll">
            <div className="inline-viz-calendar-grid">
              {weekdays.map((day) => <span className="inline-viz-calendar-weekday" key={day.getUTCDay()}>{formatDate(day, { weekday: "short" })}</span>)}
              {days.map((day) => {
                const events = visibleEvents.filter((event) => eventIncludesDay(event, day));
                const outside = day.getUTCMonth() !== cursor.getUTCMonth();
                const isToday = today && dateKey(day) === dateKey(today);
                return (
                  <div
                    className="inline-viz-calendar-day"
                    data-outside={outside || undefined}
                    data-today={isToday || undefined}
                    data-selected={selectedDay && dateKey(day) === dateKey(selectedDay) || undefined}
                    onClick={() => { setSelectedDay(day); setSelectedId(null); }}
                    key={dateKey(day)}
                  >
                    <button type="button" className="inline-viz-calendar-date" aria-label={`Show ${events.length} events on ${formatDate(day, { month: "long", day: "numeric", year: "numeric" })}`} onClick={() => { setSelectedDay(day); setSelectedId(null); }}>{day.getUTCDate()}</button>
                    <div>
                      {events.slice(0, 3).map((event) => <CalendarEventButton event={event} selected={selectedId === event.id} onClick={() => chooseEvent(event.id)} key={event.id} />)}
                      {events.length > 3 && <button type="button" className="inline-viz-calendar-more" onClick={(clickEvent) => { clickEvent.stopPropagation(); setSelectedDay(day); setSelectedId(null); }}>+{events.length - 3} more</button>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      ) : (
        <div className="inline-viz-agenda">
          {visibleEvents.length === 0 && <div className="inline-viz-temporal-empty">No events match the current view.</div>}
          {[...visibleEvents].sort((first, second) => parseDate(first.start) - parseDate(second.start)).map((event) => {
            const { start, end } = temporalItemDates(event);
            return (
              <button type="button" className="inline-viz-agenda-row" aria-pressed={selectedId === event.id} onClick={() => chooseEvent(event.id)} key={event.id}>
                <time><strong>{start ? formatDate(start, { day: "2-digit" }) : ""}</strong><span>{start ? formatDate(start, { month: "short" }) : ""}</span></time>
                <i style={{ "--temporal-color": itemColor(event.color) }} />
                <span><strong>{event.title}</strong><small>{formatDateRange(start, end)}{event.owner ? `, ${event.owner}` : ""}</small></span>
                <em data-status={event.status}>{statusLabel(event.status)}</em>
              </button>
            );
          })}
        </div>
      )}

      {selected && <TemporalDetail item={{ ...selected, label: selected.title }} onClose={() => setSelectedId(null)} />}
      {!selected && selectedDay && (
        <aside className="inline-viz-day-detail">
          <div><strong>{formatDate(selectedDay, { weekday: "long", month: "long", day: "numeric" })}</strong><button type="button" aria-label="Close day events" onClick={() => setSelectedDay(null)}><X size={13} /></button></div>
          {selectedDayEvents.length > 0
            ? selectedDayEvents.map((event) => <CalendarEventButton event={event} selected={false} onClick={() => chooseEvent(event.id)} key={event.id} />)
            : <small>No events scheduled.</small>}
        </aside>
      )}
    </div>
  );
}

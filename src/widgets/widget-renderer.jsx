import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { z } from 'zod';
import { MorphText } from '../components/MorphText.jsx';
import { widgetV2Schema } from './widget-schema.mjs';
import { widgetCatalog } from './widget-catalog.mjs';
import { dispatchWidgetAction, initialWidgetState } from './widget-state.mjs';
import { projectWidgetSource, resolveWidgetProp } from './widget-selectors.mjs';

const label = z.string().trim().min(1).max(160);
const timer = z.object({ type: z.literal('timer'), label, durationSeconds: z.number().int().min(1).max(2592000), endAt: z.string().datetime().nullable() }).strict();
const checklist = z.object({ type: z.literal('checklist'), label, items: z.array(z.object({ id: z.string().uuid(), text: label, done: z.boolean() }).strict()).min(1).max(30) }).strict();
const counter = z.object({ type: z.literal('counter'), label, value: z.number().int().min(-1000000).max(1000000), step: z.number().int().min(1).max(1000) }).strict();
const specSchema = z.object({ version: z.literal(1), title: label, size: z.enum(['small', 'medium', 'large']).optional(), blocks: z.array(z.discriminatedUnion('type', [timer, checklist, counter])).min(1).max(8) }).strict();

export function isRenderableWidget(widget) {
  return Boolean(widget && typeof widget.id === 'string' && Number.isInteger(widget.revision) && widget.revision > 0 &&
    (widget.spec?.version === 2 ? widgetV2Schema.safeParse(widget.spec).success : specSchema.safeParse(widget.spec).success));
}

function remainingText(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function TimerBlock({ block, displayLabel, disabled, onRestart }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!block.endAt) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [block.endAt]);
  const remaining = block.endAt ? Math.max(0, Math.ceil((Date.parse(block.endAt) - now) / 1000)) : block.durationSeconds;
  const progress = Math.min(1, remaining / block.durationSeconds);
  const expired = Boolean(block.endAt) && remaining === 0;
  return <section className="widget-shelf-unit widget-shelf-timer" aria-label={block.label}>
    <div className="widget-shelf-ring" style={{ '--widget-progress': progress }}>
      <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <circle className="widget-shelf-ring-track" cx="50" cy="50" r="43" />
        <circle className="widget-shelf-ring-fill" cx="50" cy="50" r="43" pathLength="1" />
      </svg>
      <span className="widget-shelf-time" role="timer" aria-label={`${block.label}: ${expired ? 'Time is up' : remainingText(remaining)}`}>
        <MorphText className="widget-shelf-morph" value={expired ? 'Done' : remainingText(remaining)} duration={260} />
      </span>
    </div>
    <div className="widget-shelf-unit-copy">
      <h3>{displayLabel}</h3>
      <span><MorphText value={expired ? 'Time is up' : block.endAt ? 'In progress' : 'Ready'} duration={300} /></span>
      <div className="widget-shelf-timer-actions">
        <button className="widget-shelf-text-button" type="button" disabled={disabled} onClick={onRestart} aria-label={`${block.endAt ? 'Restart' : 'Start'} ${block.label}`}>
          {block.endAt ? 'Restart' : 'Start'}
        </button>
      </div>
    </div>
  </section>;
}

const fallbackLine = { left: 0, top: 0, width: '100%', height: '100%' };

function WavyChecklistText({ text, done, reduceMotion }) {
  const wrapperRef = useRef(null);
  const copyRef = useRef(null);
  const [lines, setLines] = useState([fallbackLine]);

  useLayoutEffect(() => {
    function measure() {
      const wrapper = wrapperRef.current;
      const copy = copyRef.current;
      if (!wrapper || !copy || typeof document.createRange !== 'function') return;
      const range = document.createRange();
      range.selectNodeContents(copy);
      if (typeof range.getClientRects !== 'function') return;
      const origin = wrapper.getBoundingClientRect();
      const measured = Array.from(range.getClientRects()).filter((rect) => rect.width > 0).map((rect) => ({
        left: rect.left - origin.left,
        top: rect.top - origin.top,
        width: rect.width,
        height: rect.height
      }));
      setLines(measured.length ? measured : [fallbackLine]);
    }
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (wrapperRef.current) observer?.observe(wrapperRef.current);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [text]);

  return <span ref={wrapperRef} className="widget-shelf-check-text" data-done={done}>
    <span ref={copyRef} className="widget-shelf-check-copy">{text}</span>
    {lines.map((line, index) => <motion.svg key={index} className="widget-shelf-wavy-line" style={{ left: line.left, top: line.top, width: line.width, height: line.height }} viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <motion.path d="M 1 11 C 12 4, 18 17, 31 10 S 51 5, 63 11 S 84 17, 99 9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" vectorEffect="non-scaling-stroke" initial={false} animate={{ pathLength: done ? 1 : 0, opacity: done ? 1 : 0 }} transition={{ pathLength: { duration: reduceMotion ? 0 : .55, ease: 'easeInOut' }, opacity: { duration: 0, delay: done || reduceMotion ? 0 : .55 } }} data-done={done} />
    </motion.svg>)}
  </span>;
}

function ChecklistBlock({ block, displayLabel, size, disabled, onToggle, onOpen, openRef, reduceMotion }) {
  const completed = block.items.filter((item) => item.done).length;
  const visibleCount = size === 'medium' ? 2 : block.items.length;
  const hiddenCount = Math.max(0, block.items.length - visibleCount);
  return <section className="widget-shelf-unit widget-shelf-list-unit" aria-label={block.label}>
    <div className="widget-shelf-unit-heading"><h3>{displayLabel}</h3><span><MorphText value={`${completed}/${block.items.length}`} duration={300} /></span></div>
    {size === 'small' && <div className="widget-shelf-small-list-summary"><strong><MorphText className="widget-shelf-morph" value={completed} duration={300} scale /><span>/{block.items.length}</span></strong><span><MorphText value={completed === block.items.length ? 'All done' : 'complete'} duration={300} /></span></div>}
    <div className="widget-shelf-list-progress" role="progressbar" aria-label={`${block.label} complete`} aria-valuemin="0" aria-valuemax={block.items.length} aria-valuenow={completed} style={{ '--widget-list-progress': `${completed / block.items.length * 100}%` }} />
    {size === 'small' ? <button ref={openRef} className="widget-shelf-open-list" type="button" onClick={onOpen} aria-label={`Open ${displayLabel} list`}>Open list</button> : <ul className="widget-shelf-checklist">{block.items.slice(0, visibleCount).map((item) => <li key={item.id}>
      <label className={item.done ? 'widget-shelf-check-done' : undefined}>
        <input type="checkbox" checked={item.done} disabled={disabled} onChange={() => onToggle(item.id)} />
        <WavyChecklistText text={item.text} done={item.done} reduceMotion={reduceMotion} />
      </label>
    </li>)}</ul>}
    {size !== 'small' && hiddenCount > 0 && <p className="widget-shelf-more">+{hiddenCount} more</p>}
  </section>;
}

function CounterBlock({ block, displayLabel, disabled, onChange }) {
  const valueText = block.value.toLocaleString();
  return <section className="widget-shelf-unit widget-shelf-counter-unit" aria-label={block.label}>
    <div className="widget-shelf-unit-heading"><h3>{displayLabel}</h3><span>Step {block.step}</span></div>
    <div className={`widget-shelf-counter${valueText.length > 4 ? ' is-long' : ''}`}>
      <button type="button" aria-label={`Decrease ${block.label} by ${block.step}`} disabled={disabled || block.value - block.step < -1000000} onClick={() => onChange(-block.step)}>−</button>
      <output className={valueText.length > 8 ? 'widget-shelf-count-very-long' : valueText.length > 4 ? 'widget-shelf-count-long' : undefined} aria-label={`${block.label} value`}><MorphText className="widget-shelf-morph" value={valueText} duration={320} scale /></output>
      <button type="button" aria-label={`Increase ${block.label} by ${block.step}`} disabled={disabled || block.value + block.step > 1000000} onClick={() => onChange(block.step)}>+</button>
    </div>
  </section>;
}

// onUpdate receives the complete spec and the revision being edited, and resolves to the saved widget.
function V1WidgetRenderer({ widget, size, onSizeChange, onUpdate, onDelete }) {
  const systemReducedMotion = useReducedMotion();
  const [current, setCurrent] = useState(widget);
  const [pending, setPending] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false);
  const [expandedChecklistIndex, setExpandedChecklistIndex] = useState(null);
  const [error, setError] = useState('');
  const deleteButtonRef = useRef(null);
  const cancelButtonRef = useRef(null);
  const sizeButtonRef = useRef(null);
  const firstSizeRef = useRef(null);
  const closeListRef = useRef(null);
  const openListRefs = useRef({});
  const restoreListFocusRef = useRef(null);
  const syncedWidgetRef = useRef({ projectId: widget?.projectId, id: widget?.id, revision: widget?.revision });
  useEffect(() => {
    const previous = syncedWidgetRef.current;
    const sameIdentity = previous.projectId === widget?.projectId && previous.id === widget?.id;
    const recoveringInvalid = !isRenderableWidget(current) && isRenderableWidget(widget);
    if (sameIdentity && widget?.revision <= previous.revision && !recoveringInvalid) return;
    syncedWidgetRef.current = { projectId: widget?.projectId, id: widget?.id, revision: widget?.revision };
    setCurrent(widget);
    setError('');
    setConfirmingDelete(false);
  }, [widget]);
  useEffect(() => { setExpandedChecklistIndex(null); restoreListFocusRef.current = null; }, [size, widget?.id]);
  useEffect(() => { if (confirmingDelete) cancelButtonRef.current?.focus(); }, [confirmingDelete]);
  useEffect(() => { if (sizeMenuOpen) firstSizeRef.current?.focus(); }, [sizeMenuOpen]);
  useEffect(() => {
    if (expandedChecklistIndex !== null) closeListRef.current?.focus();
    else if (restoreListFocusRef.current !== null) {
      openListRefs.current[restoreListFocusRef.current]?.focus();
      restoreListFocusRef.current = null;
    }
  }, [expandedChecklistIndex]);
  if (!isRenderableWidget(current)) return <p className="widget-shelf-invalid">This widget cannot be displayed.</p>;
  const chosenSize = ['small', 'medium', 'large'].includes(size) ? size : current.spec.size ?? 'medium';
  const displaySize = expandedChecklistIndex !== null && chosenSize === 'small' ? 'large' : chosenSize;
  const reduceMotion = systemReducedMotion || (typeof document !== 'undefined' && Boolean(document.querySelector('.pixice-app[data-reduce-motion="true"]')));

  function closeExpandedList() {
    restoreListFocusRef.current = expandedChecklistIndex;
    setExpandedChecklistIndex(null);
  }

  async function changeBlock(index, change) {
    if (pending || !onUpdate) return;
    const nextSpec = { ...current.spec, blocks: current.spec.blocks.map((block, blockIndex) => blockIndex === index ? change(block) : block) };
    const previous = current;
    setCurrent({ ...current, spec: nextSpec });
    setPending(true);
    setError('');
    try {
      const saved = await onUpdate(nextSpec, current.revision);
      if (!isRenderableWidget(saved)) throw new Error('The widget update returned invalid data.');
      setCurrent(saved);
    } catch (cause) {
      setCurrent(previous);
      setError(cause?.message || 'Could not save this widget.');
    } finally { setPending(false); }
  }

  async function deleteWidget() {
    if (pending || !onDelete) return;
    setPending(true);
    setError('');
    try { await onDelete(); }
    catch (cause) {
      setError(cause?.message || 'Could not delete this widget.');
      setConfirmingDelete(false);
      deleteButtonRef.current?.focus();
    } finally { setPending(false); }
  }

  return <motion.article layout={reduceMotion ? false : 'position'} transition={{ layout: { duration: reduceMotion ? 0 : .28, ease: [.22, 1, .36, 1] } }} className="widget-shelf-widget" data-size={displaySize} data-kind={current.spec.blocks.length === 1 ? current.spec.blocks[0].type : 'mixed'} aria-label={current.spec.title} aria-busy={pending} onKeyDown={(event) => { if (event.key === 'Escape' && expandedChecklistIndex !== null && !sizeMenuOpen && !confirmingDelete) { event.stopPropagation(); closeExpandedList(); } }}>
    {onSizeChange && <button ref={sizeButtonRef} type="button" className="widget-shelf-size-button" onClick={() => setSizeMenuOpen((open) => !open)} aria-label={`Change size of ${current.spec.title}`} aria-expanded={sizeMenuOpen} title={`Change size of ${current.spec.title}`}>▦</button>}
    {onDelete && <button ref={deleteButtonRef} type="button" className="widget-shelf-delete-button" disabled={pending} onClick={() => setConfirmingDelete(true)} aria-label={`Delete ${current.spec.title}`} title={`Delete ${current.spec.title}`}>×</button>}
    {sizeMenuOpen && <div className="widget-shelf-size-menu" role="group" aria-label={`Size for ${current.spec.title}`} onKeyDown={(event) => { if (event.key === 'Escape') { setSizeMenuOpen(false); sizeButtonRef.current?.focus(); } }}>
      {['small', 'medium', 'large'].map((option, index) => <button key={option} ref={index === 0 ? firstSizeRef : undefined} type="button" aria-pressed={chosenSize === option} onClick={() => { setExpandedChecklistIndex(null); onSizeChange?.(option); setSizeMenuOpen(false); sizeButtonRef.current?.focus(); }}>{option[0].toUpperCase() + option.slice(1)}</button>)}
    </div>}
    {confirmingDelete && <div className="widget-shelf-delete-confirm" role="group" aria-label={`Delete ${current.spec.title}`}>
      <p>Delete this widget?</p><div><button ref={cancelButtonRef} type="button" disabled={pending} onClick={() => { setConfirmingDelete(false); deleteButtonRef.current?.focus(); }}>Cancel</button>
        <button type="button" disabled={pending} onClick={deleteWidget} aria-label={`Confirm delete ${current.spec.title}`}>Delete widget</button></div>
    </div>}
    <div className="widget-shelf-units">{current.spec.blocks.map((block, index) => {
      const displayLabel = current.spec.blocks.length === 1 ? current.spec.title : block.label;
      if (block.type === 'timer') return <TimerBlock key={index} block={block} displayLabel={displayLabel} disabled={pending || !onUpdate} onRestart={() => changeBlock(index, (value) => ({ ...value, endAt: null }))} />;
      if (block.type === 'checklist') return <ChecklistBlock key={index} block={block} displayLabel={displayLabel} size={displaySize} reduceMotion={reduceMotion} disabled={pending || !onUpdate} openRef={(node) => { if (node) openListRefs.current[index] = node; }} onOpen={() => setExpandedChecklistIndex(index)} onToggle={(id) => changeBlock(index, (value) => ({ ...value, items: value.items.map((item) => item.id === id ? { ...item, done: !item.done } : item) }))} />;
      return <CounterBlock key={index} block={block} displayLabel={displayLabel} disabled={pending || !onUpdate} onChange={(amount) => changeBlock(index, (value) => ({ ...value, value: value.value + amount }))} />;
    })}</div>
    {expandedChecklistIndex !== null && <button ref={closeListRef} type="button" className="widget-shelf-close-list" onClick={closeExpandedList} aria-label={`Close ${current.spec.title} list`}>Close list</button>}
    {error && <p className="widget-shelf-error" role="alert">{error}</p>}
  </motion.article>;
}

const numberText = (value) => new Intl.NumberFormat('en-CH', { maximumFractionDigits: 2 }).format(value);
const unavailableNumberText = (...values) => values.includes(null) ? 'Cannot divide by zero' : 'Value unavailable';
const finiteOr = (value, fallback) => Number.isFinite(value) ? value : fallback;
const compact = (size) => size === 'small';

function slot(context, node, name) {
  return (node.slots[name] ?? []).map((id) => context.render(id));
}

function canEditControl(document, node, prop, input) {
  const path = node.props[prop]?.path;
  const action = document.actions[node.on.change];
  return typeof path === 'string' && /^\/(user|view)\//.test(path) &&
    (node.type !== 'NumberInput' || path.startsWith('/user/')) &&
    action?.target === path &&
    ((action.type === 'assign' && action.input === input) || (node.type === 'Toggle' && action.type === 'toggle'));
}

const v2Registry = {
  Stack: (c, n, p) => <div className="widget-v2-stack" data-direction={p.direction === 'horizontal' ? 'horizontal' : 'vertical'} style={{ '--widget-gap': `${Math.max(0, Math.min(40, finiteOr(p.gap, 8)))}px` }}>{slot(c, n, 'children')}</div>,
  Grid: (c, n, p) => <div className="widget-v2-grid" style={{ '--widget-columns': Math.max(1, Math.min(6, Math.round(finiteOr(p.columns, 2)))), '--widget-gap': `${Math.max(0, Math.min(40, finiteOr(p.gap, 8)))}px` }}>{slot(c, n, 'children')}</div>,
  Card: (c, n, p) => {
    const body = n.slots.body ?? [];
    const kind = body.some((id) => c.nodeType(id) === 'Table') ? 'collection'
      : body.some((id) => c.nodeType(id) === 'Number') ? 'calculation' : 'content';
    const controls = kind === 'collection' ? body.filter((id) => c.nodeType(id) === 'Select') : [];
    const metrics = kind === 'calculation' ? body.filter((id) => c.nodeType(id) === 'Number') : [];
    const results = metrics.length > 1 ? [metrics.at(-1), ...metrics.slice(0, -1)] : metrics;
    const factors = kind === 'calculation' ? body.filter((id) => c.nodeType(id) === 'NumberInput') : [];
    const remaining = body.filter((id) => !controls.includes(id) && !results.includes(id) && !factors.includes(id));
    return <section className="widget-v2-card" data-composition={kind} data-has-expression={remaining.some((id) => c.nodeType(id) === 'Text')}>
      {(p.title || controls.length > 0) && <header className="widget-v2-card-header">{p.title && <h3>{p.title}</h3>}{controls.map((id) => c.render(id))}</header>}
      {results.length > 0 && <div className="widget-v2-results">{results.map((id) => c.render(id))}</div>}
      {factors.length > 0 && <div className="widget-v2-factors" aria-label="Calculation factors">{factors.map((id) => c.render(id))}</div>}
      {remaining.length > 0 && <div className="widget-v2-card-body">{remaining.map((id) => c.render(id))}</div>}
      {n.slots.footer?.length > 0 && <footer>{slot(c, n, 'footer')}</footer>}
    </section>;
  },
  Text: (c, n, p) => <p className="widget-v2-text" data-tone={p.tone}>{p.text}</p>,
  Heading: (c, n, p) => <h3 className="widget-v2-heading">{p.text}</h3>,
  Number: (c, n, p) => {
    const unavailable = !Number.isFinite(p.value);
    const reason = p.value === null ? 'Cannot divide by zero' : 'Result unavailable';
    return <div className="widget-v2-number" data-unavailable={unavailable}>{p.label && <span>{p.label}</span>}<output aria-live="polite" aria-label={unavailable ? `${p.label || 'Value'}: ${reason}` : p.label ? `${p.label} value` : 'Value'}><MorphText className="widget-shelf-morph" value={unavailable ? '—' : numberText(p.value)} duration={320} scale /></output>{unavailable && <small>{reason}</small>}</div>;
  },
  Button: (c, n, p) => <button className="widget-v2-button" type="button" disabled={p.disabled || !c.canPress(n)} onClick={() => c.emit(n, 'press')}>{p.label}</button>,
  TextInput: (c, n, p) => <label className="widget-v2-field"><span>{p.label}</span><input type="text" value={p.value} disabled={!c.canEdit(n, 'value', 'value')} placeholder={p.placeholder ?? ''} onChange={(event) => c.emit(n, 'change', { value: event.target.value })} /></label>,
  NumberInput: (c, n, p) => <label className="widget-v2-field"><span>{p.label}</span><input type="number" inputMode="decimal" aria-label={p.label} value={p.value} disabled={!c.canEdit(n, 'value', 'number')} min={Number.isFinite(p.min) ? p.min : undefined} max={Number.isFinite(p.max) ? p.max : undefined} step={Number.isFinite(p.step) ? p.step : 'any'} onChange={(event) => {
    const value = event.target.valueAsNumber;
    if (Number.isFinite(value) && (!Number.isFinite(p.min) || value >= p.min) && (!Number.isFinite(p.max) || value <= p.max)) c.emit(n, 'change', { number: value });
  }} />{['min', 'max', 'step'].some((name) => Object.hasOwn(n.props, name) && !Number.isFinite(p[name])) && <small role="status" aria-label={`${p.label}: input limit unavailable`}>Input limit unavailable</small>}</label>,
  Select: (c, n, p) => <label className="widget-v2-field"><span>{p.label}</span><select aria-label={p.label} value={p.value} disabled={!c.canEdit(n, 'value', 'value')} onChange={(event) => c.emit(n, 'change', { value: event.target.value })}>{p.options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>,
  Toggle: (c, n, p) => <label className="widget-v2-toggle"><input type="checkbox" checked={p.checked} disabled={!c.canEdit(n, 'checked', 'checked')} onChange={(event) => c.emit(n, 'change', { checked: event.target.checked })} /><span>{p.label}</span></label>,
  Table: (c, n, p) => <div className="widget-v2-table-wrap" role="region" aria-label="Board table" tabIndex={0}><table role="table"><thead role="rowgroup"><tr role="row">{p.columns.map((column) => <th key={column.field} role="columnheader" scope="col">{column.label}</th>)}</tr></thead><tbody role="rowgroup">{p.rows.slice(0, compact(c.size) ? 2 : 500).map((row, index) => <tr role="row" key={row.id ?? index}>{p.columns.map((column, columnIndex) => { const value = String(row[column.field] ?? ''); return <td role="cell" key={column.field} data-field={column.field} data-primary={column.field === 'title' || (!p.columns.some((entry) => entry.field === 'title') && columnIndex === 0) ? 'true' : undefined} data-label={column.label} title={value}>{column.field === 'updatedAt' && /^\d{4}-\d\d-\d\dT/.test(value) ? value.slice(0, 10) : value}</td>; })}</tr>)}</tbody></table>{p.rows.length === 0 && <p>{p.emptyText ?? 'No rows'}</p>}{compact(c.size) && p.rows.length > 2 && <p>+{p.rows.length - 2} more rows</p>}</div>,
  List: (c, n, p) => <ul className="widget-v2-list">{p.items.slice(0, compact(c.size) ? 3 : 100).map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}{compact(c.size) && p.items.length > 3 && <li>+{p.items.length - 3} more</li>}</ul>,
  BarChart: (c, n, p) => <div className="widget-v2-chart" role="img" aria-label={`Bar chart of ${p.rows.length} values`}>{p.rows.slice(0, compact(c.size) ? 3 : 100).map((row, index) => <div key={`${row.label}-${index}`}><span>{row.label}</span><div className="widget-v2-bar-track"><i style={{ width: `${Math.max(0, Math.min(100, row.value / Math.max(1, ...p.rows.map((item) => item.value)) * 100))}%` }} /></div><strong>{numberText(row.value)}</strong></div>)}</div>,
  Progress: (c, n, p) => {
    const available = Number.isFinite(p.value) && Number.isFinite(p.max) && p.max > 0;
    const reason = Number.isFinite(p.max) && p.max <= 0 ? 'Progress range unavailable' : unavailableNumberText(p.value, p.max);
    return <div className="widget-v2-progress">{available
      ? <><progress value={Math.max(0, Math.min(p.value, p.max))} max={p.max} aria-label="Progress" /><span>{numberText(p.value)} / {numberText(p.max)}</span></>
      : <span role="status" aria-label={`Progress: ${reason}`}>{reason}</span>}</div>;
  },
  Timer: (c, n, p) => {
    const seconds = p.endAt ? Math.max(0, Math.ceil((Date.parse(p.endAt) - c.now) / 1000)) : p.durationSeconds;
    const available = Number.isFinite(seconds);
    return <div className="widget-v2-utility"><span>{p.label}</span><strong role={available ? undefined : 'status'} aria-label={available ? undefined : `${p.label}: ${unavailableNumberText(seconds)}`}>{available ? remainingText(seconds) : '—'}</strong>{!available && <small>{unavailableNumberText(seconds)}</small>}</div>;
  },
  Checklist: (c, n, p) => <div className="widget-v2-utility"><span>{p.label}</span>{p.items.slice(0, compact(c.size) ? 2 : 100).map((item) => <div className="widget-v2-check-item" key={item.id}><span aria-hidden="true">{item.done ? '✓' : '○'}</span><span>{item.text}</span><span className="widget-v2-sr-only">{item.done ? 'complete' : 'incomplete'}</span></div>)}</div>,
  Counter: (c, n, p) => <div className="widget-v2-counter"><span>{p.label}</span>{Number.isFinite(p.value) && Number.isFinite(p.step) && c.canCount(n, 'decrement', -p.step) && <button type="button" aria-label={`Decrease ${p.label}`} onClick={() => c.emit(n, 'decrement')}>−</button>}<output aria-live="polite" aria-label={Number.isFinite(p.value) ? `${p.label} value` : `${p.label}: ${unavailableNumberText(p.value)}`}>{Number.isFinite(p.value) ? numberText(p.value) : '—'}</output>{Number.isFinite(p.value) && Number.isFinite(p.step) && c.canCount(n, 'increment', p.step) && <button type="button" aria-label={`Increase ${p.label}`} onClick={() => c.emit(n, 'increment')}>+</button>}{(!Number.isFinite(p.value) || !Number.isFinite(p.step)) && <small>{!Number.isFinite(p.value) ? unavailableNumberText(p.value) : 'Step unavailable'}</small>}</div>
};

function V2WidgetRenderer({ widget, size, onSizeChange, onDelete, onStateChange, onSourceRead, sourceData = {}, api = globalThis.window?.pixice }) {
  const systemReducedMotion = useReducedMotion();
  const document = useMemo(() => widgetV2Schema.parse(widget.spec), [widget.spec]);
  const [state, setState] = useState(() => initialWidgetState(document, widget.runtimeState));
  const [data, setData] = useState({});
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [temporarilyOpen, setTemporarilyOpen] = useState(false);
  const openButtonRef = useRef(null);
  const closeButtonRef = useRef(null);
  const restoreOpenFocus = useRef(false);
  const pendingWrites = useRef(0);
  const sourceRequests = useRef({});
  const chosenSize = ['small', 'medium', 'large'].includes(size) ? size : document.size ?? 'medium';
  const displaySize = temporarilyOpen ? 'large' : chosenSize;
  const hasEditableFactor = document.nodes.some((node) => node.type === 'NumberInput');
  const canOpen = chosenSize === 'small'
    ? document.nodes.some((node) => ['NumberInput', 'Table', 'List', 'BarChart', 'Grid', 'Stack', 'Progress', 'Timer', 'Checklist', 'Counter'].includes(node.type))
    : chosenSize === 'medium' && hasEditableFactor;
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  useEffect(() => { if (temporarilyOpen) closeButtonRef.current?.focus(); else if (restoreOpenFocus.current) { openButtonRef.current?.focus(); restoreOpenFocus.current = false; } }, [temporarilyOpen]);
  useEffect(() => { setTemporarilyOpen(false); }, [widget.id, chosenSize]);
  useEffect(() => { if (pendingWrites.current === 0) setState(initialWidgetState(document, widget.runtimeState)); setError(''); }, [widget.id, widget.revision, document]);
  useEffect(() => { setData({}); sourceRequests.current = {}; }, [widget.id, widget.projectId]);
  useEffect(() => {
    if (!document.nodes.some((node) => node.type === 'Timer')) return undefined;
    const timerId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timerId);
  }, [document]);
  useEffect(() => {
    for (const [name, source] of Object.entries(document.sources)) if (source.refresh !== 'manual' && !Object.hasOwn(sourceData, name)) void refreshSource(name);
    if (!api?.events?.subscribe) return undefined;
    return api.events.subscribe((event) => {
      if (event?.type === 'BoardUpdated' && event.payload?.projectId === widget.projectId) {
        for (const [name, source] of Object.entries(document.sources)) if (source.refresh === 'event') void refreshSource(name);
      }
    });
  }, [document, onSourceRead, api, widget.projectId]);

  async function refreshSource(name) {
    const source = document.sources[name];
    if (!source) return;
    const request = (sourceRequests.current[name] ?? 0) + 1;
    sourceRequests.current[name] = request;
    try {
      const reader = onSourceRead ?? ((_declaration, context) => {
        if (!api?.widgets?.readSource) throw new Error('Widget source is unavailable.');
        return api.widgets.readSource({ projectId: widget.projectId, widgetId: widget.id, source: context.source });
      });
      const result = await reader(source, { widgetId: widget.id, source: name });
      if (sourceRequests.current[name] === request) setData((current) => ({ ...current, [name]: projectWidgetSource(source, result) }));
    } catch (cause) { if (sourceRequests.current[name] === request) setError(cause?.message || 'Could not load widget data.'); }
  }

  function emit(node, event, payload) {
    const actionId = node.on[event];
    if (!actionId) return;
    if (event === 'change' && ['TextInput', 'NumberInput', 'Select', 'Toggle'].includes(node.type)) {
      const checked = node.type === 'Toggle';
      if (!canEditControl(document, node, checked ? 'checked' : 'value', checked ? 'checked' : node.type === 'NumberInput' ? 'number' : 'value')) return;
    }
    const action = document.actions[actionId];
    if (action.type === 'refresh') { void refreshSource(action.source); return; }
    try {
      const next = dispatchWidgetAction(document, state, actionId, payload);
      setState(next);
      setError('');
      if (action.target.startsWith('/user/')) {
        pendingWrites.current += 1;
        Promise.resolve().then(() => onStateChange?.({ ...next.user }, { widgetId: widget.id, revision: widget.revision }))
          .catch((cause) => { setError(cause?.message || 'Could not save widget state.'); setState(initialWidgetState(document, widget.runtimeState)); })
          .finally(() => { pendingWrites.current -= 1; });
      }
    } catch (cause) { setError(cause?.message || 'Invalid widget action.'); }
  }

  const context = { size: displaySize, now, emit, nodeType: (id) => nodes.get(id)?.type,
    canEdit: (node, prop, input) => canEditControl(document, node, prop, input),
    canPress: (node) => Boolean(document.actions[node.on.press]) && document.actions[node.on.press].type !== 'assign',
    canCount(node, event, amount) {
    const action = document.actions[node.on[event]];
    return node.props.value?.path?.startsWith('/user/') && action?.type === 'increment' && action.target === node.props.value.path && action.amount === amount;
  }, render(id) {
    const node = nodes.get(id);
    const component = v2Registry[node.type];
    if (!Object.hasOwn(widgetCatalog, node.type) || !component) return null;
    const projected = Object.fromEntries(Object.entries(document.sources).filter(([name]) => Object.hasOwn(sourceData, name)).map(([name, source]) => [name, projectWidgetSource(source, sourceData[name])]));
    const props = Object.fromEntries(Object.entries(node.props).map(([name, prop]) => [name, resolveWidgetProp(document, state, { ...projected, ...data }, prop)]));
    return <div className="widget-v2-node" data-node-type={node.type} key={id}>{component(context, node, props)}</div>;
  } };
  const reduceMotion = systemReducedMotion || (typeof document !== 'undefined' && Boolean(globalThis.document?.querySelector('.pixice-app[data-reduce-motion="true"]')));
  return <motion.article layout={reduceMotion ? false : 'position'} transition={{ layout: { duration: reduceMotion ? 0 : .26, ease: [.22, 1, .36, 1] } }} className="widget-shelf-widget widget-v2" data-size={displaySize} data-saved-size={chosenSize} data-temporary-open={temporarilyOpen} data-kind="v2" data-reduce-motion={reduceMotion} aria-label={document.title} onKeyDown={(event) => { if (event.key === 'Escape' && temporarilyOpen && !sizeMenuOpen && !confirmingDelete) { event.stopPropagation(); restoreOpenFocus.current = true; setTemporarilyOpen(false); } }}>
    {onSizeChange && <button className="widget-shelf-size-button" type="button" aria-label={`Change size of ${document.title}`} aria-expanded={sizeMenuOpen} onClick={() => setSizeMenuOpen(!sizeMenuOpen)}>▦</button>}
    {onDelete && <button className="widget-shelf-delete-button" type="button" aria-label={`Delete ${document.title}`} onClick={() => setConfirmingDelete(true)}>×</button>}
    {sizeMenuOpen && <div className="widget-shelf-size-menu" role="group" aria-label={`Size for ${document.title}`}>{['small', 'medium', 'large'].map((option) => <button key={option} type="button" aria-pressed={chosenSize === option} onClick={() => { setTemporarilyOpen(false); onSizeChange?.(option); setSizeMenuOpen(false); }}>{option}</button>)}</div>}
    {confirmingDelete && <div className="widget-shelf-delete-confirm"><p>Delete this widget?</p><button type="button" onClick={() => setConfirmingDelete(false)}>Cancel</button><button type="button" onClick={onDelete}>Delete widget</button></div>}
    <div className="widget-v2-content">{context.render(document.root)}</div>
    {canOpen && !temporarilyOpen && <button ref={openButtonRef} className="widget-v2-open-button" type="button" onClick={() => setTemporarilyOpen(true)} aria-label={`${hasEditableFactor ? 'Edit' : 'Open'} ${document.title}`} aria-expanded={false}>{hasEditableFactor ? 'Edit' : 'Open'}</button>}
    {temporarilyOpen && <button ref={closeButtonRef} className="widget-v2-open-button" type="button" onClick={() => { restoreOpenFocus.current = true; setTemporarilyOpen(false); }} aria-label={`Close ${document.title}`} aria-expanded={true}>Close</button>}
    {error && <p className="widget-shelf-error" role="alert">{error}</p>}
  </motion.article>;
}

export function WidgetRenderer(props) {
  if (props.widget?.spec?.version === 2) return isRenderableWidget(props.widget) ? <V2WidgetRenderer {...props} /> : <p className="widget-shelf-invalid">This widget cannot be displayed.</p>;
  return <V1WidgetRenderer {...props} />;
}

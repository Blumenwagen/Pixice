import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import WidgetShelf from '../../src/components/WidgetShelf.jsx';
import background from '../../src/assets/focus-background-dark.png';
import '../../src/styles.css';

const projectId = 'widget-preview';
const now = new Date().toISOString();
const seed = [
  {
    id: '0a27ca66-224e-4b8b-a56b-fc840705984e', projectId, revision: 1, createdAt: now, updatedAt: now,
    spec: { version: 1, title: 'Focus session', size: 'medium', blocks: [{ type: 'timer', label: 'Time remaining', durationSeconds: 1500, endAt: new Date(Date.now() + 1462_000).toISOString() }] }
  },
  {
    id: '93e32656-77e4-4cbd-9d0d-48566362b89e', projectId, revision: 1, createdAt: now, updatedAt: now,
    spec: { version: 1, title: 'Before you wrap up', size: 'large', blocks: [{ type: 'checklist', label: 'Today', items: [
      { id: '423b6f28-0fe9-491b-91c7-e43ba5f17624', text: 'Review the design', done: true },
      { id: '67c5b152-e60c-425e-b1e2-a0b05e45823a', text: 'Send the update', done: false },
      { id: '7ad9b853-0aca-4571-b12f-18bb82b90c44', text: 'Plan tomorrow', done: false },
      { id: '7821c166-3ab3-47ed-b8b8-4e1f81c8d696', text: 'Check the prototype', done: false },
      { id: 'a1905042-6161-4229-9161-5193214b767c', text: 'Tidy the project board', done: false },
      { id: '1c4d4a8b-2760-42ab-85c8-9326a2956f90', text: 'Write the next note', done: false },
      { id: '02e6838a-96dd-450a-95de-be419996fafe', text: 'Close open loops', done: false }
    ] }] }
  },
  {
    id: 'cb857886-e69f-475f-89c7-b54eb350a773', projectId, revision: 1, createdAt: now, updatedAt: now,
    spec: { version: 1, title: 'Water break', size: 'small', blocks: [{ type: 'counter', label: 'Glasses today', value: 2, step: 1 }] }
  },
  {
    id: 'a8c181e4-9862-4a25-a569-a75171649747', projectId, revision: 1, createdAt: now, updatedAt: now,
    spec: { version: 1, title: 'Stretch breaks', size: 'small', blocks: [{ type: 'counter', label: 'Breaks today', value: 1, step: 1 }] }
  }
];

function Preview() {
  const [widgets, setWidgets] = useState(() => new URLSearchParams(window.location.search).get('solo') === 'checklist'
    ? [{ ...seed[1], spec: { ...seed[1].spec, size: 'small' } }]
    : seed);
  const [open, setOpen] = useState(true);
  const api = useMemo(() => ({ widgets: {
    async update({ widgetId, spec, expectedRevision }) {
      const current = widgets.find((widget) => widget.id === widgetId);
      if (!current || current.revision !== expectedRevision) throw new Error('Widget changed. Refresh and try again.');
      return { ...current, revision: current.revision + 1, updatedAt: new Date().toISOString(), spec: {
        ...spec, blocks: spec.blocks.map((block) => block.type === 'timer' && block.endAt === null
          ? { ...block, endAt: new Date(Date.now() + block.durationSeconds * 1000).toISOString() } : block)
      } };
    },
    async delete() { return {}; }
  } }), [widgets]);
  return <div className="preview-stage" style={{ backgroundImage: `linear-gradient(180deg, rgba(11,14,20,.25), #1b1b1c 77%), url(${background})` }}>
    <div className="preview-note">Live widget grid preview <span>1×1 · 2×1 · 2×2 · size controls on hover</span></div>
    <div className="preview-project"><span>✦</span> Pixice</div>
    <div className="preview-chat"><span>✦</span><p>Your focus timer is ready. Keep this conversation open while it runs.</p></div>
    {!open && <button className="preview-open" type="button" onClick={() => setOpen(true)}>Open widgets</button>}
    {open && <WidgetShelf projectId={projectId} widgets={widgets} api={api} onWidgetsChange={setWidgets} onClose={() => setOpen(false)} />}
    <div className="preview-composer"><span>Ask, decide, or start something</span><div><span>＋</span><span>Sol · High　🎙　➤</span></div></div>
    <style>{`
      * { box-sizing: border-box; } html, body, #root { width: 100%; height: 100%; margin: 0; }
      body { font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #1b1b1c; color: #eef1f3; }
      .preview-stage { position: relative; width: 100%; height: 100%; min-height: 520px; overflow: hidden; background-size: cover; background-position: center top; }
      .preview-note { position: absolute; top: 18px; left: 24px; padding: 7px 11px; border: 1px solid #ffffff26; border-radius: 11px; background: #20252ac9; font-size: 12px; font-weight: 700; }
      .preview-note span { margin-left: 12px; color: #9fa8b2; font-weight: 400; }
      .preview-project { position: absolute; top: 20px; left: 50%; transform: translateX(-50%); padding: 7px 12px; border: 1px solid #ffffff2b; border-radius: 12px; background: #252a30da; font-size: 13px; }
      .preview-project span { color: #f7a5b9; }
      .preview-chat { position: absolute; top: 27%; left: max(14%, 70px); display: flex; gap: 18px; max-width: 510px; color: #d5dce1; font-size: 16px; line-height: 1.6; }
      .preview-chat span { color: #f6a8bd; }.preview-chat p { margin: 0; }
      .preview-composer { position: absolute; left: 50%; bottom: 28px; transform: translateX(-50%); width: min(840px, calc(100% - 48px)); height: 112px; padding: 18px 20px 14px; border: 2px solid #ffffff1f; border-radius: 27px; background: #25282bdd; box-shadow: 0 20px 50px #0005; color: #98a3ad; font-size: 16px; }
      .preview-composer div { display: flex; justify-content: space-between; margin-top: 33px; }
      .preview-open { position: absolute; top: 22px; right: 18px; padding: 9px 14px; border: 1px solid #ffffff30; border-radius: 12px; color: #eee; background: #25282b; cursor: pointer; }
      @media (max-width: 800px) { .preview-note { display: none; } .preview-chat { left: 30px; max-width: calc(100% - 60px); } }
    `}</style>
  </div>;
}

createRoot(document.getElementById('root')).render(<Preview />);

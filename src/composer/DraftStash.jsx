import { useEffect, useRef, useState } from 'react';
import './DraftStash.css';

/** A small project-scoped reusable prompt menu. The owning composer restores drafts. */
export function DraftStash({ memory, disabled = false, onRestore = () => {}, onNotice = () => {}, open: controlledOpen, onOpenChange, revision = 0 }) {
  const [localOpen, setLocalOpen] = useState(false);
  const [entries, setEntries] = useState(() => memory?.listStashes() ?? []);
  const panelRef = useRef(null);
  const buttonRef = useRef(null);
  const open = controlledOpen ?? localOpen;
  const setOpen = value => { setLocalOpen(value); onOpenChange?.(value); };
  useEffect(() => {
    setEntries(memory?.listStashes() ?? []);
    return memory?.subscribe(() => setEntries(memory.listStashes()));
  }, [memory, revision]);
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector('button')?.focus();
    const dismiss = event => {
      if (!panelRef.current?.contains(event.target) && !buttonRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  const restore = async id => {
    const result = memory.restore(id);
    if (!result.ok) { onNotice(result.message); return; }
    const accepted = await onRestore(result.draft, result);
    if (accepted !== false) { onNotice(result.message); setOpen(false); }
  };
  const remove = id => {
    const result = memory.remove(id);
    if (!result.ok) onNotice(result.message ?? 'The saved prompt could not be deleted.');
  };
  const moveFocus = event => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); buttonRef.current?.focus(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...panelRef.current.querySelectorAll('button:not(:disabled)')];
    const current = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    if (buttons[next]) { event.preventDefault(); buttons[next].focus(); }
  };
  return <div className="draft-stash">
    <button ref={buttonRef} className="draft-stash-toggle" type="button" disabled={disabled} aria-label={`Saved prompts${entries.length ? ` (${entries.length})` : ''}`} aria-expanded={Boolean(open)} aria-haspopup="dialog" title="Saved prompts · ⌘/Ctrl S saves or restores" onClick={() => setOpen(!open)}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="4" rx="1.5" /><path d="M5.5 8v10.5A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V8M9 12h6" /></svg>{entries.length > 0 && <span>{entries.length}</span>}</button>
    {open && <section ref={panelRef} className="draft-stash-menu" role="dialog" aria-label="Saved prompts" onKeyDown={moveFocus}>
      <header><strong>Saved prompts</strong><span>For this project</span></header>
      {entries.length === 0 ? <p className="draft-stash-empty">Press ⌘/Ctrl S in the composer to save a prompt with its context and attachments.</p> : <ul>{entries.map(entry => <li key={entry.id}>
        <button className="draft-stash-restore" type="button" disabled={disabled} onClick={() => void restore(entry.id)} aria-label={`Restore ${entry.text.trim().slice(0, 80) || 'attached files'}`}>
          <span>{entry.text.trim() || 'Attached files'}</span>
          <small>{[entry.attachments?.length ? `${entry.attachments.length} ${entry.attachments.length === 1 ? 'attachment' : 'attachments'}` : '', entry.records?.length ? `${entry.records.length} context ${entry.records.length === 1 ? 'reference' : 'references'}` : ''].filter(Boolean).join(' · ') || 'Text prompt'}</small>
          {entry.unavailableAttachments?.length > 0 && <small className="draft-stash-warning">{entry.unavailableAttachments.length} {entry.unavailableAttachments.length === 1 ? 'file needs' : 'files need'} reselecting</small>}
        </button>
        <button className="draft-stash-delete" type="button" disabled={disabled} aria-label={`Delete saved prompt ${entry.text.trim().slice(0, 80) || 'attached files'}`} onClick={() => remove(entry.id)}>×</button>
      </li>)}</ul>}
      <footer>Saved prompts stay available after you restore them.</footer>
    </section>}
  </div>;
}

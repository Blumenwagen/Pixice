import { useEffect, useRef, useState } from 'react';
import { createContextRecord, requestComposerContext } from './context.js';
import './SelectionContextMenu.css';

// Source selection stays local; only an explicit click attaches the excerpt.
export function SelectionContextMenu({ projectId, threadId, hostId = 'local', onAttached, children }) {
  const surface = useRef(null);
  const [selection, setSelection] = useState(null);
  useEffect(() => {
    const select = () => {
      const picked = window.getSelection();
      const text = picked?.toString().trim();
      const element = picked?.anchorNode?.parentElement?.closest('[data-context-kind]');
      const end = picked?.focusNode?.parentElement?.closest('[data-context-kind]');
      if (!text || text.length > 32768 || !element || element !== end || !surface.current?.contains(element)) { setSelection(null); return; }
      const range = picked.getRangeAt(0);
      const rect = range.getBoundingClientRect?.() ?? element.getBoundingClientRect();
      setSelection({ text, kind: element.dataset.contextKind, label: element.dataset.contextLabel || 'Selected excerpt', source: {
        projectId, threadId, hostId, itemId: element.dataset.contextItem, turnId: element.closest('[data-turn-id]')?.dataset.turnId,
        path: element.dataset.contextPath, url: element.dataset.contextUrl
      }, left: Math.min(window.innerWidth - 190, Math.max(12, rect.left)), top: Math.max(12, rect.top - 38) });
    };
    document.addEventListener('mouseup', select);
    document.addEventListener('keyup', select);
    return () => { document.removeEventListener('mouseup', select); document.removeEventListener('keyup', select); };
  }, [projectId, threadId, hostId]);
  return <div ref={surface} className="composer-context-source-scope">{children}{selection && <button type="button" className="composer-selection-cite" style={{ left: selection.left, top: selection.top }} onMouseDown={event => event.preventDefault()} onClick={() => {
    const record = createContextRecord(selection.kind, selection);
    requestComposerContext({ projectId, threadId, record });
    setSelection(null);
    onAttached?.(record);
    window.getSelection()?.removeAllRanges();
  }}>{selection.kind === 'citation' ? 'Cite in composer' : 'Attach selection'}</button>}</div>;
}

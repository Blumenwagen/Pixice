import { useEffect, useState } from "react";
import "./RewindPrompt.css";

export function RewindPromptAction({ preview, rewind, restoreFile, onRewound, disabled = false, checkpointId }) {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  useEffect(() => { setOpen(false); setDetails(null); setError(null); setSelectedFile(null); }, [checkpointId]);
  const load = async () => {
    setOpen(true); setBusy(true); setError(null);
    try { setDetails(await preview()); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const apply = async (restoreFiles) => {
    setBusy(true); setError(null);
    try {
      const result = await rewind({ checkpointId: details.checkpointId, conversationRevision: details.conversationRevision, workspaceRevision: details.workspaceRevision, restoreFiles });
      await onRewound(result);
      if (result.restoreError) setError(result.restoreError);
      else setOpen(false);
    } catch (cause) {
      setError(cause.message);
      if (cause.conversationRewound && cause.input) await onRewound({ input: cause.input, filesKept: true });
    } finally { setBusy(false); }
  };
  const applyFile = async () => {
    setBusy(true); setError(null);
    try {
      await restoreFile({ checkpointId: details.checkpointId, file: { root: selectedFile.root, path: selectedFile.path }, workspaceRevision: details.workspaceRevision });
      setSelectedFile(null); setDetails(await preview());
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  return <div className="rewind-prompt">
    <button type="button" className="rewind-prompt-action" disabled={disabled || busy} aria-expanded={open} onClick={() => open ? setOpen(false) : load()}>Edit from here</button>
    {open && <section className="rewind-prompt-preview" aria-label="Rewind conversation preview" aria-busy={busy}>
      <header><strong>Edit from here</strong><button type="button" disabled={busy} onClick={() => setOpen(false)} aria-label="Close rewind preview">×</button></header>
      {!details && busy && <p role="status">Preparing checkpoint…</p>}
      {details && <>
        <p>Remove this message and {details.removedTurns > 1 ? `${details.removedTurns - 1} later turn${details.removedTurns > 2 ? "s" : ""}` : "its response"} from the conversation, then edit the original prompt. Your current draft is kept.</p>
        {details.fileCount > 0 && <details className="rewind-file-details" open><summary>{details.fileCount} file{details.fileCount === 1 ? "" : "s"} changed since this prompt</summary><ul>{details.files.map((file) => <li key={`${file.root}:${file.path}`}><code title={file.root}>{file.path}</code><span>+{file.plus} −{file.minus}</span>{details.restoreAllowed && restoreFile && <button type="button" disabled={busy} onClick={() => setSelectedFile(file)} aria-label={`Restore ${file.path}`}>Restore</button>}</li>)}</ul>{details.truncated && <p>Showing the first {details.files.length} files. Revert files too restores every changed file in the checkpoint scope.</p>}</details>}
        {!details.restoreAllowed && <p>{details.restoreReason}</p>}
        {selectedFile && <div className="rewind-file-confirm"><p>Restore <strong>{selectedFile.path}</strong> to its state before this prompt? A recovery snapshot keeps the current content.</p><button type="button" disabled={busy} onClick={applyFile}>Restore selected file</button><button type="button" disabled={busy} onClick={() => setSelectedFile(null)}>Cancel</button></div>}
        <div className="rewind-prompt-buttons"><button type="button" disabled={busy} onClick={() => apply(false)}>Revert and keep changes</button><button type="button" disabled={busy || !details.restoreAllowed || !details.workspaceRevision} onClick={() => apply(true)}>Revert files too</button></div>
        <p className="rewind-prompt-note">External actions and separate provider memory remain. File restoration keeps a recovery snapshot.</p>
      </>}
      {error && <p role="alert">{error}</p>}
    </section>}
  </div>;
}

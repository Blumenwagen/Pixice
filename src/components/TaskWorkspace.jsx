import { useState } from "react";
import "./TaskWorkspace.css";

export function TaskWorkspacePicker({ value = { mode: "project" }, onChange, repository, disabled = false }) {
  const [open, setOpen] = useState(false);
  const worktree = value.mode === "worktree";
  const supported = repository?.kind === "git" && Boolean(repository.baseCommit);
  const change = (update) => onChange({ ...value, ...update });
  return <div className="task-workspace-picker">
    <button type="button" className="task-workspace-trigger" aria-expanded={open} aria-label="Task execution workspace" disabled={disabled} onClick={() => setOpen(!open)}>{worktree ? "New worktree" : "Project folder"}<span aria-hidden="true">⌄</span></button>
    {open && <div className="task-workspace-options" role="group" aria-label="Task execution workspace">
      <button type="button" aria-pressed={!worktree} onClick={() => change({ mode: "project" })}><strong>Project folder</strong><span>Work in the current checkout.</span></button>
      <button type="button" aria-pressed={worktree} disabled={!supported} onClick={() => change({ mode: "worktree", startingState: value.startingState ?? { type: "working-tree" } })}><strong>New worktree</strong><span>Keep this task in its own branch and checkout.</span></button>
      {!supported && <p>A worktree needs a Git repository with an initial commit.</p>}
      {worktree && supported && <div className="task-workspace-fields">
        <label>Start from<select value={value.startingState?.type ?? "working-tree"} onChange={(event) => change({ startingState: event.target.value === "ref" ? { type: "ref", ref: "HEAD" } : { type: "working-tree" } })}><option value="working-tree">Current files and changes</option><option value="ref">Branch, tag, or commit</option></select></label>
        {value.startingState?.type === "ref" && <label>Git reference<input value={value.startingState.ref ?? ""} spellCheck={false} onChange={(event) => change({ startingState: { type: "ref", ref: event.target.value } })} placeholder="HEAD or origin/main" /></label>}
        <label>New branch<input value={value.branch ?? ""} spellCheck={false} onChange={(event) => change({ branch: event.target.value })} placeholder="Automatic" /></label>
        <p>Ignored files and installed dependencies are kept in the original checkout. Reference starts initialize submodules.</p>
      </div>}
      <button type="button" className="task-workspace-done" onClick={() => setOpen(false)}>Done</button>
    </div>}
  </div>;
}

export function TaskWorkspaceBadge({ workspace, onRemove, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!workspace) return null;
  const remove = async () => {
    setBusy(true); setError(null);
    try { await onRemove(); setOpen(false); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  return <div className="task-workspace-badge">
    <button type="button" className="task-workspace-trigger" aria-expanded={open} onClick={() => setOpen(!open)}>{workspace.repositories?.[0]?.branch ?? "Task worktree"}</button>
    {open && <div className="task-workspace-options" role="group" aria-label="Task worktree">
      <strong>{workspace.status === "removed" ? "Checkout removed" : "Task worktree"}</strong>
      <p className="task-workspace-path">{workspace.cwd}</p>
      {workspace.status === "removed" ? <p>The branch and conversation are preserved. The checkout is recreated when you continue.</p> : onRemove && <><p>Remove this checkout only when its agents are stopped and its files are clean. The branch and conversation are kept.</p><button type="button" disabled={disabled || busy} onClick={remove}>{busy ? "Checking files…" : "Remove clean checkout"}</button></>}
      {error && <p role="alert">{error}</p>}
      <button type="button" className="task-workspace-done" disabled={busy} onClick={() => setOpen(false)}>Close</button>
    </div>}
  </div>;
}

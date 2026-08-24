import { useEffect, useMemo, useState } from "react";
import { CheckCircle, SpinnerGap, Trash, X } from "../icons/index.jsx";
import { getCleanupCandidates, THREAD_CLEANUP_AGE_DAYS } from "./thread-cleanup.js";
import styles from "./ThreadCleanupPopover.module.css";

export function ThreadCleanupPopover({
  tasks,
  selectedThreadId,
  protectedThreadIds,
  disabled,
  onDeleteThread,
  onCleanupAll,
  ageDays = THREAD_CLEANUP_AGE_DAYS,
  reduceMotion = false
}) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [anchor, setAnchor] = useState({ left: 260, top: 128 });
  const [checkedAt, setCheckedAt] = useState(Date.now);
  const candidates = useMemo(() => getCleanupCandidates({
    tasks,
    selectedThreadId,
    protectedThreadIds,
    ageDays,
    now: checkedAt
  }), [ageDays, checkedAt, protectedThreadIds, selectedThreadId, tasks]);

  useEffect(() => {
    if (!open) return undefined;
    const closeFromKeyboard = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeFromKeyboard);
    return () => window.removeEventListener("keydown", closeFromKeyboard);
  }, [open]);

  const deleteOne = async (threadId) => {
    setBusyId(threadId);
    await onDeleteThread(threadId, { skipConfirm: true });
    setBusyId(null);
  };

  const cleanupAll = async () => {
    if (!candidates.length) return;
    setBusyId("all");
    await onCleanupAll(candidates.map((candidate) => candidate.id));
    setBusyId(null);
  };

  const triggerLabel = candidates.length
    ? `Review ${candidates.length} old thread${candidates.length === 1 ? "" : "s"}`
    : "Review old threads";

  const openCleanup = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const panelWidth = Math.min(390, window.innerWidth - 32);
    setCheckedAt(Date.now());
    setAnchor({
      left: Math.max(16, Math.min(bounds.right + 8, window.innerWidth - panelWidth - 16)),
      top: Math.max(40, bounds.top - 8)
    });
    setOpen(true);
  };

  return (
    <>
      <button
        type="button"
        className={`thread-cleanup-trigger ${styles.trigger}`}
        aria-label={triggerLabel}
        title={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={openCleanup}
      >
        <Trash size={13} />
        {candidates.length > 0 && <span>{candidates.length > 9 ? "9+" : candidates.length}</span>}
      </button>

      {open && (
        <div className={styles.backdrop} data-reduce-motion={reduceMotion} onMouseDown={() => setOpen(false)}>
          <section
            className={styles.panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="thread-cleanup-title"
            style={{ "--cleanup-left": `${anchor.left}px`, "--cleanup-top": `${anchor.top}px` }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className={styles.header}>
              <div className={styles.mark}><Trash size={15} /></div>
              <div>
                <strong id="thread-cleanup-title">Thread cleanup</strong>
                <small>Inactive chats last used {ageDays}+ days ago</small>
              </div>
              <button type="button" className={styles.close} aria-label="Close thread cleanup" onClick={() => setOpen(false)}><X size={14} /></button>
            </header>

            {candidates.length > 0 ? (
              <>
                <p className={styles.summary}>
                  {candidates.length} chat{candidates.length === 1 ? " matches" : "s match"} the cleanup rule. Open, running, and board-linked work stays out of this list.
                </p>
                <div className={styles.list}>
                  {candidates.map((candidate) => (
                    <article className={styles.row} key={candidate.id}>
                      <div className={styles.copy}>
                        <strong>{candidate.title}</strong>
                        <small>{candidate.detail}</small>
                        {candidate.preview && <p>{candidate.preview}</p>}
                      </div>
                      <button
                        type="button"
                        className={styles.delete}
                        aria-label={`Delete ${candidate.title} from cleanup`}
                        title={`Delete ${candidate.title}`}
                        disabled={Boolean(busyId)}
                        onClick={() => void deleteOne(candidate.id)}
                      >
                        {busyId === candidate.id ? <SpinnerGap className={styles.spin} size={14} /> : <Trash size={14} />}
                      </button>
                    </article>
                  ))}
                </div>
                <footer className={styles.footer}>
                  <small>Checked just now</small>
                  <button type="button" disabled={Boolean(busyId)} onClick={() => void cleanupAll()}>
                    {busyId === "all" ? <SpinnerGap className={styles.spin} size={14} /> : <Trash size={14} />}
                    Clean up all
                  </button>
                </footer>
              </>
            ) : (
              <div className={styles.empty}>
                <CheckCircle size={24} />
                <strong>Nothing to clean up</strong>
                <p>No unused chats are older than {ageDays} days.</p>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}

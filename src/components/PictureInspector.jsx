import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowClockwise, X } from "./icons/index.jsx";
import styles from "./PictureInspector.module.css";

function focusableElements(node) {
  if (!node) return [];
  return [...node.querySelectorAll('button:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')];
}

export function PictureInspector({
  source,
  alt,
  generated = false,
  prompt = null,
  onClose,
  onRequestRevision,
  revisionDisabled = false
}) {
  const [comment, setComment] = useState("");
  const [zoomed, setZoomed] = useState(false);
  const [sending, setSending] = useState(false);
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(null);
  const portalTarget = document.querySelector(".pixice-app") ?? document.body;

  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    const dialog = dialogRef.current;
    const modalRoot = dialog?.parentElement;
    const coveredElements = [...portalTarget.children]
      .filter((element) => element !== modalRoot)
      .map((element) => ({ element, inert: element.inert, ariaHidden: element.getAttribute("aria-hidden") }));
    coveredElements.forEach(({ element }) => {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    });
    const target = generated ? dialog?.querySelector("textarea") : dialog?.querySelector("button");
    target?.focus();

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(dialogRef.current);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      coveredElements.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      });
      previousFocusRef.current?.focus?.();
    };
  }, [generated, onClose, portalTarget]);

  const submitRevision = async (event) => {
    event.preventDefault();
    const feedback = comment.trim();
    if (!feedback || !onRequestRevision || sending || revisionDisabled) return;
    setSending(true);
    try {
      const accepted = await onRequestRevision({ comment: feedback, source, prompt });
      if (accepted !== false) onClose();
    } finally {
      setSending(false);
    }
  };

  return createPortal(
    <div className={styles.piBackdrop} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        className={styles.piDialog}
        role="dialog"
        aria-modal="true"
        aria-label={generated ? "Generated picture inspector" : "Picture inspector"}
        data-has-comments={generated}
        ref={dialogRef}
      >
        <header className={styles.piToolbar}>
          <span>
            <strong>{generated ? "Generated picture" : "Picture"}</strong>
            <small>{zoomed ? "Actual size" : "Fit to window"}</small>
          </span>
          <div className={styles.piToolbarActions}>
            <button type="button" onClick={() => setZoomed((value) => !value)}>{zoomed ? "Fit" : "Actual size"}</button>
            <button className={styles.piClose} type="button" aria-label="Close picture inspector" onClick={onClose}><X size={16} /></button>
          </div>
        </header>

        <div className={styles.piStage} data-zoomed={zoomed}>
          <button type="button" aria-label={zoomed ? "Fit picture to window" : "View picture at actual size"} onClick={() => setZoomed((value) => !value)}>
            <img src={source} alt={alt} />
          </button>
        </div>

        {generated && (
          <aside className={styles.piComments}>
            <div className={styles.piCommentsHead}>
              <span className={styles.piCommentsIcon}><ArrowClockwise size={15} /></span>
              <span><strong>Make another version</strong><small>Tell the agent what should change in this picture.</small></span>
            </div>
            <form onSubmit={submitRevision}>
              <textarea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="Make the sky warmer, move the subject left…"
                aria-label="Picture revision comments"
                rows={7}
              />
              <button type="submit" disabled={!comment.trim() || !onRequestRevision || sending || revisionDisabled}>
                <ArrowClockwise size={14} />
                {sending ? "Sending…" : "Generate revision"}
              </button>
            </form>
          </aside>
        )}
      </section>
    </div>,
    portalTarget
  );
}

export function InspectablePicture({
  source,
  alt,
  generated = false,
  prompt = null,
  onRequestRevision,
  revisionDisabled = false,
  buttonClassName,
  imageClassName,
  buttonStyle,
  dataPromptId
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={buttonClassName}
        style={buttonStyle}
        data-prompt-id={dataPromptId}
        type="button"
        aria-label={`Inspect ${alt || "picture"}`}
        onClick={() => setOpen(true)}
      >
        <img className={imageClassName} src={source} alt={alt} />
      </button>
      {open && (
        <PictureInspector
          source={source}
          alt={alt}
          generated={generated}
          prompt={prompt}
          onClose={() => setOpen(false)}
          onRequestRevision={onRequestRevision}
          revisionDisabled={revisionDisabled}
        />
      )}
    </>
  );
}

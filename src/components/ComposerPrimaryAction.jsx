import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { PaperPlaneTilt, SpinnerGap } from './icons/index.jsx';
import './composer-integration.css';

export function ComposerPrimaryAction({ state, label, disabled, reason, pending, onClick, reducedMotion = false }) {
  const systemReducedMotion = useReducedMotion();
  const reduce = reducedMotion || systemReducedMotion;
  return <button type="button" className="icon-button send composer-run-action composer-primary-action"
    data-state={state} aria-label={label} title={reason || label} disabled={disabled} onClick={onClick}>
    <AnimatePresence initial={false} mode="sync">
      <motion.span key={state} className="composer-action-symbol" aria-hidden="true"
        initial={reduce ? false : { opacity: 0, scale: .7, rotate: -18 }}
        animate={{ opacity: 1, scale: 1, rotate: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, scale: .7, rotate: 18 }}
        transition={{ duration: reduce ? 0 : .16 }}>
        {pending ? <SpinnerGap size={17} className={reduce ? '' : 'spin-icon'} /> : state === 'voice' ? <svg width="20" height="20" viewBox="0 0 20 20" fill="none" focusable="false">
          <path d="M3 8v4M6.5 5.5v9M10 3v14M13.5 6v8M17 8v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg> : state === 'stop' ? <i className="composer-stop-symbol" /> : <PaperPlaneTilt size={17} weight="fill" />}
      </motion.span>
    </AnimatePresence>
  </button>;
}

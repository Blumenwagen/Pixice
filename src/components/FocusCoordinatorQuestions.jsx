import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, PencilSimple } from "./icons/index.jsx";
import "./FocusCoordinatorQuestions.css";

const storageKeyFor = (projectId) => `pixice.focusCoordinatorQuestionDrafts.${projectId ?? "none"}`;

function requestKey(request) {
  return `${request?.id ?? "question"}:${request?.requestGeneration ?? "legacy"}`;
}

function readDrafts(storage, projectId) {
  if (!storage || !projectId) return {};
  try {
    const parsed = JSON.parse(storage.getItem(storageKeyFor(projectId)) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function coordinatorCopy(request) {
  const params = request?.params ?? {};
  return {
    reason: params.coordinatorReason ?? params.reason ?? request?.coordinatorReason ?? request?.reason ?? null,
    recommendation: params.coordinatorRecommendation ?? params.recommendation ?? request?.coordinatorRecommendation ?? request?.recommendation ?? null,
    workers: params.workerCount ?? params.memberCount ?? request?.workerCount ?? null,
  };
}

function labelFor(option) {
  return String(option?.label ?? "").replace(/\s*\(recommended\)\s*$/i, "").trim();
}

function isRecommended(option) {
  return option?.recommended === true || /\(recommended\)\s*$/i.test(option?.label ?? "");
}

function receiptKey(receipt) {
  return receipt?.key ?? requestKey(receipt?.request);
}

function receiptFromEvent(event) {
  if (event?.kind !== "question-answered") return null;
  const payload = event.payload && typeof event.payload === "object" ? event.payload : event;
  if (payload.focusCoordinatorQuestion !== true || (payload.wasVisible !== true && payload.userEscalated !== true)) return null;
  const rawRequest = payload.request;
  const request = rawRequest?.params ? rawRequest : {
    id: rawRequest?.id ?? payload.requestId ?? event.requestId ?? event.id,
    requestGeneration: rawRequest?.generation ?? rawRequest?.requestGeneration ?? payload.requestGeneration ?? event.requestGeneration,
    params: { questions: rawRequest?.questions ?? payload.questions ?? event.questions ?? [] }
  };
  const answers = payload.answers ?? event.answers ?? payload.result?.answers ?? event.result?.answers;
  if (!Array.isArray(request.params?.questions) || !answers || typeof answers !== "object") return null;
  return { key: payload.requestKey ?? event.requestKey ?? requestKey(request), request, result: { action: "answer", answers } };
}

function persistableDrafts(requests, drafts) {
  const result = {};
  for (const request of requests) {
    const answers = drafts[requestKey(request)];
    if (!answers) continue;
    const secretIds = new Set();
    (request.params?.questions ?? []).forEach((question, index) => {
      if (question.isSecret) secretIds.add(question.id ?? `question-${index + 1}`);
    });
    const safe = Object.fromEntries(Object.entries(answers).filter(([id]) => !secretIds.has(id)));
    if (Object.keys(safe).length) result[requestKey(request)] = safe;
  }
  return result;
}

function answerText(answer) {
  if (Array.isArray(answer)) return answer.filter((item) => typeof item === "string" && item.trim()).join("\n") || "No answer recorded";
  return typeof answer === "string" && answer.trim() ? answer : "No answer recorded";
}

function redactedReceipt(receipt) {
  const questions = receipt.request?.params?.questions ?? [];
  const answers = { ...(receipt.result?.answers ?? {}) };
  questions.forEach((question, index) => {
    if (question.isSecret) answers[question.id ?? `question-${index + 1}`] = "Answer redacted";
  });
  return { ...receipt, result: { ...receipt.result, answers } };
}

function QuestionReceipt({ receipt }) {
  const request = receipt.request;
  const answers = receipt.result?.answers ?? {};
  if (!request?.params?.questions?.length) return null;
  return (
    <article className="focus-coordinator-question-receipt" aria-label="Answered coordinator question">
      <header><Check size={13} /><span>Coordinator question answered</span></header>
      {request.params.questions.map((question, index) => {
        const id = question.id ?? `question-${index + 1}`;
        return <p key={id}><strong>{question.question ?? question.header ?? `Question ${index + 1}`}</strong><span>{answerText(answers[id])}</span></p>;
      })}
    </article>
  );
}

function QuestionRequest({ request, drafts, onDraftChange, onResolve, onResolved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [customQuestions, setCustomQuestions] = useState({});
  const key = requestKey(request);
  const questions = request?.params?.questions ?? [];
  const answers = drafts[key] ?? {};
  const context = coordinatorCopy(request);

  const update = (questionId, value) => onDraftChange(key, { ...answers, [questionId]: value });
  const complete = async (action) => {
    if (busy || !onResolve) return;
    setBusy(true);
    setError(null);
    try {
      const result = { action, answers: action === "cancel" ? {} : answers };
      const accepted = await onResolve?.(request, result);
      if (accepted === false) {
        setError("The answer was not accepted. Try again.");
        return;
      }
      if (action === "answer") onResolved({ key, request, result });
      onDraftChange(key, null);
    } catch (cause) {
      setError(cause?.message ?? "Could not send the answer.");
    } finally { setBusy(false); }
  };

  const canSubmit = questions.length > 0 && questions.every((question, index) => {
    const answer = String(answers[question.id ?? `question-${index + 1}`] ?? "").trim();
    return Boolean(answer);
  });
  return (
    <article className="focus-coordinator-question" data-request-key={key} aria-label="Coordinator question">
      <header className="focus-coordinator-question-header">
        <span>Coordinator question</span>
        {context.workers && <small>Guides {context.workers} worker{Number(context.workers) === 1 ? "" : "s"}</small>}
      </header>
      {context.reason && <p className="focus-coordinator-question-reason">{context.reason}</p>}
      {context.recommendation && <p className="focus-coordinator-question-recommendation"><strong>Recommendation</strong>{context.recommendation}</p>}
      <div className="focus-coordinator-question-list">
        {questions.map((question, index) => {
          const questionId = question.id ?? `question-${index + 1}`;
          const options = Array.isArray(question.options) ? question.options : [];
          const selected = answers[questionId] ?? "";
          const usesText = !options.length || customQuestions[questionId] === true;
          return <section className="focus-coordinator-question-item" key={questionId}>
            <h3>{question.question ?? question.header ?? `Question ${index + 1}`}</h3>
            {question.coordinatorRecommendation && question.coordinatorRecommendation !== context.recommendation && <p className="focus-coordinator-question-recommendation"><strong>Recommendation</strong>{question.coordinatorRecommendation}</p>}
            {question.header && question.question && <p>{question.header}</p>}
            {options.length > 0 && <div className="focus-coordinator-question-options" role="radiogroup" aria-label={question.question ?? question.header}>
              {options.map((option, optionIndex) => {
                const label = String(option.label ?? "");
                return <button type="button" key={`${label}-${optionIndex}`} role="radio" aria-checked={!customQuestions[questionId] && selected === label} data-recommended={isRecommended(option)} onClick={() => {
                  if (option.isOther) {
                    setCustomQuestions((current) => ({ ...current, [questionId]: true }));
                    update(questionId, "");
                  } else {
                    setCustomQuestions((current) => ({ ...current, [questionId]: false }));
                    update(questionId, label);
                  }
                }} disabled={busy}>
                  <span><strong>{labelFor(option)}</strong>{isRecommended(option) && <em>Recommended</em>}{option.description && <small>{option.description}</small>}</span>
                </button>;
              })}
            </div>}
            {options.length > 0 && !usesText && <button type="button" className="focus-coordinator-question-custom" onClick={() => { setCustomQuestions((current) => ({ ...current, [questionId]: true })); update(questionId, ""); }} disabled={busy}><PencilSimple size={12} />Type a different answer</button>}
            {usesText && <label className="focus-coordinator-question-text"><PencilSimple size={13} /><span className="sr-only">Answer for {question.question ?? question.header}</span><input type={question.isSecret ? "password" : "text"} value={selected} onChange={(event) => update(questionId, event.target.value)} placeholder="Type an answer" disabled={busy} /></label>}
          </section>;
        })}
      </div>
      {error && <p className="focus-coordinator-question-error" role="alert">{error}</p>}
      <footer className="focus-coordinator-question-actions">
        <button type="button" className="answer" onClick={() => void complete("answer")} disabled={busy || !canSubmit || !onResolve}>{busy ? "Sending…" : "Send answer"}</button>
      </footer>
    </article>
  );
}

/**
 * Inline Focus-only questions. `history` accepts `{ key?, request, result }`
 * receipts from the owner if resolved questions should survive remounts.
 */
export function FocusCoordinatorQuestions({ requests = [], onResolve, projectId, storage = null, history = [], api = null }) {
  const [drafts, setDrafts] = useState(() => readDrafts(storage, projectId));
  const [localReceipts, setLocalReceipts] = useState([]);
  const [durableReceipts, setDurableReceipts] = useState([]);
  const scopeRef = useRef(projectId);
  const refreshTimerRef = useRef(null);
  const hasSeenRequestsRef = useRef(false);

  const refreshReceipts = useCallback(async () => {
    if (!api?.focus?.state || !projectId) return;
    const expectedProjectId = projectId;
    try {
      const state = await api.focus.state({ projectId: expectedProjectId });
      if (scopeRef.current !== expectedProjectId) return;
      setDurableReceipts((state?.events ?? []).map(receiptFromEvent).filter(Boolean));
    } catch { /* The inline prompt remains usable while a durable receipt refresh waits. */ }
  }, [api, projectId]);

  useEffect(() => {
    scopeRef.current = projectId;
    setDrafts(readDrafts(storage, projectId));
    setDurableReceipts([]);
    setLocalReceipts([]);
    hasSeenRequestsRef.current = requests.length > 0;
    if (projectId) void refreshReceipts();
    return () => { if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current); };
  }, [projectId, refreshReceipts, storage]);
  useEffect(() => {
    const subscribe = api?.onEvent ?? api?.events?.subscribe;
    if (!subscribe || !projectId) return undefined;
    return subscribe((event) => {
      if (event?.type !== "FocusUpdated" || event?.payload?.projectId !== projectId) return;
      if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = window.setTimeout(() => { refreshTimerRef.current = null; void refreshReceipts(); }, 120);
    });
  }, [api, projectId, refreshReceipts]);
  useEffect(() => {
    if (!storage || !projectId) return;
    if (requests.length > 0) hasSeenRequestsRef.current = true;
    if (!hasSeenRequestsRef.current) return;
    try { storage.setItem(storageKeyFor(projectId), JSON.stringify(persistableDrafts(requests, drafts))); } catch { /* Draft persistence remains optional. */ }
  }, [drafts, projectId, requests, storage]);

  const updateDraft = (key, next) => setDrafts((current) => {
    const updated = { ...current };
    if (next === null) delete updated[key];
    else updated[key] = next;
    return updated;
  });
  const receipts = useMemo(() => {
    const merged = [...history, ...durableReceipts, ...localReceipts];
    return merged.filter((receipt, index) => merged.findIndex((candidate) => receiptKey(candidate) === receiptKey(receipt)) === index);
  }, [durableReceipts, history, localReceipts]);
  const resolvedKeys = new Set(receipts.map(receiptKey));
  const unresolved = requests.filter((request) => Array.isArray(request?.params?.questions) && request.params.questions.length && !resolvedKeys.has(requestKey(request)));
  if (!unresolved.length && !receipts.length) return null;

  return (
    <section className="focus-coordinator-questions" aria-label="Coordinator questions">
      {receipts.map((receipt) => <QuestionReceipt key={receiptKey(receipt)} receipt={receipt} />)}
      {unresolved.map((request) => <QuestionRequest key={requestKey(request)} request={request} drafts={drafts} onDraftChange={updateDraft} onResolve={onResolve} onResolved={(receipt) => setLocalReceipts((current) => [...current, redactedReceipt(receipt)])} />)}
    </section>
  );
}

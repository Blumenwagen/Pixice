import { useEffect, useRef, useState } from 'react';
import { attentionIdentity } from '../lib/attention-identity.js';

/** Keep the submitted answer in memory until the provider confirms its callback. */
export function useRequestResponse(request, onResolve) {
  const key = attentionIdentity(request);
  const scope = useRef(key);
  const inFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [lastResponse, setLastResponse] = useState(null);
  const [localError, setLocalError] = useState(null);
  useEffect(() => {
    scope.current = key;
    inFlight.current = false;
    setSubmitting(false);
    setLastResponse(null);
    setLocalError(null);
    return () => { scope.current = null; inFlight.current = false; };
  }, [key]);
  const pending = submitting || request?.responseState === 'responding';
  const uncertain = request?.responseState === 'uncertain' || localError?.uncertain === true;
  const submit = async response => {
    if (inFlight.current || request?.responseState === 'responding' || !onResolve) return false;
    const expectedKey = key;
    inFlight.current = true;
    setSubmitting(true);
    setLocalError(null);
    // Snapshot, rather than retaining references to editable form values. This is
    // deliberately ephemeral: answers and secrets are not stored in a receipt.
    const snapshot = typeof response === 'object' && response !== null ? structuredClone(response) : response;
    setLastResponse(snapshot);
    try {
      const result = await onResolve(request, snapshot);
      if (scope.current !== expectedKey) return false;
      if (result === false || result?.resolved === false || result?.accepted === false) {
        if (scope.current === expectedKey) setLocalError({ message: 'The response was not confirmed. Try again.' });
        return false;
      }
      return true;
    } catch (cause) {
      if (scope.current === expectedKey) setLocalError({ message: cause?.message ?? 'Could not send the response.', uncertain: cause?.uncertain === true });
      return false;
    } finally {
      if (scope.current === expectedKey) {
        inFlight.current = false;
        setSubmitting(false);
      }
    }
  };
  return { submit, retry: () => submit(lastResponse), lastResponse, pending, uncertain,
    locked: pending || uncertain && lastResponse !== null,
    canRetry: lastResponse !== null,
    error: request?.responseError ?? localError?.message ?? null };
}

export function RequestResponseStatus({ response, onRetry = response.retry, className = '', errorClassName = className, actionsClassName = "", retryClassName = "" }) {
  if (response.pending) return <p className={className} role="status">Waiting for provider confirmation…</p>;
  if (!response.uncertain && !response.error) return null;
  return <div>
    <p className={errorClassName} role="alert">{response.error ?? 'The response may have been sent. Retry the same response to confirm it.'}</p>
    {response.canRetry && <div className={actionsClassName}><button type="button" className={retryClassName} onClick={onRetry}>Retry response</button></div>}
  </div>;
}

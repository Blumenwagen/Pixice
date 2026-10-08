const RETRY_DELAYS = [500, 1000, 2000];
const TRANSIENT_CODES = new Set([
  "OFFLINE", "NETWORK_ERROR", "HOST_RESTARTED", "REQUEST_ABORTED",
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "BOOTSTRAP_TIMEOUT"
]);

export function isTransientBootstrapError(error) {
  // Authentication, permissions, invalid responses, and corrupt saved data
  // need a deliberate recovery action rather than repeated requests.
  if ([401, 403].includes(error?.status)) return false;
  if (error?.status >= 500) return true;
  if (error?.code) return TRANSIENT_CODES.has(error.code);
  return /offline|timed? out|stream closed|fetch failed|ECONN|not (?:yet )?(?:ready|connected|initialized)|(?:connection|backend|service).*(?:lost|closed|starting|restarting|reconnecting|could not be completed)/i.test(String(error?.message ?? ""));
}

function abortError(signal) {
  return signal.reason ?? new DOMException("Workspace loading was cancelled.", "AbortError");
}

function waitForRetry(delay, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function boundedRead(read, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortError(signal));
    const timer = setTimeout(() => finish(reject, Object.assign(new Error("The workspace did not respond in time."), { code: "BOOTSTRAP_TIMEOUT" })), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => {
      if (signal?.aborted) throw abortError(signal);
      return read();
    }).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

// Bootstrap is a read. Only this read is retried; task starts, steering,
// approvals, and other mutations must never be replayed by startup recovery.
export async function recoverWorkspaceBootstrap(read, { signal, onRetry, retryDelays = RETRY_DELAYS, timeoutMs = 8000 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await boundedRead(read, signal, timeoutMs); }
    catch (error) {
      if (signal?.aborted || !isTransientBootstrapError(error) || attempt >= retryDelays.length) throw error;
      onRetry?.(error);
      await waitForRetry(retryDelays[attempt], signal);
    }
  }
}

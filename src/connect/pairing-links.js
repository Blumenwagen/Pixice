export * from '../../electron/connect/connect-links.mjs';
import { normalizeEndpoint } from '../../electron/connect/protocol.mjs';

export const PAIRING_PROBE_TIMEOUT_MS = 5_000;

export async function probeEndpoint(value, { fetchImpl = globalThis.fetch, timeoutMs = PAIRING_PROBE_TIMEOUT_MS } = {}) {
  const endpoint = normalizeEndpoint(value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(new URL('/api/connect/info', endpoint), {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (cause) {
      throw new Error(cause?.name === 'AbortError' ? 'The endpoint probe timed out. Check the HTTPS address and try again.' : 'The endpoint could not be reached. Check the HTTPS address and try again.');
    }
    let body = {};
    try { body = await response.json(); } catch { /* A plain response gets the same safe UI error below. */ }
    if (!response.ok) throw new Error(body?.error || `The endpoint rejected the probe (${response.status}).`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

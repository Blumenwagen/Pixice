export const attentionProvider = request => request?.provider ?? 'codex';

export function attentionGeneration(request) {
  const value = request?.requestGeneration;
  if (value === undefined || value === null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}

// Provider callbacks may reuse an ID, including across providers. Keep its type
// and the durable global generation in the identity used by React and replies.
export const attentionOwnerKey = request => JSON.stringify([attentionProvider(request), typeof request?.id, request?.id]);
export const attentionIdentity = request => JSON.stringify([attentionOwnerKey(request), attentionGeneration(request) ?? 'legacy']);

const experimentalMethods = new Set([
  "thread/fork",
  "thread/readAncestry",
  "collaboration/children"
]);

export class CapabilityAdapter {
  constructor(capabilities = {}) {
    this.capabilities = capabilities;
  }

  supports(method) {
    if (!experimentalMethods.has(method)) return true;
    return this.capabilities.experimentalApi === true || this.capabilities.methods?.includes(method) === true;
  }

  request(client, method, params) {
    if (!this.supports(method)) throw new Error(`The bundled Codex runtime does not advertise ${method}`);
    return client.request(method, params);
  }
}

export function normalizeCodexEvent(message) {
  const { method, params = {} } = message;
  if (method?.includes("approval") || method?.includes("requestUserInput")) return { type: "AttentionRequired", payload: { source: "codex", method, ...params } };
  if (params.item?.type === "collabToolCall" || method?.includes("collab")) return { type: "AgentUpdated", payload: { method, ...params } };
  if (method?.startsWith("thread/") || method?.startsWith("turn/")) return { type: "TaskUpdated", payload: { method, ...params } };
  return { type: "ActivityReceived", payload: { method, ...params } };
}

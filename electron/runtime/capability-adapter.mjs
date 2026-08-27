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
    if (!this.supports(method)) throw new Error(`The connected Codex app-server does not advertise ${method}`);
    return client.request(method, params);
  }
}

export function normalizeCodexEvent(message) {
  const { method, params = {} } = message;
  // Actionable prompts arrive as JSON-RPC server requests. Notifications with
  // similar names are status updates and must never create a response card.
  if (method?.includes("approval") || method?.includes("requestUserInput")) return { type: "ActivityReceived", payload: { source: "codex", method, ...params } };
  if (["collabToolCall", "collabAgentToolCall", "subAgentActivity"].includes(params.item?.type) || method?.includes("collab")) {
    return { type: "AgentUpdated", payload: { method, ...params } };
  }
  if (method?.startsWith("thread/") || method?.startsWith("turn/")) return { type: "TaskUpdated", payload: { method, ...params } };
  return { type: "ActivityReceived", payload: { method, ...params } };
}

import { createTaskProgressPreviewApi } from "./task-progress-preview.js";
import { listPricingCatalog } from "../electron/usage/pricing.mjs";

// Development-only fixtures. No provider requests, project writes, or model usage.
export async function createTaskResultsPreviewApi() {
  const api = createTaskProgressPreviewApi();
  const bootstrap = await api.app.bootstrap();
  const project = { ...bootstrap.projects[0], displayName: "Pixice · feature preview" };
  const models = [{ id: "codex:gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6 Astra", provider: "codex", isDefault: true,
    defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }], serviceTiers: [{ id: "priority" }] },
  { id: "claude:sonnet", model: "sonnet", provider: "claude", displayName: "Claude Sonnet", supportedReasoningEfforts: [] }];
  const receipt = { threadId: "preview-task", projectId: project.id, groupId: "preview-task", projectName: project.displayName,
    revision: "demo-1", title: "Refactor authentication flow", prompt: "Replace local-storage sessions with secure cookies, preserve sign-in, and test session expiry.",
    promptCount: 1, model: "codex:gpt-6-astra", status: "completed", startedAt: new Date(Date.now() - 150_000).toISOString(),
    completedAt: new Date().toISOString(), durationMs: 142_000,
    summary: "Demo result: cookie-backed sessions now survive refresh, expire correctly, and clear on sign-out. The sign-in screen keeps its existing behavior.",
    usage: { tokens: 34_210, costUsd: .426, events: 8, unpricedEvents: 0 },
    checks: [{ id: "demo-check", command: "pnpm test -- session", status: "passed", exitCode: 0, output: "Demo output: 18 tests passed." }],
    unresolved: [], changes: { files: [{ path: "src/auth/session.ts", root: "/work/pixice", plus: 42, minus: 16 }, { path: "tests/session.test.ts", root: "/work/pixice", plus: 68, minus: 4 }], fileCount: 2, patch: "diff --git a/src/auth/session.ts b/src/auth/session.ts\n--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -1 +1 @@\n-useLocalStorageSession()\n+useCookieSession()\ndiff --git a/tests/session.test.ts b/tests/session.test.ts\n--- a/tests/session.test.ts\n+++ b/tests/session.test.ts\n@@ -1 +1 @@\n-testLocalStorage()\n+testCookieExpiry()\n" },
    replayAvailable: true, remainingReplayTurns: 0 };
  let receipts = [receipt, { ...receipt, threadId: "preview-blocked", groupId: "preview-blocked", title: "Check payment retries", status: "failed", model: "claude:sonnet",
    summary: "Demo result: the retry test failed on a duplicate payment response.", checks: [{ id: "payment-check", command: "pnpm test -- payments", status: "failed", exitCode: 1, output: "Demo output: expected one request, received two." }], error: "A duplicate payment response still needs handling." }];
  const listeners = new Set();
  const originalSubscribe = api.events.subscribe;
  api.events.subscribe = (listener) => { listeners.add(listener); const unsubscribe = originalSubscribe(listener); return () => { listeners.delete(listener); unsubscribe(); }; };
  const emit = () => listeners.forEach((listener) => listener({ type: "TaskReceiptUpdated", payload: {} }));
  api.app.bootstrap = async () => ({ ...bootstrap, projects: [project], models });
  api.models.list = async () => models;
  const originalRead = api.threads.read;
  api.threads.read = async (payload) => {
    const result = await originalRead(payload);
    return { ...result, thread: { ...result.thread, status: { type: "idle" }, turns: result.thread.id === "preview-task" ? [{ id: "demo-result-turn", status: "completed", items: [
      { id: "demo-prompt", type: "userMessage", content: [{ type: "text", text: receipt.prompt }] },
      { id: "demo-answer", type: "agentMessage", phase: "final_answer", text: receipt.summary }
    ] }] : result.thread.turns.map((turn) => ({ ...turn, status: "completed" })) } };
  };
  api.tasks = {
    receipts: async () => receipts,
    receipt: async ({ threadId }) => receipts.find((item) => item.threadId === threadId) ?? null,
    interventions: async () => ({ requests: [], receipts }),
    replay: async ({ model }) => {
      const replay = { ...receipt, threadId: `demo-replay-${receipts.length}`, title: "Demo replay · authentication", model,
        sourceThreadId: receipt.threadId, usage: { ...receipt.usage, costUsd: .288, tokens: 27_500 }, durationMs: 105_000, startedAt: new Date().toISOString() };
      receipts = [...receipts, replay]; emit(); return { project, thread: { id: replay.threadId }, receipt: replay };
    }
  };
  api.usage = {
    limits: async () => ({ status: "unavailable", providers: [], message: "Development preview — no account usage is read." }),
    summary: async () => ({ stats: { allTimeTokens: 61_710, allTimeCostUsd: .714, currentMonthCostUsd: .714 }, selected: { events: 16, unpricedEvents: 0, totalTokens: 61_710 }, daily: [], heatmapDaily: [], models: [], pricing: listPricingCatalog() })
  };
  return api;
}

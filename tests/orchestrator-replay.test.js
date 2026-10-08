import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionJournal } from "../electron/runtime/execution-journal.mjs";
import { ProviderReplayTransport } from "./helpers/provider-replay.js";
import fixture from "./fixtures/orchestrator-replay/provider.json";

const cleanups = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function setup(name) {
  const db = new DatabaseSync(":memory:");
  const journal = new ExecutionJournal({ database: { db } });
  const transport = new ProviderReplayTransport(fixture[name]);
  cleanups.push(() => db.close(), () => transport.close());
  transport.client.on("notification", ({ method, params }) => {
    if (method === "turn/started") journal.observeStarted(params.threadId, params.turn.id);
    if (method === "turn/completed") journal.observeCompleted(params.threadId, params.turn);
  });
  return { db, journal, transport };
}
async function dispatch(journal, client, commandId) {
  const receipt = journal.accept({ commandId, threadId: "thread-1" });
  if (receipt.duplicate) return receipt.record;
  const claimed = journal.beforeDispatch(commandId);
  if (!claimed) throw new Error("Request is held for recovery.");
  try {
    const result = await client.request("turn/start", { threadId: "thread-1" }, 1_000);
    return journal.started(commandId, result.turn.id);
  } catch (error) {
    journal.failed(commandId, error, { uncertain: true });
    throw error;
  }
}

describe("Orchestrator provider transcript replay", () => {
  it("retains terminal state when provider notifications beat the start RPC response", async () => {
    const { journal, transport } = setup("terminalBeforeStartResponse");
    expect(await dispatch(journal, transport.client, "prompt-1")).toMatchObject({ status: "completed", turnId: "turn-1" });
    expect(await dispatch(journal, transport.client, "prompt-1")).toMatchObject({ status: "completed" });
    expect(transport.requests).toHaveLength(1);
    transport.assertComplete();
  });

  it("ignores late raw notifications for an older turn during a subsequent dispatch", async () => {
    const { journal, transport } = setup("lateCompletionDuringNextStart");
    await dispatch(journal, transport.client, "prompt-old");
    await dispatch(journal, transport.client, "prompt-new");
    expect(journal.getActive("thread-1")).toMatchObject({ commandId: "prompt-new", turnId: "turn-new", status: "running" });
    expect(journal.get("prompt-old").status).toBe("completed");
    transport.assertComplete();
  });

  it("holds a dropped response durably and never replays the original provider start", async () => {
    const { db, journal, transport } = setup("lostStartResponse");
    await expect(dispatch(journal, transport.client, "lost-prompt")).rejects.toThrow("stream closed");
    const recovered = new ExecutionJournal({ database: { db } });
    expect(await dispatch(recovered, transport.client, "lost-prompt")).toMatchObject({ status: "uncertain", turnId: null });
    expect(transport.requests).toHaveLength(1);
    transport.assertComplete();
  });

  it("uses the persisted exact turn across raw provider restart reads instead of the latest turn", async () => {
    const { db, journal, transport } = setup("recoverExactTurn");
    journal.accept({ commandId: "prompt-1", threadId: "thread-1" });
    journal.beforeDispatch("prompt-1");
    journal.started("prompt-1", "turn-1");
    const recovered = new ExecutionJournal({ database: { db } });
    const readThread = (threadId) => transport.client.request("thread/read", { threadId, includeTurns: true }, 1_000);
    await recovered.reconcile({ readThread });
    expect(recovered.get("prompt-1")).toMatchObject({ status: "running", turnId: "turn-1" });
    await recovered.reconcile({ readThread });
    expect(recovered.get("prompt-1")).toMatchObject({ status: "completed", turnId: "turn-1" });
    expect(transport.requests.map((request) => request.method)).toEqual(["thread/read", "thread/read"]);
    transport.assertComplete();
  });
});

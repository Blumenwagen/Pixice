// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeCodexEvent } from "../electron/runtime/capability-adapter.mjs";
import { ExecutionJournal } from "../electron/runtime/execution-journal.mjs";
import { RequestResponseDelivery } from "../electron/runtime/request-response-delivery.mjs";
import { RecordedProviderReplayTransport } from "./helpers/recorded-provider-replay.js";

const capture = readFileSync(new URL("./fixtures/orchestrator-replay/codex-recorded-approval.ndjson", import.meta.url), "utf8")
  .trim().split("\n").map(JSON.parse);
const startFrame = capture.find(record => record.type === "expect_outbound" && record.frame.method === "turn/start").frame;
const cleanups = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function connect(db, records = capture) {
  const journal = new ExecutionJournal({ database: { db } });
  const transport = new RecordedProviderReplayTransport(records);
  const events = [];
  const requests = [];
  const delivery = new RequestResponseDelivery({ database: { db }, timeoutMs: 1_000,
    respond: (id, result) => transport.client.respond(id, result) });
  cleanups.push(() => transport.close(), () => delivery.dispose());
  transport.client.on("server-request", request => {
    const pending = { request: { ...request, provider: "codex" }, generation: delivery.nextGeneration() };
    requests.push(pending);
    delivery.register(pending);
  });
  transport.client.on("notification", frame => {
    // This is the production Codex event boundary used by CodexRuntime.
    const event = normalizeCodexEvent(frame);
    events.push(event);
    const payload = event.payload;
    if (payload.method === "turn/started") journal.observeStarted(payload.threadId, payload.turn.id);
    if (payload.method === "serverRequest/resolved") delivery.confirm(payload.requestId, { provider: "codex", threadId: payload.threadId });
    if (payload.method === "turn/completed") {
      journal.observeCompleted(payload.threadId, payload.turn);
      delivery.terminal(payload.threadId, payload.turn.id);
    }
  });
  return { journal, transport, events, requests, delivery };
}

async function start(harness) {
  const { journal, transport } = harness;
  journal.accept({ commandId: "recorded-command", threadId: startFrame.params.threadId });
  expect(journal.beforeDispatch("recorded-command").status).toBe("dispatching");
  const response = transport.client.request(startFrame.method, startFrame.params, 1_000);
  transport.advance();
  const { turn } = await response;
  journal.started("recorded-command", turn.id);
  return turn;
}

describe("sanitized recorded native Codex transcript replay", () => {
  it("replays raw approval, confirmation and terminal frames through production transport, normalization and SQLite receipts", async () => {
    const db = new DatabaseSync(":memory:");
    cleanups.push(() => db.close());
    const harness = connect(db);
    const turn = await start(harness);
    const { journal, transport, requests, delivery, events } = harness;
    expect(capture[0]).toMatchObject({ protocol: "codex.app-server", version: "0.156.1", metadata: {
      source: "record-codex-app-server-replay-fixture", provenance: { commit: "30cc788975500a8c00d32a50f348174d1ce578d1" }
    } });
    expect(transport.outbound[0].id).toBe(1); // Capture ID3 was correlated to this client's ID1.
    expect(journal.get("recorded-command")).toMatchObject({ status: "running", turnId: turn.id });
    expect(requests).toHaveLength(1);
    const pending = requests[0];
    expect(pending.request).toMatchObject({ id: 0, method: "item/commandExecution/requestApproval", params: {
      threadId: "recorded-thread", turnId: "recorded-turn", itemId: "recorded-command-item", availableDecisions: expect.arrayContaining(["accept", "cancel"])
    } });
    const answer = delivery.send(pending, { decision: "accept" });
    await tick();
    // The captured provider confirmation is held, even though JsonlClient's
    // native Writable callback already succeeded.
    expect(transport.outbound[1]).toMatchObject({ id: 0, result: { decision: "accept" } });
    expect(delivery.state(pending.generation).state).toBe("responding");
    expect(journal.get("recorded-command").status).toBe("running");
    transport.advance();
    await expect(answer).resolves.toMatchObject({ resolved: true });
    transport.assertComplete();
    expect(delivery.state(pending.generation).state).toBe("resolved");
    expect(journal.get("recorded-command")).toMatchObject({ status: "completed", turnId: "recorded-turn" });
    expect(journal.events("recorded-command").map(event => event.type)).toEqual(["accepted", "dispatching", "provider-started", "provider-terminal"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "ActivityReceived", payload: expect.objectContaining({
      method: "item/agentMessage/delta", delta: "Sanitized ", itemId: "recorded-answer-item"
    }) }));
    expect(events.at(-1)).toMatchObject({ type: "TaskUpdated", payload: { method: "turn/completed", turn: {
      id: "recorded-turn", status: "completed", items: [{ text: "Sanitized recorded answer.", phase: "final_answer" }]
    } } });
  });

  it("uses captured terminal facts to settle a reopened exact turn without repeating a paid dispatch", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-recorded-replay-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, "receipts.sqlite");
    const firstDb = new DatabaseSync(filename);
    let firstOpen = true;
    cleanups.push(() => { if (firstOpen) firstDb.close(); });
    const first = connect(firstDb);
    await start(first);
    const pending = first.requests[0];
    // Fault injection is local: process memory disappears after the recorded
    // start, while the actual captured native terminal frame stays unchanged.
    first.delivery.pending.clear();
    first.transport.close();
    firstDb.close();
    firstOpen = false;
    const secondDb = new DatabaseSync(filename);
    cleanups.push(() => secondDb.close());
    const terminal = capture.filter(record => record.frame?.method === "turn/completed");
    const recovered = connect(secondDb, terminal);
    expect(recovered.journal.get("recorded-command")).toMatchObject({ status: "uncertain", turnId: "recorded-turn" });
    expect(recovered.delivery.state(pending.generation).state).toBe("unavailable");
    recovered.transport.advance();
    recovered.transport.assertComplete();
    expect(recovered.transport.outbound).toHaveLength(0);
    expect(recovered.journal.get("recorded-command")).toMatchObject({ status: "completed", turnId: "recorded-turn" });
    expect(recovered.journal.accept({ commandId: "recorded-command", threadId: "recorded-thread" })).toMatchObject({ duplicate: true, status: "completed" });
    expect(recovered.journal.beforeDispatch("recorded-command")).toBeNull();
  });
});

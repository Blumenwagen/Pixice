import { buildCodexUserInput } from "./user-input.mjs";
import { BridgeJobStore } from "../persistence/bridge-job-store.mjs";

export function bridgeContinuationPrompt({ childThreadId, status, answer, error, deliveryId }) {
  const result = String(answer || error || `Bridge thread ${status || "completed"}`).trim();
  return [
    "[Pixice bridge completion]",
    ...(deliveryId ? [`[Pixice delivery: ${deliveryId}]`] : []),
    `Child thread: ${childThreadId}`,
    `Status: ${status || "completed"}`,
    "The child finished after the turn that spawned it was no longer active. Continue the original task using the result below. Do not merely acknowledge this message.",
    "",
    result
  ].join("\n");
}

export class BridgeParentContinuation {
  constructor({ activeTurnId, startTurn, steerTurn, onError, jobStore, database }) {
    this.activeTurnId = activeTurnId;
    this.startTurn = startTurn;
    this.steerTurn = steerTurn;
    this.onError = onError;
    this.jobStore = jobStore ?? (database ? new BridgeJobStore(database) : null);
    this.delivered = new Set();
    this.parentQueues = new Map();
  }

  notify(completion) {
    const key = completion.deliveryId ?? `${completion.parentThreadId}\u0000${completion.childThreadId}`;
    const durable = completion.deliveryId && this.jobStore?.getDelivery(completion.deliveryId);
    if (durable && durable.state !== "pending") return Promise.resolve({ action: durable.state });
    if (this.delivered.has(key)) return Promise.resolve({ action: "duplicate" });

    const previous = this.parentQueues.get(completion.parentThreadId) ?? Promise.resolve();
    const delivery = previous
      .catch(() => {})
      .then(() => this.#deliver(completion))
      .then((result) => {
        if (["started", "steered"].includes(result.action)) this.delivered.add(key);
        return result;
      })
      .catch((error) => {
        this.delivered.delete(key);
        this.onError?.(error, completion);
        return { action: "failed", error };
      });
    this.parentQueues.set(completion.parentThreadId, delivery);
    void delivery.finally(() => {
      if (this.parentQueues.get(completion.parentThreadId) === delivery) {
        this.parentQueues.delete(completion.parentThreadId);
      }
    });
    return delivery;
  }

  async #deliver(completion) {
    const prompt = bridgeContinuationPrompt(completion);
    let activeTurnId = this.activeTurnId(completion.parentThreadId);
    if (activeTurnId && completion.blocking !== false &&
      (!completion.parentTurnId || activeTurnId === completion.parentTurnId)) {
      // The active spawning turn may still be waiting for its tool result.
      // Only serverRequest/resolved may acknowledge it. Leave the mailbox
      // pending so a later parent settlement/restart can deliver the result.
      return { action: "awaiting-tool-resolution", turnId: activeTurnId };
    }
    const store = completion.deliveryId && this.jobStore;
    if (store && !store.claimDelivery(completion.deliveryId)) return { action: "duplicate" };
    const meta = completion.deliveryId ? { deliveryId: completion.deliveryId, jobId: completion.jobId } : null;
    const call = async (action, turnId = null) => {
      try {
        const input = buildCodexUserInput(prompt, []);
        const turn = action === "steered"
          ? await this.steerTurn(completion.parentThreadId, turnId, input, ...(meta ? [meta] : []))
          : await this.startTurn(completion.parentThreadId, input, ...(meta ? [meta] : []));
        const acceptedTurnId = turnId ?? turn?.id ?? turn?.turn?.id ?? null;
        store?.setDelivery(completion.deliveryId, { state: "delivered", targetTurnId: acceptedTurnId });
        return { action, turnId: acceptedTurnId };
      } catch (error) {
        const rejected = error?.executionDisposition === "rejected" || error?.providerRejected === true;
        store?.setDelivery(completion.deliveryId, { state: rejected ? "pending" : "uncertain", error: error.message });
        throw error;
      }
    };

    if (activeTurnId) {
      try {
        return await call("steered", activeTurnId);
      } catch (error) {
        const currentTurnId = this.activeTurnId(completion.parentThreadId);
        if (store || (currentTurnId && currentTurnId === activeTurnId)) throw error;
        activeTurnId = currentTurnId;
      }
    }

    if (activeTurnId) {
      return call("steered", activeTurnId);
    }

    try {
      return await call("started");
    } catch (error) {
      const currentTurnId = this.activeTurnId(completion.parentThreadId);
      if (store || !currentTurnId || currentTurnId === completion.parentTurnId) throw error;
      await this.steerTurn(completion.parentThreadId, currentTurnId, buildCodexUserInput(prompt, []));
      return { action: "steered", turnId: currentTurnId };
    }
  }
}

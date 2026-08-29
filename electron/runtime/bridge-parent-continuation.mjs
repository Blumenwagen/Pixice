import { buildCodexUserInput } from "./user-input.mjs";

export function bridgeContinuationPrompt({ childThreadId, status, answer, error }) {
  const result = String(answer || error || `Bridge thread ${status || "completed"}`).trim();
  return [
    "[Pixice bridge completion]",
    `Child thread: ${childThreadId}`,
    `Status: ${status || "completed"}`,
    "The child finished after the turn that spawned it was no longer active. Continue the original task using the result below. Do not merely acknowledge this message.",
    "",
    result
  ].join("\n");
}

export class BridgeParentContinuation {
  constructor({ activeTurnId, startTurn, steerTurn, onError }) {
    this.activeTurnId = activeTurnId;
    this.startTurn = startTurn;
    this.steerTurn = steerTurn;
    this.onError = onError;
    this.delivered = new Set();
    this.parentQueues = new Map();
  }

  notify(completion) {
    const key = `${completion.parentThreadId}\u0000${completion.childThreadId}`;
    if (this.delivered.has(key)) return Promise.resolve({ action: "duplicate" });
    this.delivered.add(key);

    const previous = this.parentQueues.get(completion.parentThreadId) ?? Promise.resolve();
    const delivery = previous
      .catch(() => {})
      .then(() => this.#deliver(completion))
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
    if (activeTurnId && (!completion.parentTurnId || activeTurnId === completion.parentTurnId)) {
      return { action: "same-turn", turnId: activeTurnId };
    }

    if (activeTurnId) {
      try {
        await this.steerTurn(completion.parentThreadId, activeTurnId, buildCodexUserInput(prompt, []));
        return { action: "steered", turnId: activeTurnId };
      } catch (error) {
        const currentTurnId = this.activeTurnId(completion.parentThreadId);
        if (currentTurnId && currentTurnId === activeTurnId) throw error;
        activeTurnId = currentTurnId;
      }
    }

    if (activeTurnId) {
      await this.steerTurn(completion.parentThreadId, activeTurnId, buildCodexUserInput(prompt, []));
      return { action: "steered", turnId: activeTurnId };
    }

    try {
      const turn = await this.startTurn(completion.parentThreadId, buildCodexUserInput(prompt, []));
      return { action: "started", turnId: turn?.id ?? turn?.turn?.id ?? null };
    } catch (error) {
      const currentTurnId = this.activeTurnId(completion.parentThreadId);
      if (!currentTurnId || currentTurnId === completion.parentTurnId) throw error;
      await this.steerTurn(completion.parentThreadId, currentTurnId, buildCodexUserInput(prompt, []));
      return { action: "steered", turnId: currentTurnId };
    }
  }
}

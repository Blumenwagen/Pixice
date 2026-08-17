import { EventEmitter } from "node:events";
import readline from "node:readline";

export class JsonlClient extends EventEmitter {
  #nextId = 1;
  #pending = new Map();
  #input;

  constructor({ input, output }) {
    super();
    this.#input = input;
    const lines = readline.createInterface({ input: output, crlfDelay: Infinity });
    lines.on("line", (line) => this.#receive(line));
    lines.on("close", () => this.#rejectPending(new Error("Codex app-server stream closed")));
  }

  request(method, params = {}, timeoutMs = 30_000) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timeout, method });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params = {}) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  respond(id, result) {
    this.#send({ jsonrpc: "2.0", id, result });
  }

  #send(message) {
    this.#input.write(`${JSON.stringify(message)}\n`);
  }

  #receive(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit("protocol-error", { error, line });
      return;
    }

    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "App-server request failed"));
      else pending.resolve(message.result);
      return;
    }

    if (Object.hasOwn(message, "id") && message.method) {
      this.emit("server-request", message);
      return;
    }

    if (message.method) this.emit("notification", message);
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

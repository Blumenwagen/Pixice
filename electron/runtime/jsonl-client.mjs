import { EventEmitter } from "node:events";
import readline from "node:readline";

export class JsonlClient extends EventEmitter {
  #nextId = 1;
  #pending = new Map();
  #input;
  #closed = false;

  constructor({ input, output }) {
    super();
    this.#input = input;
    input.on("error", (error) => this.#rejectPending(error));
    const lines = readline.createInterface({ input: output, crlfDelay: Infinity });
    lines.on("line", (line) => this.#receive(line));
    lines.on("close", () => {
      this.#closed = true;
      this.#rejectPending(new Error("Codex app-server stream closed"));
    });
  }

  request(method, params = {}, timeoutMs = 30_000) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timeout, method });
      this.#send({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.#pending.delete(id);
        pending.reject(error);
      });
    });
  }

  notify(method, params = {}) {
    return this.#send({ jsonrpc: "2.0", method, params }).catch((error) => {
      this.emit("protocol-error", { error });
    });
  }

  respond(id, result) {
    return this.#send({ jsonrpc: "2.0", id, result });
  }

  #send(message) {
    return new Promise((resolve, reject) => {
      if (this.#closed || this.#input.destroyed || this.#input.writableEnded) { reject(new Error("The provider response stream is closed")); return; }
      try {
        this.#input.write(`${JSON.stringify(message)}\n`, error => error ? reject(error) : resolve({ written: true, resolved: false }));
      } catch (error) { reject(error); }
    });
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

    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.emit("protocol-error", { error: new Error("JSON-RPC message must be an object"), line });
      return;
    }

    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message ?? "App-server request failed"), { code: message.error.code, data: message.error.data }));
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

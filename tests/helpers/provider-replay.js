import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import { JsonlClient } from "../../electron/runtime/jsonl-client.mjs";

// Like T3 V2 ReplayTranscriptNdjson, fixtures sit below provider methods: real
// JSONL framing, correlation, notifications and stream loss remain exercised.
export class ProviderReplayTransport {
  constructor(steps) {
    this.steps = steps;
    this.requests = [];
    this.index = 0;
    this.input = new PassThrough();
    this.output = new PassThrough();
    this.client = new JsonlClient({ input: this.input, output: this.output });
    let partial = "";
    this.input.on("data", (chunk) => {
      partial += chunk.toString();
      let boundary;
      while ((boundary = partial.indexOf("\n")) >= 0) {
        const line = partial.slice(0, boundary);
        partial = partial.slice(boundary + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        this.requests.push(request);
        const step = this.steps[this.index++];
        try {
          assert.ok(step, `Unexpected provider request: ${request.method}`);
          assert.equal(request.method, step.request.method);
          assert.deepEqual(request.params, step.request.params);
          for (const frame of step.frames ?? []) {
            this.output.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame, ...(frame.id === "$request" ? { id: request.id } : {}) })}\n`);
          }
          if (step.close) this.output.end();
        } catch (error) {
          this.error = error;
          this.output.end();
        }
      }
    });
  }

  assertComplete() {
    if (this.error) throw this.error;
    assert.equal(this.index, this.steps.length, "All raw provider transcript steps must be consumed.");
  }

  close() { this.output.end(); this.input.end(); }
}

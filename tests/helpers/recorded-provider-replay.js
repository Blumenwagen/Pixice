import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { JsonlClient } from "../../electron/runtime/jsonl-client.mjs";

// T3 V2 ReplayTranscriptNdjson is the reference. Keep native transcript frames
// below production framing/correlation; this helper never calls a provider.
export class RecordedProviderReplayTransport {
  constructor(records, { fragmentBytes = 37 } = {}) {
    this.records = records.filter(record => ["expect_outbound", "emit_inbound"].includes(record.type));
    assert.ok(this.records.length <= 128, "Recorded replay exceeds its frame budget.");
    assert.ok(Number.isInteger(fragmentBytes) && fragmentBytes > 0, "Fragment size must be a positive byte count.");
    this.index = 0;
    this.outbound = [];
    this.rpcIds = new Map();
    this.input = new PassThrough();
    this.output = new PassThrough();
    this.client = new JsonlClient({ input: this.input, output: this.output });
    this.fragmentBytes = fragmentBytes;
    let partial = "";
    this.input.on("data", chunk => {
      partial += chunk.toString();
      let boundary;
      while ((boundary = partial.indexOf("\n")) !== -1) {
        const line = partial.slice(0, boundary);
        partial = partial.slice(boundary + 1);
        if (!line.trim()) continue;
        try {
          const actual = JSON.parse(line);
          this.outbound.push(actual);
          const step = this.records[this.index];
          assert.equal(step?.type, "expect_outbound", `Unexpected outbound frame at replay index ${this.index}.`);
          const expected = structuredClone(step.frame);
          // Native RPC request IDs belong to each client process. Server-request
          // response IDs remain exactly those captured in the inbound request.
          if (expected.method && Object.hasOwn(expected, "id")) {
            this.rpcIds.set(expected.id, actual.id);
            expected.id = actual.id;
          }
          const { jsonrpc, ...body } = actual;
          assert.equal(jsonrpc, "2.0");
          assert.deepEqual(body, expected);
          this.index++;
        } catch (error) {
          this.error = error;
          this.output.end();
        }
      }
    });
  }

  // Explicit advance lets tests observe a successful transport write before
  // releasing the recorded provider confirmation. Timings remain deterministic.
  advance() {
    if (this.error) throw this.error;
    while (this.records[this.index]?.type === "emit_inbound") {
      const frame = structuredClone(this.records[this.index++].frame);
      if (Object.hasOwn(frame, "id") && !frame.method && this.rpcIds.has(frame.id)) frame.id = this.rpcIds.get(frame.id);
      const wire = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
      for (let start = 0; start < wire.length; start += this.fragmentBytes) this.output.write(wire.subarray(start, start + this.fragmentBytes));
    }
    return this.records[this.index] ?? null;
  }

  assertComplete() {
    if (this.error) throw this.error;
    assert.equal(this.index, this.records.length, "Every retained recorded frame must be consumed.");
  }

  close() { this.output.end(); this.input.end(); }
}

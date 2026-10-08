import { describe, expect, it } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { JsonlClient } from "../electron/runtime/jsonl-client.mjs";

describe("JsonlClient", () => {
  it("response writes confirm transport only, preserving native request id type", async () => {
    const input = new PassThrough(), output = new PassThrough();
    const client = new JsonlClient({ input, output });
    const written = new Promise(resolve => input.once("data", resolve));
    await expect(client.respond("request-1", { decision: "accept" })).resolves.toEqual({ written: true, resolved: false });
    expect(JSON.parse((await written).toString())).toEqual({ jsonrpc: "2.0", id: "request-1", result: { decision: "accept" } });
    output.end();
  });

  it("response writes reject asynchronously failed writable streams without an uncaught stream error", async () => {
    const input = new Writable({ write(chunk, encoding, callback) { callback(new Error("Broken pipe")); } });
    const output = new PassThrough();
    const client = new JsonlClient({ input, output });
    await expect(client.respond(12, {})).rejects.toThrow("Broken pipe");
    output.end();
  });

  it("respond and request reject after the provider closes, without lingering RPC timeouts", async () => {
    const input = new PassThrough(), output = new PassThrough();
    const client = new JsonlClient({ input, output });
    output.end();
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(client.respond(1, {})).rejects.toThrow("stream is closed");
    await expect(client.request("model/list", {})).rejects.toThrow("stream is closed");
  });

  it("rejects an ended writable response stream before reporting any acknowledgement", async () => {
    const input = new PassThrough(), output = new PassThrough();
    const client = new JsonlClient({ input, output });
    input.end();
    await expect(client.respond(1, {})).rejects.toThrow("stream is closed");
    output.end();
  });

  it("rejects outgoing RPC write errors immediately instead of waiting for its response timeout", async () => {
    const input = new Writable({ write(chunk, encoding, callback) { callback(new Error("RPC write failed")); } });
    const output = new PassThrough();
    const client = new JsonlClient({ input, output });
    await expect(client.request("turn/start", {})).rejects.toThrow("RPC write failed");
    output.end();
  });
  it("frames JSONL and correlates responses", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonlClient({ input, output });
    const written = new Promise((resolve) => input.once("data", resolve));
    const pending = client.request("model/list", {});
    const request = JSON.parse((await written).toString());
    expect(request.method).toBe("model/list");
    output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { data: ["gpt-5"] } })}\n`);
    await expect(pending).resolves.toEqual({ data: ["gpt-5"] });
  });

  it("surfaces malformed JSON as a recoverable protocol error", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonlClient({ input, output });
    const error = new Promise((resolve) => client.once("protocol-error", resolve));
    output.write("not json\n");
    await expect(error).resolves.toMatchObject({ line: "not json" });
  });

  it("rejects valid JSON primitives without crashing the stream", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonlClient({ input, output });
    const error = new Promise((resolve) => client.once("protocol-error", resolve));
    output.write("null\n");
    await expect(error).resolves.toMatchObject({
      line: "null",
      error: expect.objectContaining({ message: "JSON-RPC message must be an object" })
    });
  });
});

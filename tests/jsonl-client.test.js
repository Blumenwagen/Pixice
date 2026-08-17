import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { JsonlClient } from "../electron/runtime/jsonl-client.mjs";

describe("JsonlClient", () => {
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
});

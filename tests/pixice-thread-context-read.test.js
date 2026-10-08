import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PixiceBridge, PIXICE_BRIDGE_MCP_TOOLS, pixiceBridgeDynamicTools, pixiceBridgeToolShapes } from "../electron/runtime/pixice-bridge.mjs";

const message = (id, type, text) => type === "userMessage"
  ? { id, type, content: [{ type: "text", text }] }
  : { id, type, text };
const sampleThread = (provider = "codex") => ({ id: "reference", provider, status: { type: "idle" }, name: "Source conversation",
  turns: [1, 2, 3].map(index => ({ id: `turn-${index}`, status: "completed", items: [
    message(`user-${index}`, "userMessage", `Question ${index}`),
    message(`assistant-${index}`, "agentMessage", `Answer ${index}`)
  ] })) });

function fixture({ thread = sampleThread(), references = ["reference"], owners = { caller: "project", reference: "project" } } = {}) {
  const runtime = new EventEmitter();
  runtime.request = vi.fn(async () => ({ thread }));
  const referencedThreadIds = vi.fn(() => references);
  const resolveThreadProjectId = vi.fn(id => owners[id] ?? null);
  const onActivity = vi.fn();
  const bridge = new PixiceBridge({ runtime, database: {}, threadContext: () => null, dynamicTools: () => [],
    referencedThreadIds, resolveThreadProjectId, onActivity });
  const read = async args => bridge.handleToolCall({ threadId: "caller", turnId: "current-turn", tool: "read_thread", arguments: { targetThreadId: "reference", ...args } });
  return { runtime, bridge, read, referencedThreadIds, resolveThreadProjectId, onActivity };
}

const payload = result => JSON.parse(result.contentItems[0].text);

describe("lazy thread context reads", () => {
  it("exposes the same bounded read tool to Codex dynamic tools and Claude MCP", () => {
    const definition = pixiceBridgeDynamicTools[0].tools.find(tool => tool.name === "read_thread");
    expect(definition.inputSchema.required).toEqual(["targetThreadId"]);
    expect(definition.inputSchema.additionalProperties).toBe(false);
    expect(definition.description).toContain("Read-only");
    expect(PIXICE_BRIDGE_MCP_TOOLS.has("mcp__pixice_bridge__read_thread")).toBe(true);
    expect(pixiceBridgeToolShapes.read_thread.targetThreadId.safeParse("reference").success).toBe(true);
    expect(pixiceBridgeToolShapes.read_thread.limit.safeParse(21).success).toBe(false);
  });

  it.each(["codex", "claude"])("reads only the requested %s source after an explicit call", async provider => {
    const { read, runtime, referencedThreadIds, onActivity } = fixture({ thread: sampleThread(provider), references: new Set(["reference", "another-attached-thread"]) });
    expect(runtime.request).not.toHaveBeenCalled();
    const result = await read({});
    expect(result.success).toBe(true);
    expect(payload(result)).toMatchObject({ threadId: "reference", provider, nextCursor: null });
    expect(payload(result).items.map(item => item.text)).toEqual(["Question 1", "Answer 1", "Question 2", "Answer 2", "Question 3", "Answer 3"]);
    expect(runtime.request).toHaveBeenCalledExactlyOnceWith("thread/read", { threadId: "reference", includeTurns: true });
    expect(referencedThreadIds).toHaveBeenCalledWith({ threadId: "caller", turnId: "current-turn" });
    expect(onActivity).not.toHaveBeenCalled();
  });

  it.each([
    { owners: { reference: "project" }, error: "calling thread" },
    { references: [], error: "Attach this thread" },
    { owners: { caller: "project", reference: "foreign" }, error: "unavailable in this project" },
    { owners: { caller: "project" }, error: "unavailable in this project" }
  ])("rejects missing caller, unreferenced, foreign, and unowned targets before history access: $error", async ({ error, ...options }) => {
    const { read, runtime } = fixture(options);
    const result = await read({});
    expect(result.success).toBe(false);
    expect(payload(result).error).toContain(error);
    expect(runtime.request).not.toHaveBeenCalled();
  });

  it("denies reads unless a reference allowlist was explicitly wired", async () => {
    const runtime = new EventEmitter();
    runtime.request = vi.fn();
    const bridge = new PixiceBridge({ runtime, database: {}, threadContext: () => ({ projectId: "project" }), dynamicTools: () => [] });
    const result = await bridge.handleToolCall({ threadId: "caller", tool: "read_thread", arguments: { targetThreadId: "reference" } });
    expect(result.success).toBe(false);
    expect(runtime.request).not.toHaveBeenCalled();
  });

  it("does not use a caller-supplied project to bypass ownership", async () => {
    const { read, runtime } = fixture();
    const result = await read({ projectId: "project" });
    expect(result.success).toBe(false);
    expect(runtime.request).not.toHaveBeenCalled();
  });

  it("rechecks source ownership and current references after the provider read", async () => {
    const first = fixture();
    first.resolveThreadProjectId.mockImplementationOnce(() => "project").mockImplementationOnce(() => "project").mockImplementation(() => "foreign");
    expect(payload(await first.read({})).error).toContain("ownership changed");
    const second = fixture();
    second.referencedThreadIds.mockReturnValueOnce(["reference"]).mockReturnValue([]);
    expect(payload(await second.read({})).error).toContain("no longer attached");
  });

  it.each([{ id: "wrong", turns: [] }, { id: "reference" }])("rejects unavailable or mismatched provider history", async thread => {
    const { read } = fixture({ thread });
    expect(payload(await read({})).error).toContain("history is unavailable");
  });

  it("returns conversational text without tool activity, reasoning, image bytes, or provider metadata", async () => {
    const thread = sampleThread();
    thread.privateProviderMetadata = "private metadata";
    thread.turns[2].items.push(
      { id: "reasoning", type: "reasoning", summary: ["secret reasoning"] },
      { id: "execution", type: "commandExecution", command: "private command", output: "private output" },
      { id: "mcp", type: "mcpToolCall", arguments: "private arguments" }
    );
    thread.turns[2].items[0].content.push({ type: "image", url: "data:image/png;base64,private-image-bytes" });
    const result = await fixture({ thread }).read({});
    expect(payload(result).items.at(-2).attachmentCount).toBe(1);
    expect(result.contentItems[0].text).not.toMatch(/secret reasoning|private command|private output|private arguments|private-image-bytes|private metadata/);
  });

  it("paginates older messages without repeating or losing conversation order", async () => {
    const { read } = fixture();
    const newest = payload(await read({ limit: 2 }));
    expect(newest.items.map(item => item.itemId)).toEqual(["user-3", "assistant-3"]);
    expect(newest.nextCursor).toBe(2);
    const older = payload(await read({ limit: 2, cursor: newest.nextCursor }));
    expect(older.items.map(item => item.itemId)).toEqual(["user-2", "assistant-2"]);
    const oldest = payload(await read({ limit: 2, cursor: older.nextCursor }));
    expect(oldest.items.map(item => item.itemId)).toEqual(["user-1", "assistant-1"]);
    expect(oldest.nextCursor).toBeNull();
  });

  it("recovers clipped message text using the returned UTF-16 offset", async () => {
    const thread = sampleThread();
    thread.turns[2].items[1].text = "abc🙂defghi";
    const { read } = fixture({ thread });
    const first = payload(await read({ itemId: "assistant-3", maxOutputCharsPerItem: 5 })).items[0];
    expect(first).toMatchObject({ text: "abc🙂", truncated: true, nextTextOffset: 5 });
    const second = payload(await read({ itemId: first.itemId, textOffset: first.nextTextOffset, maxOutputCharsPerItem: 8 })).items[0];
    expect(second).toMatchObject({ text: "defghi", truncated: false, nextTextOffset: null });
  });

  it("preserves the separator and offsets between user text parts", async () => {
    const thread = sampleThread();
    thread.turns[2].items[0].content = [{ type: "text", text: "ab" }, { type: "inputText", text: "cdef" }];
    const { read } = fixture({ thread });
    const first = payload(await read({ itemId: "user-3", maxOutputCharsPerItem: 3 })).items[0];
    const second = payload(await read({ itemId: "user-3", textOffset: first.nextTextOffset })).items[0];
    expect(first.text + second.text).toBe("ab\ncdef");
  });

  it.each(["\u0000", "漢🙂"])("caps the encoded response for escaped and multibyte text", async text => {
    const thread = sampleThread();
    thread.turns = Array.from({ length: 25 }, (_, index) => ({ id: `turn-${index}`, status: "completed", items: [message(`assistant-${index}`, "agentMessage", text.repeat(100_000))] }));
    const result = await fixture({ thread }).read({ limit: 20, maxOutputCharsPerItem: 8000 });
    expect(result.success).toBe(true);
    expect(Buffer.byteLength(result.contentItems[0].text, "utf8")).toBeLessThanOrEqual(32_768);
    expect(payload(result).items[0].text.length).toBeGreaterThan(0);
    expect(payload(result).items[0].nextTextOffset).toBeGreaterThan(0);
    expect(payload(result).nextCursor).toBeGreaterThan(0);
  });

  it.each([{ limit: 21 }, { cursor: -1 }, { maxOutputCharsPerItem: 8001 }, { textOffset: 1 }, { itemId: "assistant-1", cursor: 0 }])("rejects invalid bounds or mixed pagination before history access", async args => {
    const { read, runtime } = fixture();
    expect((await read(args)).success).toBe(false);
    expect(runtime.request).not.toHaveBeenCalled();
  });

  it("reports removed messages and provider failures without mutations", async () => {
    const { read, runtime } = fixture();
    expect(payload(await read({ itemId: "missing" })).error).toContain("no longer available");
    runtime.request.mockRejectedValueOnce(new Error("Source provider is disconnected"));
    expect(payload(await read({})).error).toContain("disconnected");
    expect(runtime.request.mock.calls.every(([method]) => method === "thread/read")).toBe(true);
  });
});

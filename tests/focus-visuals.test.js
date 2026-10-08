import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FocusVisuals } from "../electron/runtime/focus-visuals.mjs";
import { buildClaudeUserMessage, buildCodexUserInput } from "../electron/runtime/user-input.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9YH1sAAAAASUVORK5CYII=", "base64");
const directories = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "focus-visuals-"));
  directories.push(root);
  const live = new Map([["coordinator", { id: "coordinator", turns: [{ items: [
    { id: "older", type: "userMessage", content: [{ type: "image", url: `data:image/png;base64,${png.toString("base64")}` }] },
    { id: "newest", type: "userMessage", content: [{ type: "text", text: "Compare" }, { type: "image", url: `data:image/png;base64,${png.toString("base64")}` }] }
  ] }] }]]);
  const persisted = new Map([["coordinator", { id: "coordinator", turns: [{ items: [{ id: "stale", type: "userMessage", content: [] }] }] }]]);
  const captured = new Map();
  const readThread = vi.fn(async ({ projectId, threadId }) => ({ projectId, thread: live.get(threadId), currentUserInput: captured.get(threadId) }));
  return { root, live, persisted, captured, readThread, visuals: new FocusVisuals({ userDataPath: root, readThread }) };
}

describe("FocusVisuals", () => {
  it("selects only coordinator user images by message ID or latest image index", async () => {
    const { visuals, live, persisted, readThread } = fixture();
    live.set("other-thread", { id: "other-thread", turns: [{ items: [{ id: "foreign", type: "userMessage", content: [{ type: "image", url: `data:image/png;base64,${png.toString("base64")}` }] }] }] });
    const staged = await visuals.stage("project", "coordinator", [
      { source: "conversation", messageId: "older", index: 0, label: "Before" },
      { source: "conversation", index: 0 }
    ]);
    expect(staged.map((item) => item.source)).toEqual(["user message older, image 0", "user message newest, image 0"]);
    expect(persisted.get("coordinator").turns[0].items[0].id).toBe("stale");
    expect(readThread).toHaveBeenCalledWith({ projectId: "project", threadId: "coordinator" });
    expect(readFileSync(staged[0].path)).toEqual(png);
    expect(await visuals.load("project", "coordinator", staged)).toEqual([`data:image/png;base64,${png.toString("base64")}`, `data:image/png;base64,${png.toString("base64")}`]);
    const input = buildCodexUserInput("Compare", await visuals.load("project", "coordinator", staged));
    expect(input.filter((part) => part.type === "image")).toHaveLength(2);
    expect(buildClaudeUserMessage("Compare", input.filter((part) => part.type === "image").map((part) => part.url)).message.content[1]).toMatchObject({
      type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") }
    });
    await expect(visuals.stage("project", "coordinator", [{ source: "conversation", messageId: "foreign", index: 0 }])).rejects.toThrow(/not found in this coordinator conversation/);
    await expect(visuals.load("other-project", "coordinator", staged)).rejects.toThrow(/missing/);
  });

  it("uses the captured current user image when the live read omits active-turn image bytes", async () => {
    const { visuals, live, captured } = fixture();
    live.set("coordinator", { id: "coordinator", turns: [{ id: "current-turn", items: [{ id: "current-user", type: "userMessage", content: [{ type: "text", text: "Inspect this" }] }] }] });
    captured.set("coordinator", { turnId: "current-turn", messageId: "current-user", images: [`data:image/png;base64,${png.toString("base64")}`] });
    const [staged] = await visuals.stage("project", "coordinator", [{ source: "conversation", index: 0 }]);
    expect(staged.source).toBe("user message current-user, image 0");
    expect(readFileSync(staged.path)).toEqual(png);
    captured.set("coordinator", { turnId: "next-turn", messageId: null, images: [] });
    await expect(visuals.stage("project", "coordinator", [{ source: "conversation", index: 0 }])).rejects.toThrow(/Image index 0 was not found/);
  });

  it("rejects a live read that returns another thread or project", async () => {
    const { root } = fixture();
    const wrongThread = new FocusVisuals({ userDataPath: root, readThread: async () => ({ projectId: "project", thread: { id: "other-thread", turns: [] } }) });
    await expect(wrongThread.stage("project", "coordinator", [{ source: "conversation", index: 0 }])).rejects.toThrow(/live coordinator conversation/);
    const wrongProject = new FocusVisuals({ userDataPath: root, readThread: async () => ({ projectId: "other-project", thread: { id: "coordinator", turns: [] } }) });
    await expect(wrongProject.stage("project", "coordinator", [{ source: "conversation", index: 0 }])).rejects.toThrow(/live coordinator conversation/);
  });

  it("stages a local video frame and rejects unsafe or invalid files", async () => {
    const { root, visuals } = fixture();
    const frame = path.join(root, "x-post-frame.png");
    writeFileSync(frame, png);
    const [staged] = await visuals.stage("project", "coordinator", [{ source: "file", path: frame, label: "00:02 frame" }]);
    expect(staged).toMatchObject({ mimeType: "image/png", bytes: png.length, label: "00:02 frame" });
    expect((await visuals.load("project", "coordinator", [staged]))[0]).toContain(png.toString("base64"));
    const link = path.join(root, "link.png");
    symlinkSync(frame, link);
    await expect(visuals.stage("project", "coordinator", [{ source: "file", path: link }])).rejects.toThrow(/safely open/);
    const invalid = path.join(root, "fake.png");
    writeFileSync(invalid, "not an image");
    await expect(visuals.stage("project", "coordinator", [{ source: "file", path: invalid }])).rejects.toThrow(/valid PNG/);
    await expect(visuals.stage("project", "coordinator", Array.from({ length: 9 }, () => ({ source: "file", path: frame })))).rejects.toThrow(/at most 8/);
  });
});

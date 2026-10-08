import { describe, expect, it, vi } from "vitest";
import {
  MAX_CONTEXT_TEXT, createContextRecord, normalizeContextRecords, serializeContextToken, parseContextTokens,
  serializeContextForProvider, contextPromptTextForDisplay, contextSendIssues, encodeContextClipboard, decodeContextClipboard,
  composerContextTrigger, requestComposerContext, subscribeComposerContext
} from "../src/composer/context.js";

const citation = createContextRecord("citation", { id: "quote-1", label: "Quoted [reply] \\ excerpt", source: { projectId: "p1", threadId: "t1", itemId: "m1", messageId: "m1" }, text: "The exact quoted words.", comment: "Please explain this part." });
const thread = createContextRecord("thread", { source: { projectId: "p1", threadId: "other-thread" }, label: "Prior investigation", text: "Historical thread payload must not be eagerly sent" });

describe("Structured composer context", () => {
  it("shows human labels in sent prompts without exposing context transport or source content", () => {
    const canonical = `Compare ${serializeContextToken(citation)} with ${serializeContextToken(thread)}.`;
    expect(contextPromptTextForDisplay(canonical)).toBe(`Compare ${citation.label} with ${thread.label}.`);
    const expanded = serializeContextForProvider(canonical, [citation, thread]);
    const displayed = contextPromptTextForDisplay(expanded);
    expect(displayed).toContain(citation.label);
    expect(displayed).toContain(thread.label);
    expect(displayed).toMatch(/^Compare /);
    expect(displayed).toMatch(/\.$/);
    expect(displayed).not.toContain("context-reference");
    expect(displayed).not.toContain("pixice-context://");
    expect(displayed).not.toContain("The exact quoted words.");
    expect(displayed).not.toContain("Read this thread");
  });

  it("leaves unknown XML and incomplete blocks intact and treats decoded labels as text", () => {
    const unknown = '<context-reference kind="future-kind" label="Unknown">keep this XML</context-reference>';
    expect(contextPromptTextForDisplay(`Before ${unknown} after.`)).toBe(`Before ${unknown} after.`);
    const unknownWithToken = `<context-reference kind="future-kind" label="Unknown">${serializeContextToken(thread)}</context-reference>`;
    expect(contextPromptTextForDisplay(unknownWithToken)).toBe(unknownWithToken);
    expect(contextPromptTextForDisplay('<context-reference kind="citation" label="No close">keep')).toBe('<context-reference kind="citation" label="No close">keep');
    const label = 'Quoted "<script>" & text \\ here';
    const block = `<context-reference kind="citation" label=${JSON.stringify(label)}>private source</context-reference>`;
    expect(contextPromptTextForDisplay(`Before ${block} after.`)).toBe(`Before ${label} after.`);
    expect(contextPromptTextForDisplay(null)).toBe("");
  });

  it("round trips labels and source offsets without making labels identity", () => {
    const token = serializeContextToken(citation);
    expect(token).toContain("pixice-context://v1/citation/quote-1");
    expect(parseContextTokens(`a ${token} z`)).toEqual([{ start: 2, end: 2 + token.length, source: token, url: "pixice-context://v1/citation/quote-1", label: citation.label, id: "quote-1", kind: "citation", type: "citation" }]);
    expect(parseContextTokens("[broken](pixice-context://v1/file/%ZZ)")).toEqual([]);
    const file = createContextRecord("file", { label: "notes.md", source: { projectId: "p1", path: "/work/Project (1)/notes.md" } });
    expect(parseContextTokens(serializeContextToken(file))[0].id).toBe(file.id);
    expect(contextSendIssues(serializeContextToken(file), [file], { projectId: "p1" })).toEqual([]);
  });

  it("serializes referenced source and comment while keeping thread history lazy", () => {
    const removed = createContextRecord("terminal", { id: "removed", label: "Secret removed excerpt", text: "DO NOT INCLUDE" });
    const output = serializeContextForProvider(`${serializeContextToken(citation)} then ${serializeContextToken(thread)}`, [citation, thread, removed]);
    expect(output).toContain("The exact quoted words.");
    expect(output).toContain("Please explain this part.");
    expect(output).toContain("Message: m1");
    expect(output).toContain("Thread: other-thread (project p1)");
    expect(output).toContain("Read this thread's history on demand");
    expect(output).toContain('pixice_bridge.read_thread({targetThreadId:"other-thread"})');
    expect(output).toContain("does not authorize sending messages");
    expect(output).not.toContain("DO NOT INCLUDE");
    expect(output).not.toContain("Historical thread payload");
    expect(output).not.toContain("pixice-context://");
  });

  it("bounds records and clipboard data and copies only selected context", () => {
    const record = createContextRecord("terminal", { id: "long", source: { terminalId: "build" }, text: "x".repeat(MAX_CONTEXT_TEXT + 200), arbitrary: "discard" });
    expect(record.text.length).toBeLessThanOrEqual(MAX_CONTEXT_TEXT);
    expect(record.text).toContain("truncated");
    expect(record.arbitrary).toBeUndefined();
    const payload = decodeContextClipboard(encodeContextClipboard(serializeContextToken(citation), [citation, thread], { projectId: "p1", threadId: "t1" }));
    expect(payload.records).toEqual([citation]);
    expect(payload.source).toEqual({ projectId: "p1", threadId: "t1", hostId: "" });
    expect(decodeContextClipboard("bad json")).toBeNull();
    expect(normalizeContextRecords([{ kind: "unsupported", id: "evil" }, null])).toEqual([]);
  });

  it("blocks unresolved and foreign resource chips but allows captured quotes", () => {
    const foreignFile = createContextRecord("file", { id: "f1", label: "notes.md", source: { projectId: "other", path: "/other/notes.md" } });
    const image = createContextRecord("image", { id: "i1", label: "diagram.png", imageId: "attachment-1", source: { projectId: "p1" } });
    const draft = [foreignFile, image, citation].map(serializeContextToken).join(" ");
    expect(contextSendIssues(draft, [foreignFile, image, citation], { projectId: "p1", attachments: [] }).map(issue => issue.reason)).toEqual(["scope", "attachment"]);
    expect(contextSendIssues(serializeContextToken(image), [image], { projectId: "p1", attachments: [{ id: "attachment-1" }] })).toEqual([]);
    expect(contextSendIssues(serializeContextToken(citation), [], { projectId: "p1" })[0].reason).toBe("missing");
    const file = createContextRecord("file", { label: "pasted.txt", attachmentId: "file-attachment", source: { projectId: "p1" } });
    expect(contextSendIssues(serializeContextToken(file), [file], { projectId: "p1", attachments: [] })[0].reason).toBe("attachment");
  });

  it("recognizes cursor-local @ and # without matching emails or complete chip URLs", () => {
    expect(composerContextTrigger("Look at @src/mai")).toEqual({ marker: "@", query: "src/mai", start: 8, end: 16, kind: "all" });
    expect(composerContextTrigger("Review #42")).toMatchObject({ marker: "#", query: "42", kind: "pull-request" });
    expect(composerContextTrigger("email@example.com")).toBeNull();
    expect(composerContextTrigger(serializeContextToken(citation))).toBeNull();
  });

  it("routes source insertion only to its exact project and thread", () => {
    const target = new EventTarget();
    const selected = vi.fn();
    const other = vi.fn();
    const stop = subscribeComposerContext({ projectId: "p1", threadId: "t1", onInsert: selected, target });
    const stopOther = subscribeComposerContext({ projectId: "p1", threadId: "t2", onInsert: other, target });
    requestComposerContext({ projectId: "p1", threadId: "t1", record: citation, target });
    expect(selected).toHaveBeenCalledWith([citation]);
    expect(other).not.toHaveBeenCalled();
    stop(); stopOther();
    requestComposerContext({ projectId: "p1", threadId: "t1", record: citation, target });
    expect(selected).toHaveBeenCalledTimes(1);
  });

  it("delivers a bounded Review selection after its exact host/thread composer mounts", () => {
    const target = new EventTarget();
    const remote = vi.fn();
    const wrongHost = vi.fn();
    for (let index = 0; index < 19; index++) requestComposerContext({ projectId: "p1", threadId: "t1", hostId: "remote", record: { ...citation, id: `q${index}` }, target });
    const stopLocal = subscribeComposerContext({ projectId: "p1", threadId: "t1", hostId: "local", onInsert: wrongHost, target });
    expect(wrongHost).not.toHaveBeenCalled();
    const stop = subscribeComposerContext({ projectId: "p1", threadId: "t1", hostId: "remote", onInsert: remote, target });
    expect(remote).toHaveBeenCalledTimes(1);
    expect(remote.mock.calls[0][0]).toHaveLength(16);
    expect(remote.mock.calls[0][0][0].id).toBe("q3");
    stop(); stopLocal();
    const again = vi.fn();
    const stopAgain = subscribeComposerContext({ projectId: "p1", threadId: "t1", hostId: "remote", onInsert: again, target });
    expect(again).not.toHaveBeenCalled();
    stopAgain();
  });
});

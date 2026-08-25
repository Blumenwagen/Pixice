import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncPromptQueue, ClaudeProvider } from "../electron/providers/claude-provider.mjs";
import { PixiceDatabase } from "../electron/persistence/database.mjs";

const temporaryDirectories = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Claude thread instructions", () => {
  it("uses thread-specific developer instructions for workflow-attached Skills", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-thread-instructions-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const output = new AsyncPromptQueue();
    let queryArguments;
    const query = {
      [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
      setModel: vi.fn(),
      setPermissionMode: vi.fn(),
      interrupt: vi.fn(),
      close: vi.fn()
    };
    const provider = new ClaudeProvider({
      database,
      clientVersion: "test",
      developerInstructions: () => "Base Pixice instructions",
      queryFactory: (arguments_) => {
        queryArguments = arguments_;
        return query;
      }
    });
    await provider.start();

    const attachedInstructions = "Base Pixice instructions\n\n## Workflow-attached Skills\nAlways inspect the changelog.";
    const { thread } = await provider.request("thread/start", {
      cwd: directory,
      model: "sonnet",
      permissionMode: "workspace-write",
      developerInstructions: attachedInstructions
    });
    await provider.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "Review the release" }],
      model: "sonnet",
      effort: "high",
      permissionMode: "workspace-write"
    });

    expect(queryArguments.options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: attachedInstructions
    });
    expect(queryArguments.options.appendSubagentSystemPrompt).toBe(attachedInstructions);

    output.push({
      type: "result",
      subtype: "success",
      session_id: thread.providerThreadId,
      uuid: "result-1",
      is_error: false,
      result: "Reviewed",
      permission_denials: []
    });
    await tick();
    await provider.stop();
    database.db.close();
  });

  it("refreshes global behavior instructions before the next turn", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-refresh-instructions-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const outputs = [new AsyncPromptQueue(), new AsyncPromptQueue()];
    const queryArguments = [];
    let instructions = "Pixice instructions v1";
    const provider = new ClaudeProvider({
      database,
      clientVersion: "test",
      developerInstructions: () => instructions,
      queryFactory: (arguments_) => {
        const index = queryArguments.length;
        queryArguments.push(arguments_);
        return {
          [Symbol.asyncIterator]: () => outputs[index][Symbol.asyncIterator](),
          setModel: vi.fn(),
          setPermissionMode: vi.fn(),
          interrupt: vi.fn(),
          close: vi.fn()
        };
      }
    });
    await provider.start();

    const { thread } = await provider.request("thread/start", {
      cwd: directory,
      model: "sonnet",
      permissionMode: "workspace-write",
      developerInstructions: instructions
    });
    await provider.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "First turn" }],
      model: "sonnet",
      permissionMode: "workspace-write"
    });
    outputs[0].push({
      type: "system",
      subtype: "init",
      session_id: thread.providerThreadId
    });
    instructions = "Pixice instructions v2";
    provider.refreshDeveloperInstructions();
    expect(queryArguments).toHaveLength(1);
    outputs[0].push({
      type: "result",
      subtype: "success",
      session_id: thread.providerThreadId,
      uuid: "result-1",
      is_error: false,
      result: "First result",
      permission_denials: []
    });
    await tick();

    await provider.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "Second turn" }],
      model: "sonnet",
      permissionMode: "workspace-write"
    });

    expect(queryArguments).toHaveLength(2);
    expect(queryArguments[1].options).toMatchObject({
      resume: thread.providerThreadId,
      systemPrompt: { type: "preset", preset: "claude_code", append: "Pixice instructions v2" },
      appendSubagentSystemPrompt: "Pixice instructions v2"
    });

    outputs[1].push({
      type: "result",
      subtype: "success",
      session_id: thread.providerThreadId,
      uuid: "result-2",
      is_error: false,
      result: "Second result",
      permission_denials: []
    });
    await tick();
    await provider.stop();
    database.db.close();
  });
});

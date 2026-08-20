import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncPromptQueue, ClaudeProvider } from "../electron/providers/claude-provider.mjs";
import { LoomDatabase } from "../electron/persistence/database.mjs";

const temporaryDirectories = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Claude thread instructions", () => {
  it("uses thread-specific developer instructions for workflow-attached Skills", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-claude-thread-instructions-"));
    temporaryDirectories.push(directory);
    const database = new LoomDatabase(directory);
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
      developerInstructions: () => "Base Loom instructions",
      queryFactory: (arguments_) => {
        queryArguments = arguments_;
        return query;
      }
    });
    await provider.start();

    const attachedInstructions = "Base Loom instructions\n\n## Workflow-attached Skills\nAlways inspect the changelog.";
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
});

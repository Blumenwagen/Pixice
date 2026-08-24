import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncPromptQueue, ClaudeProvider, claudeAccountIsAuthenticated, claudePermissionSettings, claudeQueryOptions, resolveClaudeCodeExecutable, resolvePackagedClaudeCodeExecutable } from "../electron/providers/claude-provider.mjs";
import { PixiceDatabase } from "../electron/persistence/database.mjs";

const temporaryDirectories = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Claude provider", () => {
  it("does not treat a bare first-party backend as an authenticated account", () => {
    expect(claudeAccountIsAuthenticated({ apiProvider: "firstParty", apiKeySource: "none" })).toBe(false);
    expect(claudeAccountIsAuthenticated({ apiProvider: "firstParty", email: "dev@example.com" })).toBe(true);
    expect(claudeAccountIsAuthenticated({ apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" })).toBe(true);
    expect(claudeAccountIsAuthenticated({ apiProvider: "bedrock" })).toBe(true);
  });

  it("uses exactly the models reported by the Claude SDK", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-claude-models-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const provider = new ClaudeProvider({
      database,
      queryFactory: () => ({
        supportedModels: vi.fn().mockResolvedValue([
          { value: "default", displayName: "Default (recommended)" },
          { value: "sonnet", displayName: "Sonnet" },
          { value: "haiku", displayName: "Haiku" }
        ]),
        close: vi.fn()
      })
    });
    await provider.start();

    const response = await provider.request("model/list");
    const cachedResponse = await provider.request("model/list");

    expect(response.data.map((model) => model.model)).toEqual(["default", "sonnet", "haiku"]);
    expect(cachedResponse).toEqual(response);
    expect(response.data).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ model: "opus" })
    ]));
    await provider.stop();
    database.db.close();
  });

  it("does not cache the minimal fallback when model discovery fails", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-claude-model-retry-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const supportedModels = vi.fn()
      .mockRejectedValueOnce(new Error("Sign in required"))
      .mockResolvedValueOnce([{ value: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", description: "Latest Sonnet" }]);
    const provider = new ClaudeProvider({
      database,
      queryFactory: () => ({ supportedModels, close: vi.fn() })
    });
    await provider.start();

    expect((await provider.request("model/list")).data.map((model) => model.model)).toEqual(["default"]);
    expect((await provider.request("model/list")).data.map((model) => model.model)).toEqual(["claude-sonnet-4-6"]);
    expect(supportedModels).toHaveBeenCalledTimes(2);
    await provider.stop();
    database.db.close();
  });

  it("prefers an installed Claude Code executable like T3's provider", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-claude-bin-"));
    temporaryDirectories.push(directory);
    const executable = path.join(directory, process.platform === "win32" ? "claude.exe" : "claude");
    writeFileSync(executable, "test");
    if (process.platform !== "win32") chmodSync(executable, 0o755);

    expect(resolveClaudeCodeExecutable({ pathValue: directory, homeDirectory: directory })).toBe(executable);
  });

  it("finds electron-builder's unpacked Claude runtime in packaged apps", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-packaged-claude-"));
    temporaryDirectories.push(directory);
    const packageName = `claude-agent-sdk-${process.platform === "win32" ? "win32" : process.platform}-${process.arch}`;
    const executable = path.join(
      directory,
      "app.asar.unpacked",
      "node_modules",
      "@anthropic-ai",
      packageName,
      process.platform === "win32" ? "claude.exe" : "claude"
    );
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, "test");
    if (process.platform !== "win32") chmodSync(executable, 0o755);

    expect(resolvePackagedClaudeCodeExecutable({ resourcesPath: directory })).toBe(executable);
  });

  it("maps Pixice permissions to the same Claude Code modes used by T3", () => {
    expect(claudePermissionSettings("workspace-write").permissionMode).toBe("acceptEdits");
    expect(claudePermissionSettings("auto-approve").permissionMode).toBe("auto");
    expect(claudePermissionSettings("full-access")).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true
    });
    expect(claudePermissionSettings("read-only").tools).toContain("mcp__loom__request_user_input");
    expect(claudePermissionSettings("read-only").tools).toContain("mcp__loom_board__list_tasks");
    expect(claudePermissionSettings("read-only").tools).toContain("mcp__loom_board__create_task");
    expect(claudePermissionSettings("read-only").tools).toContain("mcp__loom_instruments__create_instrument");
  });

  it("uses the Claude Code system preset and preserves the host environment", () => {
    const options = claudeQueryOptions({
      cwd: "/workspace",
      permissionMode: "workspace-write",
      sessionId: "session-1",
      developerInstructions: "Pixice guidance",
      clientVersion: "1.2.3",
      canUseTool: vi.fn()
    });
    expect(options).toMatchObject({
      cwd: "/workspace",
      sessionId: "session-1",
      permissionMode: "acceptEdits",
      includePartialMessages: true,
      forwardSubagentText: true,
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code", append: "Pixice guidance" },
      appendSubagentSystemPrompt: "Pixice guidance"
    });
    expect(options.env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("loom/1.2.3");
  });

  it("reads the Claude account and starts the SDK sign-in flow", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-claude-account-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const queries = [];
    const provider = new ClaudeProvider({
      database,
      clientVersion: "test",
      queryFactory: () => {
        const query = {
          accountInfo: vi.fn().mockResolvedValue({ email: "dev@example.com", subscriptionType: "pro", apiProvider: "firstParty" }),
          claudeAuthenticate: vi.fn().mockResolvedValue({ authUrl: "https://claude.ai/oauth/authorize", state: "state-1" }),
          claudeOAuthWaitForCompletion: vi.fn().mockResolvedValue({ success: true }),
          close: vi.fn()
        };
        queries.push(query);
        return query;
      }
    });
    await provider.start();

    await expect(provider.account()).resolves.toEqual({
      account: { type: "claude", email: "dev@example.com", subscriptionType: "pro", apiProvider: "firstParty" },
      authenticated: true,
      requiresAuth: true
    });
    provider.models = [{ value: "stale", displayName: "Stale Claude" }];
    await expect(provider.login()).resolves.toMatchObject({ type: "claude", authUrl: "https://claude.ai/oauth/authorize" });
    await tick();

    expect(queries[1].claudeAuthenticate).toHaveBeenCalledWith(true);
    expect(queries[1].claudeOAuthWaitForCompletion).toHaveBeenCalled();
    expect(queries[1].close).toHaveBeenCalled();
    expect(provider.models).toBeNull();
    await provider.stop();
    database.db.close();
  });

  it("keeps one streaming query open and translates SDK output to canonical Pixice events", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-claude-provider-"));
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
      loomBridge: { handleToolCall: vi.fn() },
      loomInstruments: { handleToolCall: vi.fn() },
      queryFactory: (args) => { queryArguments = args; return query; }
    });
    const events = [];
    provider.on("event", (event) => events.push(event));
    await provider.start();

    const { thread } = await provider.request("thread/start", {
      cwd: directory,
      model: "sonnet",
      permissionMode: "workspace-write"
    });
    const { turn } = await provider.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "Implement it" }],
      model: "sonnet",
      effort: "high",
      permissionMode: "workspace-write"
    });
    const promptMessage = await queryArguments.prompt[Symbol.asyncIterator]().next();
    expect(promptMessage.value.message.content).toEqual([{ type: "text", text: "Implement it" }]);
    expect(queryArguments.options).toMatchObject({ model: "sonnet", effort: "high", permissionMode: "acceptEdits" });
    expect(queryArguments.options.mcpServers.loom).toMatchObject({ type: "sdk", name: "loom" });
    expect(queryArguments.options.mcpServers.loom_bridge).toMatchObject({ type: "sdk", name: "loom_bridge" });
    expect(queryArguments.options.mcpServers.loom_instruments).toMatchObject({ type: "sdk", name: "loom_instruments" });
    await expect(queryArguments.options.canUseTool("mcp__loom__request_user_input", {}, {})).resolves.toMatchObject({ behavior: "allow" });
    await expect(queryArguments.options.canUseTool("mcp__loom_bridge__spawn_thread", {}, {})).resolves.toMatchObject({ behavior: "allow" });
    await expect(queryArguments.options.canUseTool("mcp__loom_instruments__create_instrument", {}, {})).resolves.toMatchObject({ behavior: "allow" });

    output.push({ type: "system", subtype: "init", session_id: thread.providerThreadId, uuid: "init-1" });
    output.push({
      type: "stream_event",
      session_id: thread.providerThreadId,
      uuid: "assistant-1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Done" } }
    });
    output.push({
      type: "assistant",
      session_id: thread.providerThreadId,
      uuid: "assistant-1",
      message: { content: [{ type: "text", text: "Done" }] }
    });
    output.push({
      type: "result",
      subtype: "success",
      session_id: thread.providerThreadId,
      uuid: "result-1",
      is_error: false,
      result: "Done",
      permission_denials: []
    });
    await tick();

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "TaskUpdated", payload: expect.objectContaining({ method: "turn/started", turn: expect.objectContaining({ id: turn.id }) }) }),
      expect.objectContaining({ type: "TaskUpdated", payload: expect.objectContaining({ method: "item/agentMessage/delta", delta: "Done" }) }),
      expect.objectContaining({ type: "TaskUpdated", payload: expect.objectContaining({ method: "turn/completed", turn: expect.objectContaining({ status: "completed" }) }) })
    ]));
    expect(database.getThreadProviderBinding(thread.id)).toMatchObject({ provider: "claude", resumeCursor: thread.providerThreadId });
    expect((await provider.request("thread/read", { threadId: thread.id })).thread.turns[0].items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: "agentMessage", text: "Done", phase: "final_answer" })]));

    await provider.stop();
    database.db.close();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserDynamicTools } from "../electron/browser/browser-workspace.mjs";
import { iosDynamicTools } from "../electron/ios/ios-tools.mjs";
import { AsyncPromptQueue, ClaudeProvider, claudeAccountIsAuthenticated, claudeExternallyManagedAuth, claudePermissionSettings, claudeQueryOptions } from "../electron/providers/claude-provider.mjs";
import { PixiceDatabase } from "../electron/persistence/database.mjs";
import { pixiceBoardTools } from "../electron/runtime/pixice-board.mjs";
import { pixiceBridgeDynamicTools } from "../electron/runtime/pixice-bridge.mjs";
import { previewContextDynamicTools } from "../electron/runtime/preview-context.mjs";

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

  it("reports credentials supplied by the environment or a cloud backend as externally managed", () => {
    expect(claudeExternallyManagedAuth({ apiProvider: "firstParty", apiKeySource: "none" }, {})).toBe(false);
    expect(claudeExternallyManagedAuth({ apiProvider: "firstParty", apiKeySource: "/login managed key" }, {})).toBe(false);
    expect(claudeExternallyManagedAuth({ apiProvider: "bedrock" }, {})).toBe(true);
    expect(claudeExternallyManagedAuth({ apiProvider: "firstParty" }, { ANTHROPIC_API_KEY: "present" })).toBe(true);
    expect(claudeExternallyManagedAuth({ apiProvider: "firstParty" }, { CLAUDE_CODE_OAUTH_TOKEN: "present" })).toBe(true);
  });

  it("uses exactly the models reported by the Claude SDK", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-models-"));
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

  it("retries the minimal model fallback after a cooldown", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-model-retry-"));
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
    expect((await provider.request("model/list")).data.map((model) => model.model)).toEqual(["default"]);
    expect(supportedModels).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(31_001);
    expect((await provider.request("model/list")).data.map((model) => model.model)).toEqual(["claude-sonnet-4-6"]);
    clock.mockRestore();
    expect(supportedModels).toHaveBeenCalledTimes(2);
    await provider.stop();
    database.db.close();
  });

  it("repairs legacy Claude snapshots without touching active work", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-snapshot-repair-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const threadId = "legacy-thread";
    database.saveThreadProviderBinding({ threadId, provider: "claude", providerThreadId: "session", resumeCursor: "session", cwd: directory });
    database.saveProviderThreadSnapshot(threadId, {
      id: threadId,
      cwd: directory,
      status: { type: "idle" },
      turns: [{ id: "turn", status: "completed", completedAt: "2026-08-30T12:00:00.000Z", items: [
        { id: "empty-thought", type: "reasoning", summary: [] },
        { id: "empty-message", type: "agentMessage", text: "" },
        { id: "legacy-edit", type: "fileChange", path: "src/App.jsx", changes: { file_path: "src/App.jsx", content: "new" }, status: "inProgress" }
      ] }]
    });
    const provider = new ClaudeProvider({ database, queryFactory: vi.fn() });
    await provider.start();

    expect(database.getProviderThreadSnapshot(threadId).turns[0].items).toEqual([
      expect.objectContaining({ id: "legacy-edit", status: "completed", changes: [expect.objectContaining({ path: "src/App.jsx" })] })
    ]);
    await provider.stop();
    database.db.close();
  });

  it("maps Pixice permissions to the same Claude Code modes used by T3", () => {
    expect(claudePermissionSettings("workspace-write").permissionMode).toBe("acceptEdits");
    expect(claudePermissionSettings("auto-approve").permissionMode).toBe("auto");
    expect(claudePermissionSettings("full-access")).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true
    });
    expect(claudePermissionSettings("read-only").tools).toContain("mcp__pixice__request_user_input");
    expect(claudePermissionSettings("read-only").tools).toContain("mcp__pixice_board__list_tasks");
    expect(claudePermissionSettings("read-only").tools).toContain("mcp__pixice_board__create_task");
    expect(claudePermissionSettings("read-only").tools).toContain("mcp__pixice_instruments__create_instrument");
    expect(claudePermissionSettings("read-only").tools).toContain("mcp__pixice_preview__current");
    expect(claudePermissionSettings("read-only").tools).toContain("mcp__pixice_ios__start");
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
    expect(options.env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("pixice/1.2.3");
  });

  it("prepends an external CLI directory to the Claude child environment", () => {
    const options = claudeQueryOptions({
      cwd: "/workspace",
      permissionMode: "read-only",
      sessionId: "session-1",
      clientVersion: "1.2.3",
      canUseTool: vi.fn(),
      pathToClaudeCodeExecutable: "/Users/dev/.nvm/versions/node/v22/bin/claude",
      environment: { PATH: "/usr/bin:/bin" }
    });

    expect(options.env.PATH).toBe(`/Users/dev/.nvm/versions/node/v22/bin${path.delimiter}/usr/bin:/bin`);
  });

  it("reads the Claude account and starts the SDK sign-in flow", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-account-"));
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
      requiresAuth: true,
      externallyManagedAuth: false
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

  it("logs out stored Claude credentials through the external CLI", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-logout-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const logoutCommand = vi.fn().mockResolvedValue({ code: 0 });
    const runtimeLifecycle = {
      on: vi.fn(),
      discover: vi.fn().mockResolvedValue({ installed: true, compatible: true, executablePath: "/tools/claude" }),
      snapshot: vi.fn().mockReturnValue({ installed: true, compatible: true, executablePath: "/tools/claude" }),
      logoutCommand
    };
    const provider = new ClaudeProvider({
      database,
      clientVersion: "test",
      environment: {},
      runtimeLifecycle,
      requireExternalExecutable: true,
      queryFactory: () => ({
        accountInfo: vi.fn().mockResolvedValue({ email: "dev@example.com", apiProvider: "firstParty", apiKeySource: "/login managed key" }),
        close: vi.fn()
      })
    });
    await provider.start();

    await expect(provider.logout()).resolves.toEqual({ loggedOut: true, externallyManagedAuth: false });
    expect(logoutCommand).toHaveBeenCalledOnce();
    await provider.stop();
    database.db.close();
  });

  it("reads authenticated Claude plan limits through the SDK usage command", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-claude-usage-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const usage = { subscription_type: "max", rate_limits_available: true, rate_limits: { five_hour: { utilization: 22, resets_at: null } } };
    const usageMethod = vi.fn().mockResolvedValue(usage);
    const close = vi.fn();
    const provider = new ClaudeProvider({
      database,
      queryFactory: () => ({
        accountInfo: vi.fn().mockResolvedValue({ email: "dev@example.com", apiProvider: "firstParty" }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usageMethod,
        close
      })
    });
    await provider.start();

    await expect(provider.usageLimits()).resolves.toMatchObject({ authenticated: true, usage });
    expect(usageMethod).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalled();

    await provider.stop();
    database.db.close();
  });

  it("keeps one streaming query open and translates SDK output to canonical Pixice events", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-provider-"));
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
    const pixiceBoard = {
      handleToolCall: vi.fn().mockResolvedValue({ success: true, contentItems: [{ type: "inputText", text: "board result" }] })
    };
    const pixiceBrowser = {
      handleToolCall: vi.fn().mockResolvedValue({ success: true, contentItems: [{ type: "inputText", text: "browser result" }] })
    };
    const pixicePreview = {
      handleToolCall: vi.fn().mockReturnValue({ success: true, contentItems: [{ type: "inputText", text: "preview result" }] })
    };
    const pixiceIos = {
      handleToolCall: vi.fn().mockResolvedValue({ success: true, contentItems: [{ type: "inputText", text: "ios result" }] })
    };
    const provider = new ClaudeProvider({
      database,
      clientVersion: "test",
      pixiceBridge: { handleToolCall: vi.fn() },
      pixiceBoard,
      pixiceInstruments: { handleToolCall: vi.fn() },
      pixiceBrowser,
      pixicePreview,
      pixiceIos,
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
    expect(queryArguments.options.mcpServers.pixice).toMatchObject({ type: "sdk", name: "pixice" });
    expect(queryArguments.options.mcpServers.pixice_bridge).toMatchObject({ type: "sdk", name: "pixice_bridge" });
    expect(queryArguments.options.mcpServers.pixice_board).toMatchObject({ type: "sdk", name: "pixice_board" });
    expect(queryArguments.options.mcpServers.pixice_instruments).toMatchObject({ type: "sdk", name: "pixice_instruments" });
    expect(queryArguments.options.mcpServers.pixice_browser).toMatchObject({ type: "sdk", name: "pixice_browser" });
    expect(queryArguments.options.mcpServers.pixice_preview).toMatchObject({ type: "sdk", name: "pixice_preview" });
    expect(queryArguments.options.mcpServers.pixice_ios).toMatchObject({ type: "sdk", name: "pixice_ios" });
    expect(Object.keys(queryArguments.options.mcpServers.pixice_board.instance._registeredTools)).toEqual(
      pixiceBoardTools.map((definition) => definition.name)
    );
    expect(Object.keys(queryArguments.options.mcpServers.pixice_browser.instance._registeredTools)).toEqual(
      browserDynamicTools[0].tools.map((definition) => definition.name)
    );
    expect(Object.keys(queryArguments.options.mcpServers.pixice_preview.instance._registeredTools)).toEqual(
      previewContextDynamicTools[0].tools.map((definition) => definition.name)
    );
    expect(Object.keys(queryArguments.options.mcpServers.pixice_ios.instance._registeredTools)).toEqual(
      iosDynamicTools[0].tools.map((definition) => definition.name)
    );
    const iosStartSchema = queryArguments.options.mcpServers.pixice_ios.instance._registeredTools.start.inputSchema;
    expect(iosStartSchema.safeParse({}).success).toBe(false);
    expect(iosStartSchema.safeParse({
      containerPath: "Demo.xcodeproj",
      scheme: "Demo",
      simulatorUdid: "SIM-1"
    })).toMatchObject({ success: true, data: { configuration: "Debug" } });
    const iosTapSchema = queryArguments.options.mcpServers.pixice_ios.instance._registeredTools.tap.inputSchema;
    expect(iosTapSchema.safeParse({ x: 1.1, y: 0.5 }).success).toBe(false);
    await expect(queryArguments.options.canUseTool("mcp__pixice__request_user_input", {}, {})).resolves.toMatchObject({ behavior: "allow" });
    await expect(queryArguments.options.canUseTool("mcp__pixice_bridge__spawn_thread", {}, {})).resolves.toMatchObject({ behavior: "allow" });
    await expect(queryArguments.options.canUseTool("mcp__pixice_board__read_task", {}, {})).resolves.toMatchObject({ behavior: "allow" });
    await expect(queryArguments.options.canUseTool("mcp__pixice_instruments__create_instrument", {}, {})).resolves.toMatchObject({ behavior: "allow" });
    await expect(queryArguments.options.canUseTool("mcp__pixice_browser__navigate", {}, {})).resolves.toMatchObject({ behavior: "allow" });
    await expect(queryArguments.options.canUseTool("mcp__pixice_preview__current", {}, {})).resolves.toMatchObject({ behavior: "allow" });
    await expect(queryArguments.options.canUseTool("mcp__pixice_ios__start", {}, {})).resolves.toMatchObject({ behavior: "allow" });

    await queryArguments.options.mcpServers.pixice_browser.instance._registeredTools.navigate.handler({ url: "https://apple.com" });
    expect(pixiceBrowser.handleToolCall).toHaveBeenCalledWith(expect.objectContaining({
      namespace: "pixice_browser",
      tool: "navigate",
      threadId: thread.id,
      arguments: { url: "https://apple.com" },
      source: "claude"
    }));
    await queryArguments.options.mcpServers.pixice_preview.instance._registeredTools.current.handler({});
    expect(pixicePreview.handleToolCall).toHaveBeenCalledWith(expect.objectContaining({
      namespace: "pixice_preview",
      tool: "current",
      threadId: thread.id,
      arguments: {},
      source: "claude"
    }));
    await queryArguments.options.mcpServers.pixice_ios.instance._registeredTools.start.handler({
      containerPath: "Demo.xcodeproj",
      scheme: "Demo",
      simulatorUdid: "SIM-1"
    });
    expect(pixiceIos.handleToolCall).toHaveBeenCalledWith(expect.objectContaining({
      namespace: "pixice_ios",
      tool: "start",
      threadId: thread.id,
      arguments: {
        containerPath: "Demo.xcodeproj",
        scheme: "Demo",
        simulatorUdid: "SIM-1"
      },
      source: "claude"
    }));
    await queryArguments.options.mcpServers.pixice_board.instance._registeredTools.read_task.handler({ taskId: "task-1" });
    expect(pixiceBoard.handleToolCall).toHaveBeenCalledWith(expect.objectContaining({
      namespace: "pixice_board",
      tool: "read_task",
      threadId: thread.id,
      arguments: { taskId: "task-1" }
    }));

    output.push({ type: "system", subtype: "init", session_id: thread.providerThreadId, uuid: "init-1" });
    output.push({ type: "system", subtype: "status", status: "compacting", session_id: thread.providerThreadId, uuid: "compact-1" });
    await tick();

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "TaskUpdated",
        payload: expect.objectContaining({
          method: "item/started",
          item: expect.objectContaining({ type: "contextCompaction", status: "inProgress", provider: "claude" })
        })
      })
    ]));
    expect((await provider.request("thread/read", { threadId: thread.id })).thread.turns[0].items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: "contextCompaction", status: "inProgress" })]));

    output.push({ type: "system", subtype: "status", status: null, compact_result: "success", session_id: thread.providerThreadId, uuid: "compact-2" });
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
      message: { content: [
        { type: "text", text: "Done" },
        { type: "tool_use", id: "write-1", name: "Write", input: { file_path: "src/App.jsx", content: "updated" } }
      ] }
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
      expect.objectContaining({ type: "TaskUpdated", payload: expect.objectContaining({ method: "item/completed", item: expect.objectContaining({ type: "contextCompaction", status: "completed" }) }) }),
      expect.objectContaining({ type: "TaskUpdated", payload: expect.objectContaining({ method: "item/agentMessage/delta", delta: "Done" }) }),
      expect.objectContaining({ type: "TaskUpdated", payload: expect.objectContaining({ method: "turn/completed", turn: expect.objectContaining({ status: "completed" }) }) })
    ]));
    expect(database.getThreadProviderBinding(thread.id)).toMatchObject({ provider: "claude", resumeCursor: thread.providerThreadId });
    expect((await provider.request("thread/read", { threadId: thread.id })).thread.turns[0].items)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "contextCompaction", status: "completed" }),
        expect.objectContaining({
          type: "fileChange",
          path: "src/App.jsx",
          changes: [{ path: "src/App.jsx" }],
          arguments: { file_path: "src/App.jsx", content: "updated" }
        }),
        expect.objectContaining({ type: "agentMessage", text: "Done", phase: "final_answer" })
      ]));

    await provider.stop();
    database.db.close();
  });

  it("limits a coordinator query to its explicit Pixice capabilities and omits skills", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-coordinator-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const output = new AsyncPromptQueue();
    let queryArguments;
    const provider = new ClaudeProvider({
      database,
      pixiceBridge: { handleToolCall: vi.fn() },
      pixicePreview: { handleToolCall: vi.fn() },
      queryFactory: (args) => {
        queryArguments = args;
        return {
          [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
          close: vi.fn()
        };
      }
    });
    await provider.start();

    const bridgeTools = [{
      ...pixiceBridgeDynamicTools[0],
      tools: pixiceBridgeDynamicTools[0].tools.filter((tool) => ["list_models", "spawn_thread"].includes(tool.name))
    }];
    const { thread } = await provider.request("thread/start", {
      cwd: directory,
      model: "sonnet",
      permissionMode: "workspace-write",
      dynamicTools: [...bridgeTools, ...previewContextDynamicTools]
    });
    await provider.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "Show the worker prototype" }],
      model: "sonnet",
      permissionMode: "workspace-write"
    });

    expect(queryArguments.options.skills).toEqual([]);
    expect(Object.keys(queryArguments.options.mcpServers).sort()).toEqual(["pixice_bridge", "pixice_preview"]);
    expect(Object.keys(queryArguments.options.mcpServers.pixice_bridge.instance._registeredTools)).toEqual(["list_models", "spawn_thread"]);
    await expect(queryArguments.options.canUseTool("mcp__pixice_preview__present_thread", {}, {})).resolves.toMatchObject({ behavior: "allow" });
    await expect(queryArguments.options.canUseTool("mcp__pixice_board__create_task", {}, {})).resolves.toMatchObject({ behavior: "deny" });

    await provider.stop();
    database.db.close();
  });

  it("persists a chatty Claude stream once at its terminal boundary", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-checkpoints-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const output = new AsyncPromptQueue();
    const provider = new ClaudeProvider({
      database,
      streamCheckpointMs: 10_000,
      queryFactory: () => ({
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        close: vi.fn()
      })
    });
    const saveSnapshot = vi.spyOn(database, "saveProviderThreadSnapshot");
    const saveBinding = vi.spyOn(database, "saveThreadProviderBinding");
    await provider.start();
    const { thread } = await provider.request("thread/start", { cwd: directory, model: "sonnet" });
    await provider.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "Stream a long answer" }],
      model: "sonnet"
    });
    saveSnapshot.mockClear();
    saveBinding.mockClear();

    for (let index = 0; index < 100; index += 1) {
      output.push({
        type: "stream_event",
        session_id: thread.providerThreadId,
        uuid: "streamed-answer",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "abcdefghij" } }
      });
      await Promise.resolve();
    }
    for (const thinking of ["Think ", "carefully"]) {
      output.push({
        type: "stream_event",
        session_id: thread.providerThreadId,
        uuid: "streamed-thinking",
        event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } }
      });
      await Promise.resolve();
    }
    await tick();

    expect(saveSnapshot).not.toHaveBeenCalled();
    expect(saveBinding).not.toHaveBeenCalled();

    output.push({
      type: "result",
      subtype: "success",
      session_id: thread.providerThreadId,
      uuid: "stream-result",
      is_error: false,
      result: "",
      permission_denials: []
    });
    await tick();

    expect(saveSnapshot).toHaveBeenCalledTimes(1);
    expect(saveBinding).not.toHaveBeenCalled();
    expect(database.getProviderThreadSnapshot(thread.id).turns[0].items)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "agentMessage", text: "abcdefghij".repeat(100) }),
        expect.objectContaining({ type: "reasoning", summary: [{ type: "summary_text", text: "Think carefully" }] })
      ]));

    await provider.stop();
    database.db.close();
  });

  it("checkpoints only the active Claude turn between terminal snapshots", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-active-turn-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const output = new AsyncPromptQueue();
    const provider = new ClaudeProvider({
      database,
      streamCheckpointMs: 5,
      queryFactory: () => ({
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        close: vi.fn()
      })
    });
    const saveSnapshot = vi.spyOn(database, "saveProviderThreadSnapshot");
    const saveActiveTurn = vi.spyOn(database, "saveProviderActiveTurn");
    await provider.start();
    const { thread } = await provider.request("thread/start", { cwd: directory, model: "sonnet" });
    await provider.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "Keep this recoverable" }],
      model: "sonnet"
    });
    saveSnapshot.mockClear();

    output.push({
      type: "stream_event",
      session_id: thread.providerThreadId,
      uuid: "active-answer",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Partial answer" } }
    });
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(saveSnapshot).not.toHaveBeenCalled();
    expect(saveActiveTurn).toHaveBeenCalledTimes(1);
    expect(database.getProviderThreadSnapshot(thread.id).turns[0].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agentMessage", text: "Partial answer" })
    ]));

    output.push({ type: "result", subtype: "success", session_id: thread.providerThreadId, uuid: "active-result", is_error: false, result: "", permission_denials: [] });
    await tick();
    expect(saveSnapshot).toHaveBeenCalledTimes(1);
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM provider_thread_active_turns WHERE thread_id = ?").get(thread.id).count).toBe(0);

    await provider.stop();
    database.db.close();
  });

  it("keeps internal workflow helpers ephemeral and denies their tool calls", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-workflow-helper-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const output = new AsyncPromptQueue();
    let queryArguments;
    const provider = new ClaudeProvider({
      database,
      queryFactory: (args) => {
        queryArguments = args;
        return {
          [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
          close: vi.fn()
        };
      }
    });
    await provider.start();

    const { thread } = await provider.request("thread/start", {
      cwd: directory,
      model: "sonnet",
      permissionMode: "read-only",
      ephemeral: true,
      internalNoTools: true
    });
    await provider.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "Return a workflow graph" }],
      model: "sonnet",
      permissionMode: "read-only"
    });

    await expect(queryArguments.options.canUseTool("Read", { file_path: "AGENTS.md" }, {})).resolves.toMatchObject({
      behavior: "deny",
      message: "This internal helper cannot use tools"
    });
    await expect(queryArguments.options.canUseTool("mcp__pixice_bridge__spawn_thread", {}, {})).resolves.toMatchObject({ behavior: "deny" });
    expect(database.getThreadProviderBinding(thread.id)).toBeNull();

    await provider.stop();
    database.db.close();
  });

  it("coalesces real Claude block streams by API response id without empty reasoning or duplicate messages", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-real-stream-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const output = new AsyncPromptQueue();
    const provider = new ClaudeProvider({
      database,
      queryFactory: () => ({ [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), close: vi.fn() })
    });
    await provider.start();
    const { thread } = await provider.request("thread/start", { cwd: directory, model: "sonnet" });
    await provider.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Think and answer" }], model: "sonnet" });

    output.push({ type: "stream_event", session_id: thread.providerThreadId, uuid: "partial-start", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg-api-1" } } });
    output.push({ type: "stream_event", session_id: thread.providerThreadId, uuid: "partial-thinking", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Carefully" } } });
    output.push({ type: "assistant", session_id: thread.providerThreadId, uuid: "completed-thinking", parent_tool_use_id: null, message: { id: "msg-api-1", content: [{ type: "thinking", thinking: "Carefully" }] } });
    output.push({ type: "stream_event", session_id: thread.providerThreadId, uuid: "partial-text", parent_tool_use_id: null, event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Final answer" } } });
    output.push({ type: "assistant", session_id: thread.providerThreadId, uuid: "completed-text", parent_tool_use_id: null, message: { id: "msg-api-1", content: [{ type: "text", text: "Final answer" }] } });
    output.push({ type: "result", subtype: "success", session_id: thread.providerThreadId, uuid: "result", is_error: false, result: "Final answer", modelUsage: {} });
    await tick();

    const items = (await provider.request("thread/read", { threadId: thread.id })).thread.turns[0].items;
    expect(items.filter((item) => item.type === "agentMessage")).toEqual([
      expect.objectContaining({ id: "claude-message:msg-api-1:1", text: "Final answer", phase: "final_answer" })
    ]);
    expect(items.filter((item) => item.type === "reasoning")).toEqual([
      expect.objectContaining({ id: "claude-reasoning:msg-api-1:0", summary: [{ type: "summary_text", text: "Carefully" }] })
    ]);
    await provider.stop();
    database.db.close();
  });

  it("forks through the selected native assistant message and remaps copied transcript UUIDs", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-fork-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const outputs = [];
    const queryOptions = [];
    const sourceAssistant = {
      type: "assistant",
      session_id: "source-session",
      uuid: "assistant-source",
      parent_tool_use_id: null,
      message: { id: "response-1", content: [{ type: "text", text: "The ordinary final answer" }] }
    };
    const forkedAssistant = { ...structuredClone(sourceAssistant), session_id: "forked-session", uuid: "assistant-forked" };
    const sessionFork = vi.fn().mockResolvedValue({ sessionId: "forked-session" });
    const sessionMessages = vi.fn(async (sessionId) => sessionId === "forked-session" ? [forkedAssistant] : [sourceAssistant]);
    const sessionDelete = vi.fn().mockResolvedValue(undefined);
    const provider = new ClaudeProvider({
      database,
      clientVersion: "test",
      sessionFork,
      sessionMessages,
      sessionDelete,
      queryFactory: ({ options }) => {
        const output = new AsyncPromptQueue();
        outputs.push(output);
        queryOptions.push(options);
        return { [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), close: vi.fn() };
      }
    });
    const events = [];
    provider.on("event", (event) => events.push(event));
    await provider.start();

    const { thread } = await provider.request("thread/start", {
      cwd: directory,
      runtimeWorkspaceRoots: [directory, path.join(directory, "shared")],
      model: "sonnet",
      permissionMode: "read-only",
      developerInstructions: "Keep the fork instructions. ",
      parentThreadId: "bridge-parent"
    });
    thread.bridge = { kind: "pixiceBridge", parentThreadId: "bridge-parent" };
    thread.bridgeModel = "claude:sonnet";
    thread.agentNickname = "Backend helper";
    thread.agentRole = "Backend work";
    thread.agentStatusMessage = "Done";
    await provider.request("thread/name/set", { threadId: thread.id, name: "Source task" });
    const { turn } = await provider.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "Give me the answer" }],
      effort: "high"
    });
    outputs[0].push(sourceAssistant);
    outputs[0].push({
      type: "result",
      subtype: "success",
      session_id: thread.providerThreadId,
      uuid: "result-source",
      is_error: false,
      result: "The ordinary final answer",
      modelUsage: {}
    });
    await tick();
    const source = (await provider.request("thread/read", { threadId: thread.id })).thread;
    const finalItem = source.turns[0].items.find((item) => item.type === "agentMessage" && item.phase === "final_answer");
    await provider.stop();
    await provider.start();
    events.length = 0;

    const result = await provider.request("thread/fork", {
      threadId: thread.id,
      lastTurnId: turn.id,
      lastItemId: finalItem.id
    });

    expect(sessionFork).toHaveBeenCalledWith(thread.providerThreadId, {
      dir: directory,
      upToMessageId: "assistant-source",
      title: "Source task (fork)"
    });
    expect(sessionMessages).toHaveBeenCalledWith(thread.providerThreadId, { dir: directory, includeSystemMessages: true });
    expect(sessionMessages).toHaveBeenCalledWith("forked-session", { dir: directory, includeSystemMessages: true });
    expect(sessionDelete).not.toHaveBeenCalled();
    expect(result.thread).toMatchObject({
      providerThreadId: "forked-session",
      name: "Source task (fork)",
      parentThreadId: null,
      forkedFromId: thread.id,
      status: { type: "idle" }
    });
    expect(result.thread).not.toHaveProperty("bridge");
    expect(result.thread).not.toHaveProperty("bridgeModel");
    expect(result.thread).not.toHaveProperty("agentNickname");
    expect(result.thread).not.toHaveProperty("agentRole");
    expect(result.thread).not.toHaveProperty("agentStatusMessage");
    expect(result.thread.turns[0].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: finalItem.id, phase: "final_answer", sourceUuid: "assistant-forked" })
    ]));
    expect(database.getThreadProviderBinding(result.thread.id)).toMatchObject({
      provider: "claude",
      providerThreadId: "forked-session",
      resumeCursor: "forked-session",
      forkedFromId: thread.id
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "TaskUpdated", payload: expect.objectContaining({ method: "thread/started", thread: expect.objectContaining({ id: result.thread.id }) }) })
    ]);

    await provider.request("turn/start", {
      threadId: result.thread.id,
      input: [{ type: "text", text: "Continue separately" }]
    });
    expect(queryOptions[1]).toMatchObject({
      model: "sonnet",
      effort: "high",
      permissionMode: "default",
      resume: "forked-session",
      systemPrompt: { append: "Keep the fork instructions. " }
    });
    expect(queryOptions[1].additionalDirectories).toEqual([directory, path.join(directory, "shared")]);

    await provider.stop();
    database.db.close();
  });

  it("forks a synthetic result answer through its native transcript cutoff", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-result-fork-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const output = new AsyncPromptQueue();
    const sourceAssistant = {
      type: "assistant",
      session_id: "source-session",
      uuid: "assistant-source",
      parent_tool_use_id: null,
      message: { id: "response-1", content: [{ type: "text", text: "Synthetic final answer" }] }
    };
    const forkedAssistant = { ...structuredClone(sourceAssistant), session_id: "forked-session", uuid: "assistant-forked" };
    const sessionFork = vi.fn().mockResolvedValue({ sessionId: "forked-session" });
    const sessionMessages = vi.fn(async (sessionId) => sessionId === "forked-session" ? [forkedAssistant] : [sourceAssistant]);
    const provider = new ClaudeProvider({
      database,
      sessionFork,
      sessionMessages,
      sessionDelete: vi.fn(),
      queryFactory: () => ({ [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), close: vi.fn() })
    });
    await provider.start();
    const { thread } = await provider.request("thread/start", { cwd: directory, model: "sonnet" });
    const { turn } = await provider.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "Answer without an assistant event" }]
    });
    output.push({
      type: "result",
      subtype: "success",
      session_id: thread.providerThreadId,
      uuid: "result-source",
      is_error: false,
      result: "Synthetic final answer",
      modelUsage: {}
    });
    await tick();

    const source = (await provider.request("thread/read", { threadId: thread.id })).thread;
    const finalItem = source.turns[0].items.find((item) => item.type === "agentMessage" && item.phase === "final_answer");
    expect(finalItem).toMatchObject({ sourceUuid: "result-source" });

    const result = await provider.request("thread/fork", {
      threadId: thread.id,
      lastTurnId: turn.id,
      lastItemId: finalItem.id
    });

    expect(sessionFork).toHaveBeenCalledWith(thread.providerThreadId, {
      dir: directory,
      upToMessageId: "result-source"
    });
    expect(result.thread).toMatchObject({ forkedFromId: thread.id, status: { type: "idle" } });
    expect(result.thread.turns[0].items.find((item) => item.id === finalItem.id)).not.toHaveProperty("sourceUuid");

    await provider.stop();
    database.db.close();
  });

  it("uses structured tool results and denial events as the authority for tool status", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-tool-results-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const output = new AsyncPromptQueue();
    const provider = new ClaudeProvider({
      database,
      queryFactory: () => ({ [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), close: vi.fn() })
    });
    await provider.start();
    const { thread } = await provider.request("thread/start", { cwd: directory });
    await provider.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Run tools" }] });

    output.push({ type: "assistant", session_id: thread.providerThreadId, uuid: "tools", parent_tool_use_id: null, message: { id: "tools-response", content: [
      { type: "tool_use", id: "bash-ok", name: "Bash", input: { command: "printf ok" } },
      { type: "tool_use", id: "edit-ok", name: "Edit", input: { file_path: "src/a.js", old_string: "a", new_string: "b" } },
      { type: "tool_use", id: "bash-denied", name: "Bash", input: { command: "unsafe" } }
    ] } });
    output.push({ type: "user", session_id: thread.providerThreadId, uuid: "bash-result", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "bash-ok", content: "ok" }] }, tool_use_result: { stdout: "ok", stderr: "", interrupted: false } });
    output.push({ type: "user", session_id: thread.providerThreadId, uuid: "edit-result", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "edit-ok", content: "edited" }] }, tool_use_result: { filePath: "src/a.js", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] } });
    output.push({ type: "system", subtype: "permission_denied", session_id: thread.providerThreadId, uuid: "denied", tool_use_id: "bash-denied", tool_name: "Bash", message: "Blocked by policy" });
    output.push({ type: "result", subtype: "success", session_id: thread.providerThreadId, uuid: "result", is_error: false, result: "Tools handled", modelUsage: {} });
    await tick();

    const items = (await provider.request("thread/read", { threadId: thread.id })).thread.turns[0].items;
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "bash-ok", status: "completed", aggregatedOutput: "ok" }),
      expect.objectContaining({ id: "edit-ok", status: "completed", path: "src/a.js", changes: [expect.objectContaining({ path: "src/a.js", patch: expect.any(Array) })] }),
      expect.objectContaining({ id: "bash-denied", status: "failed", failure: { message: "Blocked by policy" } }),
      expect.objectContaining({ type: "agentMessage", text: "Tools handled", phase: "final_answer" })
    ]));
    await provider.stop();
    database.db.close();
  });

  it("records only cumulative usage deltas and recreates the query when effort changes", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-usage-delta-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const outputs = [];
    const queries = [];
    const provider = new ClaudeProvider({
      database,
      queryFactory: ({ options }) => {
        const output = new AsyncPromptQueue();
        outputs.push(output);
        const query = { options, [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), close: vi.fn() };
        queries.push(query);
        return query;
      }
    });
    const events = [];
    provider.on("event", (event) => events.push(event));
    await provider.start();
    const { thread } = await provider.request("thread/start", { cwd: directory, model: "sonnet" });
    await provider.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "One" }], effort: "high" });
    outputs[0].push({ type: "result", subtype: "success", session_id: thread.providerThreadId, uuid: "r1", is_error: false, result: "One", modelUsage: { sonnet: { inputTokens: 10, outputTokens: 5, costUSD: 0.01 } } });
    await tick();
    await provider.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Two" }], effort: "high" });
    expect(queries).toHaveLength(1);
    outputs[0].push({ type: "result", subtype: "success", session_id: thread.providerThreadId, uuid: "r2", is_error: false, result: "Two", modelUsage: { sonnet: { inputTokens: 15, outputTokens: 8, costUSD: 0.016 } } });
    await tick();
    await provider.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Three" }], effort: "low" });
    expect(queries).toHaveLength(2);
    expect(queries[0].close).toHaveBeenCalled();
    expect(queries.map((query) => query.options.effort)).toEqual(["high", "low"]);
    outputs[1].push({ type: "result", subtype: "success", session_id: thread.providerThreadId, uuid: "r3", is_error: false, result: "Three", modelUsage: { sonnet: { inputTokens: 3, outputTokens: 2, costUSD: 0.004 } } });
    await tick();

    const usage = events.filter((event) => event.payload.method === "provider/usage/recorded").map((event) => event.payload);
    expect(usage.map((event) => event.usage)).toEqual([
      expect.objectContaining({ inputTokens: 10, outputTokens: 5 }),
      expect.objectContaining({ inputTokens: 5, outputTokens: 3 }),
      expect.objectContaining({ inputTokens: 3, outputTokens: 2 })
    ]);
    expect(usage.map((event) => Number(event.costUsd.toFixed(3)))).toEqual([0.01, 0.006, 0.004]);
    await provider.stop();
    database.db.close();
  });

  it("fails pending tools on interruption and never carries them into the next turn", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-interrupt-tools-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const output = new AsyncPromptQueue();
    const query = { [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), interrupt: vi.fn(), close: vi.fn() };
    const provider = new ClaudeProvider({ database, queryFactory: () => query });
    await provider.start();
    const { thread } = await provider.request("thread/start", { cwd: directory });
    const { turn } = await provider.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Long command" }] });
    output.push({ type: "assistant", session_id: thread.providerThreadId, uuid: "tool", parent_tool_use_id: null, message: { id: "response", content: [{ type: "tool_use", id: "stale", name: "Bash", input: { command: "sleep" } }] } });
    await tick();
    await provider.request("turn/interrupt", { threadId: thread.id, turnId: turn.id });
    await provider.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Next" }] });
    output.push({ type: "result", subtype: "success", session_id: thread.providerThreadId, uuid: "next-result", is_error: false, result: "Next", modelUsage: {} });
    await tick();

    const turns = (await provider.request("thread/read", { threadId: thread.id })).thread.turns;
    expect(turns[0]).toMatchObject({ status: "interrupted", items: expect.arrayContaining([expect.objectContaining({ id: "stale", status: "failed" })]) });
    expect(turns[1].items.some((item) => item.id === "stale")).toBe(false);
    await provider.stop();
    database.db.close();
  });

  it("routes Claude task lifecycle events and retracts refusal output without leaking subagent text", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-task-events-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const output = new AsyncPromptQueue();
    const provider = new ClaudeProvider({ database, queryFactory: () => ({ [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), close: vi.fn() }) });
    await provider.start();
    const { thread } = await provider.request("thread/start", { cwd: directory });
    await provider.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Delegate" }] });

    output.push({ type: "assistant", session_id: thread.providerThreadId, uuid: "refused-frame", parent_tool_use_id: null, message: { id: "refused-response", content: [{ type: "text", text: "Refused partial" }] } });
    output.push({ type: "system", subtype: "model_refusal_fallback", session_id: thread.providerThreadId, uuid: "fallback", original_model: "opus", fallback_model: "sonnet", content: "Retrying with Sonnet", retracted_message_uuids: ["refused-frame"] });
    output.push({ type: "system", subtype: "api_retry", session_id: thread.providerThreadId, uuid: "retry", attempt: 1, max_retries: 3, error: "overloaded", retry_delay_ms: 10, error_status: 529 });
    output.push({ type: "assistant", session_id: thread.providerThreadId, uuid: "agent-tool", parent_tool_use_id: null, message: { id: "agent-response", content: [{ type: "tool_use", id: "agent-use", name: "Agent", input: { prompt: "Investigate" } }] } });
    output.push({ type: "system", subtype: "task_started", session_id: thread.providerThreadId, uuid: "task-start", task_id: "agent-42", tool_use_id: "agent-use", description: "Investigating", subagent_type: "Explore" });
    output.push({ type: "assistant", session_id: thread.providerThreadId, uuid: "subagent-text", parent_tool_use_id: "agent-use", message: { id: "sub-response", content: [{ type: "text", text: "private subagent transcript" }] } });
    output.push({ type: "system", subtype: "task_progress", session_id: thread.providerThreadId, uuid: "task-progress", task_id: "agent-42", tool_use_id: "agent-use", description: "Reading files", summary: "Found the handler", usage: { total_tokens: 20, tool_uses: 2, duration_ms: 50 } });
    output.push({ type: "tool_use_summary", session_id: thread.providerThreadId, uuid: "summary", summary: "Investigation complete", preceding_tool_use_ids: ["agent-use"] });
    output.push({ type: "result", subtype: "success", session_id: thread.providerThreadId, uuid: "result", is_error: false, result: "Delegated", modelUsage: {} });
    await tick();
    output.push({ type: "system", subtype: "task_notification", session_id: thread.providerThreadId, uuid: "task-end", task_id: "agent-42", tool_use_id: "agent-use", status: "completed", summary: "All done", output_file: "/tmp/result" });
    await tick();

    const items = (await provider.request("thread/read", { threadId: thread.id })).thread.turns[0].items;
    expect(items.some((item) => item.text === "Refused partial" || item.text === "private subagent transcript")).toBe(false);
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "reasoning", summary: [expect.objectContaining({ text: "Retrying with Sonnet" })] }),
      expect.objectContaining({ type: "reasoning", summary: [expect.objectContaining({ text: expect.stringContaining("retrying 1/3") })] }),
      expect.objectContaining({ id: "agent-use", status: "completed", receiverThreadIds: ["agent-42"], agentsStates: { "agent-42": expect.objectContaining({ status: "completed", message: "All done" }) } })
    ]));
    await provider.stop();
    database.db.close();
  });

  it("surfaces success-shaped Claude API errors and recovers cleanly from query creation failure", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-visible-errors-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const output = new AsyncPromptQueue();
    const factory = vi.fn()
      .mockImplementationOnce(() => { throw new Error("Claude executable failed to start"); })
      .mockImplementation(() => ({ [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), close: vi.fn() }));
    const provider = new ClaudeProvider({ database, queryFactory: factory });
    await provider.start();
    const { thread } = await provider.request("thread/start", { cwd: directory });
    await expect(provider.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "First" }] })).rejects.toThrow("Claude executable failed to start");
    await provider.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Second" }] });
    output.push({ type: "result", subtype: "success", session_id: thread.providerThreadId, uuid: "api-error", is_error: true, result: "Authentication expired", modelUsage: {} });
    await tick();

    const turns = (await provider.request("thread/read", { threadId: thread.id })).thread.turns;
    expect(turns[0]).toMatchObject({ status: "failed", error: { message: "Claude executable failed to start" } });
    expect(turns[1]).toMatchObject({
      status: "failed",
      error: { message: "Authentication expired" },
      items: expect.arrayContaining([expect.objectContaining({ type: "agentMessage", text: "Authentication expired", phase: "final_answer", error: true })])
    });
    await provider.stop();
    database.db.close();
  });
});

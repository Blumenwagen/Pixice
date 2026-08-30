import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, formatElapsedDuration, generatedImageAttachment, generatedImageRevisionPrompt, horizontalPopoverShift } from "../src/App.jsx";
import { WorkflowHost } from "../src/components/workflows/WorkflowHost.jsx";

const appCss = readFileSync("src/styles.css", "utf8");

it("keeps picker popovers aligned inside the prompt box", () => {
  expect(horizontalPopoverShift(
    { left: 42, right: 382, width: 340 },
    { left: 80, right: 464 },
    0
  )).toBe(38);
  expect(horizontalPopoverShift(
    { left: 150, right: 490, width: 340 },
    { left: 80, right: 464 },
    0
  )).toBe(-26);
});

const project = {
  id: "project-1",
  displayName: "Aurora",
  canonicalPath: "/work/aurora",
  icon: "code",
  color: "purple",
  folders: ["/work/aurora", "/work/shared"],
  repository: { kind: "git", root: "/work/aurora", baseCommit: "abc", dirtyPaths: ["src/auth.js"] }
};

const thread = {
  id: "thread-1",
  name: "Refactor authentication",
  preview: "Refactor authentication",
  cwd: "/work/aurora",
  parentThreadId: null,
  status: { type: "idle" },
  updatedAt: Math.floor(Date.now() / 1000),
  turns: [{
    id: "turn-1",
    status: "completed",
    items: [
      { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Refactor authentication" }] },
      { id: "agent-1", type: "agentMessage", text: "I traced the current flow.\n\n## Summary\n\n- Sessions use **cookies**\n- Tests run with `pnpm test`\n\n| Area | State |\n| --- | --- |\n| [Runtime](src/runtime.js) | Ready |", phase: "final_answer" }
    ]
  }]
};

function createApi(threadValue = thread, initialProactiveSuggestions = []) {
  const eventListeners = new Set();
  const threadValues = Array.isArray(threadValue) ? threadValue : [threadValue];
  let boardTasks = [];
  let boardPhases = [];
  let proactiveSuggestions = [...initialProactiveSuggestions];
  const browserState = {
    native: false,
    activeTabId: "browser-1",
    tabs: [{ id: "browser-1", title: "New tab", url: "", loading: false, error: null, canGoBack: false, canGoForward: false }]
  };
  const scopedBrowserState = (payload = {}) => ({ ...browserState, workspaceId: payload.workspaceId });
  const api = {
    emit(event) { eventListeners.forEach((listener) => listener(event)); },
    app: {
      platform: "test",
      bootstrap: vi.fn().mockResolvedValue({ projects: [project], models: [{ id: "gpt", model: "gpt-5.6", displayName: "GPT-5.6", provider: "codex", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], runtime: { state: "ready", connected: true }, settings: {} }),
      saveSettings: vi.fn().mockResolvedValue({})
    },
    runtime: { status: vi.fn().mockResolvedValue({ state: "ready", connected: true }) },
    providers: {
      list: vi.fn().mockResolvedValue([
        { id: "codex", connected: true, status: { state: "ready", message: "Codex app server" }, account: { type: "chatgpt", email: "dev@example.com", planType: "plus" }, authenticated: true, requiresAuth: true, sessionCount: 3, loginAvailable: true },
        { id: "claude", connected: true, status: { state: "ready", message: "Claude runtime available" }, account: null, authenticated: false, requiresAuth: true, sessionCount: 0, loginAvailable: true }
      ]),
      install: vi.fn().mockResolvedValue({}),
      locate: vi.fn().mockResolvedValue({}),
      repair: vi.fn().mockResolvedValue({}),
      checkUpdates: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      login: vi.fn().mockResolvedValue({ provider: "claude", opened: true }),
      logout: vi.fn().mockResolvedValue({})
    },
    git: {
      status: vi.fn().mockResolvedValue({ state: "ready", available: true, installSupported: false, executablePath: "/usr/bin/git", version: "git version 2.50.1", message: "git version 2.50.1 is ready." }),
      installCommandLineTools: vi.fn().mockResolvedValue({ state: "install-requested", available: false, installSupported: true, installRequested: true, executablePath: null, version: null, message: "Finish the Apple Command Line Tools installation, then choose Check again." })
    },
    github: {
      status: vi.fn().mockResolvedValue({ available: true, authenticated: false, source: "bundled", version: "2.80.0", account: null, message: "Sign in to use GitHub from agents." }),
      login: vi.fn().mockResolvedValue({ available: true, authenticated: true, source: "bundled", version: "2.80.0", account: { login: "octocat", name: "The Octocat" }, message: "Signed in as octocat." }),
      logout: vi.fn().mockResolvedValue({ available: true, authenticated: false, source: "bundled", version: "2.80.0", account: null, message: "Sign in to use GitHub from agents." })
    },
    usage: {
      summary: vi.fn().mockResolvedValue({
        rangeDays: 30,
        recordingStartedAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-08-19T10:00:00.000Z",
        pricingVerifiedAt: "2026-08-19",
        stats: {
          todayCostUsd: 1.24,
          currentWeekCostUsd: 8.75,
          currentMonthCostUsd: 31.5,
          projectedMonthCostUsd: 51.39,
          dailyAverageCostUsd: 1.66,
          weeklyAverageCostUsd: 11.61,
          monthlyAverageCostUsd: 50.52,
          allTimeCostUsd: 96.42,
          allTimeTokens: 2_400_000
        },
        selected: {
          inputTokens: 800_000,
          cachedInputTokens: 1_200_000,
          cacheWriteInputTokens: 40_000,
          outputTokens: 360_000,
          reasoningOutputTokens: 180_000,
          totalTokens: 2_400_000,
          costUsd: 31.5,
          events: 24,
          unpricedEvents: 0,
          unpricedTokens: 0
        },
        daily: Array.from({ length: 30 }, (_, index) => ({ date: `2026-08-${String(index + 1).padStart(2, "0")}`, costUsd: index / 10, totalTokens: index * 1_000 })),
        heatmapDaily: Array.from({ length: 365 }, (_, index) => {
          const date = new Date(2025, 7, 20);
          date.setDate(date.getDate() + index);
          return { date: date.toISOString().slice(0, 10), costUsd: index % 9 === 0 ? index / 100 : 0, totalTokens: index * 750, events: index % 9 === 0 ? 1 : 0 };
        }),
        models: [
          { provider: "codex", model: "gpt-5.6-sol", costUsd: 23.5, totalTokens: 1_600_000 },
          { provider: "claude", model: "claude-sonnet-5", costUsd: 8, totalTokens: 800_000 }
        ],
        pricing: [
          { provider: "codex", model: "gpt-5.6-sol", label: "GPT-5.6 Sol", rates: { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 30 }, fastRates: { input: 10, cachedInput: 1, cacheWriteInput: 12.5, output: 60 } },
          { provider: "claude", model: "claude-sonnet-5", label: "Claude Sonnet 5", rates: { input: 2, cachedInput: 0.2, cacheWriteInput: 2.5, output: 10 }, fastRates: null }
        ]
      }),
      limits: vi.fn().mockResolvedValue({
        status: "available",
        fetchedAt: "2026-08-25T10:00:00.000Z",
        providers: [{
          provider: "codex",
          label: "Codex",
          status: "available",
          planType: "prolite",
          limits: [
          {
            id: "codex",
            name: null,
            planType: "prolite",
            windows: [{ usedPercent: 34, remainingPercent: 66, windowDurationMins: 10_080, resetsAt: Math.floor(Date.now() / 1000) + 86_400 }],
            credits: { hasCredits: false, unlimited: false, balance: "0" },
            individualLimit: null,
            spendControlReached: false,
            rateLimitReachedType: null
          },
          {
            id: "codex_spark",
            name: "GPT-5.3-Codex-Spark",
            planType: "prolite",
            windows: [
              { usedPercent: 12, remainingPercent: 88, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3_600 },
              { usedPercent: 47, remainingPercent: 53, windowDurationMins: 10_080, resetsAt: Math.floor(Date.now() / 1000) + 172_800 }
            ],
            credits: null,
            individualLimit: null,
            spendControlReached: false,
            rateLimitReachedType: null
          }
          ],
          resetCredits: { availableCount: 1, credits: [{ id: "reset-1", title: "Full reset", description: null, expiresAt: null }] }
        }, {
          provider: "claude",
          label: "Claude",
          status: "available",
          planType: "max",
          limits: [{
            id: "claude",
            name: "Claude",
            planType: "max",
            windows: [
              { usedPercent: 21, remainingPercent: 79, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3_600 },
              { usedPercent: 43, remainingPercent: 57, windowDurationMins: 10_080, resetsAt: Math.floor(Date.now() / 1000) + 172_800 }
            ],
            credits: null,
            individualLimit: null,
            spendControlReached: false,
            rateLimitReachedType: null
          }],
          resetCredits: { availableCount: 0, credits: [] }
        }]
      })
    },
    updates: {
      status: vi.fn().mockResolvedValue({ supported: false, state: "development", currentVersion: "0.0.0", availableVersion: null, percent: 0, message: "Updates are available in packaged Pixice builds." }),
      check: vi.fn().mockResolvedValue({ supported: false, state: "development", currentVersion: "0.0.0", availableVersion: null, percent: 0, message: "Updates are available in packaged Pixice builds." }),
      download: vi.fn(),
      install: vi.fn()
    },
    browser: {
      state: vi.fn(async (payload) => scopedBrowserState(payload)),
      create: vi.fn(async (payload) => scopedBrowserState(payload)),
      close: vi.fn(async (payload) => scopedBrowserState(payload)),
      activate: vi.fn(async (payload) => scopedBrowserState(payload)),
      navigate: vi.fn(async (payload) => scopedBrowserState(payload)),
      history: vi.fn(async (payload) => scopedBrowserState(payload)),
      setViewport: vi.fn(async (payload) => scopedBrowserState(payload)),
      adopt: vi.fn(async ({ toWorkspaceId }) => scopedBrowserState({ workspaceId: toWorkspaceId })),
      destroy: vi.fn().mockResolvedValue({ destroyed: true })
    },
    preview: { setContext: vi.fn().mockResolvedValue({ open: false, tabCount: 0, active: null }) },
    ios: {
      environment: vi.fn().mockResolvedValue({ ready: true, simulators: [{ udid: "SIM-1", name: "iPhone 17 Pro" }], issues: [] }),
      discover: vi.fn().mockResolvedValue([{ path: "/work/aurora/Aurora.xcodeproj", relativePath: "Aurora.xcodeproj", schemes: ["Aurora"] }]),
      createStarter: vi.fn().mockResolvedValue({ created: true }),
      start: vi.fn().mockResolvedValue({ id: "ios-session-1", status: "ready", scheme: "Aurora", deviceName: "iPhone 17 Pro", simulatorUdid: "SIM-1", previewUrl: "http://127.0.0.1:3200" }),
      state: vi.fn().mockResolvedValue(null),
      stop: vi.fn().mockResolvedValue({ status: "stopped" }),
      action: vi.fn().mockResolvedValue({ ok: true }),
      adopt: vi.fn().mockResolvedValue(null)
    },
    files: {
      read: vi.fn(async ({ path }) => ({
        path: path.startsWith("/") ? path.replace(/:\d+$/, "") : `/work/aurora/${path.replace(/:\d+$/, "")}`,
        relativePath: path.replace(/:\d+$/, ""),
        name: path.replace(/:\d+$/, "").split("/").at(-1),
        extension: `.${path.replace(/:\d+$/, "").split(".").at(-1)}`,
        kind: path.endsWith(".md") ? "markdown" : "text",
        content: "export const ready = true;\n",
        editable: true,
        size: 27,
        mtimeMs: 1
      })),
      preview: vi.fn(async ({ path }) => ({
        path: path.startsWith("/") ? path.replace(/:\d+$/, "") : `/work/aurora/${path.replace(/:\d+$/, "")}`,
        relativePath: path.replace(/:\d+$/, ""),
        name: path.replace(/:\d+$/, "").split("/").at(-1),
        extension: `.${path.replace(/:\d+$/, "").split(".").at(-1)}`,
        kind: path.endsWith(".md") ? "markdown" : "text",
        content: "export const ready = true;\n",
        editable: true,
        size: 27,
        mtimeMs: 1
      })),
      write: vi.fn(async ({ path, content }) => ({
        path,
        relativePath: path.replace("/work/aurora/", ""),
        name: path.split("/").at(-1),
        extension: `.${path.split(".").at(-1)}`,
        kind: path.endsWith(".md") ? "markdown" : "text",
        content,
        editable: true,
        size: content.length,
        mtimeMs: 2
      }))
    },
    projects: {
      list: vi.fn().mockResolvedValue([project]),
      touch: vi.fn().mockResolvedValue(null),
      pickFolders: vi.fn().mockResolvedValue(["/work/aurora", "/work/shared"]),
      create: vi.fn().mockResolvedValue(project),
      delete: vi.fn().mockResolvedValue(project)
    },
    board: {
      list: vi.fn(async () => ({ data: boardTasks, phases: boardPhases })),
      create: vi.fn(async (payload) => {
        const task = { id: `task-${boardTasks.length + 1}`, ...payload, description: payload.description ?? "", position: (boardTasks.length + 1) * 1024, threadId: null, createdAt: "2026-08-19T12:00:00.000Z", updatedAt: "2026-08-19T12:00:00.000Z" };
        boardTasks = [...boardTasks, task];
        return task;
      }),
      update: vi.fn(async (payload) => {
        boardTasks = boardTasks.map((task) => task.id === payload.taskId ? { ...task, ...payload, id: task.id } : task);
        return boardTasks.find((task) => task.id === payload.taskId);
      }),
      move: vi.fn(async (payload) => {
        boardTasks = boardTasks.map((task) => task.id === payload.taskId ? { ...task, column: payload.column, updatedAt: "2026-08-19T12:00:00.000Z" } : task);
        return boardTasks.find((task) => task.id === payload.taskId);
      }),
      delete: vi.fn(async ({ taskId }) => {
        const task = boardTasks.find((candidate) => candidate.id === taskId);
        boardTasks = boardTasks.filter((candidate) => candidate.id !== taskId);
        return task;
      }),
      attach: vi.fn(async ({ taskId, threadId }) => {
        boardTasks = boardTasks.map((task) => task.id === taskId ? { ...task, threadId } : task);
        return boardTasks.find((task) => task.id === taskId);
      }),
      createPhase: vi.fn(async ({ projectId, title, taskIds }) => {
        const phaseTasks = boardTasks.filter((task) => taskIds.includes(task.id));
        const starts = phaseTasks.map((task) => Date.parse(task.schedule?.plannedStart)).filter(Number.isFinite);
        const ends = phaseTasks.map((task) => Date.parse(task.schedule?.plannedEnd ?? task.schedule?.plannedStart)).filter(Number.isFinite);
        const phase = {
          id: `phase-${boardPhases.length + 1}`,
          projectId,
          title,
          taskIds,
          tasks: phaseTasks.map((task) => ({ id: task.id, title: task.title, column: task.column })),
          plannedStart: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
          plannedEnd: ends.length ? new Date(Math.max(...ends)).toISOString() : null,
          completedCount: phaseTasks.filter((task) => task.column === "done").length
        };
        boardPhases = [...boardPhases, phase];
        boardTasks = boardTasks.map((task) => taskIds.includes(task.id) ? { ...task, phaseId: phase.id } : task);
        return phase;
      })
    },
    proactivity: {
      list: vi.fn(async ({ threadId }) => ({ data: proactiveSuggestions.filter((suggestion) => !threadId || suggestion.threadId === threadId) })),
      resolve: vi.fn(async ({ suggestionId, decision }) => {
        const suggestion = proactiveSuggestions.find((candidate) => candidate.id === suggestionId);
        proactiveSuggestions = proactiveSuggestions.filter((candidate) => candidate.id !== suggestionId);
        return { suggestion: { ...suggestion, status: decision === "accept" ? "accepted" : "dismissed" } };
      })
    },
    threads: {
      list: vi.fn().mockResolvedValue({ data: threadValues, nextCursor: null }),
      read: vi.fn(async ({ threadId }) => ({ thread: threadValues.find((candidate) => candidate.id === threadId) ?? threadValues[0] })),
      children: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
      create: vi.fn().mockResolvedValue({ thread: { ...thread, id: "thread-new", name: null, preview: "", turns: [] } }),
      archive: vi.fn().mockResolvedValue({})
    },
    turns: {
      start: vi.fn().mockResolvedValue({ turn: { id: "turn-new", status: "inProgress", items: [] } }),
      steer: vi.fn().mockResolvedValue({}),
      interrupt: vi.fn().mockResolvedValue({})
    },
    approvals: { resolve: vi.fn().mockResolvedValue({ ok: true }) },
    requests: { respond: vi.fn().mockResolvedValue({ ok: true }) },
    questions: { respond: vi.fn().mockResolvedValue({ ok: true }) },
    elicitations: { respond: vi.fn().mockResolvedValue({ ok: true }) },
    review: {
      read: vi.fn().mockResolvedValue({ repository: project.repository, diff: "diff --git a/src/auth.js b/src/auth.js\n--- a/src/auth.js\n+++ b/src/auth.js\n@@ -1 +1 @@\n-old\n+new" }),
      file: vi.fn().mockResolvedValue({ path: "src/auth.js", baseCommit: "abc", diff: "diff --git a/src/auth.js b/src/auth.js\n--- a/src/auth.js\n+++ b/src/auth.js\n@@ -1 +1 @@\n-old\n+new" })
    },
    models: { list: vi.fn().mockResolvedValue([]) },
    extensions: { list: vi.fn().mockResolvedValue({ skills: [], apps: [], mcp: [], errors: [] }) },
    external: { openEditor: vi.fn(), openTerminal: vi.fn(), reveal: vi.fn() },
    events: { subscribe: vi.fn((listener) => { eventListeners.add(listener); return () => { eventListeners.delete(listener); }; }) }
  };
  return api;
}

beforeEach(() => {
  window.pixice = createApi();
  localStorage.clear();
});

describe("Pixice app shell", () => {
  it("builds an image revision prompt and reattaches local generated image data", () => {
    expect(generatedImageRevisionPrompt("Make the sky warmer", "A blue dawn scene")).toContain("Make the sky warmer");
    expect(generatedImageRevisionPrompt("Make the sky warmer", "A blue dawn scene")).toContain("A blue dawn scene");
    expect(generatedImageRevisionPrompt("Make the sky warmer", null, false)).toContain("most recent generated image");
    expect(generatedImageAttachment("data:image/png;base64,AA==")).toEqual([{
      name: "generated-image.png",
      type: "image/png",
      size: 1,
      dataUrl: "data:image/png;base64,AA=="
    }]);
    expect(generatedImageAttachment("https://example.com/image.png")).toEqual([]);
  });

  it("formats elapsed work time without noisy units", () => {
    expect(formatElapsedDuration(8_000)).toBe("8s");
    expect(formatElapsedDuration(68_000)).toBe("1m 8s");
    expect(formatElapsedDuration(6_480_000)).toBe("1h 48m");
  });

  it("surfaces repeated work as a reviewable workflow draft suggestion", async () => {
    const suggestion = {
      id: "suggestion-1",
      projectId: project.id,
      threadId: thread.id,
      type: "workflow-pattern",
      status: "open",
      title: "Turn this into a workflow?",
      message: "Pixice has seen this sequence 3 times.",
      payload: {
        count: 3,
        suggestedName: "Desktop release check",
        steps: [
          { action: "command:git:status", label: "Run git status --short" },
          { action: "command:pnpm:test", label: "Run pnpm test" }
        ]
      }
    };
    window.pixice = createApi(thread, [suggestion]);
    const user = userEvent.setup();
    render(<App />);

    const card = await screen.findByRole("region", { name: "Turn this into a workflow?" });
    expect(card).toHaveTextContent("Pixice has seen this sequence 3 times.");
    expect(card).toHaveTextContent("Run pnpm test");
    await user.click(within(card).getByRole("button", { name: "Create draft" }));

    expect(window.pixice.proactivity.resolve).toHaveBeenCalledWith({
      projectId: project.id,
      suggestionId: suggestion.id,
      decision: "accept"
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Turn this into a workflow?" })).not.toBeInTheDocument());
  });

  it("does not apply a viewport-sized backdrop filter over native window vibrancy", () => {
    const stageRule = appCss.match(/\.pixice-stage\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(stageRule).not.toContain("backdrop-filter");
  });

  it("creates a project with chosen metadata and multiple folders", async () => {
    const createdProject = {
      id: "project-new",
      displayName: "Studio",
      canonicalPath: "/work/studio",
      icon: "code",
      color: "purple",
      folders: ["/work/studio", "/work/shared"]
    };
    window.pixice.projects.pickFolders.mockResolvedValue(createdProject.folders);
    window.pixice.projects.create.mockResolvedValue(createdProject);
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    const dialog = await screen.findByRole("dialog", { name: "Create project" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Project name" }), { target: { value: "Studio" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Code icon" }));
    fireEvent.click(within(dialog).getByRole("radio", { name: "Purple color" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add folders" }));

    expect(await within(dialog).findByText("/work/studio")).toBeInTheDocument();
    expect(within(dialog).getByText("/work/shared")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(window.pixice.projects.create).toHaveBeenCalledWith({
      displayName: "Studio",
      icon: "code",
      color: "purple",
      folders: ["/work/studio", "/work/shared"]
    }));
    expect(window.pixice.projects.pickFolders).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Studio" })).toHaveAttribute("aria-current", "true");
  });

  it("switches top project tiles and shows only the active project's threads", async () => {
    const secondProject = {
      id: "project-2",
      displayName: "Beacon",
      canonicalPath: "/work/beacon",
      icon: "terminal",
      color: "green",
      folders: ["/work/beacon"]
    };
    const secondThread = {
      ...thread,
      id: "thread-2",
      name: "Ship Beacon",
      preview: "Ship Beacon",
      cwd: "/work/beacon",
      turns: [{
        id: "turn-2",
        status: "completed",
        items: [{ id: "agent-2", type: "agentMessage", text: "Beacon is ready.", phase: "final_answer" }]
      }]
    };
    const api = createApi();
    api.app.bootstrap.mockResolvedValue({
      projects: [project, secondProject],
      models: [{ id: "gpt", model: "gpt-5.6", displayName: "GPT-5.6", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
      runtime: { state: "ready", connected: true },
      settings: {}
    });
    api.threads.list.mockImplementation(async ({ projectId }) => ({
      data: projectId === secondProject.id ? [secondThread] : [thread],
      nextCursor: null
    }));
    api.threads.read.mockImplementation(async ({ projectId }) => ({
      thread: projectId === secondProject.id ? secondThread : thread
    }));
    window.pixice = api;
    render(<App />);

    await screen.findByText("I traced the current flow.");
    expect(screen.getByRole("button", { name: "Aurora" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "Refactor authentication" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ship Beacon" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Beacon" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Beacon" })).toHaveAttribute("aria-current", "true"));
    expect(await screen.findByRole("button", { name: "Ship Beacon" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refactor authentication" })).not.toBeInTheDocument();
    expect(api.threads.list).toHaveBeenCalledWith({ projectId: "project-2" });
    expect(localStorage.getItem("pixice.activeProjectId")).toBe("project-2");
  });

  it("keeps visible project slots stable and replaces the least-recently-used slot from overflow", async () => {
    const olderProjects = Array.from({ length: 7 }, (_, index) => ({
      id: `project-${index + 2}`,
      displayName: `Project ${index + 2}`,
      canonicalPath: `/work/project-${index + 2}`,
      icon: "folder",
      color: "blue",
      folders: [`/work/project-${index + 2}`],
      updatedAt: new Date(Date.now() - ((index + 1) * 1_000)).toISOString()
    }));
    const api = createApi();
    api.app.bootstrap.mockResolvedValue({
      projects: [project, ...olderProjects],
      models: [{ id: "gpt", model: "gpt-5.6", displayName: "GPT-5.6", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
      runtime: { state: "ready", connected: true },
      settings: {}
    });
    window.pixice = api;
    render(<App />);

    await screen.findByText("I traced the current flow.");
    const recent = within(screen.getByRole("region", { name: "Projects" })).getByRole("list", { name: "Recent projects" });
    const visibleProjectNames = () => within(recent).getAllByRole("button").map((button) => button.getAttribute("aria-label"));
    expect(within(recent).getAllByRole("button")).toHaveLength(6);
    expect(visibleProjectNames()).toEqual(["Aurora", "Project 2", "Project 3", "Project 4", "Project 5", "Project 6"]);
    expect(within(recent).queryByRole("button", { name: "Project 8" })).not.toBeInTheDocument();

    fireEvent.click(within(recent).getByRole("button", { name: "Project 6" }));
    await waitFor(() => expect(within(recent).getByRole("button", { name: "Project 6" })).toHaveAttribute("aria-current", "true"));
    expect(visibleProjectNames()).toEqual(["Aurora", "Project 2", "Project 3", "Project 4", "Project 5", "Project 6"]);

    fireEvent.click(screen.getByRole("button", { name: "Show all projects" }));
    const older = within(screen.getByRole("region", { name: "Older projects" })).getByRole("list");
    fireEvent.click(within(older).getByRole("button", { name: "Project 8" }));

    await waitFor(() => expect(within(recent).getByRole("button", { name: "Project 8" })).toHaveAttribute("aria-current", "true"));
    expect(visibleProjectNames()).toEqual(["Aurora", "Project 2", "Project 3", "Project 4", "Project 8", "Project 6"]);
    expect(within(older).getByRole("button", { name: "Project 5" })).toBeInTheDocument();
    expect(api.projects.touch).toHaveBeenCalledWith({ projectId: "project-6" });
    expect(api.projects.touch).toHaveBeenCalledWith({ projectId: "project-8" });
  });

  it("creates, orders, and starts durable board tasks without making a thread first", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    expect(await screen.findByRole("heading", { name: "Plan work before it runs" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Aurora task board" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Plan release notes" } });
    fireEvent.click(within(screen.getByRole("region", { name: "Backlog" })).getByRole("button", { name: "Add task" }));

    const card = await screen.findByRole("button", { name: "Plan release notes" });
    expect(window.pixice.board.create).toHaveBeenCalledWith({
      projectId: "project-1",
      title: "Plan release notes",
      description: "",
      column: "backlog"
    });
    fireEvent.keyDown(card, { key: "ArrowLeft" });
    expect(window.pixice.board.move).not.toHaveBeenCalled();
    fireEvent.keyDown(card, { key: "ArrowRight" });

    await waitFor(() => expect(window.pixice.board.move).toHaveBeenCalledWith({
      projectId: "project-1",
      taskId: "task-1",
      column: "ready"
    }));

    const ready = screen.getByRole("region", { name: "Ready" });
    fireEvent.click(await within(ready).findByRole("button", { name: "Start Plan release notes" }));
    await waitFor(() => expect(window.pixice.board.attach).toHaveBeenCalledWith({
      projectId: "project-1",
      taskId: "task-1",
      threadId: "thread-new"
    }));
    expect(window.pixice.turns.start).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      threadId: "thread-new",
      text: "Plan release notes"
    }));
  });

  it("defaults scheduled work to Board and keeps the same items in Timeline", async () => {
    const api = createApi();
    await api.board.create({
      projectId: project.id,
      title: "Schedule editor",
      description: "Shared scheduled work",
      column: "active",
      kind: "task",
      owner: "UI agent",
      schedule: {
        plannedStart: "2026-08-17T08:00:00.000Z",
        plannedEnd: "2026-08-28T16:00:00.000Z",
        hardDeadline: "2026-08-28T16:00:00.000Z",
        timezone: "Europe/Zurich"
      }
    });
    window.pixice = api;
    localStorage.setItem(`pixice.boardDate.${project.id}`, "2026-08-25T12:00:00.000Z");
    localStorage.setItem(`pixice.boardView.${project.id}`, "calendar");
    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.click(screen.getByRole("button", { name: "Board" }));

    expect(await screen.findByRole("tab", { name: "Board" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "Calendar" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Schedule editor").length).toBeGreaterThan(0);
    expect(localStorage.getItem(`pixice.boardView.${project.id}`)).toBe("board");

    fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
    const timeline = screen.getByLabelText("Scheduled work timeline");
    expect(timeline).toHaveAttribute("data-scale", "day");
    expect(within(timeline).queryByRole("group", { name: "Timeline zoom" })).not.toBeInTheDocument();
    expect(within(timeline).getByText(/scroll to zoom/)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Timeline" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: "Previous range" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Today" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next range" })).not.toBeInTheDocument();
    expect(screen.getAllByText("1 task").length).toBeGreaterThan(0);
    expect(localStorage.getItem(`pixice.boardView.${project.id}`)).toBe("board");
  });

  it("uses an intraday scale for same-day agent work", async () => {
    const api = createApi();
    const research = await api.board.create({
      projectId: project.id,
      title: "Morning research",
      column: "done",
      kind: "task",
      owner: "Research agent",
      schedule: {
        plannedStart: new Date(2026, 7, 27, 10).toISOString(),
        plannedEnd: new Date(2026, 7, 27, 12).toISOString(),
        timezone: "Europe/Zurich"
      }
    });
    await api.board.create({
      projectId: project.id,
      title: "Synthesize findings",
      column: "active",
      kind: "task",
      owner: "Lead agent",
      dependencies: [research.id],
      schedule: {
        plannedStart: new Date(2026, 7, 27, 12).toISOString(),
        plannedEnd: new Date(2026, 7, 27, 14).toISOString(),
        timezone: "Europe/Zurich"
      }
    });
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Timeline" }));

    const timeline = screen.getByLabelText("Scheduled work timeline");
    expect(timeline).toHaveAttribute("data-scale", "hour");
    expect(within(timeline).getByText("after Morning research")).toBeInTheDocument();
    const researchBar = within(timeline).getByRole("button", { name: /Morning research,/ });
    const synthesisBar = within(timeline).getByRole("button", { name: /Synthesize findings,/ });
    expect(parseFloat(researchBar.style.left)).toBeCloseTo(100 / 6);
    expect(parseFloat(researchBar.style.width)).toBeCloseTo(200 / 6);
    expect(parseFloat(synthesisBar.style.left)).toBeCloseTo(50);
    expect(parseFloat(synthesisBar.style.width)).toBeCloseTo(200 / 6);
  });

  it("keeps ordinary wheel scrolling for rows and zooms only with a modifier", async () => {
    const api = createApi();
    await api.board.create({
      projectId: project.id,
      title: "Research window",
      column: "done",
      schedule: {
        plannedStart: new Date(2026, 7, 27, 10).toISOString(),
        plannedEnd: new Date(2026, 7, 27, 12).toISOString(),
        timezone: "Europe/Zurich"
      }
    });
    await api.board.create({
      projectId: project.id,
      title: "Delivery window",
      column: "active",
      schedule: {
        plannedStart: new Date(2026, 7, 29, 9).toISOString(),
        plannedEnd: new Date(2026, 7, 29, 14).toISOString(),
        timezone: "Europe/Zurich"
      }
    });
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Timeline" }));

    const timeline = screen.getByLabelText("Scheduled work timeline");
    const canvas = within(timeline).getByLabelText("Zoomable timeline canvas");
    expect(timeline).toHaveAttribute("data-scale", "day");
    expect(within(timeline).queryByRole("button", { name: "Phase" })).not.toBeInTheDocument();

    expect(fireEvent.wheel(canvas, { deltaY: 120, clientX: 560, clientY: 240 })).toBe(true);
    expect(timeline).toHaveAttribute("data-scale", "day");
    expect(localStorage.getItem(`pixice.timelineZoomPosition.${project.id}`)).toBeNull();

    for (let index = 0; index < 3; index += 1) expect(fireEvent.wheel(canvas, { deltaY: 120, clientX: 560, clientY: 240, metaKey: true })).toBe(false);
    expect(timeline).toHaveAttribute("data-scale", "phase");
    expect(Number(localStorage.getItem(`pixice.timelineZoomPosition.${project.id}`))).toBeGreaterThanOrEqual(1.48);

    for (let index = 0; index < 5; index += 1) fireEvent.wheel(canvas, { deltaY: -120, clientX: 560, clientY: 240, metaKey: true });
    expect(timeline).toHaveAttribute("data-scale", "hour");
  });

  it("suggests a phase and persists it only after review and confirmation", async () => {
    const api = createApi();
    await api.board.create({
      projectId: project.id,
      title: "Provider discovery",
      column: "done",
      schedule: {
        plannedStart: new Date(2026, 7, 27, 10).toISOString(),
        plannedEnd: new Date(2026, 7, 27, 12).toISOString(),
        timezone: "Europe/Zurich"
      }
    });
    await api.board.create({
      projectId: project.id,
      title: "Provider implementation",
      column: "active",
      schedule: {
        plannedStart: new Date(2026, 7, 28, 9).toISOString(),
        plannedEnd: new Date(2026, 7, 28, 14).toISOString(),
        timezone: "Europe/Zurich"
      }
    });
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Timeline" }));
    const canvas = screen.getByLabelText("Zoomable timeline canvas");
    for (let index = 0; index < 3; index += 1) fireEvent.wheel(canvas, { deltaY: 120, clientX: 560, clientY: 240, metaKey: true });

    const timeline = screen.getByLabelText("Scheduled work timeline");
    expect(timeline).toHaveAttribute("data-scale", "phase");
    expect(api.board.createPhase).not.toHaveBeenCalled();
    fireEvent.click(within(timeline).getByRole("button", { name: /Review suggested phase, Provider phase/ }));
    expect(screen.getByText("Confirm suggested phase")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Phase name"), { target: { value: "Provider rollout" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm phase" }));

    await waitFor(() => expect(api.board.createPhase).toHaveBeenCalledWith({
      projectId: project.id,
      title: "Provider rollout",
      taskIds: ["task-1", "task-2"]
    }));
    expect(await within(timeline).findByRole("button", { name: "Provider rollout, confirmed phase" })).toBeInTheDocument();
    expect(screen.queryByText("Confirm suggested phase")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    expect(screen.getAllByText("Provider rollout")).toHaveLength(2);
  });

  it("reloads an open Board when an agent applies a plan", async () => {
    const api = createApi();
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    expect(await screen.findByRole("heading", { name: "Plan work before it runs" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Agent-created roadmap item" })).not.toBeInTheDocument();

    await api.board.create({
      projectId: project.id,
      title: "Agent-created roadmap item",
      description: "Applied from a reviewed plan",
      column: "ready",
      schedule: {
        plannedStart: "2026-09-07T07:00:00.000Z",
        plannedEnd: "2026-09-28T07:00:00.000Z",
        timezone: "Europe/Zurich"
      }
    });
    expect((await api.board.list({ projectId: project.id })).data).toEqual([
      expect.objectContaining({ title: "Agent-created roadmap item" })
    ]);
    const boardLoadsBeforeEvent = api.board.list.mock.calls.length;
    act(() => api.emit({ type: "BoardUpdated", payload: { action: "plan-applied", projectId: project.id } }));

    await waitFor(() => expect(api.board.list.mock.calls.length).toBeGreaterThan(boardLoadsBeforeEvent));
    expect(await screen.findByText("Agent-created roadmap item")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
    expect(screen.getAllByText("1 task").length).toBeGreaterThan(0);
  });

  it("shows a bridge-created Pixice thread in the sidebar like a regular task", async () => {
    const bridgeThread = {
      ...thread,
      id: "bridge-thread",
      name: "Cross-model UI review",
      parentThreadId: thread.id,
      bridge: { kind: "pixiceBridge", parentThreadId: thread.id, model: "claude:claude-sonnet-4-6" }
    };
    const subagentThread = {
      ...thread,
      id: "subagent-thread",
      name: "Internal test audit",
      parentThreadId: thread.id
    };
    window.pixice = createApi([thread, bridgeThread, subagentThread]);

    render(<App />);

    const bridgeTask = await screen.findByRole("button", { name: "Cross-model UI review" });
    expect(screen.queryByRole("button", { name: "Internal test audit" })).not.toBeInTheDocument();

    fireEvent.click(bridgeTask);
    await waitFor(() => expect(window.pixice.threads.read).toHaveBeenCalledWith({
      projectId: project.id,
      threadId: bridgeThread.id
    }));
    expect(bridgeTask).toHaveAttribute("aria-current", "page");
  });

  it("adds a bridge thread immediately but only marks it unseen after its final answer", async () => {
    localStorage.setItem("pixice.threadCompletionsSeen", JSON.stringify({ __baselineAt: 0 }));
    render(<App />);
    await screen.findByText("I traced the current flow.");

    act(() => window.pixice.emit({
      type: "AgentUpdated",
      payload: {
        method: "pixice/bridge/updated",
        projectId: project.id,
        threadId: thread.id,
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          bridge: true,
          senderThreadId: thread.id,
          receiverThreadIds: ["bridge-thread"],
          prompt: "Review the interface hierarchy",
          model: "claude:claude-sonnet-4-6",
          agentsStates: { "bridge-thread": { status: "running", message: "Reviewing" } }
        }
      }
    }));

    const bridgeButton = await screen.findByRole("button", { name: "Review the interface hierarchy" });
    expect(bridgeButton).toBeInTheDocument();
    expect(Array.from(document.querySelectorAll(".task-tree .task-select"), (button) => button.textContent)).toEqual([
      "Refactor authentication",
      "Review the interface hierarchy"
    ]);

    act(() => window.pixice.emit({
      type: "AgentUpdated",
      payload: {
        method: "pixice/bridge/updated",
        projectId: project.id,
        threadId: thread.id,
        item: {
          type: "collabAgentToolCall",
          tool: "pixiceBridge",
          bridge: true,
          senderThreadId: thread.id,
          receiverThreadIds: ["bridge-thread"],
          prompt: "Review the interface hierarchy",
          model: "claude:claude-sonnet-4-6",
          agentsStates: { "bridge-thread": { status: "completed", message: "Increase the spacing between sections." } }
        }
      }
    }));

    expect(bridgeButton.closest(".task-row")).not.toHaveClass("finished");

    act(() => window.pixice.emit({
      type: "ThreadUpdated",
      payload: {
        method: "turn/completed",
        projectId: project.id,
        threadId: "bridge-thread",
        turn: {
          id: "bridge-turn",
          status: "completed",
          items: [{ id: "bridge-answer", type: "agentMessage", text: "Increase the spacing between sections.", phase: "final_answer" }]
        }
      }
    }));

    await waitFor(() => expect(bridgeButton.closest(".task-row")).toHaveClass("finished"));
  });

  it("only promotes a bridge-created thread after the user messages it", async () => {
    const user = userEvent.setup();
    const bridgeThread = {
      ...thread,
      id: "bridge-thread",
      name: "Cross-model UI review",
      preview: "Cross-model UI review",
      bridge: { kind: "pixiceBridge", parentThreadId: thread.id, model: "claude:claude-sonnet-4-6" }
    };
    localStorage.setItem("pixice.threadMessageRecency", JSON.stringify({ [thread.id]: 20 }));
    window.pixice = createApi([thread, bridgeThread]);
    render(<App />);
    await screen.findByText("I traced the current flow.");

    const threadOrder = () => Array.from(document.querySelectorAll(".task-tree .task-select"), (button) => button.textContent);
    expect(threadOrder()).toEqual(["Refactor authentication", "Cross-model UI review"]);

    fireEvent.click(screen.getByRole("button", { name: "Cross-model UI review" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cross-model UI review" })).toHaveAttribute("aria-current", "page"));
    await user.type(screen.getByRole("textbox", { name: "Task prompt" }), "Take another pass at the hierarchy");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(threadOrder()[0]).toBe("Cross-model UI review"));
  });

  it("labels prompts and answers relayed through a Pixice bridge thread", async () => {
    const bridgeThread = {
      ...thread,
      id: "bridge-thread",
      name: "Cross-model UI review",
      bridge: { kind: "pixiceBridge", parentThreadId: "main-thread", model: "claude:claude-sonnet-4-6" },
      turns: [{
        id: "bridge-turn",
        status: "completed",
        items: [
          { id: "bridge-prompt", type: "userMessage", content: [{ type: "text", text: "Review the interface hierarchy" }] },
          { id: "bridge-answer", type: "agentMessage", text: "Increase the spacing between sections.", phase: "final_answer" }
        ]
      }]
    };
    window.pixice = createApi(bridgeThread);

    const { container } = render(<App />);

    const opened = await screen.findByText("Task opened by another Pixice agent");
    const sent = await screen.findByText("Sent answer to main agent");
    expect(opened).toHaveClass("bridge-prompt-status");
    expect(sent).toHaveClass("bridge-answer-status");
    expect(container.querySelector(".bridge-prompt-status + .user-message")).toHaveTextContent("Review the interface hierarchy");
    expect(sent.closest(".assistant-message")).toHaveTextContent("Increase the spacing between sections.");
  });

  it("switches top-level views without a full-screen transition", async () => {
    const { container } = render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(container.querySelector(".shell-transition-curtain")).not.toBeInTheDocument();
    expect(container.querySelector(".pixice-app")).not.toHaveAttribute("data-view-transitioning");

    fireEvent.click(screen.getByRole("button", { name: "Back to task" }));
    expect(await screen.findByRole("complementary", { name: "Primary navigation" })).toBeInTheDocument();
  });

  it("renders Codex image generation in progress and swaps in the completed image", async () => {
    const user = userEvent.setup();
    const imageThread = {
      ...thread,
      status: { type: "active" },
      turns: [{
        id: "turn-image",
        status: "inProgress",
        items: [
          { id: "user-image", type: "userMessage", content: [{ type: "text", text: "Make a lake image" }] },
          { id: "tool-image", type: "dynamicToolCall", tool: "image_gen__imagegen", status: "completed", arguments: { prompt: "a calm mountain lake at dawn", size: "1536x1024" } },
          { id: "generated-image", type: "imageGeneration", status: "inProgress", result: "", revisedPrompt: null, savedPath: null, failure: null }
        ]
      }]
    };
    window.pixice = createApi(imageThread);

    render(<App />);
    expect(await screen.findByRole("img", { name: "Generating image" })).toBeInTheDocument();
    expect(screen.getByText("“a calm mountain lake at dawn”")).toBeInTheDocument();
    expect(screen.getByText("1536 × 1024")).toBeInTheDocument();

    act(() => window.pixice.emit({
      type: "RuntimeEvent",
      payload: {
        method: "item/completed",
        threadId: "thread-1",
        turnId: "turn-image",
        item: {
          id: "generated-image",
          type: "imageGeneration",
          status: "completed",
          result: "data:image/png;base64,AA==",
          revisedPrompt: "a glassy lake beneath a pink dawn sky",
          savedPath: "/tmp/lake.png",
          failure: null
        }
      }
    }));

    const result = await screen.findByRole("img", { name: "a glassy lake beneath a pink dawn sky" });
    expect(result).toHaveAttribute("src", "data:image/png;base64,AA==");
    expect(screen.getByText("Generated image")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Inspect a glassy lake beneath a pink dawn sky" }));
    await user.type(screen.getByRole("textbox", { name: "Picture revision comments" }), "Add a small red canoe");
    await user.click(screen.getByRole("button", { name: "Generate revision" }));

    await waitFor(() => expect(window.pixice.turns.steer).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      threadId: "thread-1",
      turnId: "turn-image",
      text: expect.stringContaining("Add a small red canoe"),
      attachments: [{
        name: "generated-image.png",
        type: "image/png",
        size: 1,
        dataUrl: "data:image/png;base64,AA=="
      }]
    })));
  });

  it("loads real task data and moves between review and settings", async () => {
    render(<App />);
    expect(document.querySelector(".window-drag-region")).toHaveAttribute("aria-hidden", "true");
    expect(await screen.findByText("I traced the current flow.")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Summary" })).toBeInTheDocument();
    expect((await screen.findByText("cookies")).tagName).toBe("STRONG");
    expect((await screen.findByText("pnpm test")).tagName).toBe("CODE");
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(await screen.findByText("Runtime")).toHaveAttribute("title", "src/runtime.js");
    expect(document.querySelector(".assistant-message [aria-hidden='true']")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByRole("heading", { name: "Aurora" })).toBeInTheDocument();
    expect(screen.getByText("auth.js")).toBeInTheDocument();
    expect(screen.getByText("old").closest(".file-diff-row")).toHaveClass("del");
    expect(screen.getByText("new").closest(".file-diff-row")).toHaveClass("add");
    expect(document.querySelector(".file-diff-stat")).toHaveTextContent("+1−1");
    expect(document.querySelector(".diff-panel > .file-diff")).toBeInTheDocument();
    expect(appCss).toMatch(/\.diff-panel\s*\{[^}]*padding:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(appCss).toMatch(/\.file-browser::\-webkit-scrollbar,\s*\.file-diff-body::\-webkit-scrollbar\s*\{[^}]*width:\s*8px;/s);
    expect(appCss).toMatch(/\.file-browser::\-webkit-scrollbar-thumb,\s*\.file-diff-body::\-webkit-scrollbar-thumb\s*\{[^}]*background-clip:\s*padding-box;[^}]*border:\s*2px solid transparent;/s);
    expect(appCss).toMatch(/\.file-diff\s*\{[^}]*min-width:\s*0;[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*display:\s*flex;[^}]*padding:\s*0;/s);
    expect(appCss).toMatch(/\.file-diff-body\s*\{[^}]*min-height:\s*0;[^}]*flex:\s*1;[^}]*overflow:\s*auto;/s);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Primary navigation" })).not.toBeInTheDocument();
    const settingsSidebar = screen.getByRole("complementary", { name: "Settings navigation" });
    expect(settingsSidebar).toBeInTheDocument();
    expect(within(settingsSidebar).getByRole("navigation").querySelectorAll("button")).toHaveLength(7);
    expect(within(settingsSidebar).queryByRole("button", { name: /^Runtime/ })).not.toBeInTheDocument();
    expect(within(settingsSidebar).queryByRole("button", { name: /^Notifications/ })).not.toBeInTheDocument();
    expect(within(settingsSidebar).getByRole("button", { name: /^About Pixice/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to task" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Capabilities/ }));
    expect(screen.queryByRole("heading", { name: "General" })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Capabilities" })).toBeInTheDocument();
    expect(window.pixice.git.status).toHaveBeenCalled();
    expect(window.pixice.extensions.list).toHaveBeenCalled();
  });

  it("keeps a plain folder usable when Git is missing and offers explicit macOS setup", async () => {
    const api = createApi();
    const missingGit = {
      state: "command-line-tools-missing",
      available: false,
      installSupported: true,
      executablePath: null,
      version: null,
      message: "Apple Command Line Tools are not installed. Pixice can still work with folders, but Git features are unavailable."
    };
    api.review.read.mockResolvedValue({
      repository: { kind: "folder", root: "/work/aurora", baseCommit: null, dirtyPaths: [], git: missingGit },
      files: []
    });
    api.git.status.mockResolvedValue(missingGit);
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByRole("heading", { name: "Git is not available yet" })).toBeInTheDocument();
    expect(screen.getByText(/File editing, agents, Preview, Board, and Workflows remain available/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Install Apple Command Line Tools" }));
    await waitFor(() => expect(api.git.installCommandLineTools).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("heading", { name: "Finish installing Git" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(api.git.status).toHaveBeenCalled());
    expect(api.review.read).toHaveBeenCalled();
  });

  it("shows status-only Review items instead of a clean working tree", async () => {
    window.pixice.review.read.mockResolvedValue({
      repository: { ...project.repository, dirtyPaths: ["blog/"] },
      diff: ""
    });
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Review" }));

    expect(await screen.findByText("1 changed file")).toBeInTheDocument();
    expect(screen.getByText("blog")).toBeInTheDocument();
    expect(screen.getByText("No textual diff is available for this file.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Working tree is clean" })).not.toBeInTheDocument();
  });

  it("loads the Review manifest before requesting only the selected file diff", async () => {
    const api = createApi();
    let resolveFileDiff;
    api.review.read.mockResolvedValue({
      repository: { ...project.repository, dirtyPaths: ["src/auth.js", "src/session.js"] },
      files: [
        { path: "src/auth.js", plus: 1, minus: 1 },
        { path: "src/session.js", plus: 2, minus: 0 }
      ]
    });
    api.review.file.mockImplementation(({ path }) => new Promise((resolve) => {
      resolveFileDiff = () => resolve({
        path,
        baseCommit: "abc",
        diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old selected\n+new selected`
      });
    }));
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Review" }));

    await waitFor(() => expect(api.review.file).toHaveBeenCalledWith({ projectId: "project-1", path: "src/auth.js" }));
    expect(screen.getByText("Reading file diff…")).toBeInTheDocument();
    await act(async () => resolveFileDiff());
    expect(await screen.findByText("new selected")).toBeInTheDocument();
    expect(api.review.read).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /session\.js/ }));
    await waitFor(() => expect(api.review.file).toHaveBeenCalledWith({ projectId: "project-1", path: "src/session.js" }));
    expect(api.review.file).toHaveBeenCalledTimes(2);
  });

  it("opens the selected Review file in the external editor", async () => {
    window.pixice.review.read.mockResolvedValue({
      repository: { ...project.repository, dirtyPaths: ["src/auth.js", "src/session.js"] },
      diff: [
        "diff --git a/src/auth.js b/src/auth.js",
        "--- a/src/auth.js",
        "+++ b/src/auth.js",
        "@@ -1 +1 @@",
        "-old auth",
        "+new auth",
        "diff --git a/src/session.js b/src/session.js",
        "--- a/src/session.js",
        "+++ b/src/session.js",
        "@@ -1 +1 @@",
        "-old session",
        "+new session"
      ].join("\n")
    });
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(await screen.findByRole("button", { name: /session\.js/ }));
    fireEvent.click(screen.getByRole("button", { name: "Editor" }));

    await waitFor(() => expect(window.pixice.external.openEditor).toHaveBeenCalledWith({
      projectId: "project-1",
      path: "src/session.js"
    }));
  });

  it("keeps the selected Review file and scroll positions while live changes refresh", async () => {
    const initialReview = {
      repository: { ...project.repository, dirtyPaths: ["src/auth.js", "src/session.js"] },
      diff: [
        "diff --git a/src/auth.js b/src/auth.js",
        "--- a/src/auth.js",
        "+++ b/src/auth.js",
        "@@ -1 +1 @@",
        "-old auth",
        "+new auth",
        "diff --git a/src/session.js b/src/session.js",
        "--- a/src/session.js",
        "+++ b/src/session.js",
        "@@ -1 +1 @@",
        "-old session",
        "+new session"
      ].join("\n")
    };
    const refreshedReview = {
      repository: { ...project.repository, dirtyPaths: ["src/new.js", "src/auth.js", "src/session.js"] },
      diff: [
        "diff --git a/src/new.js b/src/new.js",
        "--- /dev/null",
        "+++ b/src/new.js",
        "@@ -0,0 +1 @@",
        "+new first file",
        "diff --git a/src/auth.js b/src/auth.js",
        "--- a/src/auth.js",
        "+++ b/src/auth.js",
        "@@ -1 +1 @@",
        "-old auth",
        "+new auth",
        "diff --git a/src/session.js b/src/session.js",
        "--- a/src/session.js",
        "+++ b/src/session.js",
        "@@ -1 +1 @@",
        "-old session",
        "+newer session"
      ].join("\n")
    };
    const api = createApi();
    api.review.read.mockResolvedValue(initialReview);
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(await screen.findByRole("button", { name: /session\.js/ }));
    const fileBrowser = document.querySelector(".file-browser");
    const diffBody = document.querySelector(".file-diff-body");
    fileBrowser.scrollTop = 144;
    diffBody.scrollTop = 96;
    diffBody.scrollLeft = 40;

    api.review.read.mockResolvedValue(refreshedReview);
    act(() => api.emit({
      type: "RuntimeEvent",
      payload: { projectId: project.id, threadId: thread.id, method: "turn/completed", turn: { id: "live-turn" } }
    }));

    expect(document.querySelector(".file-browser")).toBe(fileBrowser);
    expect(document.querySelector(".file-diff-body")).toBe(diffBody);
    expect(screen.queryByText("Reading Git changes…")).not.toBeInTheDocument();
    expect(await screen.findByText("newer session")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /session\.js/ })).toHaveClass("selected");
    expect(document.querySelector(".file-browser")).toBe(fileBrowser);
    expect(document.querySelector(".file-diff-body")).toBe(diffBody);
    expect(fileBrowser.scrollTop).toBe(144);
    expect(diffBody.scrollTop).toBe(96);
    expect(diffBody.scrollLeft).toBe(40);
  });

  it("lets Tools replace the primary sidebar instead of adding a second rail", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Tools" }));

    expect(await screen.findByRole("complementary", { name: "Tools navigation" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Primary navigation" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to task" })).toBeInTheDocument();
    expect(document.querySelector(".pixice-app")).toHaveClass("view-tools");
    expect(screen.getByRole("main")).toHaveClass("main-canvas");
  });

  it("reloads persisted threads when the runtime becomes ready after startup", async () => {
    const api = createApi();
    api.app.bootstrap.mockResolvedValue({
      projects: [project],
      models: [],
      runtime: { state: "connecting", connected: false },
      settings: {}
    });
    api.threads.list
      .mockResolvedValueOnce({ data: [], nextCursor: null })
      .mockResolvedValue({ data: [thread], nextCursor: null });
    window.pixice = api;
    render(<App />);

    await waitFor(() => expect(api.threads.list).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("I traced the current flow.")).not.toBeInTheDocument();

    act(() => api.emit({ type: "RuntimeStatus", payload: { state: "ready", connected: true } }));

    expect(await screen.findByText("I traced the current flow.")).toBeInTheDocument();
    expect(api.threads.list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("wires settings controls to real app preferences", async () => {
    const api = createApi();
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Default permissions" }), { target: { value: "read-only" } });
    expect(localStorage.getItem("pixice.permissionMode")).toBe("read-only");
    fireEvent.click(screen.getByRole("checkbox", { name: "Use Fast mode for new tasks" }));
    expect(api.app.saveSettings).toHaveBeenCalledWith({ defaultFastMode: true });
    fireEvent.change(screen.getByRole("combobox", { name: "Thread name model" }), { target: { value: "off" } });
    expect(api.app.saveSettings).toHaveBeenCalledWith({ threadNamingModel: "off" });
    fireEvent.change(screen.getByRole("combobox", { name: "Workflow generation model" }), { target: { value: "codex:gpt-5.6" } });
    expect(api.app.saveSettings).toHaveBeenCalledWith({ workflowGenerationModel: "codex:gpt-5.6" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep System awake" }));
    expect(api.app.saveSettings).toHaveBeenCalledWith({ keepSystemAwake: true });
    fireEvent.change(screen.getByRole("combobox", { name: "Thread cleanup age" }), { target: { value: "14" } });
    expect(JSON.parse(localStorage.getItem("pixice.preferences"))).toMatchObject({ threadCleanupAgeDays: 14 });
    fireEvent.change(screen.getByRole("combobox", { name: "Thread cleanup age" }), { target: { value: "custom" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Custom thread cleanup age" }), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Notify when tasks finish" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Play notification sounds" }));
    expect(api.app.saveSettings).toHaveBeenCalledWith({ completionNotifications: true });
    expect(api.app.saveSettings).toHaveBeenCalledWith({ notificationSound: false });

    fireEvent.click(screen.getByRole("button", { name: /^Conversation/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Send shortcut" }), { target: { value: "mod-enter" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Check spelling in prompts" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show slash command suggestions" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show message timestamps" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Completed work details" }), { target: { value: "expanded" } });

    fireEvent.click(screen.getByRole("button", { name: /^Agents/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Expand task progress by default" }));

    fireEvent.click(screen.getByRole("button", { name: /^Appearance/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show shortcut hints" }));
    expect(document.querySelector(".pixice-app")).toHaveAttribute("data-show-shortcuts", "false");
    fireEvent.change(screen.getByRole("combobox", { name: "Interface density" }), { target: { value: "comfortable" } });
    expect(document.querySelector(".pixice-app")).toHaveAttribute("data-density", "comfortable");
    fireEvent.change(screen.getByRole("combobox", { name: "Conversation width" }), { target: { value: "wide" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Conversation text size" }), { target: { value: "large" } });
    fireEvent.click(screen.getByRole("radio", { name: "Teal accent" }));
    expect(screen.getByRole("radio", { name: "Teal accent" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("checkbox", { name: "Reduce transparency" }));

    const app = document.querySelector(".pixice-app");
    expect(app).toHaveAttribute("data-conversation-width", "wide");
    expect(app).toHaveAttribute("data-conversation-text-size", "large");
    expect(app).toHaveAttribute("data-accent-color", "teal");
    expect(app).toHaveAttribute("data-reduce-transparency", "true");

    const saved = JSON.parse(localStorage.getItem("pixice.preferences"));
    expect(saved).toMatchObject({
      showShortcutHints: false,
      density: "comfortable",
      conversationWidth: "wide",
      conversationTextSize: "large",
      accentColor: "teal",
      reduceTransparency: true,
      sendShortcut: "mod-enter",
      spellCheckComposer: false,
      showSlashCommands: false,
      showMessageTimestamps: false,
      completedWorkDetails: "expanded",
      expandTaskProgress: false,
      threadCleanupAgeDays: 9
    });
    await waitFor(() => expect(api.app.saveSettings).toHaveBeenCalledWith({
      accentColor: "teal",
      reduceTransparency: true
    }));

    fireEvent.click(screen.getByRole("button", { name: "Back to task" }));
    const prompt = await screen.findByRole("textbox", { name: "Task prompt" });
    expect(prompt).toHaveAttribute("spellcheck", "false");
    expect(document.querySelectorAll("time.message-timestamp")).toHaveLength(0);
    fireEvent.change(prompt, { target: { value: "Use the customized composer" } });
    fireEvent.keyDown(prompt, { key: "Enter" });
    expect(api.turns.start).not.toHaveBeenCalled();
    fireEvent.keyDown(prompt, { key: "Enter", metaKey: true });
    await waitFor(() => expect(api.turns.start).toHaveBeenCalledTimes(1));
  });

  it("connects and disconnects GitHub from Settings", async () => {
    const api = createApi();
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Capabilities/ }));
    await waitFor(() => expect(api.github.status).toHaveBeenCalled());
    expect(await screen.findByText("Sign in required")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(api.github.login).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("The Octocat · @octocat")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(api.github.logout).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Sign in required")).toBeInTheDocument();
  });

  it("keeps the third project row off by default and persists the nine-tile opt-in", async () => {
    const additionalProjects = Array.from({ length: 9 }, (_, index) => ({
      id: `project-${index + 2}`,
      displayName: `Project ${index + 2}`,
      canonicalPath: `/work/project-${index + 2}`,
      icon: "folder",
      color: "blue",
      folders: [`/work/project-${index + 2}`],
      lastUsedAt: new Date(Date.now() - ((index + 1) * 1_000)).toISOString()
    }));
    const api = createApi();
    api.app.bootstrap.mockResolvedValue({
      projects: [project, ...additionalProjects],
      models: [{ id: "gpt", model: "gpt-5.6", displayName: "GPT-5.6", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
      runtime: { state: "ready", connected: true },
      settings: {}
    });
    window.pixice = api;
    render(<App />);

    await screen.findByText("I traced the current flow.");
    expect(within(screen.getByRole("list", { name: "Recent projects" })).getAllByRole("button")).toHaveLength(6);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Appearance/ }));
    const thirdRow = await screen.findByRole("checkbox", { name: "Show third project row" });
    expect(thirdRow).not.toBeChecked();
    fireEvent.click(thirdRow);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("pixice.preferences"))).toMatchObject({ showThirdProjectRow: true }));

    fireEvent.click(screen.getByRole("button", { name: "Back to task" }));
    const recent = await screen.findByRole("list", { name: "Recent projects" });
    expect(within(recent).getAllByRole("button")).toHaveLength(9);
    expect(within(recent).getByRole("button", { name: "Project 9" })).toBeInTheDocument();
    expect(within(recent).queryByRole("button", { name: "Project 10" })).not.toBeInTheDocument();
  });

  it("keeps the legacy sidebar off by default and restores nested project rows when enabled", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");

    expect(screen.getByRole("region", { name: "Projects" })).toBeInTheDocument();
    expect(document.querySelector(".project-node")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Appearance/ }));
    const legacySidebar = await screen.findByRole("checkbox", { name: "Legacy sidebar" });
    expect(legacySidebar).not.toBeChecked();
    fireEvent.click(legacySidebar);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("pixice.preferences"))).toMatchObject({ legacySidebar: true }));

    fireEvent.click(screen.getByRole("button", { name: "Back to task" }));
    await screen.findByRole("complementary", { name: "Primary navigation" });
    expect(screen.queryByRole("region", { name: "Projects" })).not.toBeInTheDocument();
    expect(screen.getByText("Projects", { selector: ".rail-group-label" })).toBeInTheDocument();

    const projectNode = document.querySelector(".project-node");
    expect(projectNode).toHaveClass("selected");
    expect(within(projectNode).getByRole("button", { name: "Aurora" })).toHaveAttribute("aria-expanded", "true");
    expect(within(projectNode).getByRole("button", { name: "Refactor authentication" })).toBeInTheDocument();
  });

  it("deletes projects from legacy list rows and selects the next project", async () => {
    const secondProject = {
      id: "project-2",
      displayName: "Beacon",
      canonicalPath: "/work/beacon",
      icon: "terminal",
      color: "green",
      folders: ["/work/beacon"]
    };
    const api = createApi();
    api.app.bootstrap.mockResolvedValue({
      projects: [project, secondProject],
      models: [{ id: "gpt", model: "gpt-5.6", displayName: "GPT-5.6", provider: "codex", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
      runtime: { state: "ready", connected: true },
      settings: { legacySidebar: true }
    });
    window.pixice = api;
    localStorage.setItem("pixice.preferences", JSON.stringify({ legacySidebar: true }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);

    await screen.findByText("I traced the current flow.");
    fireEvent.click(screen.getByRole("button", { name: "Delete Aurora" }));

    await waitFor(() => expect(api.projects.delete).toHaveBeenCalledWith({ projectId: "project-1" }));
    expect(confirm).toHaveBeenCalledWith("Delete “Aurora”?\n\nThis removes the project and its Pixice data. Your folders and files stay on disk.");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Aurora" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Beacon" })).toHaveAttribute("aria-current", "true");
    confirm.mockRestore();
  });

  it("keeps Workspace fixed, scrolls only threads, and fades when more threads remain", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");

    const sidebar = screen.getByRole("complementary", { name: "Primary navigation" });
    const navigation = within(sidebar).getByRole("navigation");
    const projectHeader = within(sidebar).getByRole("region", { name: "Projects" }).closest(".project-rail-header");
    const settings = within(sidebar).getByRole("button", { name: "Settings" });

    const workspaceHeading = sidebar.querySelector(".workspace-heading");
    const threadRegion = sidebar.querySelector(".thread-scroll-region");
    const threadScroller = sidebar.querySelector(".thread-list-scroll");
    expect(workspaceHeading).toHaveTextContent("Workspace");
    expect(within(workspaceHeading).getByRole("button", { name: "Collapse navigation labels" })).toBeInTheDocument();
    expect(navigation.children[0]).toBe(workspaceHeading.closest(".rail-group"));
    expect(navigation.children[1]).toBe(threadRegion);
    expect(threadRegion).toContainElement(screen.getByRole("button", { name: "Refactor authentication" }));
    expect(threadScroller).toHaveAttribute("data-overflow", "false");

    Object.defineProperties(threadScroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, writable: true, value: 0 }
    });
    fireEvent.scroll(threadScroller);
    expect(threadScroller).toHaveAttribute("data-overflow", "true");

    threadScroller.scrollTop = 200;
    fireEvent.scroll(threadScroller);
    expect(threadScroller).toHaveAttribute("data-overflow", "false");
    expect(appCss).toMatch(/\.rail-scroll\s*\{[^}]*overflow-y:\s*hidden;/s);
    expect(appCss).toMatch(/\.thread-list-scroll\s*\{[^}]*overflow-y:\s*auto;/s);
    expect(appCss).toMatch(/\.thread-list-scroll\[data-overflow="true"\]\s*\{[^}]*mask-image:\s*linear-gradient/s);
    expect(appCss).not.toContain("thread-overflow-fade");
    expect(sidebar.children[0]).toBe(navigation);
    expect(sidebar.children[1]).toBe(projectHeader);
    expect(sidebar.children[2]).toBe(settings);
  });

  it("shows saved plan completion at the bottom of each sidebar thread row", async () => {
    window.pixice = createApi({ ...thread, status: { type: "idle" }, turns: [], planProgress: { completed: 4, total: 5 } });
    render(<App />);

    const sidebar = await screen.findByRole("complementary", { name: "Primary navigation" });
    const progress = await within(sidebar).findByRole("progressbar", { name: "4 of 5 complete" });
    expect(progress).toHaveAttribute("aria-valuenow", "4");
    expect(progress).toHaveAttribute("aria-valuemax", "5");
    expect(progress.querySelector("span")).toHaveStyle({ width: "80%" });
    expect(progress.closest(".task-row")).toContainElement(within(sidebar).getByRole("button", { name: "Refactor authentication" }));

    act(() => window.pixice.emit({
      type: "RuntimeEvent",
      payload: {
        method: "turn/plan/updated",
        threadId: thread.id,
        plan: [
          { step: "One", status: "completed" },
          { step: "Two", status: "completed" },
          { step: "Three", status: "in_progress" },
          { step: "Four", status: "pending" },
          { step: "Five", status: "pending" }
        ]
      }
    }));

    const updatedProgress = await within(sidebar).findByRole("progressbar", { name: "2 of 5 complete" });
    expect(updatedProgress.querySelector("span")).toHaveStyle({ width: "40%" });

    act(() => window.pixice.emit({
      type: "RuntimeEvent",
      payload: { method: "turn/started", threadId: thread.id, turn: { id: "next-turn" } }
    }));
    await waitFor(() => expect(within(sidebar).queryByRole("progressbar")).not.toBeInTheDocument());
  });

  it("keeps completed plan progress hidden after a finished thread has been read", async () => {
    window.pixice = createApi({
      ...thread,
      status: { type: "idle" },
      turns: thread.turns.map((turn) => ({ ...turn, status: "idle" })),
      planProgress: { completed: 5, total: 5 }
    });
    render(<App />);

    await screen.findByText("I traced the current flow.");
    const sidebar = await screen.findByRole("complementary", { name: "Primary navigation" });
    const threadRow = within(sidebar).getByRole("button", { name: "Refactor authentication" }).closest(".task-row");
    expect(threadRow).toHaveClass("active");
    expect(threadRow.querySelector(".task-row-progress")).not.toBeInTheDocument();
  });

  it("clears a finished thread badge after the thread is opened", async () => {
    const secondThread = {
      ...thread,
      id: "thread-2",
      name: "Finished background task",
      preview: "Finished background task",
      planProgress: { completed: 5, total: 5 },
      updatedAt: Math.floor(Date.now() / 1000) + 1,
      turns: [{ id: "turn-2", status: "completed", items: [] }]
    };
    const incompleteFinalThread = {
      ...secondThread,
      id: "thread-3",
      name: "Final answer with remaining work",
      preview: "Final answer with remaining work",
      planProgress: { completed: 4, total: 5 },
      updatedAt: Math.floor(Date.now() / 1000) + 2,
      turns: [{ id: "turn-3", status: "completed", items: [] }]
    };
    const api = createApi([thread, secondThread, incompleteFinalThread]);
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    expect(screen.getByRole("button", { name: "Refactor authentication" }).closest(".task-row").querySelector(".task-finished-badge")).not.toBeInTheDocument();

    const threadButton = screen.getByRole("button", { name: "Finished background task" });
    const threadRow = threadButton.closest(".task-row");
    expect(threadRow).toHaveClass("finished");
    expect(threadButton).toHaveAttribute("title", "Finished background task · Finished");
    expect(threadRow.querySelector(".task-finished-badge")).toHaveAttribute("title", "Finished");
    expect(threadRow.querySelector(".task-row-progress")).not.toBeInTheDocument();

    const incompleteFinalRow = screen.getByRole("button", { name: "Final answer with remaining work" }).closest(".task-row");
    expect(incompleteFinalRow.querySelector(".task-finished-badge")).toHaveAttribute("title", "Finished");
    expect(incompleteFinalRow.querySelector(".task-row-progress")).toHaveAttribute("aria-valuenow", "4");
    expect(incompleteFinalRow.querySelector(".task-row-progress")).toHaveAttribute("aria-valuemax", "5");

    fireEvent.click(threadButton);
    await waitFor(() => expect(screen.getByRole("button", { name: "Finished background task" }).closest(".task-row")).not.toHaveClass("finished"));
    expect(screen.getByRole("button", { name: "Finished background task" }).closest(".task-row").querySelector(".task-row-progress")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("pixice.threadCompletionsSeen"))).toMatchObject({ "thread-2": "turn:turn-2" });
    expect(api.app.saveSettings).toHaveBeenCalledWith({
      threadCompletionsSeen: expect.objectContaining({ "thread-2": "turn:turn-2" })
    });
  });

  it("keeps a read completion seen after restart and project switching", async () => {
    const secondProject = {
      id: "project-2",
      displayName: "Beacon",
      canonicalPath: "/work/beacon",
      icon: "terminal",
      color: "green",
      folders: ["/work/beacon"]
    };
    const completedThread = {
      ...thread,
      id: "thread-2",
      name: "Finished today",
      preview: "Finished today",
      updatedAt: Math.floor(Date.now() / 1000) + 30,
      completionRevision: "turn:turn-2",
      planProgress: { completed: 5, total: 5 },
      turns: [{ id: "turn-2", status: "completed", items: [] }]
    };
    const beaconThread = {
      ...thread,
      id: "thread-3",
      name: "Beacon task",
      preview: "Beacon task",
      cwd: "/work/beacon"
    };
    const createRestartApi = () => {
      const api = createApi();
      api.app.bootstrap.mockResolvedValue({
        projects: [project, secondProject],
        models: [{ id: "gpt", model: "gpt-5.6", displayName: "GPT-5.6", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
        runtime: { state: "ready", connected: true },
        settings: {}
      });
      api.threads.list.mockImplementation(async ({ projectId }) => ({
        data: projectId === secondProject.id ? [beaconThread] : [thread, completedThread],
        nextCursor: null
      }));
      api.threads.read.mockImplementation(async ({ projectId, threadId }) => ({
        thread: projectId === secondProject.id
          ? beaconThread
          : [thread, completedThread].find((candidate) => candidate.id === threadId) ?? thread
      }));
      return api;
    };

    window.pixice = createRestartApi();
    const firstRender = render(<App />);
    await screen.findByText("I traced the current flow.");

    const completedButton = screen.getByRole("button", { name: "Finished today" });
    expect(completedButton.closest(".task-row")).toHaveClass("finished");
    fireEvent.click(completedButton);
    await waitFor(() => expect(screen.getByRole("button", { name: "Finished today" }).closest(".task-row")).not.toHaveClass("finished"));
    firstRender.unmount();

    window.pixice = createRestartApi();
    render(<App />);
    await screen.findByText("I traced the current flow.");
    expect(screen.getByRole("button", { name: "Finished today" }).closest(".task-row")).not.toHaveClass("finished");

    fireEvent.click(screen.getByRole("button", { name: "Beacon" }));
    expect(await screen.findByRole("button", { name: "Beacon task" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Aurora" }));
    await screen.findByRole("button", { name: "Finished today" });
    expect(screen.getByRole("button", { name: "Finished today" }).closest(".task-row")).not.toHaveClass("finished");
  });

  it("keeps legacy timestamp read records seen after restoring stable completion identities", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) + 10;
    const completedThread = {
      ...thread,
      id: "thread-2",
      name: "Previously read task",
      preview: "Previously read task",
      updatedAt,
      completionRevision: "turn:turn-2",
      turns: [{ id: "turn-2", status: "completed", items: [] }]
    };
    localStorage.setItem("pixice.threadCompletionsSeen", JSON.stringify({
      __baselineAt: Date.now() - 60_000,
      "thread-2": String(updatedAt)
    }));
    window.pixice = createApi([thread, completedThread]);
    render(<App />);

    await screen.findByText("I traced the current flow.");
    expect(screen.getByRole("button", { name: "Previously read task" }).closest(".task-row")).not.toHaveClass("finished");
  });

  it("treats existing completions as seen when an app update resets renderer storage", async () => {
    const completedThread = {
      ...thread,
      id: "thread-2",
      name: "Completed before update",
      preview: "Completed before update",
      updatedAt: Math.floor(Date.now() / 1000) - 30,
      completionRevision: "turn:turn-2",
      turns: [{ id: "turn-2", status: "completed", items: [] }]
    };
    window.pixice = createApi([thread, completedThread]);
    render(<App />);

    await screen.findByText("I traced the current flow.");
    expect(screen.getByRole("button", { name: "Completed before update" }).closest(".task-row")).not.toHaveClass("finished");
  });

  it("restores completion read state from durable app settings", async () => {
    const completedThread = {
      ...thread,
      id: "thread-2",
      name: "Durably read task",
      preview: "Durably read task",
      updatedAt: Math.floor(Date.now() / 1000) + 30,
      completionRevision: "turn:turn-2",
      turns: [{ id: "turn-2", status: "completed", items: [] }]
    };
    const api = createApi([thread, completedThread]);
    api.app.bootstrap.mockResolvedValue({
      projects: [project],
      models: [{ id: "gpt", model: "gpt-5.6", displayName: "GPT-5.6", provider: "codex", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
      runtime: { state: "ready", connected: true },
      settings: {
        threadCompletionsSeen: {
          __baselineAt: Date.now() - 60_000,
          "thread-2": "turn:turn-2"
        }
      }
    });
    window.pixice = api;
    render(<App />);

    await screen.findByText("I traced the current flow.");
    expect(screen.getByRole("button", { name: "Durably read task" }).closest(".task-row")).not.toHaveClass("finished");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("pixice.threadCompletionsSeen"))).toMatchObject({
      "thread-2": "turn:turn-2"
    }));
  });

  it("treats historical completions as seen when migrating an existing installation", async () => {
    const secondProject = {
      id: "project-2",
      displayName: "Beacon",
      canonicalPath: "/work/beacon",
      icon: "terminal",
      color: "green",
      folders: ["/work/beacon"]
    };
    const historicalThreads = [
      thread,
      {
        ...thread,
        id: "thread-2",
        name: "Older completed task",
        preview: "Older completed task",
        updatedAt: Math.floor(Date.now() / 1000) - 60,
        turns: [{ id: "turn-2", status: "completed", items: [] }]
      },
      {
        ...thread,
        id: "thread-3",
        name: "Another completed task",
        preview: "Another completed task",
        updatedAt: Math.floor(Date.now() / 1000) - 30,
        turns: [{ id: "turn-3", status: "completed", items: [] }]
      }
    ];
    const otherHistoricalThreads = [
      {
        ...thread,
        id: "thread-4",
        name: "Older Beacon task",
        preview: "Older Beacon task",
        cwd: "/work/beacon",
        updatedAt: Math.floor(Date.now() / 1000) - 90,
        turns: [{ id: "turn-4", status: "completed", items: [] }]
      },
      {
        ...thread,
        id: "thread-5",
        name: "Another Beacon task",
        preview: "Another Beacon task",
        cwd: "/work/beacon",
        updatedAt: Math.floor(Date.now() / 1000) - 45,
        turns: [{ id: "turn-5", status: "completed", items: [] }]
      }
    ];
    localStorage.setItem("pixice.threadCompletionsSeen", JSON.stringify({ "thread-1": "turn:turn-1" }));
    const api = createApi(historicalThreads);
    api.app.bootstrap.mockResolvedValue({
      projects: [project, secondProject],
      models: [{ id: "gpt", model: "gpt-5.6", displayName: "GPT-5.6", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
      runtime: { state: "ready", connected: true },
      settings: {}
    });
    api.threads.list.mockImplementation(async ({ projectId }) => ({
      data: projectId === secondProject.id ? otherHistoricalThreads : historicalThreads,
      nextCursor: null
    }));
    api.threads.read.mockImplementation(async ({ projectId, threadId }) => {
      const candidates = projectId === secondProject.id ? otherHistoricalThreads : historicalThreads;
      return { thread: candidates.find((candidate) => candidate.id === threadId) ?? candidates[0] };
    });
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    expect(document.querySelectorAll(".task-row.finished")).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem("pixice.threadCompletionsSeen"))).toMatchObject({
      "thread-1": "turn:turn-1",
      __baselineAt: expect.any(Number)
    });

    fireEvent.click(screen.getByRole("button", { name: "Beacon" }));
    expect(await screen.findByRole("button", { name: "Older Beacon task" })).toBeInTheDocument();
    expect(document.querySelectorAll(".task-row.finished")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Aurora" }));
    expect(await screen.findByRole("button", { name: "Older completed task" })).toBeInTheDocument();
    expect(document.querySelectorAll(".task-row.finished")).toHaveLength(0);

    act(() => api.emit({
      type: "ThreadUpdated",
      payload: { method: "turn/completed", projectId: project.id, threadId: "thread-2", turnId: "turn-new" }
    }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Older completed task" }).closest(".task-row")).toHaveClass("finished"));
  });

  it("moves the last messaged thread to the top and persists that order", async () => {
    const user = userEvent.setup();
    const secondThread = {
      ...thread,
      id: "thread-2",
      name: "Polish the sidebar",
      preview: "Polish the sidebar",
      turns: [{
        id: "turn-2",
        status: "completed",
        items: [
          { id: "user-2", type: "userMessage", content: [{ type: "text", text: "Polish the sidebar" }] },
          { id: "agent-2", type: "agentMessage", text: "The first pass is ready.", phase: "final_answer" }
        ]
      }]
    };
    window.pixice = createApi([thread, secondThread]);
    render(<App />);
    await screen.findByText("I traced the current flow.");

    const threadOrder = () => Array.from(document.querySelectorAll(".task-tree .task-select"), (button) => button.textContent);
    expect(threadOrder()).toEqual(["Refactor authentication", "Polish the sidebar"]);

    fireEvent.click(screen.getByRole("button", { name: "Polish the sidebar" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Polish the sidebar" })).toHaveAttribute("aria-current", "page"));
    const composer = screen.getByRole("textbox", { name: "Task prompt" });
    await user.type(composer, "Tighten the spacing too");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(threadOrder()[0]).toBe("Polish the sidebar"));
    expect(JSON.parse(localStorage.getItem("pixice.threadMessageRecency"))).toMatchObject({ "thread-2": expect.any(Number) });
    expect(screen.getByRole("button", { name: "Polish the sidebar" }).closest(".task-row")).toHaveAttribute("data-layout-animation", "true");
  });

  it("restores thread message order without animating when reduced motion is enabled", async () => {
    const secondThread = { ...thread, id: "thread-2", name: "Polish the sidebar", preview: "Polish the sidebar" };
    localStorage.setItem("pixice.threadMessageRecency", JSON.stringify({ "thread-1": 10, "thread-2": 20 }));
    localStorage.setItem("pixice.preferences", JSON.stringify({ reduceMotion: true }));
    window.pixice = createApi([thread, secondThread]);
    render(<App />);
    await screen.findByText("I traced the current flow.");

    const rows = Array.from(document.querySelectorAll(".task-tree .task-row"));
    expect(rows.map((row) => row.querySelector(".task-select").textContent)).toEqual(["Polish the sidebar", "Refactor authentication"]);
    expect(rows.every((row) => row.dataset.layoutAnimation === "false")).toBe(true);
  });

  it("tracks running and unseen finished work across projects", async () => {
    const secondProject = {
      ...project,
      id: "project-2",
      displayName: "Borealis",
      canonicalPath: "/work/borealis",
      folders: ["/work/borealis"],
      lastUsedAt: "2026-08-20T10:00:00.000Z"
    };
    const secondThread = {
      ...thread,
      id: "thread-2",
      name: "Ship Borealis",
      cwd: "/work/borealis",
      status: { type: "active", activeFlags: [] },
      updatedAt: "2026-08-22T10:00:00.000Z"
    };
    let secondProjectThreads = [secondThread];
    const api = createApi();
    api.app.bootstrap.mockResolvedValue({
      projects: [{ ...project, lastUsedAt: "2026-08-22T11:00:00.000Z" }, secondProject],
      models: [{ id: "gpt", model: "gpt-5.6", displayName: "GPT-5.6", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
      runtime: { state: "ready", connected: true },
      settings: {}
    });
    api.threads.list.mockImplementation(async ({ projectId }) => ({
      data: projectId === secondProject.id ? secondProjectThreads : [thread],
      nextCursor: null
    }));
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    const borealis = screen.getByRole("button", { name: "Borealis" });
    await waitFor(() => expect(borealis).toHaveAttribute("title", "Borealis · 1 running"));

    secondProjectThreads = [{ ...secondThread, status: "completed" }];
    act(() => api.emit({
      type: "ThreadUpdated",
      payload: { method: "turn/completed", projectId: secondProject.id, threadId: secondThread.id }
    }));
    await waitFor(() => expect(borealis).toHaveAttribute("title", "Borealis · 1 finished, unseen"));

    fireEvent.click(borealis);
    await waitFor(() => expect(screen.getByRole("button", { name: "Borealis" })).toHaveAttribute("title", "Borealis"));
  });

  it("does not mark a background bridge thread unseen before its final answer", async () => {
    const secondProject = {
      ...project,
      id: "project-2",
      displayName: "Borealis",
      canonicalPath: "/work/borealis",
      folders: ["/work/borealis"],
      lastUsedAt: "2026-08-20T10:00:00.000Z"
    };
    const bridgeThread = {
      ...thread,
      id: "bridge-thread",
      name: "Review Borealis",
      cwd: "/work/borealis",
      parentThreadId: "borealis-parent",
      bridge: { kind: "pixiceBridge", parentThreadId: "borealis-parent", model: "claude:claude-sonnet-4-6" },
      status: { type: "active", activeFlags: [] },
      turns: [],
      updatedAt: "2026-08-22T10:00:00.000Z"
    };
    const api = createApi();
    api.app.bootstrap.mockResolvedValue({
      projects: [{ ...project, lastUsedAt: "2026-08-22T11:00:00.000Z" }, secondProject],
      models: [{ id: "gpt", model: "gpt-5.6", displayName: "GPT-5.6", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
      runtime: { state: "ready", connected: true },
      settings: {}
    });
    api.threads.list.mockImplementation(async ({ projectId }) => ({
      data: projectId === secondProject.id ? [bridgeThread] : [thread],
      nextCursor: null
    }));
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    const borealis = screen.getByRole("button", { name: "Borealis" });
    await waitFor(() => expect(borealis).toHaveAttribute("title", "Borealis · 1 running"));

    act(() => api.emit({
      type: "ThreadUpdated",
      payload: { method: "thread/status/changed", projectId: secondProject.id, threadId: bridgeThread.id, status: "idle" }
    }));
    await waitFor(() => expect(borealis).toHaveAttribute("title", "Borealis"));

    act(() => api.emit({
      type: "ThreadUpdated",
      payload: {
        method: "turn/completed",
        projectId: secondProject.id,
        threadId: bridgeThread.id,
        turn: {
          id: "bridge-turn",
          status: "completed",
          items: [{ id: "bridge-answer", type: "agentMessage", text: "Borealis is ready.", phase: "final_answer" }]
        }
      }
    }));
    await waitFor(() => expect(borealis).toHaveAttribute("title", "Borealis · 1 finished, unseen"));
  });

  it("persists agent behavior packs for every Pixice agent", async () => {
    const api = createApi();
    api.app.bootstrap.mockResolvedValue({
      projects: [project],
      models: [{ id: "gpt", model: "gpt-5.6", displayName: "GPT-5.6", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
      runtime: { state: "ready", connected: true },
      settings: { agentBehaviors: { structuredPlanning: true, parallelDelegation: false, verification: true } },
      agentBehaviors: [
        { id: "structuredPlanning", label: "Structured planning", description: "Plan multi-step work.", category: "core", defaultEnabled: true },
        { id: "parallelDelegation", label: "Parallel delegation", description: "Use focused helper agents.", category: "core", defaultEnabled: false },
        { id: "verification", label: "Verification before handoff", description: "Run proportionate checks.", category: "core", defaultEnabled: true },
        { id: "workflowAutomation", label: "Workflow-first automation", description: "Proactively use Pixice workflows for reusable processes.", category: "pixice-native", defaultEnabled: false },
        { id: "boardStewardship", label: "Board stewardship", description: "Proactively inspect the board and capture durable follow-ups.", category: "pixice-native", defaultEnabled: false },
        { id: "threadOrchestration", label: "Thread orchestration", description: "Spawn focused Pixice threads.", category: "pixice-native", defaultEnabled: false },
        { id: "tools", label: "Tools", description: "Extend Pixice with project-specific controls and views without building a separate app.", category: "pixice-native", defaultEnabled: false }
      ]
    });
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Agents/ }));
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pixice-native features" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Parallel delegation" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Tools" })).not.toBeChecked();

    fireEvent.click(screen.getByRole("checkbox", { name: "Tools" }));
    expect(api.app.saveSettings).toHaveBeenCalledWith({
      agentBehaviors: {
        structuredPlanning: true,
        parallelDelegation: false,
        verification: true,
        workflowAutomation: false,
        boardStewardship: false,
        threadOrchestration: false,
        tools: true
      }
    });
  });

  it("shows provider accounts, previous sessions, and opens sign in", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Providers/ }));

    expect(await screen.findByRole("heading", { name: "Providers" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "OpenAI Codex" })).toBeInTheDocument();
    expect(screen.getByText("dev@example.com · plus")).toBeInTheDocument();
    expect(screen.getByText("3 previous sessions")).toBeInTheDocument();
    const claudeProvider = screen.getByRole("article", { name: "Anthropic Claude provider" });
    expect(within(claudeProvider).getByRole("heading", { name: "Anthropic Claude" })).toBeInTheDocument();
    expect(within(claudeProvider).getByText("Sign in required")).toBeInTheDocument();
    expect(within(claudeProvider).queryByText("Connected")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(window.pixice.providers.login).toHaveBeenCalledWith({ provider: "claude" });
    expect(screen.getByRole("button", { name: "Check sign-in" })).toBeInTheDocument();
  });

  it("shows Codex and Claude runtime health independently", async () => {
    const api = createApi();
    api.app.bootstrap.mockResolvedValue({
      projects: [project],
      models: [{ id: "claude", model: "claude-sonnet-5", displayName: "Claude Sonnet 5", provider: "claude", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
      runtime: { state: "ready", connected: true },
      settings: {}
    });
    api.providers.list.mockResolvedValue([
      { id: "codex", installed: true, compatible: true, connected: false, status: { state: "unavailable", message: "Codex service failed to start" }, health: { state: "healthy", message: "Codex executable verified" }, actions: { checkUpdate: true, login: false } },
      { id: "claude", installed: true, compatible: true, connected: true, status: { state: "ready", message: "Claude runtime available" }, health: { state: "healthy", message: "Claude Code is ready" }, actions: { checkUpdate: true, login: true } }
    ]);
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Providers/ }));

    const healthSection = (await screen.findByRole("heading", { name: "Runtime health" })).closest("section");
    const codexRow = within(healthSection).getByText("Codex", { selector: "strong" }).closest(".preference-row");
    const claudeRow = within(healthSection).getByText("Claude Code", { selector: "strong" }).closest(".preference-row");
    expect(within(codexRow).getByText("Offline")).toBeInTheDocument();
    expect(within(codexRow).getByText(/Codex service failed to start/)).toBeInTheDocument();
    expect(within(claudeRow).getByText("Connected")).toBeInTheDocument();
    expect(within(claudeRow).getByText(/Claude runtime available/)).toBeInTheDocument();
    expect(within(claudeRow).getByText(/1 model available/)).toBeInTheDocument();

    act(() => api.emit({
      type: "RuntimeStatus",
      payload: {
        state: "ready",
        connected: true,
        providers: {
          codex: { state: "ready", message: "Codex runtime recovered" },
          claude: { state: "unavailable", message: "Claude runtime stopped" }
        }
      }
    }));
    await waitFor(() => expect(within(codexRow).getByText("Connected")).toBeInTheDocument());
    expect(within(codexRow).getByText(/Codex runtime recovered/)).toBeInTheDocument();
    expect(within(claudeRow).getByText("Offline")).toBeInTheDocument();
    expect(within(claudeRow).getByText(/Claude runtime stopped/)).toBeInTheDocument();
  });

  it("keeps separate setup actions available for missing and broken providers", async () => {
    const user = userEvent.setup();
    const api = createApi();
    let finishCodexInstall;
    api.providers.install.mockImplementation(() => new Promise((resolve) => { finishCodexInstall = resolve; }));
    api.providers.list.mockResolvedValue([
      { id: "codex", installed: false, compatible: false, health: { state: "missing", message: "Codex is not installed" }, actions: { install: true, locate: true } },
      { id: "claude", compatible: false, health: { state: "broken", message: "Claude Code needs repair" }, actions: { repair: true, locate: true } }
    ]);
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: /^Providers/ }));

    const codex = await screen.findByRole("article", { name: "OpenAI Codex provider" });
    const claude = screen.getByRole("article", { name: "Anthropic Claude provider" });
    expect(within(codex).getByText("Not installed")).toBeInTheDocument();
    expect(within(codex).getByRole("button", { name: "Install" })).toBeInTheDocument();
    expect(within(codex).getByRole("button", { name: "Locate" })).toBeInTheDocument();
    expect(within(claude).getByText("Needs repair")).toBeInTheDocument();
    expect(within(claude).getByRole("button", { name: "Repair" })).toBeInTheDocument();
    expect(within(claude).getByRole("button", { name: "Locate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /install both/i })).not.toBeInTheDocument();

    await user.click(within(codex).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(api.providers.install).toHaveBeenCalledWith({ provider: "codex" }));
    const claudeLocate = within(screen.getByRole("article", { name: "Anthropic Claude provider" })).getByRole("button", { name: "Locate" });
    expect(claudeLocate).toBeEnabled();
    await user.click(claudeLocate);
    await waitFor(() => expect(api.providers.locate).toHaveBeenCalledWith({ provider: "claude" }));
    await act(async () => finishCodexInstall({}));
  });

  it("keeps managed credentials honest and allows a connected provider to sign out", async () => {
    const user = userEvent.setup();
    const api = createApi();
    api.providers.list.mockResolvedValue([
      { id: "codex", installed: true, compatible: true, connected: true, authenticated: true, externallyManagedAuth: true, executablePath: "/usr/local/bin/codex", version: "1.2.3", actions: { logout: false } },
      { id: "claude", installed: true, compatible: true, connected: true, authenticated: true, account: { email: "dev@example.com" }, actions: { logout: true } }
    ]);
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: /^Providers/ }));

    const codex = await screen.findByRole("article", { name: "OpenAI Codex provider" });
    const claude = screen.getByRole("article", { name: "Anthropic Claude provider" });
    expect(within(codex).getByText("Managed externally")).toBeInTheDocument();
    expect(within(codex).queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    await user.click(within(claude).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(api.providers.logout).toHaveBeenCalledWith({ provider: "claude" }));
  });

  it("does not label a missing runtime as connected just because its credentials are external", async () => {
    const user = userEvent.setup();
    const api = createApi();
    api.providers.list.mockResolvedValue([
      { id: "codex", installed: false, compatible: false, externallyManagedAuth: true, health: { state: "missing", message: "Codex is not installed" }, actions: { install: true, locate: true, logout: false } },
      { id: "claude", installed: false, compatible: false, health: { state: "missing", message: "Claude Code is not installed" }, actions: { install: true, locate: true, logout: false } }
    ]);
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: /^Providers/ }));

    const codex = await screen.findByRole("article", { name: "OpenAI Codex provider" });
    expect(within(codex).getByText("Not installed")).toBeInTheDocument();
    expect(within(codex).queryByText("Managed externally")).not.toBeInTheDocument();
    expect(within(codex).getByRole("button", { name: "Install" })).toBeInTheDocument();
  });

  it("keeps provider-neutral workspaces usable with zero connected providers", async () => {
    const user = userEvent.setup();
    const api = createApi();
    api.app.bootstrap.mockResolvedValue({
      projects: [project],
      models: [],
      runtime: { state: "unavailable", connected: false },
      settings: {},
      agentBehaviors: [{ id: "verification", label: "Verification", description: "Run proportional checks.", category: "core", defaultEnabled: true }]
    });
    api.providers.list.mockResolvedValue([]);
    window.pixice = api;
    render(<WorkflowHost><App /></WorkflowHost>);
    await screen.findByText("I traced the current flow.");

    expect(screen.getAllByText("Aurora").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Board" })).toBeEnabled();
    expect(await screen.findByRole("button", { name: "Workflows" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: /^Providers/ }));
    expect(await screen.findByRole("article", { name: "OpenAI Codex provider" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Anthropic Claude provider" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Agents/ }));
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeInTheDocument();
  });

  it("updates an individual provider row from lifecycle progress events", async () => {
    const api = createApi();
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Providers/ }));
    await screen.findByRole("article", { name: "OpenAI Codex provider" });

    act(() => api.emit({
      type: "ProviderLifecycleState",
      payload: {
        provider: "codex",
        installed: false,
        compatible: false,
        health: { state: "missing", message: "Codex is not installed" },
        installState: { state: "installing", operation: "installing", message: "Installing Codex", progress: "Downloading Codex" },
        actions: { install: false, locate: false }
      }
    }));

    const codex = screen.getByRole("article", { name: "OpenAI Codex provider" });
    expect(within(codex).getByText("Installing Codex")).toBeInTheDocument();
    expect(codex).toHaveAttribute("aria-busy", "true");
  });

  it("checks and updates Codex and Claude independently from Settings", async () => {
    const user = userEvent.setup();
    const api = createApi();
    api.providers.list.mockResolvedValue([
      {
        id: "codex",
        installed: true,
        compatible: true,
        connected: true,
        authenticated: true,
        version: "codex-cli 0.149.0",
        health: { state: "healthy", message: "Codex is ready" },
        updateState: { state: "available", availableVersion: "0.151.0", message: "Codex 0.151.0 is available" },
        actions: { checkUpdate: true, update: true, logout: true }
      },
      {
        id: "claude",
        installed: true,
        compatible: true,
        connected: true,
        authenticated: true,
        version: "2.1.234",
        health: { state: "healthy", message: "Claude Code is ready" },
        updateState: { state: "not-available", availableVersion: null, message: "Claude Code is up to date" },
        actions: { checkUpdate: true, update: false, logout: true }
      }
    ]);
    api.app.bootstrap.mockResolvedValue({
      projects: [project],
      models: [{ id: "gpt", model: "gpt-5.6", displayName: "GPT-5.6", provider: "codex", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
      runtime: { state: "ready", connected: true },
      settings: { checkProviderUpdates: true }
    });
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: /^Providers/ }));
    const codex = await screen.findByRole("article", { name: "OpenAI Codex provider" });
    const claude = screen.getByRole("article", { name: "Anthropic Claude provider" });
    expect(within(codex).getByText("Update available")).toBeInTheDocument();
    await user.click(within(codex).getByRole("button", { name: "Update to 0.151.0" }));
    await waitFor(() => expect(api.providers.update).toHaveBeenCalledWith({ provider: "codex" }));
    expect(api.providers.update).not.toHaveBeenCalledWith({ provider: "claude" });
    await user.click(within(claude).getByRole("button", { name: "Check update" }));
    await waitFor(() => expect(api.providers.checkUpdates).toHaveBeenCalledWith({ provider: "claude" }));

    await user.click(screen.getByRole("checkbox", { name: "Check provider updates automatically" }));
    expect(api.app.saveSettings).toHaveBeenCalledWith({ checkProviderUpdates: false });
  });

  it("shows measured token usage, cost averages, charts, and the current rate card", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Usage/ }));

    expect(await screen.findByRole("heading", { name: "Usage" })).toBeInTheDocument();
    await waitFor(() => expect(window.pixice.usage.summary).toHaveBeenCalledWith({ days: 30 }));
    await waitFor(() => expect(window.pixice.usage.limits).toHaveBeenCalled());
    const usageOverview = screen.getByRole("region", { name: "Usage overview" });
    const usageLimits = screen.getByRole("region", { name: "Codex usage limits" });
    expect(usageOverview.compareDocumentPosition(usageLimits) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "Codex" })).toHaveClass("selected");
    expect(screen.getByText("66% left")).toBeInTheDocument();
    expect(screen.getByText("GPT-5.3-Codex-Spark")).toBeInTheDocument();
    expect(screen.getByText("1 free full reset available")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Codex Weekly window remaining" })).toHaveAttribute("aria-valuenow", "66");
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(screen.getByRole("region", { name: "Claude usage limits" })).toBeInTheDocument();
    expect(screen.getByText("79% left")).toBeInTheDocument();
    expect(screen.queryByText("GPT-5.3-Codex-Spark")).not.toBeInTheDocument();
    expect(screen.getByLabelText("$31.50", { selector: ".usage-hero-heading .number-ticker" })).toBeInTheDocument();
    expect(screen.getByLabelText("$96.42", { selector: ".usage-hero-lifetime .number-ticker" })).toBeInTheDocument();
    expect(screen.getByText("Weekly average")).toBeInTheDocument();
    expect(screen.getByRole("grid", { name: "Daily API-equivalent spend heat map over the last 365 days" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Daily API-equivalent spend over 30 days" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "API-equivalent cost by model" })).toBeInTheDocument();
    expect(screen.getByText("GPT-5.6 Sol", { selector: ".usage-rate-row strong" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Anthropic" }));
    expect(screen.getByText("Claude Sonnet 5", { selector: ".usage-rate-row strong" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await waitFor(() => expect(window.pixice.usage.summary).toHaveBeenLastCalledWith({ days: 7 }));
  });

  it("shows only Claude limits when Claude is the sole signed-in provider", async () => {
    const api = createApi();
    api.usage.limits.mockResolvedValue({
      status: "available",
      fetchedAt: "2026-08-25T10:00:00.000Z",
      providers: [{
        provider: "claude",
        label: "Claude",
        status: "available",
        planType: "pro",
        limits: [{
          id: "claude",
          name: "Claude",
          windows: [{ usedPercent: 25, remainingPercent: 75, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3_600 }]
        }],
        resetCredits: { availableCount: 0, credits: [] }
      }]
    });
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Usage/ }));

    expect(await screen.findByRole("region", { name: "Claude usage limits" })).toBeInTheDocument();
    expect(screen.getByText("75% left")).toBeInTheDocument();
    expect(screen.queryByLabelText("Usage provider")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Codex usage limits" })).not.toBeInTheDocument();
  });

  it("shows only Codex limits when Codex is the sole signed-in provider", async () => {
    const api = createApi();
    api.usage.limits.mockResolvedValue({
      status: "available",
      fetchedAt: "2026-08-25T10:00:00.000Z",
      providers: [{
        provider: "codex",
        label: "Codex",
        status: "available",
        planType: "plus",
        limits: [{
          id: "codex",
          name: null,
          windows: [{ usedPercent: 20, remainingPercent: 80, windowDurationMins: 10_080, resetsAt: Math.floor(Date.now() / 1000) + 86_400 }]
        }],
        resetCredits: { availableCount: 0, credits: [] }
      }]
    });
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Usage/ }));

    expect(await screen.findByRole("region", { name: "Codex usage limits" })).toBeInTheDocument();
    expect(screen.getByText("80% left")).toBeInTheDocument();
    expect(screen.queryByLabelText("Usage provider")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Claude usage limits" })).not.toBeInTheDocument();
  });

  it("checks GitHub releases from About Pixice", async () => {
    const api = createApi();
    api.updates.status.mockResolvedValue({ supported: true, state: "idle", currentVersion: "0.1.0", availableVersion: null, percent: 0, message: "Ready to check GitHub releases." });
    api.updates.check.mockResolvedValue({ supported: true, state: "not-available", currentVersion: "0.1.0", availableVersion: null, percent: 0, message: "Pixice is up to date." });
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: /^About Pixice/ }));
    expect(await screen.findByRole("heading", { name: "About Pixice" })).toBeInTheDocument();
    expect(screen.getByText("Pixice 0.1.0")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(api.updates.check).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Pixice is up to date.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Provider updates" })).not.toBeInTheDocument();
    expect(screen.getByText(/Provider runtime updates live.*under Providers/)).toBeInTheDocument();
  });

  it("restores persistent model, reasoning, and permission defaults after an app update", async () => {
    const models = [{
      id: "gpt",
      model: "gpt-5.6",
      displayName: "GPT-5.6",
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }]
    }, {
      id: "gpt-54",
      model: "gpt-5.4",
      displayName: "GPT-5.4",
      isDefault: false,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }]
    }];
    const firstApi = createApi();
    firstApi.app.bootstrap.mockResolvedValue({
      projects: [project], models, runtime: { state: "ready", connected: true },
      settings: { defaultModel: "gpt-5.6", defaultEffort: "medium", defaultPermissionMode: "workspace-write" }
    });
    window.pixice = firstApi;

    const firstLaunch = render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    const modelSelect = await screen.findByRole("combobox", { name: "Default model" });
    const effortSelect = await screen.findByRole("combobox", { name: "Default reasoning effort" });
    const permissionSelect = await screen.findByRole("combobox", { name: "Default permissions" });
    fireEvent.change(modelSelect, { target: { value: "gpt-5.4" } });
    expect(effortSelect).toHaveValue("medium");
    fireEvent.change(effortSelect, { target: { value: "high" } });
    fireEvent.change(permissionSelect, { target: { value: "full-access" } });
    expect(firstApi.app.saveSettings).toHaveBeenCalledWith({ defaultModel: "gpt-5.4", defaultEffort: "medium" });
    expect(firstApi.app.saveSettings).toHaveBeenCalledWith({ defaultEffort: "high" });
    expect(firstApi.app.saveSettings).toHaveBeenCalledWith({ defaultPermissionMode: "full-access" });
    firstLaunch.unmount();
    localStorage.clear();

    const restartedApi = createApi();
    restartedApi.app.bootstrap.mockResolvedValue({
      projects: [project], models, runtime: { state: "ready", connected: true },
      settings: { defaultModel: "gpt-5.4", defaultEffort: "high", defaultPermissionMode: "full-access" }
    });
    window.pixice = restartedApi;
    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.keyDown(window, { key: ",", metaKey: true });

    expect(await screen.findByRole("combobox", { name: "Default model" })).toHaveValue("gpt-5.4");
    expect(await screen.findByRole("combobox", { name: "Default reasoning effort" })).toHaveValue("high");
    expect(await screen.findByRole("combobox", { name: "Default permissions" })).toHaveValue("full-access");
  });

  it("keeps composer reasoning changes scoped to their thread", async () => {
    const user = userEvent.setup();
    const secondThread = { ...thread, id: "thread-2", name: "Prepare release notes", preview: "Prepare release notes" };
    const models = [{
      id: "gpt",
      model: "gpt-5.6",
      displayName: "GPT-5.6",
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }]
    }];
    const api = createApi();
    api.app.bootstrap.mockResolvedValue({ projects: [project], models, runtime: { state: "ready", connected: true } });
    api.threads.list.mockResolvedValue({ data: [thread, secondThread], nextCursor: null });
    api.threads.read.mockImplementation(async ({ threadId }) => ({ thread: threadId === secondThread.id ? secondThread : thread }));
    window.pixice = api;

    const firstLaunch = render(<App />);
    await screen.findByText("I traced the current flow.");
    await user.click(screen.getByRole("button", { name: "Reasoning: Medium" }));
    await user.click(screen.getByRole("option", { name: /High/ }));
    expect(JSON.parse(localStorage.getItem("pixice.threadConfiguration.thread-1"))).toMatchObject({ effort: "high" });

    await user.click(screen.getByRole("button", { name: "Prepare release notes" }));
    expect(await screen.findByRole("button", { name: "Reasoning: Medium" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refactor authentication" }));
    expect(await screen.findByRole("button", { name: "Reasoning: High" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(await screen.findByRole("combobox", { name: "Default reasoning effort" })).toHaveValue("medium");

    firstLaunch.unmount();
    const restartedApi = createApi();
    restartedApi.app.bootstrap.mockResolvedValue({ projects: [project], models, runtime: { state: "ready", connected: true } });
    restartedApi.threads.list.mockResolvedValue({ data: [thread, secondThread], nextCursor: null });
    restartedApi.threads.read.mockImplementation(async ({ threadId }) => ({ thread: threadId === secondThread.id ? secondThread : thread }));
    window.pixice = restartedApi;
    render(<App />);

    expect(await screen.findByRole("button", { name: "Reasoning: High" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Prepare release notes" }));
    expect(await screen.findByRole("button", { name: "Reasoning: Medium" })).toBeInTheDocument();
  });

  it("filters the model picker by Codex and Claude provider", async () => {
    const user = userEvent.setup();
    const api = createApi();
    api.providers.list.mockResolvedValue([
      { id: "codex", connected: true, account: { type: "chatgpt", email: "dev@example.com" }, authenticated: true, requiresAuth: true, sessionCount: 0, loginAvailable: true },
      { id: "claude", connected: true, account: { type: "claude", email: "dev@example.com" }, authenticated: true, requiresAuth: true, sessionCount: 0, loginAvailable: true }
    ]);
    api.app.bootstrap.mockResolvedValue({
      projects: [project],
      models: [
        { model: "gpt-5.6", displayName: "GPT-5.6", provider: "codex", isDefault: true },
        { model: "sonnet", displayName: "Claude Sonnet", provider: "claude" },
        { model: "opus", displayName: "Claude Opus", provider: "claude" }
      ],
      runtime: { state: "ready", connected: true }
    });
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    await user.click(screen.getByRole("button", { name: "Model: GPT-5.6" }));
    expect(screen.getByRole("tab", { name: "Codex" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: /GPT-5.6/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Claude Opus/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Claude" }));
    expect(screen.getByRole("option", { name: /Claude Opus/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /GPT-5.6/ })).not.toBeInTheDocument();
  });

  it("marks Claude models as unauthenticated in the picker and starts sign in there", async () => {
    const user = userEvent.setup();
    const api = createApi();
    api.app.bootstrap.mockResolvedValue({
      projects: [project],
      models: [{ model: "gpt-5.6", displayName: "GPT-5.6", provider: "codex", isDefault: true }],
      runtime: { state: "ready", connected: true }
    });
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");
    await waitFor(() => expect(api.providers.list).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "Model: GPT-5.6" }));
    await user.click(screen.getByRole("tab", { name: "Claude" }));

    expect(screen.getByText("Claude isn't authenticated")).toBeInTheDocument();
    expect(screen.getByText("Sign in to use Anthropic models.")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Claude/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sign in to Anthropic" }));
    expect(api.providers.login).toHaveBeenCalledWith({ provider: "claude" });
    expect(screen.getByRole("button", { name: "Check sign-in" })).toBeInTheDocument();
  });

  it("keeps provider sign in reachable when no models are authenticated", async () => {
    const user = userEvent.setup();
    const api = createApi();
    api.app.bootstrap.mockResolvedValue({
      projects: [project],
      models: [],
      runtime: { state: "ready", connected: true }
    });
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");
    await waitFor(() => expect(api.providers.list).toHaveBeenCalled());

    const picker = screen.getByRole("button", { name: "Model: Choose model" });
    expect(picker).toBeEnabled();
    await user.click(picker);
    await user.click(screen.getByRole("tab", { name: "Claude" }));

    expect(screen.getByRole("button", { name: "Sign in to Anthropic" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("adds provider marks to model rows without changing generic Markdown tables", async () => {
    const modelTableThread = {
      ...thread,
      turns: [{
        id: "turn-model-table",
        status: "completed",
        items: [{
          id: "agent-model-table",
          type: "agentMessage",
          phase: "final_answer",
          text: "| Model | Context | $/1M in |\n| --- | --- | --- |\n| gpt-4o | 128k | $5.00 |\n| claude-3.5 | 200k | $3.00 |\n| llama-3.1 | 128k | $0.90 |\n\n| Area | State |\n| --- | --- |\n| Runtime | Ready |"
        }]
      }]
    };
    window.pixice = createApi(modelTableThread);

    const { container } = render(<App />);
    expect(await screen.findByText("gpt-4o")).toBeInTheDocument();
    expect(container.querySelectorAll(".message-table-wrap [data-model-brand]")).toHaveLength(3);
    expect(container.querySelector('.message-table-wrap [data-model-brand="openai"]')).toHaveAttribute("title", "OpenAI");
    expect(container.querySelector('.message-table-wrap [data-model-brand="anthropic"]')).toHaveAttribute("title", "Anthropic");
    expect(container.querySelector('.message-table-wrap [data-model-brand="meta"]')).toHaveAttribute("title", "Meta");
    expect(screen.getAllByRole("table")).toHaveLength(2);
  });

  it("resolves a live approval request", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");
    act(() => window.pixice.emit({
      type: "AttentionRequired",
      payload: { id: 17, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", command: "pnpm test" } },
      at: new Date().toISOString()
    }));
    fireEvent.click(await screen.findByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(window.pixice.approvals.resolve).toHaveBeenCalledWith({ requestId: 17, decision: "accept" }));
  });

  it("applies generated task names everywhere as soon as the runtime publishes them", async () => {
    const { container } = render(<App />);
    await screen.findByText("I traced the current flow.");

    act(() => window.pixice.emit({
      type: "RuntimeEvent",
      payload: { method: "thread/name/updated", threadId: "thread-1", name: "Authentication session repair" }
    }));

    await waitFor(() => expect(container.querySelector(".task-title")).toHaveTextContent("Authentication session repair"));
    expect(container.querySelector(".toolbar-title strong")).toHaveTextContent("Authentication session repair");
  });

  it("repairs an untitled sidebar entry from the named active-thread snapshot", async () => {
    const untitled = { ...thread, name: null, preview: "" };
    const api = createApi(untitled);
    api.threads.read.mockResolvedValue({ thread: { ...untitled, name: "Authentication session repair" } });
    window.pixice = api;

    const { container } = render(<App />);

    await waitFor(() => expect(container.querySelector(".task-title")).toHaveTextContent("Authentication session repair"));
    expect(container.querySelector(".toolbar-title strong")).toHaveTextContent("Authentication session repair");
  });

  it("answers structured user-input requests", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");
    act(() => window.pixice.emit({
      type: "AttentionRequired",
      payload: {
        id: "question-17",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          questions: [{ id: "strategy", header: "Strategy", question: "Which strategy?", options: [{ label: "Safe", description: "Use the conservative path" }] }]
        }
      },
      at: new Date().toISOString()
    }));

    await user.click(await screen.findByRole("radio", { name: /Safe/ }));
    await waitFor(() => expect(window.pixice.questions.respond).toHaveBeenCalledWith({
      requestId: "question-17",
      action: "answer",
      answers: { strategy: "Safe" }
    }));
  });

  it("wires unrestricted permission modes and MCP elicitation forms", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.keyDown(window, { key: ",", metaKey: true });
    const permissions = await screen.findByRole("combobox", { name: "Default permissions" });
    expect(within(permissions).getByRole("option", { name: "Auto-review" })).toBeInTheDocument();
    fireEvent.change(permissions, { target: { value: "full-access" } });
    expect(localStorage.getItem("pixice.permissionMode")).toBe("full-access");
    fireEvent.click(screen.getByRole("button", { name: "Back to task" }));

    act(() => window.pixice.emit({
      type: "AttentionRequired",
      payload: {
        id: "elicitation-17",
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          serverName: "Browser",
          mode: "form",
          message: "Choose how Pixice should continue",
          requestedSchema: {
            type: "object",
            properties: { destination: { type: "string", title: "Destination" } },
            required: ["destination"]
          }
        }
      }
    }));

    await user.type(await screen.findByRole("textbox", { name: "Destination" }), "Preview");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(window.pixice.elicitations.respond).toHaveBeenCalledWith({
      requestId: "elicitation-17",
      action: "accept",
      content: { destination: "Preview" }
    }));
  });

  it("keeps one live trace line with its timer while running and expands the full history after the final answer", async () => {
    const startedAt = new Date(Date.now() - 65_000).toISOString();
    const completedAt = new Date(Date.parse(startedAt) + 65_000).toISOString();
    const liveItems = [
      { id: "user-live", type: "userMessage", createdAt: startedAt, content: [{ type: "text", text: "Check the task" }] },
      { id: "reasoning-live", type: "reasoning", summary: ["Checking the current flow"] },
      { id: "command-live", type: "commandExecution", command: "pnpm test", status: "inProgress" }
    ];
    const liveThread = {
      ...thread,
      status: { type: "active" },
      turns: [{ id: "turn-live", status: "inProgress", startedAt, items: liveItems }]
    };
    window.pixice = createApi(liveThread);

    render(<App />);
    const runningStatus = await screen.findByRole("status", { name: "Running command: pnpm test" });
    expect(document.querySelector(".task-row.active [data-reasoning-orb]")).toBeInTheDocument();
    expect(runningStatus.querySelector('[data-reasoning-orb] > [aria-hidden="true"]')).toBeInTheDocument();
    expect(runningStatus.querySelectorAll(".trace-live-item")).toHaveLength(1);
    expect(runningStatus.querySelector("[data-shimmer-label]")).toHaveTextContent("Running command");
    expect(runningStatus.closest(".working-trace").querySelector(".trace-reasoning-list")).toHaveTextContent("Checking the current flow");
    expect(runningStatus).toHaveTextContent(/Working for 1m [5-6]s/);

    act(() => window.pixice.emit({
      type: "RuntimeEvent",
      payload: {
        method: "turn/plan/updated",
        threadId: "thread-1",
        plan: [{ step: "Inspect the project", status: "in_progress" }]
      }
    }));

    await waitFor(() => expect(document.querySelector(".conversation-column .task-progress")).toBeInTheDocument());
    const workingTrace = runningStatus.closest(".working-trace");
    const taskProgress = document.querySelector(".conversation-column .task-progress");
    expect(taskProgress).toHaveTextContent("Inspect the project");
    expect(workingTrace.compareDocumentPosition(taskProgress) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(taskProgress.querySelector(".progress-step.inProgress .spin-icon")).toBeInTheDocument();
    expect(taskProgress.querySelector(".progress-track > span")).toHaveStyle({ width: "0%" });
    const collapseProgress = screen.getByRole("button", { name: "Collapse task progress" });
    fireEvent.click(collapseProgress);
    expect(taskProgress).toHaveAttribute("data-expanded", "false");
    expect(screen.getByRole("button", { name: "Expand task progress" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Expand task progress" }));
    fireEvent.click(screen.getByRole("button", { name: "Open task map" }));
    expect(screen.getByRole("complementary", { name: "Task inspector" })).toHaveClass("open");
    expect(screen.getByRole("button", { name: "Hide task map" })).toBeInTheDocument();

    act(() => window.pixice.emit({
      type: "RuntimeEvent",
      payload: {
        method: "turn/plan/updated",
        threadId: "thread-1",
        plan: [
          { step: "One", status: "completed" },
          { step: "Two", status: "completed" },
          { step: "Three", status: "completed" },
          { step: "Four", status: "in_progress" },
          { step: "Five", status: "in_progress" },
          { step: "Six", status: "pending" }
        ]
      }
    }));
    await waitFor(() => expect(within(taskProgress).getByLabelText("3 of 6 complete")).toBeInTheDocument());
    expect(taskProgress.querySelector(".progress-track > span")).toHaveStyle({ width: "50%" });

    act(() => window.pixice.emit({
      type: "AgentUpdated",
      payload: {
        method: "item/completed",
        threadId: "thread-1",
        turnId: "turn-live",
        item: {
          id: "collab-live",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "thread-1",
          receiverThreadIds: ["agent-live"],
          prompt: "Audit runtime safety",
          agentsStates: { "agent-live": { status: "running", message: "Inspecting Electron" } }
        }
      }
    }));

    expect(await screen.findByText("Delegated agent")).toBeInTheDocument();
    expect(document.querySelector(".agent-row.child")).toHaveTextContent(/Working for \d+s · Inspecting Electron/);
    await waitFor(() => expect(workingTrace).not.toHaveTextContent("pnpm test"));
    expect(workingTrace).toHaveTextContent("Delegated work");
    expect(workingTrace.querySelectorAll(".trace-live-item")).toHaveLength(1);

    act(() => window.pixice.emit({
      type: "RuntimeEvent",
      payload: {
        method: "turn/plan/updated",
        threadId: "thread-1",
        plan: [{ step: "Inspect the project", status: "completed" }]
      }
    }));
    await waitFor(() => expect(within(taskProgress).getByLabelText("1 of 1 complete")).toBeInTheDocument());
    expect(taskProgress.querySelector(".progress-track > span")).toHaveStyle({ width: "100%" });

    act(() => window.pixice.emit({
      type: "RuntimeEvent",
      payload: {
        method: "turn/completed",
        threadId: "thread-1",
        turn: {
          id: "turn-live",
          status: "completed",
          startedAt,
          completedAt,
          items: [
            liveItems[0],
            liveItems[1],
            { ...liveItems[2], status: "completed", aggregatedOutput: "13 tests passed" },
            { id: "final-live", type: "agentMessage", text: "Everything passes.", phase: "final_answer", createdAt: completedAt }
          ]
        }
      }
    }));

    const settledToggle = await screen.findByRole("button", { name: "Worked for 1m 5s" });
    await waitFor(() => expect(settledToggle).toHaveAttribute("aria-expanded", "false"));
    const disclosure = document.getElementById(settledToggle.getAttribute("aria-controls"));
    expect(disclosure).toHaveAttribute("aria-hidden", "true");
    expect(await screen.findByText("Everything passes.")).toBeInTheDocument();
    expect(document.querySelectorAll("time.message-timestamp")).toHaveLength(2);

    fireEvent.click(settledToggle);
    expect(settledToggle).toHaveAttribute("aria-expanded", "true");
    expect(disclosure).toHaveAttribute("aria-hidden", "false");
    expect(screen.queryByText("13 tests passed")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("View output"));
    expect(await screen.findByText("13 tests passed")).toBeInTheDocument();
  });

  it("contains the live trace animation within the conversation width", () => {
    expect(appCss).toMatch(/\.working-trace\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(appCss).toMatch(/\.trace-live-viewport\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(appCss).toMatch(/\.conversation-scroll\s*\{[^}]*overflow-x:\s*hidden;/s);
  });

  it("shows only the newest working animation when an active turn has multiple trace groups", async () => {
    const startedAt = new Date(Date.now() - 30_000).toISOString();
    const liveThread = {
      ...thread,
      status: { type: "active" },
      turns: [{
        id: "turn-split-trace",
        status: "inProgress",
        startedAt,
        items: [
          { id: "user-split-trace", type: "userMessage", content: [{ type: "text", text: "Inspect the generated result" }] },
          { id: "file-split-trace", type: "fileChange", status: "completed", changes: [{ path: "src/result.js" }] },
          { id: "image-split-trace", type: "imageGeneration", status: "completed", result: "data:image/png;base64,aA==", revisedPrompt: "A generated result" },
          { id: "reasoning-split-trace", type: "reasoning", summary: ["Checking the generated result"] }
        ]
      }]
    };
    window.pixice = createApi(liveThread);

    render(<App />);
    expect(await screen.findByRole("status", { name: "Thinking" })).toBeInTheDocument();

    const traces = document.querySelectorAll(".conversation-column .working-trace");
    expect(traces).toHaveLength(2);
    expect(document.querySelectorAll('.conversation-column .working-trace[data-working="true"]')).toHaveLength(1);
    expect(document.querySelectorAll(".conversation-column .trace-live-toggle")).toHaveLength(1);
    expect(traces[0]).toHaveAttribute("data-working", "false");
    expect(traces[0]).toHaveTextContent("Updated files");
    expect(traces[1]).toHaveAttribute("data-working", "true");
    expect(traces[1]).toHaveTextContent("Checking the generated result");
  });

  it("applies saved conversation and orchestration disclosure defaults", async () => {
    const detailedThread = {
      ...thread,
      turns: [{
        id: "turn-detailed",
        status: "completed",
        items: [
          { id: "user-detailed", type: "userMessage", content: [{ type: "text", text: "Update the settings" }] },
          { id: "file-detailed", type: "fileChange", status: "completed", changes: [{ path: "src/App.jsx" }] },
          { id: "final-detailed", type: "agentMessage", text: "Settings updated.", phase: "final_answer" }
        ]
      }]
    };
    localStorage.setItem("pixice.preferences", JSON.stringify({
      completedWorkDetails: "expanded",
      expandTaskProgress: false,
      showMessageTimestamps: false
    }));
    window.pixice = createApi(detailedThread);
    render(<App />);

    expect(await screen.findByRole("button", { name: "Ran 1 action" })).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelectorAll("time.message-timestamp")).toHaveLength(0);

    act(() => window.pixice.emit({
      type: "RuntimeEvent",
      payload: {
        method: "turn/plan/updated",
        threadId: "thread-1",
        plan: [{ step: "Check customization", status: "in_progress" }]
      }
    }));

    await waitFor(() => expect(document.querySelector(".conversation-column .task-progress")).toHaveAttribute("data-expanded", "false"));
  });

  it("pauses stale plan activity while a task is inactive and resumes it with the next turn", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");

    act(() => window.pixice.emit({
      type: "RuntimeEvent",
      payload: {
        method: "turn/plan/updated",
        threadId: "thread-1",
        plan: [{ step: "Measure transport overhead", status: "in_progress" }]
      }
    }));

    await waitFor(() => expect(document.querySelector(".conversation-column .task-progress")).toBeInTheDocument());
    const taskProgress = document.querySelector(".conversation-column .task-progress");
    expect(taskProgress).toHaveAttribute("data-active", "false");
    expect(taskProgress).toHaveTextContent("Task is inactive");
    expect(taskProgress.querySelector(".progress-step.inProgress.inactive")).toBeInTheDocument();
    expect(taskProgress.querySelector(".progress-step .spin-icon")).not.toBeInTheDocument();

    act(() => window.pixice.emit({
      type: "RuntimeEvent",
      payload: { method: "turn/started", threadId: "thread-1", turn: { id: "turn-resumed", status: "inProgress", items: [] } }
    }));
    act(() => window.pixice.emit({
      type: "RuntimeEvent",
      payload: {
        method: "turn/plan/updated",
        threadId: "thread-1",
        plan: [{ step: "Measure transport overhead", status: "in_progress" }]
      }
    }));

    await waitFor(() => expect(document.querySelector(".conversation-column .task-progress")).toHaveAttribute("data-active", "true"));
    const resumedTaskProgress = document.querySelector(".conversation-column .task-progress");
    expect(resumedTaskProgress.querySelector(".progress-step.inProgress .spin-icon")).toBeInTheDocument();
  });

  it("preserves the reading position when live reasoning arrives after scrolling up", async () => {
    const readingThread = {
      ...thread,
      status: { type: "active" },
      turns: [{
        id: "turn-reading",
        status: "inProgress",
        items: [{ id: "user-reading", type: "userMessage", content: [{ type: "text", text: "Review the project" }] }]
      }]
    };
    window.pixice = createApi(readingThread);

    render(<App />);
    await screen.findByText("Review the project");
    await waitFor(() => expect(document.querySelector(".conversation-column")).not.toBeNull());
    const scroller = document.querySelector(".conversation-scroll");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1400 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
    scroller.scrollTop = 180;
    fireEvent.scroll(scroller);

    act(() => window.pixice.emit({
      type: "RuntimeEvent",
      payload: {
        method: "item/completed",
        threadId: "thread-1",
        turnId: "turn-reading",
        item: { id: "reasoning-reading", type: "reasoning", summary: ["Tracing another execution path"] }
      }
    }));

    expect(await screen.findByText("Tracing another execution path")).toBeInTheDocument();
    expect(scroller.scrollTop).toBe(180);

    scroller.scrollTop = 790;
    fireEvent.scroll(scroller);
    act(() => window.pixice.emit({
      type: "RuntimeEvent",
      payload: {
        method: "item/agentMessage/delta",
        threadId: "thread-1",
        turnId: "turn-reading",
        itemId: "commentary-reading",
        delta: "Still working"
      }
    }));

    await screen.findByText("Still working");
    await waitFor(() => expect(scroller.scrollTop).toBe(1400));
  });

  it("jumps to a selected prompt from the thread preview rail", async () => {
    const longThread = {
      ...thread,
      turns: [1, 2, 3].map((number) => ({
        id: `turn-${number}`,
        status: "completed",
        items: [
          { id: `user-${number}`, type: "userMessage", content: [{ type: "text", text: `Prompt ${number}` }] },
          { id: `agent-${number}`, type: "agentMessage", text: `Response ${number}`, phase: "final_answer" },
        ],
      })),
    };
    window.pixice = createApi(longThread);

    render(<App />);
    await screen.findByText("Response 3");
    const scroller = document.querySelector(".conversation-scroll");
    const target = document.getElementById("prompt-user-2");
    scroller.scrollTo = vi.fn();
    scroller.getBoundingClientRect = () => ({ top: 58 });
    target.getBoundingClientRect = () => ({ top: 500 });

    fireEvent.click(screen.getByRole("button", { name: "Jump to prompt 2: Prompt 2" }));

    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 414, behavior: "smooth" });

    fireEvent.click(screen.getByRole("button", { name: "Open preview workspace" }));
    expect(await screen.findByRole("region", { name: "Preview workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Prompts in this thread" })).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Close preview workspace" })[0]);
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Prompts in this thread" })).toBeInTheDocument());
  });

  it("shows the morphing reasoning orb and timer while waiting for the first activity event", async () => {
    const waitingThread = {
      ...thread,
      status: { type: "active" },
      turns: [{
        id: "turn-waiting",
        status: "inProgress",
        items: [{ id: "user-waiting", type: "userMessage", content: [{ type: "text", text: "Start the work" }] }]
      }]
    };
    window.pixice = createApi(waitingThread);

    render(<App />);
    const thinkingStatus = await screen.findByRole("status", { name: "Thinking: Getting started" });
    expect(thinkingStatus.querySelector("[data-reasoning-orb]")).toBeInTheDocument();
    expect(thinkingStatus.querySelector('[data-reasoning-orb] > [aria-hidden="true"]')).toBeInTheDocument();
    expect(thinkingStatus.querySelector("[data-shimmer-label]")).toHaveTextContent("Thinking");

    act(() => window.pixice.emit({
      type: "RuntimeEvent",
      payload: {
        method: "item/started",
        threadId: "thread-1",
        turnId: "turn-waiting",
        item: { id: "reasoning-waiting", type: "reasoning", summary: ["Reading the current implementation"] }
      }
    }));

    const activeThinkingStatus = await screen.findByRole("status", { name: "Thinking" });
    expect(activeThinkingStatus.querySelector("[data-reasoning-orb]")).toBeInTheDocument();
    expect(activeThinkingStatus.closest(".working-trace")).toHaveTextContent("Reading the current implementation");

    act(() => window.pixice.emit({
      type: "RuntimeEvent",
      payload: {
        method: "item/started",
        threadId: "thread-1",
        turnId: "turn-waiting",
        item: { id: "compaction-waiting", type: "contextCompaction" }
      }
    }));

    const compactingStatus = await screen.findByRole("status", { name: /Compacting/ });
    await waitFor(() => expect(compactingStatus.querySelector("[data-shimmer-label]")).toHaveTextContent("Compacting"));
    expect(compactingStatus.closest(".working-trace")).toHaveTextContent("Compacting context");

    act(() => window.pixice.emit({
      type: "RuntimeEvent",
      payload: {
        method: "item/completed",
        threadId: "thread-1",
        turnId: "turn-waiting",
        item: { id: "compaction-waiting", type: "contextCompaction" }
      }
    }));

    const resumedStatus = await screen.findByRole("status", { name: "Compacted context: Conversation summary ready" });
    expect(resumedStatus.closest(".working-trace")).toHaveTextContent("Compacted context");
  });

  it("creates a real thread before sending the first new-task message", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const composer = screen.getByRole("textbox", { name: "Task prompt" });
    await user.type(composer, "Implement the refresh flow");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(window.pixice.threads.create).toHaveBeenCalledWith({ projectId: "project-1", model: "gpt-5.6", permissionMode: "workspace-write" }));
    expect(window.pixice.turns.start).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      threadId: "thread-new",
      text: "Implement the refresh flow",
      permissionMode: "workspace-write"
    }));
    expect(window.pixice.threads.read).not.toHaveBeenCalledWith({
      projectId: "project-1",
      threadId: "thread-new"
    });
  });

  it("expands multiline prompts upward and caps the textarea height", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");
    const composer = screen.getByRole("textbox", { name: "Task prompt" });
    expect(composer).toHaveStyle({ height: "24px", overflowY: "hidden" });
    let scrollHeight = 132;
    Object.defineProperty(composer, "scrollHeight", { configurable: true, get: () => scrollHeight });

    fireEvent.change(composer, { target: { value: "First line\nSecond line\nThird line" } });
    expect(composer).toHaveStyle({ height: "132px", overflowY: "hidden" });

    scrollHeight = 360;
    fireEvent.change(composer, { target: { value: "First line\nSecond line\nThird line\nFourth line" } });
    expect(composer).toHaveStyle({ height: "240px", overflowY: "auto" });
  });

  it("uses icon-only permission and fast controls when preview is open", () => {
    expect(appCss).toMatch(/\.preview-mode \.composer-fast-toggle,\s*\.preview-mode \.composer-picker\.permission \.picker-trigger\s*\{[^}]*width:\s*30px;[^}]*padding:\s*0;/);
    expect(appCss).toMatch(/\.preview-mode \.composer-fast-toggle span,\s*\.preview-mode \.composer-picker\.permission \.picker-trigger-label,\s*\.preview-mode \.composer-picker\.permission \.picker-chevron\s*\{\s*display:\s*none;/);
  });

  it("shares the transcript geometry with the composer while the task inspector is open", () => {
    expect(appCss).toMatch(/\.pixice-app\[data-inspector-open="true"\] \.conversation-column\s*\{[^}]*width:\s*var\(--inspector-chat-width\);[^}]*margin-left:\s*var\(--inspector-chat-left\);/);
    expect(appCss).toMatch(/\.pixice-app\[data-inspector-open="true"\] \.composer\s*\{[^}]*left:\s*var\(--inspector-chat-left\);[^}]*width:\s*var\(--inspector-chat-width\);/);
  });

  it("opens a new task from the sidebar shortcut", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.keyDown(window, { key: "n", metaKey: true });

    await waitFor(() => expect(screen.getByRole("button", { name: "New task" })).toHaveAttribute("aria-current", "page"));
    expect(screen.getByRole("heading", { name: "What are we working on?" })).toBeInTheDocument();
  });

  it("renders the accent-aware hover morph for the New task action", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");

    const newTask = screen.getByRole("button", { name: "New task" });
    expect(newTask.querySelector(".new-task-hover-plus")).toHaveAttribute("aria-hidden", "true");
    expect(appCss).toMatch(/--new-task-hover-fill:\s*color-mix\(in oklab, var\(--primary\)/);
    expect(appCss).toMatch(/\.rail-nav-item\.new-task:not\(:disabled\):is\(:hover, :focus-visible\)[^{]*\{[^}]*transform:\s*translateY\(-1px\)/);
    expect(appCss).toMatch(/\.pixice-app\[data-reduce-motion="true"\][^{]*\.new-task-hover-plus\s*\{\s*transition-duration:\s*1ms/);
  });

  it("discovers and autocompletes Codex commands from the slash menu", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");
    const composer = screen.getByRole("textbox", { name: "Task prompt" });

    await user.type(composer, "/");
    const commands = screen.getByRole("listbox", { name: "Slash commands" });
    expect(within(commands).getByRole("option", { name: /\/model/ })).toHaveAttribute("aria-selected", "true");
    expect(within(commands).getByRole("option", { name: /\/permissions/ })).toBeInTheDocument();
    expect(within(commands).getByRole("option", { name: /\/compact/ })).toBeInTheDocument();

    await user.keyboard("{ArrowDown}{Enter}");
    expect(composer).toHaveValue("/fast ");
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
    expect(window.pixice.turns.start).not.toHaveBeenCalled();
  });

  it("filters slash commands and keeps unknown commands sendable", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");
    const composer = screen.getByRole("textbox", { name: "Task prompt" });

    await user.type(composer, "/compact");
    const commands = screen.getByRole("listbox", { name: "Slash commands" });
    expect(within(commands).getAllByRole("option")).toHaveLength(1);
    expect(within(commands).getByRole("option", { name: /\/compact/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();

    await user.clear(composer);
    await user.type(composer, "/not-a-pixice-command{Enter}");
    await waitFor(() => expect(window.pixice.turns.start).toHaveBeenCalledWith(expect.objectContaining({ text: "/not-a-pixice-command" })));
  });

  it("does not submit a new task twice when send is clicked repeatedly", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    await user.type(screen.getByRole("textbox", { name: "Task prompt" }), "Only once");
    const send = screen.getByRole("button", { name: "Send message" });
    fireEvent.click(send);
    fireEvent.click(send);

    await waitFor(() => expect(window.pixice.turns.start).toHaveBeenCalledTimes(1));
    expect(window.pixice.threads.create).toHaveBeenCalledTimes(1);
  });

  it("renders sent image attachments separately above the user prompt bubble", async () => {
    const attachmentThread = {
      ...thread,
      turns: [{
        id: "turn-attachments",
        status: "completed",
        items: [
          {
            id: "user-attachments",
            type: "userMessage",
            content: [
              { type: "text", text: "Compare these references" },
              { type: "image", url: "data:image/png;base64,AA==" },
              { type: "image", url: "data:image/png;base64,BB==" }
            ]
          },
          { id: "agent-attachments", type: "agentMessage", text: "I compared them.", phase: "final_answer" }
        ]
      }]
    };
    window.pixice = createApi(attachmentThread);
    render(<App />);

    await screen.findByText("I compared them.");
    const prompt = screen.getByText("Compare these references").closest(".user-message");
    const attachments = screen.getByLabelText("2 attached images");
    expect(attachments).toHaveClass("user-message-attachments");
    expect(prompt).not.toContainElement(attachments);
    expect(attachments.nextElementSibling).toBe(prompt);
    expect(within(attachments).getAllByRole("img")).toHaveLength(2);
    expect(appCss).toMatch(/\.user-message-picture\s*{[^}]*width:\s*80px;[^}]*height:\s*80px;/s);
    fireEvent.click(within(attachments).getByRole("button", { name: "Inspect Attached image 1" }));
    expect(screen.getByRole("dialog", { name: "Picture inspector" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Picture revision comments" })).not.toBeInTheDocument();
  });

  it("renders an attachment-only user message without an empty prompt bubble", async () => {
    const attachmentThread = {
      ...thread,
      turns: [{
        id: "turn-attachment-only",
        status: "completed",
        items: [
          { id: "user-attachment-only", type: "userMessage", content: [{ type: "image", url: "data:image/png;base64,AA==" }] },
          { id: "agent-attachment-only", type: "agentMessage", text: "I can see it.", phase: "final_answer" }
        ]
      }]
    };
    window.pixice = createApi(attachmentThread);
    render(<App />);

    await screen.findByText("I can see it.");
    const attachment = screen.getByRole("img", { name: "Attached image 1" });
    const block = attachment.closest(".user-message-block");
    expect(block.querySelector(".user-message")).toBeNull();
    expect(attachment.parentElement).toHaveAttribute("data-prompt-id", "user-attachment-only");
  });

  it("pastes image attachments and sends an attachment-only prompt", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");
    const composer = screen.getByRole("textbox", { name: "Task prompt" });
    const image = new File([new Uint8Array([137, 80, 78, 71])], "clipboard.png", { type: "image/png" });

    fireEvent.paste(composer, { clipboardData: { files: [image], items: [{ kind: "file", type: image.type, getAsFile: () => image }] } });

    expect(await screen.findByRole("img", { name: "clipboard.png" })).toBeInTheDocument();
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toBeEnabled();
    fireEvent.click(send);

    await waitFor(() => expect(window.pixice.turns.start).toHaveBeenCalledWith(expect.objectContaining({
      text: "",
      attachments: [{
        name: "clipboard.png",
        type: "image/png",
        size: 4,
        dataUrl: expect.stringMatching(/^data:image\/png;base64,/)
      }]
    })));
  });

  it("accepts dropped files anywhere in Pixice and lets the user remove them", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");
    const image = new File([new Uint8Array([82, 73, 70, 70])], "dropped.webp", { type: "image/webp" });
    const transfer = { files: [image], items: [{ kind: "file", type: image.type }] };

    fireEvent.dragEnter(window, { dataTransfer: transfer });
    expect(screen.getByText("Drop files to attach")).toBeInTheDocument();
    fireEvent.drop(window, { dataTransfer: transfer });

    expect(await screen.findByRole("img", { name: "dropped.webp" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove dropped.webp" }));
    expect(screen.queryByRole("img", { name: "dropped.webp" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("attaches code and Office documents without an image-only accept filter", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");
    const input = document.querySelector('input[type="file"]');
    expect(input).not.toHaveAttribute("accept");
    expect(screen.getByRole("button", { name: "Attach files" })).toBeInTheDocument();

    const code = new File(["export const answer = 42;"], "answer.ts", { type: "text/typescript" });
    const workbook = new File([new Uint8Array([80, 75, 3, 4])], "budget.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    fireEvent.change(input, { target: { files: [code, workbook] } });

    expect(await screen.findByText("answer.ts")).toBeInTheDocument();
    expect(screen.getByText("budget.xlsx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(window.pixice.turns.start).toHaveBeenCalledWith(expect.objectContaining({
      text: "",
      attachments: [
        expect.objectContaining({ name: "answer.ts", type: "text/typescript", dataUrl: expect.stringMatching(/^data:text\/typescript;base64,/) }),
        expect.objectContaining({ name: "budget.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", dataUrl: expect.stringMatching(/^data:application\/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,/) })
      ]
    })));
  });

  it("uses accessible model, reasoning, and permission pickers", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");

    await user.click(screen.getByRole("button", { name: "Permissions: Workspace access" }));
    expect(screen.getByRole("listbox", { name: "Permissions" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /Read only/ }));
    expect(screen.getByRole("button", { name: "Permissions: Read only" })).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByRole("button", { name: "Model: GPT-5.6" }));
    expect(screen.getByRole("listbox", { name: "Model" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Reasoning: High" }));
    expect(screen.getByRole("listbox", { name: "Reasoning" })).toBeInTheDocument();
  });

  it("enables fast mode for supported Codex models and sends the priority service tier", async () => {
    const user = userEvent.setup();
    const api = createApi();
    api.app.bootstrap.mockResolvedValue({
      projects: [project],
      models: [{
        id: "codex:gpt-5.6",
        model: "gpt-5.6",
        displayName: "GPT-5.6",
        provider: "codex",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        serviceTiers: [{ id: "priority", name: "Fast", description: "Faster inference with increased usage." }]
      }],
      runtime: { state: "ready", connected: true }
    });
    api.turns.start.mockResolvedValue({ turn: { id: "turn-fast", status: "completed", items: [] } });
    window.pixice = api;

    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.click(screen.getByRole("button", { name: "New task" }));

    const fastToggle = screen.getByRole("button", { name: "Fast mode" });
    expect(fastToggle).toHaveAttribute("aria-pressed", "false");
    await user.click(fastToggle);
    expect(fastToggle).toHaveAttribute("aria-pressed", "true");

    await user.type(screen.getByRole("textbox", { name: "Task prompt" }), "Ship this quickly");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(api.threads.create).toHaveBeenCalledWith(expect.objectContaining({ serviceTier: "priority" })));
    expect(api.turns.start).toHaveBeenCalledWith(expect.objectContaining({ serviceTier: "priority" }));

    await waitFor(() => expect(fastToggle).toBeEnabled());
    await user.click(fastToggle);
    await user.type(screen.getByRole("textbox", { name: "Task prompt" }), "Return to standard speed");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(api.turns.start).toHaveBeenLastCalledWith(expect.objectContaining({ serviceTier: null })));
  });

  it("does not show fast mode for Claude models", async () => {
    const api = createApi();
    api.app.bootstrap.mockResolvedValue({
      projects: [project],
      models: [{
        id: "claude:claude-sonnet-4-6",
        model: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        provider: "claude",
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        serviceTiers: [{ id: "priority", name: "Fast", description: "Ignored for non-Codex providers." }]
      }],
      runtime: { state: "ready", connected: true }
    });
    window.pixice = api;

    render(<App />);
    await screen.findByText("I traced the current flow.");

    expect(screen.queryByRole("button", { name: "Fast mode" })).not.toBeInTheDocument();
  });

  it("keeps composer permission changes scoped to their thread", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");
    await user.click(screen.getByRole("button", { name: "Permissions: Workspace access" }));
    await user.click(screen.getByRole("option", { name: /Read only/ }));
    await user.type(screen.getByRole("textbox", { name: "Task prompt" }), "Inspect this thread without edits");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(window.pixice.turns.start).toHaveBeenLastCalledWith(expect.objectContaining({ permissionMode: "read-only" })));

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(screen.getByRole("button", { name: "Permissions: Workspace access" })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Task prompt" }), "Start with the default access");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(window.pixice.threads.create).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "workspace-write" })));
    expect(window.pixice.turns.start).toHaveBeenLastCalledWith(expect.objectContaining({ permissionMode: "workspace-write" }));
  });

  it("shows events emitted immediately by a newly created thread", async () => {
    const user = userEvent.setup();
    const liveApi = createApi();
    const startedTurn = { id: "turn-new-live", status: "inProgress", items: [] };
    liveApi.turns.start = vi.fn(async ({ threadId }) => {
      liveApi.emit({
        type: "RuntimeEvent",
        payload: { method: "turn/started", threadId, turn: startedTurn }
      });
      liveApi.emit({
        type: "RuntimeEvent",
        payload: {
          method: "item/agentMessage/delta",
          threadId,
          turnId: startedTurn.id,
          itemId: "message-live",
          delta: "Live without switching tasks"
        }
      });
      return { turn: startedTurn };
    });
    window.pixice = liveApi;

    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const composer = screen.getByRole("textbox", { name: "Task prompt" });
    await user.type(composer, "Start immediately");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("Live without switching tasks")).toBeInTheDocument();
    expect(liveApi.threads.read).not.toHaveBeenCalledWith({
      projectId: "project-1",
      threadId: "thread-new"
    });
  });

  it("keeps a newly submitted prompt visible while turn startup is still pending", async () => {
    const user = userEvent.setup();
    const liveApi = createApi();
    let resolveStart;
    liveApi.turns.start = vi.fn(() => new Promise((resolve) => { resolveStart = resolve; }));
    window.pixice = liveApi;

    render(<App />);
    await screen.findByText("I traced the current flow.");
    await user.type(screen.getByRole("textbox", { name: "Task prompt" }), "Keep this prompt on screen");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    const prompt = await screen.findByText("Keep this prompt on screen");
    expect(prompt.closest(".user-message")).toBeInTheDocument();

    await act(async () => resolveStart({ turn: { id: "turn-pending", status: "inProgress", items: [] } }));
    expect(screen.getAllByText("Keep this prompt on screen")).toHaveLength(1);
  });

  it("keeps a steering prompt visible while the active turn accepts it", async () => {
    const user = userEvent.setup();
    const activeThread = {
      ...thread,
      status: { type: "active" },
      turns: [{
        id: "turn-active",
        status: "inProgress",
        items: [
          { id: "active-user", type: "userMessage", content: [{ type: "text", text: "Start the active run" }] },
          { id: "active-reasoning", type: "reasoning", summary: ["Working on it"] }
        ]
      }]
    };
    const liveApi = createApi(activeThread);
    let resolveSteer;
    liveApi.turns.steer = vi.fn(() => new Promise((resolve) => { resolveSteer = resolve; }));
    window.pixice = liveApi;

    render(<App />);
    await screen.findByText("Working on it");
    await user.type(screen.getByRole("textbox", { name: "Task prompt" }), "Keep the steering message visible");
    fireEvent.click(screen.getByRole("button", { name: "Steer task" }));

    const prompt = await screen.findByText("Keep the steering message visible");
    expect(prompt.closest(".user-message")).toBeInTheDocument();

    await act(async () => resolveSteer({}));
    expect(screen.getAllByText("Keep the steering message visible")).toHaveLength(1);
  });

  it("keeps follow-up prompts and answers visible without reopening the task", async () => {
    const user = userEvent.setup();
    const liveApi = createApi();
    const followUpTurn = { id: "turn-follow-up", status: "inProgress", items: [] };
    const refreshedThread = {
      ...thread,
      turns: [
        ...thread.turns,
        {
          id: followUpTurn.id,
          status: "completed",
          items: [
            { id: "user-follow-up", type: "userMessage", content: [{ type: "text", text: "What about retries?" }] },
            { id: "answer-follow-up", type: "agentMessage", text: "Retries are covered too.", phase: "final_answer" }
          ]
        }
      ]
    };
    liveApi.turns.start = vi.fn().mockResolvedValue({ turn: followUpTurn });
    liveApi.threads.read
      .mockResolvedValueOnce({ thread })
      .mockResolvedValue({ thread: refreshedThread });
    window.pixice = liveApi;

    render(<App />);
    await screen.findByText("I traced the current flow.");
    const composer = screen.getByRole("textbox", { name: "Task prompt" });
    await user.type(composer, "What about retries?");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("What about retries?")).toBeInTheDocument();
    expect(await screen.findByText("Retries are covered too.", {}, { timeout: 2500 })).toBeInTheDocument();
    expect(liveApi.threads.read).toHaveBeenCalledWith({ projectId: "project-1", threadId: "thread-1" });
  });

  it("reconciles live and persisted turn aliases without duplicate messages or reasoning", async () => {
    const user = userEvent.setup();
    const liveApi = createApi();
    const liveTurn = { id: "turn-live-alias", status: "inProgress", items: [] };
    const prompt = "Give me a rundown";
    const commentary = "I’ll inspect the project first.";
    const persistedThread = {
      ...thread,
      turns: [
        ...thread.turns,
        {
          id: "turn-persisted-alias",
          status: "completed",
          items: [
            { id: "persisted-user", type: "userMessage", content: [{ type: "text", text: prompt }] },
            { id: "persisted-commentary", type: "agentMessage", text: commentary, phase: "commentary" },
            { id: "persisted-answer", type: "agentMessage", text: "Here is the rundown.", phase: "final_answer" }
          ]
        }
      ]
    };
    liveApi.turns.start = vi.fn(async ({ threadId }) => {
      liveApi.emit({ type: "RuntimeEvent", payload: { method: "turn/started", threadId, turn: liveTurn } });
      liveApi.emit({
        type: "RuntimeEvent",
        payload: {
          method: "item/completed",
          threadId,
          turnId: liveTurn.id,
          item: { id: "live-user", type: "userMessage", content: [{ type: "text", text: prompt }] }
        }
      });
      liveApi.emit({
        type: "RuntimeEvent",
        payload: {
          method: "item/completed",
          threadId,
          turnId: liveTurn.id,
          item: { id: "live-commentary", type: "agentMessage", text: commentary, phase: "commentary" }
        }
      });
      return { turn: liveTurn };
    });
    liveApi.threads.read
      .mockResolvedValueOnce({ thread })
      .mockResolvedValue({ thread: persistedThread });
    window.pixice = liveApi;

    render(<App />);
    await screen.findByText("I traced the current flow.");
    const composer = screen.getByRole("textbox", { name: "Task prompt" });
    await user.type(composer, prompt);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("Here is the rundown.", {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getAllByText(prompt)).toHaveLength(1);
    expect(screen.getAllByText(commentary)).toHaveLength(1);
  });

  it("deletes a conversation from the task list", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Delete Refactor authentication" }));

    await waitFor(() => expect(window.pixice.threads.archive).toHaveBeenCalledWith({
      projectId: "project-1",
      threadId: "thread-1"
    }));
    expect(screen.queryByRole("button", { name: "Delete Refactor authentication" })).not.toBeInTheDocument();
  });

  it("resizes the sidebar with pointer and keyboard controls", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");
    const separator = screen.getByRole("separator", { name: "Resize sidebar" });
    const app = separator.closest(".pixice-app");

    fireEvent.pointerDown(separator, { clientX: 296 });
    fireEvent.pointerMove(window, { clientX: 352 });
    fireEvent.pointerUp(window);

    await waitFor(() => expect(app).toHaveStyle({ "--sidebar-width": "320px" }));
    expect(localStorage.getItem("pixice.sidebarWidth")).toBe("320");

    fireEvent.keyDown(separator, { key: "End" });
    await waitFor(() => expect(separator).toHaveAttribute("aria-valuenow", "360"));
    expect(localStorage.getItem("pixice.sidebarWidth")).toBe("360");
  });

  it("changes sidebar expansion only from the explicit toggle", async () => {
    localStorage.setItem("pixice.sidebarPinned", "false");
    render(<App />);
    await screen.findByText("I traced the current flow.");
    const sidebar = screen.getByRole("complementary", { name: "Primary navigation" });

    expect(sidebar).toHaveAttribute("data-expanded", "false");
    expect(appCss).toMatch(/\.task-select\s*\{[^}]*padding:\s*0 8px;/s);
    expect(sidebar.querySelector(".rail-badge")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aurora" })).toHaveAttribute("aria-current", "true");
    fireEvent.mouseEnter(sidebar);
    fireEvent.mouseLeave(sidebar);
    expect(sidebar).toHaveAttribute("data-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "Expand navigation labels" }));
    await waitFor(() => expect(sidebar).toHaveAttribute("data-expanded", "true"));
    expect(sidebar.querySelector(".rail-badge")).toHaveTextContent("1");
    fireEvent.mouseLeave(sidebar);
    expect(sidebar).toHaveAttribute("data-expanded", "true");
  });

  it("opens a tabbed preview workspace and temporarily collapses the sidebar", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");
    const sidebar = screen.getByRole("complementary", { name: "Primary navigation" });
    const app = document.querySelector(".pixice-app");

    expect(sidebar).toHaveAttribute("data-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Open preview workspace" }));

    expect(await screen.findByRole("region", { name: "Preview workspace" })).toBeInTheDocument();
    expect(document.querySelector(".task-workspace")).toHaveClass("preview-mode");
    expect(app).toHaveAttribute("data-preview-open", "true");
    expect(sidebar).toHaveAttribute("data-expanded", "false");
    expect(app).toHaveAttribute("data-sidebar-expanded", "false");
    expect(document.querySelectorAll(".browser-tab-active-indicator")).toHaveLength(1);
    expect(appCss).toMatch(/\.browser-tab\s*\{[^}]*height:\s*32px;/s);
    expect(appCss).toMatch(/\.browser-tab-active-indicator::before[\s\S]*border-bottom-right-radius:\s*10px;/);
    expect(screen.getByRole("separator", { name: "Resize chat and preview" })).toBeInTheDocument();
    expect(appCss).toMatch(/\.task-workspace\.preview-mode\s*\{[^}]*var\(--app-frame-gap\)[^}]*minmax\(360px, 1fr\);/s);

    const expandButton = screen.getByRole("button", { name: "Expand navigation labels" });
    expect(expandButton).toBeEnabled();
    fireEvent.click(expandButton);
    expect(sidebar).toHaveAttribute("data-expanded", "true");
    expect(app).toHaveAttribute("data-sidebar-expanded", "true");
    expect(appCss).toMatch(/\.pixice-app\[data-preview-open="true"\]\[data-sidebar-expanded="false"\]\s*\{\s*--rail-width:\s*64px;/);

    fireEvent.click(screen.getByRole("button", { name: "New preview tab" }));
    expect(await screen.findByLabelText("New preview tab options")).toBeInTheDocument();
    const createdBrowserState = {
      native: false,
      workspaceId: "thread-1",
      activeTabId: "browser-2",
      tabs: [
        { id: "browser-1", title: "Existing tab", url: "https://example.com", loading: false, error: null, canGoBack: false, canGoForward: false },
        { id: "browser-2", title: "New tab", url: "", loading: false, error: null, canGoBack: false, canGoForward: false }
      ]
    };
    window.pixice.browser.create.mockResolvedValue(createdBrowserState);
    window.pixice.browser.setViewport.mockResolvedValue(createdBrowserState);
    fireEvent.click(screen.getByRole("button", { name: /BrowserOpen a web page/ }));
    expect(window.pixice.browser.create).toHaveBeenCalledWith({ workspaceId: "thread-1" });
    await waitFor(() => expect(screen.queryByLabelText("New preview tab options")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("tab", { name: "New tab" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByRole("tab", { name: "Existing tab" })).toHaveAttribute("aria-selected", "false");
    await waitFor(() => expect(window.pixice.preview.setContext).toHaveBeenCalledWith({
      threadId: "thread-1",
      context: {
        open: true,
        tabCount: 2,
        active: expect.objectContaining({ kind: "browser", id: "browser-2", title: "New tab" })
      }
    }));

    fireEvent.change(screen.getByRole("textbox", { name: "Task prompt" }), { target: { value: "look at this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(window.pixice.turns.start).toHaveBeenCalledWith(expect.objectContaining({
      text: "look at this",
      previewContext: {
        open: true,
        tabCount: 2,
        active: expect.objectContaining({ kind: "browser", id: "browser-2" })
      }
    })));

    fireEvent.click(screen.getAllByRole("button", { name: "Close preview workspace" })[0]);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Preview workspace" })).not.toBeInTheDocument());
    expect(sidebar).toHaveAttribute("data-expanded", "true");
  });

  it("opens, runs, and closes a thread-scoped iOS Simulator tab", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.click(screen.getByRole("button", { name: "Open preview workspace" }));
    await screen.findByRole("region", { name: "Preview workspace" });
    fireEvent.click(screen.getByRole("button", { name: "New preview tab" }));
    fireEvent.click(await screen.findByRole("button", { name: /iOS SimulatorBuild and run SwiftUI/ }));

    expect(await screen.findByRole("region", { name: "iOS Simulator Preview" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Run" }));
    await waitFor(() => expect(window.pixice.ios.start).toHaveBeenCalledWith({
      workspaceId: "thread-1",
      projectId: "project-1",
      containerPath: "Aurora.xcodeproj",
      scheme: "Aurora",
      simulatorUdid: "SIM-1",
      configuration: "Debug"
    }));
    await waitFor(() => expect(window.pixice.preview.setContext).toHaveBeenCalledWith({
      threadId: "thread-1",
      context: expect.objectContaining({
        active: expect.objectContaining({ kind: "simulator", sessionId: "ios-session-1", simulatorUdid: "SIM-1", status: "ready" })
      })
    }));

    fireEvent.click(screen.getByRole("button", { name: /Close iPhone 17 Pro/ }));
    expect(window.pixice.ios.stop).toHaveBeenCalledWith({ workspaceId: "thread-1" });
  });

  it("keeps the native browser viewport hidden while a workflow tab is active", async () => {
    const api = window.pixice;
    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.click(screen.getByRole("button", { name: "Open preview workspace" }));

    await screen.findByRole("region", { name: "Preview workspace" });
    await waitFor(() => expect(api.browser.setViewport).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "thread-1",
      visible: true
    })));

    api.browser.setViewport.mockClear();
    act(() => window.dispatchEvent(new CustomEvent("pixice:open-preview-tab", { detail: {
      workspaceId: "thread-1",
      tab: {
        id: "workflow:workflow-1",
        kind: "workflow",
        title: "Release workflow",
        payload: { projectId: "project-1", workflowId: "workflow-1", workflowName: "Release workflow", reason: "edit" }
      }
    } })));

    expect(await screen.findByRole("tab", { name: "Release workflow" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(api.browser.setViewport).toHaveBeenCalledWith({
      workspaceId: "thread-1",
      visible: false
    }));
    expect(api.browser.setViewport).not.toHaveBeenCalledWith(expect.objectContaining({ visible: true }));
  });

  it("hides the native browser viewport while the Workflows workspace covers Preview", async () => {
    const api = window.pixice;
    api.workflows = {
      list: vi.fn().mockResolvedValue({ data: [] })
    };
    render(<WorkflowHost><App /></WorkflowHost>);
    await screen.findByText("I traced the current flow.");
    fireEvent.click(screen.getByRole("button", { name: "Open preview workspace" }));

    await screen.findByRole("region", { name: "Preview workspace" });
    await waitFor(() => expect(api.browser.setViewport).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "thread-1",
      visible: true
    })));

    api.browser.setViewport.mockClear();
    fireEvent.click(await screen.findByRole("button", { name: "Workflows" }));
    await waitFor(() => expect(document.querySelector('[data-workflow-workspace="true"]')).toBeInTheDocument());
    await waitFor(() => expect(api.browser.setViewport).toHaveBeenCalledWith({
      workspaceId: "thread-1",
      visible: false
    }));
    expect(api.browser.setViewport).not.toHaveBeenCalledWith(expect.objectContaining({ visible: true }));

    api.browser.setViewport.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Back to task" }));
    await waitFor(() => expect(api.browser.setViewport).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "thread-1",
      visible: true
    })));
  });

  it("hides the native browser viewport behind a picture inspector and restores it on close", async () => {
    const imageThread = {
      ...thread,
      turns: [{
        ...thread.turns[0],
        items: [
          ...thread.turns[0].items,
          {
            id: "generated-picture",
            type: "imageGeneration",
            status: "completed",
            result: "data:image/png;base64,AA==",
            revisedPrompt: "Pixice workspace concept"
          }
        ]
      }]
    };
    const api = createApi(imageThread);
    window.pixice = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.click(screen.getByRole("button", { name: "Open preview workspace" }));

    await screen.findByRole("region", { name: "Preview workspace" });
    await waitFor(() => expect(api.browser.setViewport).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "thread-1",
      visible: true
    })));

    api.browser.setViewport.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Inspect Pixice workspace concept" }));
    expect(await screen.findByRole("dialog", { name: "Generated picture inspector" })).toBeInTheDocument();
    await waitFor(() => expect(api.browser.setViewport).toHaveBeenCalledWith({
      workspaceId: "thread-1",
      visible: false
    }));
    expect(api.browser.setViewport).not.toHaveBeenCalledWith(expect.objectContaining({ visible: true }));

    api.browser.setViewport.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Close picture inspector" }));
    await waitFor(() => expect(api.browser.setViewport).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "thread-1",
      visible: true
    })));
  });

  it("resizes and resets the chat-preview split", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.click(screen.getByRole("button", { name: "Open preview workspace" }));
    await screen.findByRole("region", { name: "Preview workspace" });

    const workspace = document.querySelector(".task-workspace");
    const canvas = workspace.querySelector(".main-canvas");
    const separator = screen.getByRole("separator", { name: "Resize chat and preview" });
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue({ width: 1000, height: 700, x: 0, y: 0, top: 0, right: 1000, bottom: 700, left: 0, toJSON() {} });
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ width: 400, height: 700, x: 0, y: 0, top: 0, right: 400, bottom: 700, left: 0, toJSON() {} });

    fireEvent.pointerDown(separator, { clientX: 400 });
    fireEvent.pointerMove(window, { clientX: 468 });
    fireEvent.pointerUp(window);

    expect(workspace).toHaveStyle({ "--preview-chat-width": "468px" });
    expect(localStorage.getItem("pixice.previewChatWidth")).toBe("468");

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(workspace).toHaveStyle({ "--preview-chat-width": "452px" });
    expect(localStorage.getItem("pixice.previewChatWidth")).toBe("452");

    fireEvent.doubleClick(separator);
    expect(workspace.style.getPropertyValue("--preview-chat-width")).toBe("");
    expect(localStorage.getItem("pixice.previewChatWidth")).toBeNull();
  });

  it("keeps the sidebar open when preview starts under the pointer until explicitly collapsed", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");
    const sidebar = screen.getByRole("complementary", { name: "Primary navigation" });

    fireEvent.mouseEnter(sidebar);
    act(() => window.pixice.emit({
      type: "BrowserOpenRequested",
      payload: { threadId: "thread-1", workspaceId: "thread-1", source: "codex" }
    }));

    expect(await screen.findByRole("region", { name: "Preview workspace" })).toBeInTheDocument();
    expect(sidebar).toHaveAttribute("data-expanded", "true");

    fireEvent.mouseLeave(sidebar);
    expect(sidebar).toHaveAttribute("data-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "Collapse navigation labels" }));
    expect(sidebar).toHaveAttribute("data-expanded", "false");

    fireEvent.mouseEnter(sidebar);
    expect(sidebar).toHaveAttribute("data-expanded", "false");
  });

  it("does not leave the current view when an agent opens its browser preview", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");
    const sidebar = screen.getByRole("complementary", { name: "Primary navigation" });

    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    expect(await screen.findByRole("region", { name: "Aurora task board" })).toBeInTheDocument();

    act(() => window.pixice.emit({
      type: "BrowserOpenRequested",
      payload: { threadId: "thread-1", workspaceId: "thread-1", source: "codex" }
    }));

    expect(screen.getByRole("region", { name: "Aurora task board" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Preview workspace" })).not.toBeInTheDocument();
    expect(sidebar).toHaveAttribute("data-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "Refactor authentication" }));
    expect(await screen.findByRole("region", { name: "Preview workspace" })).toBeInTheDocument();
    expect(sidebar).toHaveAttribute("data-expanded", "false");
  });

  it("opens an agent-requested external file in its thread Preview", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");

    act(() => window.pixice.emit({
      type: "FilePreviewOpenRequested",
      payload: {
        threadId: "thread-1",
        workspaceId: "thread-1",
        projectId: "project-1",
        source: "codex",
        file: {
          path: "/Users/me/.codex/skills/openai-docs/SKILL.md",
          relativePath: "/Users/me/.codex/skills/openai-docs/SKILL.md",
          folderPath: "/Users/me/.codex/skills/openai-docs",
          name: "SKILL.md",
          extension: ".md",
          kind: "markdown",
          content: "# OpenAI docs skill\n",
          external: true,
          editable: true,
          size: 20,
          mtimeMs: 1
        }
      }
    }));

    expect(await screen.findByRole("region", { name: "Preview workspace" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "SKILL.md" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "OpenAI docs skill" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("keeps preview and editor state isolated per thread", async () => {
    const secondThread = {
      ...thread,
      id: "thread-2",
      name: "Second task",
      preview: "Second task",
      turns: [{
        id: "turn-2",
        status: "completed",
        items: [{ id: "agent-2", type: "agentMessage", text: "Second task response.", phase: "final_answer" }]
      }]
    };
    window.pixice = createApi([thread, secondThread]);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");

    await user.click(screen.getByRole("button", { name: "Open src/runtime.js" }));
    expect(await screen.findByRole("tab", { name: "runtime.js" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Second task" }));
    await screen.findByText("Second task response.");
    expect(screen.queryByRole("region", { name: "Preview workspace" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open preview workspace" }));
    expect(await screen.findByRole("region", { name: "Preview workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "runtime.js" })).not.toBeInTheDocument();
    expect(window.pixice.browser.state).toHaveBeenCalledWith({ workspaceId: "thread-2" });

    await user.click(screen.getByRole("button", { name: "Refactor authentication" }));
    await screen.findByText("I traced the current flow.");
    expect(await screen.findByRole("tab", { name: "runtime.js" })).toBeInTheDocument();
  });

  it("does not apply a hidden task inspector layout when restoring a thread preview", async () => {
    const secondThread = {
      ...thread,
      id: "thread-2",
      name: "Second task",
      preview: "Second task",
      turns: [{
        id: "turn-2",
        status: "completed",
        items: [{ id: "agent-2", type: "agentMessage", text: "Second task response.", phase: "final_answer" }]
      }]
    };
    window.pixice = createApi([thread, secondThread]);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");

    await user.click(screen.getByRole("button", { name: "Open preview workspace" }));
    expect(await screen.findByRole("region", { name: "Preview workspace" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Second task" }));
    await screen.findByText("Second task response.");
    act(() => window.pixice.emit({
      type: "AttentionRequired",
      payload: {
        id: "approval-thread-2",
        projectId: project.id,
        params: { threadId: "thread-2" }
      }
    }));
    expect(document.querySelector(".pixice-app")).toHaveAttribute("data-inspector-open", "true");

    await user.click(screen.getByRole("button", { name: "Refactor authentication" }));
    expect(await screen.findByRole("region", { name: "Preview workspace" })).toBeInTheDocument();
    expect(document.querySelector(".pixice-app")).toHaveAttribute("data-inspector-open", "false");
    expect(screen.queryByRole("complementary", { name: "Task inspector" })).not.toBeInTheDocument();
  });

  it("discards the oldest hidden preview workspace after retaining two threads", async () => {
    const threads = [
      thread,
      { ...thread, id: "thread-2", name: "Second task", preview: "Second task", turns: [{ id: "turn-2", status: "completed", items: [{ id: "agent-2", type: "agentMessage", text: "Second response", phase: "final_answer" }] }] },
      { ...thread, id: "thread-3", name: "Third task", preview: "Third task", turns: [{ id: "turn-3", status: "completed", items: [{ id: "agent-3", type: "agentMessage", text: "Third response", phase: "final_answer" }] }] }
    ];
    window.pixice = createApi(threads);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");

    await user.click(screen.getByRole("button", { name: "Second task" }));
    await screen.findByText("Second response");
    await user.click(screen.getByRole("button", { name: "Third task" }));
    await screen.findByText("Third response");

    await waitFor(() => expect(window.pixice.browser.destroy).toHaveBeenCalledWith({ workspaceId: "thread-1" }));
  });

  it("opens response file links in a tab and edits the file in place", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");

    await user.click(screen.getByRole("button", { name: "Open src/runtime.js" }));
    expect(await screen.findByRole("tab", { name: "runtime.js" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("export const ready = true;")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Edit runtime.js" });
    fireEvent.change(editor, { target: { value: "export const ready = false;\n" } });
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(window.pixice.files.write).toHaveBeenCalledWith({
      projectId: "project-1",
      path: "/work/aurora/src/runtime.js",
      content: "export const ready = false;\n",
      expectedMtimeMs: 1
    }));
  });

  it("closes the first browser tab when a file tab remains, then shows the chooser after the final tab", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");

    await user.click(screen.getByRole("button", { name: "Open src/runtime.js" }));
    expect(await screen.findByRole("tab", { name: "runtime.js" })).toHaveAttribute("aria-selected", "true");
    window.pixice.browser.close.mockResolvedValueOnce({ native: false, workspaceId: "thread-1", activeTabId: null, tabs: [] });

    await user.click(screen.getByRole("button", { name: "Close New tab" }));

    await waitFor(() => expect(screen.queryByRole("tab", { name: "New tab" })).not.toBeInTheDocument());
    expect(screen.getByRole("region", { name: "Preview workspace" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "runtime.js" })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("button", { name: "Close runtime.js" }));
    expect(await screen.findByRole("region", { name: "Preview workspace" })).toBeInTheDocument();
    expect(screen.getByLabelText("New preview tab options")).toBeInTheDocument();
  });

  it("shows the new-tab chooser when its only browser tab closes", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");
    await user.click(screen.getByRole("button", { name: "Open preview workspace" }));
    await screen.findByRole("region", { name: "Preview workspace" });
    window.pixice.browser.close.mockResolvedValueOnce({ native: false, workspaceId: "thread-1", activeTabId: null, tabs: [] });

    await user.click(screen.getByRole("button", { name: "Close New tab" }));

    expect(await screen.findByRole("region", { name: "Preview workspace" })).toBeInTheDocument();
    expect(screen.getByLabelText("New preview tab options")).toBeInTheDocument();
  });

  it("replaces the active composer with a sequential question flow", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");
    expect(screen.getByRole("textbox", { name: "Task prompt" })).toBeInTheDocument();

    act(() => window.pixice.emit({
      type: "AttentionRequired",
      payload: {
        id: "question-1",
        method: "pixice/requestUserInput",
        projectId: project.id,
        params: {
          threadId: thread.id,
          questions: [
            {
              id: "approach",
              header: "Approach",
              question: "How should Pixice proceed?",
              options: [
                { label: "Build it", description: "Implement the complete flow.", recommended: true },
                { label: "Plan only", description: "Stop after the implementation plan.", recommended: false }
              ]
            },
            {
              id: "scope",
              header: "Scope",
              question: "Where should it be available?",
              options: [
                { label: "Every model", description: "Expose it across all providers.", recommended: true },
                { label: "Codex only", description: "Limit the first release.", recommended: false }
              ]
            }
          ]
        }
      }
    }));

    expect(await screen.findByText("How should Pixice proceed?")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Task prompt" })).not.toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Build it/ }));
    expect(await screen.findByText("Where should it be available?", {}, { timeout: 1000 })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Every model/ }));

    await waitFor(() => expect(window.pixice.questions.respond).toHaveBeenCalledWith({
      requestId: "question-1",
      action: "answer",
      answers: { approach: "Build it", scope: "Every model" }
    }));
    expect(await screen.findByRole("textbox", { name: "Task prompt" })).toBeInTheDocument();
  });

  it("temporarily widens the preview side chat for a question", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");
    await user.click(screen.getByRole("button", { name: "Open preview workspace" }));
    expect(await screen.findByRole("region", { name: "Preview workspace" })).toBeInTheDocument();

    act(() => window.pixice.emit({
      type: "AttentionRequired",
      payload: {
        id: "preview-question",
        method: "pixice/requestUserInput",
        projectId: project.id,
        params: {
          threadId: thread.id,
          questions: [{
            id: "scope",
            header: "Scope",
            question: "Where should it be available?",
            options: [{ label: "Every model", description: "Expose it across all providers.", recommended: true }]
          }]
        }
      }
    }));

    const workspace = document.querySelector(".task-workspace");
    expect(await screen.findByText("Where should it be available?")).toBeInTheDocument();
    expect(workspace).toHaveAttribute("data-question-active", "true");
    expect(screen.getByRole("region", { name: "Preview workspace" })).toBeInTheDocument();
    expect(appCss).toMatch(/\.task-workspace\.preview-mode\[data-question-active="true"\]\s*\{[^}]*620px[^}]*minmax\(360px, 1fr\);/s);

    await user.click(screen.getByRole("radio", { name: /Every model/ }));
    await waitFor(() => expect(workspace).toHaveAttribute("data-question-active", "false"));
    expect(screen.getByRole("region", { name: "Preview workspace" })).toBeInTheDocument();
  });
});

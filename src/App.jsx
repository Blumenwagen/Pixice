import { useUnifiedUsage } from "./connect/useUnifiedUsage.js";
import { RemoteBrowserSurface } from "./connect/RemoteBrowserSurface.jsx";
import { ConnectionsSettings } from "./connect/ConnectionsSettings.jsx";
import { getPixiceApi } from "./connect/client.js";
import { useConnect } from "./connect/ConnectRoot.jsx";
import { createWorkspaceStorage, listRemoteThreadLinks, loadRemoteThreadLinks, upsertRemoteThreadLink } from "./connect/execution-storage.js";
import {
  attachmentPolicy,
  createAttachmentScope,
  createComposerAttachment,
  disposeComposerAttachment,
  prepareSubmissionAttachments,
  requestPayloadWithAttachments,
  restoreAttachmentMetadata,
  resumeAttachmentUploads,
  serializeAttachmentMetadata,
  transferScopeKey,
  canDownloadRemoteFile,
  downloadRemoteFile,
  assertSubmissionRequestBudget,
  sha256File
} from "./connect/transfer-client.js";
import { Children, cloneElement, createContext, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useContext } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { VoiceBeam } from "voice-glow";
import {
  ArrowClockwise, Brain, CaretDown, CaretLeft, CaretRight, ChartLineUp, Check, CheckCircle,
  Circle, Code, Desktop, Eye, File, Files, Folder, FolderOpen, Gauge, Gear, GitBranch,
  Globe, Info, LockKey, MagnifyingGlass, Microphone, PaperPlaneTilt, Pause,
  PencilSimple, PlugsConnected, Plus, ShieldCheck, Sparkle, SpinnerGap, Stack,
  TerminalWindow, Trash, TreeStructure, Warning, X
} from "./components/icons/index.jsx";
import { APP_ICONS } from "./components/icons/app-iconography.jsx";
import pixiceIcon from "./assets/pixice-icon.png";
import focusBackgroundDark from "./assets/focus-background-dark.png";
import { DictationButton } from "./components/DictationButton.jsx";
import { useTranscription, formatModelBytes } from "./lib/use-transcription.js";
import { listAudioInputs, dictationUnsupportedReason } from "./lib/dictation.js";
import { ReasoningOrb } from "./components/ReasoningOrb.jsx";
import { ThinkingState } from "./components/ThinkingState.jsx";
import { ModelBrandIcon, modelBrand } from "./components/ModelBrandIcon.jsx";
import { InlineVisualization, parseVisualizationSpec } from "./components/InlineVisualization.jsx";
import { InstrumentHost } from "./components/instruments/InstrumentHost.jsx";
import { IosSimulatorPreview } from "./components/ios/IosSimulatorPreview.jsx";
import { ProjectToolsSidebar, ProjectToolsWorkspace } from "./components/instruments/ProjectToolsWorkspace.jsx";
import { TaskReceipt, ModelReplay } from "./components/TaskResults.jsx";
import { TaskPreviewContent } from "./components/TaskPreviewHost.jsx";
import { WorkflowPreview } from "./components/workflows/WorkflowWorkspace.jsx";
import { DitherAreaChart, DitherBarChart } from "./components/dither-kit/DitherChart.jsx";
import { UsageHeatMap } from "./components/dither-kit/UsageHeatMap.jsx";
import { NumberTicker } from "./components/NumberTicker.jsx";
import { MorphText } from "./components/MorphText.jsx";
import { OperationCapsuleStack } from "./components/OperationCapsule.jsx";
import { ImageGeneration } from "./components/ImageGeneration.jsx";
import { InspectablePicture } from "./components/PictureInspector.jsx";
import { PromptPreviewRail } from "./components/PromptPreviewRail.jsx";
import { FocusCoordination } from "./components/FocusCoordination.jsx";
import { FocusCoordinatorQuestions } from "./components/FocusCoordinatorQuestions.jsx";
import WidgetShelf from "./components/WidgetShelf.jsx";
import { KanbanBoard } from "./components/KanbanBoard.jsx";
import { ProjectCreationDialog, ProjectGlyph, ProjectSwitcher, projectTileStyle } from "./components/sidebar/ProjectSwitcher.jsx";
import { ThreadCleanupPopover } from "./components/sidebar/ThreadCleanupPopover.jsx";
import { normalizeThreadCleanupAgeDays, THREAD_CLEANUP_MAX_DAYS, THREAD_CLEANUP_MIN_DAYS } from "./components/sidebar/thread-cleanup.js";
import { resolveThreadNamingModel, threadNamingModels, THREAD_NAMING_AUTO, THREAD_NAMING_OFF } from "../electron/runtime/thread-naming-models.mjs";
import { resolveWorkflowGenerationModel, workflowGenerationModels, WORKFLOW_GENERATION_AUTO } from "../electron/runtime/workflow-generation-models.mjs";
import {
  appendLocalUserMessage,
  applyRuntimePayload,
  coalesceRuntimeDeltas,
  descendantsOf,
  isSidebarThread,
  mergeThreadSnapshot,
  projectCollabAgents,
  removeLocalUserMessage,
  reviewFiles,
  stripPreviewContext,
  turnIsCompacting,
  threadStatus,
  threadTitle
} from "./state/runtime.js";
import { publishOperation } from "./state/operation-events.js";

const EMPTY_EXTENSIONS = { skills: [], apps: [], mcp: [], errors: [] };
const EMPTY_BROWSER_STATE = { native: false, activeTabId: null, tabs: [] };
const EMPTY_PREVIEW_WORKSPACE = { open: false, browserState: EMPTY_BROWSER_STATE, fileTabs: [], instrumentTabs: [], customTabs: [], activeTabId: null };
const EMPTY_UPDATE_STATUS = { supported: false, state: "development", currentVersion: "0.0.0", availableVersion: null, percent: 0, message: "Updates are available in packaged Pixice builds." };
const EMPTY_GITHUB_STATUS = { available: false, authenticated: false, source: null, version: null, account: null, message: "Checking GitHub connection…" };
const EMPTY_GIT_STATUS = { state: "checking", available: false, installSupported: false, executablePath: null, version: null, message: "Checking local Git…" };
const RUNTIME_RECOVERY_SILENCE_MS = 12_000;
const FOCUS_CONNECTION_ERROR = /(?:thread|session).*(?:not found|not loaded|unavailable)|(?:unable|failed) to connect(?: to (?:thread|session))?|(?:connection|provider|runtime).*(?:lost|closed|offline|unavailable|reconnect|stopped)|ECONN|fetch failed/i;
const EMPTY_AGENT_BEHAVIORS = [];
const WorkspaceOpenContext = createContext(null);
const MIN_SIDEBAR_WIDTH = 224;
const MAX_SIDEBAR_WIDTH = 360;
const DEFAULT_SIDEBAR_WIDTH = 264;
const MIN_PREVIEW_CHAT_WIDTH = 300;
const MAX_PREVIEW_CHAT_WIDTH = 640;
const MIN_PREVIEW_PANEL_WIDTH = 360;
const PREVIEW_SPLIT_GAP = 8;
const PREVIEW_CHAT_WIDTH_KEY = "pixice.previewChatWidth";
const MAX_COMPOSER_ATTACHMENTS = 10;
const MAX_COMPOSER_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MIN_COMPOSER_TEXTAREA_HEIGHT = 24;
const MAX_COMPOSER_TEXTAREA_HEIGHT = 240;
const MAX_RETAINED_PREVIEW_WORKSPACES = 2;
const PROSPECTIVE_THREAD_ID = "00000000-0000-0000-0000-000000000000";
const THREAD_COMPLETIONS_SEEN_KEY = "pixice.threadCompletionsSeen";
const THREAD_COMPLETIONS_SEEN_BASELINE_KEY = "__baselineAt";
const THREAD_MESSAGE_RECENCY_KEY = "pixice.threadMessageRecency";
const COMPOSER_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
const DEFAULT_PREFERENCES = {
  confirmBeforeDelete: true,
  preserveDrafts: true,
  sendShortcut: "enter",
  spellCheckComposer: true,
  autoFocusComposer: true,
  showSlashCommands: true,
  showMessageTimestamps: true,
  completedWorkDetails: "auto",
  showTaskProgress: true,
  expandTaskProgress: true,
  autoOpenTaskMap: false,
  bringApprovalsForward: false,
  density: "compact",
  threadCleanupAgeDays: 30,
  legacySidebar: false,
  showThirdProjectRow: false,
  showShortcutHints: true,
  conversationWidth: "balanced",
  conversationTextSize: "standard",
  accentColor: "coral",
  reduceTransparency: false,
  reduceMotion: false,
  // The microphone belongs to the device in front of the person, so it stays a
  // local preference even though the model selection is host state.
  micDeviceId: ""
};

const APPEARANCE_PREFERENCE_OPTIONS = {
  conversationWidth: new Set(["focused", "balanced", "wide"]),
  conversationTextSize: new Set(["small", "standard", "large"]),
  accentColor: new Set(["coral", "rose", "amber", "green", "teal", "blue", "violet", "graphite"])
};

const VOICE_GLOW_ACCENT_PALETTES = {
  coral: {
    colors: ["#ff5364", "#4ed6e5", "#9a7cf6", "#ffb44f", "#e56f9d", "#6f95ff", "#55d097"],
    bandColors: { core: "#fff4f5", above: "#ff5364", mid: "#55d097", below: "#6f95ff" }
  },
  rose: {
    colors: ["#e56f9d", "#6fcbff", "#b47cff", "#58d6a3", "#ffb45c", "#6f95ff", "#4ed5c2"],
    bandColors: { core: "#fff0f6", above: "#e56f9d", mid: "#4ed5c2", below: "#6f95ff" }
  },
  amber: {
    colors: ["#dca650", "#67b8ff", "#e56f9d", "#62cc7c", "#ff704f", "#9a7cf6", "#4ecfc1"],
    bandColors: { core: "#fff6dc", above: "#dca650", mid: "#e56f9d", below: "#6f95ff" }
  },
  green: {
    colors: ["#55b96f", "#ff6b72", "#6f95ff", "#f5bd57", "#9a7cf6", "#4eb9aa", "#e56f9d"],
    bandColors: { core: "#effff3", above: "#f5bd57", mid: "#55b96f", below: "#6f95ff" }
  },
  teal: {
    colors: ["#4eb9aa", "#ff6b72", "#748fff", "#d8c153", "#b57bf5", "#55ca7c", "#e56f9d"],
    bandColors: { core: "#edfffc", above: "#ff6b72", mid: "#4eb9aa", below: "#748fff" }
  },
  blue: {
    colors: ["#6f95ff", "#ff6674", "#aa76f4", "#4eb9aa", "#e0ad53", "#e56f9d", "#55c985"],
    bandColors: { core: "#f1f5ff", above: "#e56f9d", mid: "#6f95ff", below: "#4eb9aa" }
  },
  violet: {
    colors: ["#9a7cf6", "#50c8ba", "#e56f9d", "#6f95ff", "#e0ad53", "#55c985", "#ff6b72"],
    bandColors: { core: "#f7f2ff", above: "#e56f9d", mid: "#9a7cf6", below: "#4eb9aa" }
  },
  graphite: {
    colors: ["#c0c0c5", "#6f95ff", "#e56f9d", "#55c985", "#e0ad53", "#9a7cf6", "#4eb9aa"],
    bandColors: { core: "#ffffff", above: "#e56f9d", mid: "#a4a4aa", below: "#6f95ff" }
  }
};

const BEHAVIOR_PREFERENCE_OPTIONS = {
  sendShortcut: new Set(["enter", "mod-enter"]),
  completedWorkDetails: new Set(["auto", "expanded", "collapsed"])
};

const MOTION_EASE = [0.22, 1, 0.36, 1];
const PREVIEW_TAB_SPRING = { type: "spring", stiffness: 460, damping: 38, mass: 0.72 };
const NewTaskIcon = APP_ICONS.newTask;
const BoardIcon = APP_ICONS.board;
let previewTabSequence = 0;

function newPreviewChooserTab() {
  previewTabSequence += 1;
  return { id: `new:${Date.now()}:${previewTabSequence}`, kind: "new", title: "New tab", payload: {} };
}

function newSideThreadTab(projectId, hostThreadId) {
  previewTabSequence += 1;
  const draftId = `${Date.now()}:${previewTabSequence}`;
  return {
    id: `thread:draft:${draftId}`,
    kind: "thread",
    title: "New side thread",
    payload: { projectId, threadId: null, hostThreadId, draftId, status: "idle" }
  };
}

function threadPreviewTab(projectId, candidate, hostThreadId) {
  return {
    id: `thread:${candidate.id}`,
    kind: "thread",
    title: threadTitle(candidate),
    payload: { projectId, threadId: candidate.id, hostThreadId, forkedFromId: candidate.forkedFromId ?? null, status: threadStatus(candidate) }
  };
}

function updateThreadPreviewTabs(workspaces, threadId, patch) {
  let changed = false;
  const next = Object.fromEntries(Object.entries(workspaces).map(([workspaceId, workspace]) => {
    let workspaceChanged = false;
    const customTabs = (workspace.customTabs ?? []).map((tab) => {
      if (tab.kind !== "thread" || tab.payload?.threadId !== threadId) return tab;
      changed = true;
      workspaceChanged = true;
      return {
        ...tab,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        payload: { ...tab.payload, ...(patch.payload ?? {}) }
      };
    });
    return [workspaceId, workspaceChanged ? { ...workspace, customTabs } : workspace];
  }));
  return changed ? next : workspaces;
}

function removeThreadPreviewTabs(workspaces, threadId) {
  let changed = false;
  const next = {};
  for (const [workspaceId, workspace] of Object.entries(workspaces)) {
    if (workspaceId === threadId) {
      changed = true;
      continue;
    }
    const removedIds = new Set((workspace.customTabs ?? [])
      .filter((tab) => tab.kind === "thread" && tab.payload?.threadId === threadId)
      .map((tab) => tab.id));
    if (!removedIds.size) {
      next[workspaceId] = workspace;
      continue;
    }
    changed = true;
    let customTabs = (workspace.customTabs ?? []).filter((tab) => !removedIds.has(tab.id));
    const browserTabs = workspace.browserState?.tabs ?? [];
    const fileTabs = workspace.fileTabs ?? [];
    const instrumentTabs = workspace.instrumentTabs ?? [];
    let activeTabId = workspace.activeTabId;
    if (removedIds.has(activeTabId)) {
      activeTabId = customTabs.at(-1)?.id
        ?? fileTabs.at(-1)?.id
        ?? (instrumentTabs[0] ? `instrument:${instrumentTabs[0].id}` : null)
        ?? workspace.browserState?.activeTabId
        ?? browserTabs[0]?.id
        ?? null;
    }
    if (!customTabs.length && !browserTabs.length && !fileTabs.length && !instrumentTabs.length) {
      const chooser = newPreviewChooserTab();
      customTabs = [chooser];
      activeTabId = chooser.id;
    }
    next[workspaceId] = { ...workspace, customTabs, activeTabId };
  }
  return changed ? next : workspaces;
}

export function previewContextForWorkspace(workspace) {
  const browserTabs = workspace?.browserState?.tabs ?? [];
  const fileTabs = workspace?.fileTabs ?? [];
  const instrumentTabs = workspace?.instrumentTabs ?? [];
  const customTabs = workspace?.customTabs ?? [];
  const tabCount = browserTabs.length + fileTabs.length + instrumentTabs.length + customTabs.length;
  if (!workspace?.open) return { open: false, tabCount, active: null };
  const activeId = workspace.activeTabId;
  const browser = browserTabs.find((tab) => tab.id === activeId);
  if (browser) return { open: true, tabCount, active: { kind: "browser", id: browser.id, title: browser.title, url: browser.url } };
  const file = fileTabs.find((tab) => tab.id === activeId);
  if (file) return { open: true, tabCount, active: { kind: "file", id: file.id, title: file.title, path: file.path, editable: file.editable, dirty: file.dirty } };
  const instrument = instrumentTabs.find((tab) => `instrument:${tab.id}` === activeId);
  if (instrument) return { open: true, tabCount, active: { kind: "instrument", id: activeId, title: instrument.document?.title, instrumentId: instrument.id, documentVersion: instrument.documentVersion } };
  const custom = customTabs.find((tab) => tab.id === activeId);
  if (custom) return {
    open: true,
    tabCount,
    active: {
      kind: custom.kind,
      id: custom.id,
      title: custom.title,
      projectId: custom.payload?.projectId,
      taskId: custom.payload?.taskId,
      proposalId: custom.payload?.proposalId,
      workflowId: custom.payload?.workflowId,
      threadId: custom.payload?.threadId ?? undefined,
      hostThreadId: custom.payload?.hostThreadId ?? undefined,
      forkedFromId: custom.payload?.forkedFromId ?? undefined,
      simulatorUdid: custom.payload?.session?.simulatorUdid,
      sessionId: custom.payload?.session?.id,
      status: custom.kind === "thread" ? custom.payload?.status : custom.payload?.session?.status
    }
  };
  return { open: true, tabCount, active: null };
}

export function horizontalPopoverShift(popoverRect, boundaryRect, gutter = 8) {
  const popoverWidth = popoverRect.width ?? popoverRect.right - popoverRect.left;
  const minimumLeft = boundaryRect.left + gutter;
  const maximumLeft = Math.max(minimumLeft, boundaryRect.right - gutter - popoverWidth);
  const clampedLeft = Math.min(Math.max(popoverRect.left, minimumLeft), maximumLeft);
  return clampedLeft - popoverRect.left;
}
const AttentionIcon = APP_ICONS.attention;
const ReviewIcon = APP_ICONS.review;
const PreviewIcon = APP_ICONS.preview;
const TaskMapIcon = APP_ICONS.taskMap;
const TaskProgressIcon = APP_ICONS.taskProgress;
const FastModeIcon = APP_ICONS.fastMode;
const AutoReviewIcon = APP_ICONS.autoReview;

// Mirrors the slash-command discovery surface in the installed Codex runtime.
// Pixice only presents and autocompletes these commands; Codex remains responsible
// for interpreting them when the user submits the composer.
const CODEX_SLASH_COMMANDS = [
  { name: "model", description: "Choose what model and reasoning effort to use" },
  { name: "fast", description: "Use faster inference with increased usage" },
  { name: "ide", description: "Include open files, selections, and IDE context" },
  { name: "permissions", description: "Choose what Codex is allowed to do" },
  { name: "keymap", description: "Remap Codex shortcuts" },
  { name: "vim", description: "Toggle Vim mode for the composer" },
  { name: "experimental", description: "Toggle experimental features" },
  { name: "approve", description: "Approve one retry of a recent auto-review denial" },
  { name: "memories", description: "Configure memory use and generation" },
  { name: "skills", description: "Use skills for specific tasks" },
  { name: "import", description: "Import setup and chats from Claude Code" },
  { name: "hooks", description: "View and manage lifecycle hooks" },
  { name: "review", description: "Review current changes and find issues" },
  { name: "name", description: "Name the current thread" },
  { name: "new", description: "Start a new chat" },
  { name: "archive", description: "Archive this session" },
  { name: "delete", description: "Permanently delete this session" },
  { name: "resume", description: "Resume a saved chat" },
  { name: "fork", description: "Fork the current chat" },
  { name: "app", description: "Continue this session in Codex Desktop" },
  { name: "init", description: "Create an AGENTS.md file with Codex instructions" },
  { name: "compact", description: "Summarize the conversation to preserve context" },
  { name: "plan", description: "Switch to Plan mode" },
  { name: "goal", description: "Set or view a long-running task goal" },
  { name: "agent", description: "Switch the active agent thread" },
  { name: "side", description: "Start a side conversation" },
  { name: "copy", description: "Copy the last response as Markdown" },
  { name: "raw", description: "Toggle raw output mode" },
  { name: "diff", description: "Show the Git diff, including untracked files" },
  { name: "mention", description: "Mention a file" },
  { name: "status", description: "Show session configuration and token usage" },
  { name: "usage", description: "View account usage and limits" },
  { name: "title", description: "Configure the terminal title" },
  { name: "statusline", description: "Configure the status line" },
  { name: "theme", description: "Choose a syntax-highlighting theme" },
  { name: "pets", description: "Show or hide the terminal pet" },
  { name: "mcp", description: "List configured MCP tools" },
  { name: "plugins", description: "Browse plugins" },
  { name: "logout", description: "Log out of Codex" },
  { name: "exit", description: "Exit Codex" },
  { name: "feedback", description: "Send logs to the Codex maintainers" },
  { name: "ps", description: "List background terminals" },
  { name: "stop", description: "Stop all background terminals" },
  { name: "clear", description: "Clear the surface and start a new chat" }
];

// The active Claude session replaces this starter list with its own commands,
// including project skills. Keep a useful menu before the first session starts.
const CLAUDE_SLASH_COMMANDS = [
  { name: "review", description: "Review code changes" },
  { name: "compact", description: "Summarize the conversation to preserve context" },
  { name: "init", description: "Create project instructions" },
  { name: "simplify", description: "Review changed code for reuse and quality" },
  { name: "security-review", description: "Review changes for security issues" }
];

export function slashCommandAtCaret(value, caret) {
  if (typeof value !== "string" || !Number.isInteger(caret) || caret < 0 || caret > value.length) return null;
  const before = value.slice(0, caret);
  const match = /(?:^|\s)\/([\w:.-]*)$/.exec(before);
  if (!match) return null;
  const start = caret - match[1].length - 1;
  const suffix = value.slice(caret).match(/^[\w:.-]*/)?.[0] ?? "";
  if (value[caret + suffix.length] && !/\s/.test(value[caret + suffix.length])) return null;
  return { start, end: caret + suffix.length, query: match[1].toLowerCase() };
}

export function prepareSlashCommandPrompt(value, commands) {
  if (/^\s*\/[\w:.-]+(?=\s|$)/.test(value)) return value.trim();
  const names = new Set(commands.map((command) => command.name.toLowerCase()));
  const inline = /(?:^|\s)\/([\w:.-]+)(?=\s|$)/g;
  let match;
  while ((match = inline.exec(value))) {
    if (!names.has(match[1].toLowerCase())) continue;
    const start = match.index + match[0].lastIndexOf("/");
    const command = value.slice(start, start + match[1].length + 1);
    const rest = [value.slice(0, start).trim(), value.slice(start + command.length).trim()].filter(Boolean).join(" ");
    return `${command}${rest ? ` ${rest}` : ""}`;
  }
  return value.trim();
}

function loadPreferences(storage = localStorage) {
  try {
    const saved = JSON.parse(storage.getItem("pixice.preferences") ?? "{}");
    const preferences = { ...DEFAULT_PREFERENCES, ...saved };
    preferences.threadCleanupAgeDays = normalizeThreadCleanupAgeDays(preferences.threadCleanupAgeDays);
    Object.entries({ ...APPEARANCE_PREFERENCE_OPTIONS, ...BEHAVIOR_PREFERENCE_OPTIONS }).forEach(([key, options]) => {
      if (!options.has(preferences[key])) preferences[key] = DEFAULT_PREFERENCES[key];
    });
    return preferences;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function supportedReasoningEfforts(model) {
  return model?.supportedReasoningEfforts?.map((option) => option.reasoningEffort ?? option.effort ?? option) ?? [];
}

function threadConfigurationKey(threadId) {
  return `pixice.threadConfiguration.${threadId}`;
}

function loadThreadConfiguration(threadId, storage = localStorage) {
  if (!threadId) return null;
  try {
    return JSON.parse(storage.getItem(threadConfigurationKey(threadId)) ?? "null");
  } catch {
    return null;
  }
}

function saveThreadConfiguration(threadId, configuration, storage = localStorage) {
  if (!threadId) return;
  storage.setItem(threadConfigurationKey(threadId), JSON.stringify(configuration));
}

function resolveReasoningEffort(candidate, model, fallback) {
  const supported = supportedReasoningEfforts(model);
  if (candidate && (!supported.length || supported.includes(candidate))) return candidate;
  if (fallback && (!supported.length || supported.includes(fallback))) return fallback;
  return model?.defaultReasoningEffort || supported[0] || "high";
}

function modelProvider(model) {
  return model?.provider ?? (modelBrand(model?.model)?.id === "anthropic" ? "claude" : "codex");
}

function fastServiceTier(model) {
  if (!model || modelProvider(model) !== "codex") return null;
  const tiers = model.serviceTiers?.length ? model.serviceTiers : model.additionalSpeedTiers ?? [];
  const tierIds = tiers.map((tier) => typeof tier === "string" ? tier : tier.id);
  return tierIds.find((tier) => tier === "priority") ?? tierIds.find((tier) => tier === "fast") ?? null;
}

function clampSidebarWidth(width) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function defaultPreviewChatWidth() {
  return Math.min(430, Math.max(340, window.innerWidth * 0.3));
}

function clampPreviewChatWidth(width, workspaceWidth = window.innerWidth - 64) {
  const availableMaximum = Math.max(
    MIN_PREVIEW_CHAT_WIDTH,
    workspaceWidth - MIN_PREVIEW_PANEL_WIDTH - PREVIEW_SPLIT_GAP
  );
  return Math.min(MAX_PREVIEW_CHAT_WIDTH, availableMaximum, Math.max(MIN_PREVIEW_CHAT_WIDTH, width));
}

function projectRecencyValue(project) {
  const value = project?.lastUsedAt ?? project?.updatedAt ?? project?.createdAt;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestampMillis(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0;
    return Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
  }
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatElapsedDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatMessageTime(value) {
  const timestamp = timestampMillis(value);
  if (!timestamp) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp);
}

function formatMessageDateTime(value) {
  const timestamp = timestampMillis(value);
  if (!timestamp) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

export function normalizedFileChanges(item) {
  const changes = item?.changes;
  if (Array.isArray(changes)) return changes.filter((change) => change && typeof change === "object");

  const legacyChange = changes && typeof changes === "object" ? changes : {};
  const filePath = legacyChange.path
    ?? legacyChange.filePath
    ?? legacyChange.file_path
    ?? legacyChange.notebook_path
    ?? item?.path
    ?? item?.filePath;
  return filePath ? [{ ...legacyChange, path: filePath }] : [];
}

function useLiveNow(running) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const tick = () => setNow(Date.now());
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [running]);
  return now;
}

function ElapsedTime({ startedAt, completedAt, running, prefix = "" }) {
  const now = useLiveNow(running);
  const start = timestampMillis(startedAt);
  if (!start) return null;
  const end = timestampMillis(completedAt) || now;
  const duration = formatElapsedDuration(Math.max(0, end - start));
  return <span className="elapsed-time">{prefix}{duration}</span>;
}

function MessageTimestamp({ value, align = "start" }) {
  const label = formatMessageTime(value);
  if (!label) return null;
  return <time className="message-timestamp" data-align={align} dateTime={new Date(timestampMillis(value)).toISOString()} title={formatMessageDateTime(value)}>{label}</time>;
}

function threadIsRunning(candidate) {
  const status = String(threadStatus(candidate)).toLowerCase();
  return status === "active" || status === "running" || status === "inprogress" || status === "attention";
}

function isBridgeThread(candidate) {
  return candidate?.bridge?.kind === "pixiceBridge" || Boolean(candidate?.bridgeModel);
}

function summarizeProjectThreads(project, candidates, { seen = false } = {}) {
  const seenAt = seen ? Number.POSITIVE_INFINITY : timestampMillis(project?.lastUsedAt ?? project?.updatedAt ?? project?.createdAt);
  const runningThreadIds = [];
  const unseenThreadIds = [];
  for (const candidate of candidates ?? []) {
    if (!candidate?.id) continue;
    if (threadIsRunning(candidate)) {
      runningThreadIds.push(candidate.id);
      continue;
    }
    if (isBridgeThread(candidate) && !threadCompletionRevision(candidate)) continue;
    if (timestampMillis(candidate.updatedAt) > seenAt) unseenThreadIds.push(candidate.id);
  }
  return { runningThreadIds, unseenThreadIds };
}

function threadCompletionRevision(candidate) {
  if (!candidate || threadIsRunning(candidate)) return null;
  if (candidate.completionRevision !== undefined && candidate.completionRevision !== null) {
    return String(candidate.completionRevision);
  }
  const latestTurn = candidate.turns?.at(-1);
  if (latestTurn?.status === "completed") return `turn:${latestTurn.id ?? candidate.updatedAt ?? "completed"}`;
  if (isBridgeThread(candidate)) return null;
  const status = threadStatus(candidate);
  if (status !== "completed" && status !== "idle") return null;
  return String(candidate.updatedAt ?? `status:${status}`);
}

function loadSeenThreadCompletions(storage = localStorage) {
  let value = {};
  try {
    const stored = persistedSeenThreadCompletions(JSON.parse(storage.getItem(THREAD_COMPLETIONS_SEEN_KEY) ?? "{}"));
    if (stored) value = stored;
  } catch {
    // Replace malformed legacy state with a clean migration baseline below.
  }

  if (Number.isFinite(value[THREAD_COMPLETIONS_SEEN_BASELINE_KEY])) return value;
  const migrated = { ...value, [THREAD_COMPLETIONS_SEEN_BASELINE_KEY]: Date.now() };
  try {
    storage.setItem(THREAD_COMPLETIONS_SEEN_KEY, JSON.stringify(migrated));
  } catch {
    // The in-memory baseline still prevents historical threads from appearing unseen.
  }
  return migrated;
}

function threadCompletionWasSeen(candidate, completionRevision, seenThreadCompletions) {
  const seenRevision = seenThreadCompletions?.[candidate?.id];
  if (seenRevision === completionRevision) return true;
  if (seenRevision !== undefined && seenRevision !== null && String(candidate?.updatedAt ?? "") === String(seenRevision)) return true;
  if (seenRevision !== undefined && seenRevision !== null) return false;
  const baselineAt = seenThreadCompletions?.[THREAD_COMPLETIONS_SEEN_BASELINE_KEY];
  return Number.isFinite(baselineAt) && timestampMillis(candidate?.updatedAt) <= baselineAt;
}

function persistedSeenThreadCompletions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value).filter(([key, revision]) => (
    key.length <= 256
    && (
      (typeof revision === "string" && revision.length > 0 && revision.length <= 256)
      || (Number.isFinite(revision) && revision >= 0)
    )
  ));
  return entries.length ? Object.fromEntries(entries.slice(0, 10_000)) : null;
}

function loadThreadMessageRecency(storage = localStorage) {
  try {
    const value = JSON.parse(storage.getItem(THREAD_MESSAGE_RECENCY_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, timestamp]) => Number.isFinite(timestamp)));
  } catch {
    return {};
  }
}

function activateProject(projects, projectId, update = {}, visibleProjectLimit = 6) {
  const selectedIndex = projects.findIndex((project) => project.id === projectId);
  if (selectedIndex < 0) return projects;

  const next = projects.map((project, index) => index === selectedIndex ? { ...project, ...update } : project);
  const visibleCount = Math.min(Math.max(1, visibleProjectLimit), next.length);
  if (selectedIndex < visibleCount) return next;

  let leastRecentVisibleIndex = 0;
  for (let index = 1; index < visibleCount; index += 1) {
    if (projectRecencyValue(next[index]) <= projectRecencyValue(next[leastRecentVisibleIndex])) {
      leastRecentVisibleIndex = index;
    }
  }
  [next[leastRecentVisibleIndex], next[selectedIndex]] = [next[selectedIndex], next[leastRecentVisibleIndex]];
  return next;
}

function IconButton({ label, children, className = "", ...props }) {
  return <button className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}

function attachmentFilesFromTransfer(transfer) {
  return Array.from(transfer?.files ?? []);
}

function readComposerAttachment(file, scope) {
  if (!file) return null;
  return createComposerAttachment(file, {
    scope,
    scopeKey: transferScopeKey(scope)
  });
}

function transferHasFiles(transfer) {
  const items = Array.from(transfer?.items ?? []);
  if (items.some((item) => item.kind === "file")) return true;
  return attachmentFilesFromTransfer(transfer).length > 0;
}

function attachmentExtension(name) {
  const extension = String(name ?? "").split(".").at(-1);
  return extension && extension !== name ? extension.slice(0, 8).toUpperCase() : "FILE";
}

function attachmentSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function assertSubmissionActive(signal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? Object.assign(new Error("The submission was cancelled."), { name: "AbortError" });
}

function resizeComposerTextarea(textarea) {
  if (!textarea) return;
  textarea.style.height = "0px";
  const contentHeight = textarea.scrollHeight;
  const height = Math.min(MAX_COMPOSER_TEXTAREA_HEIGHT, Math.max(MIN_COMPOSER_TEXTAREA_HEIGHT, contentHeight));
  textarea.style.height = `${height}px`;
  textarea.style.overflowY = contentHeight > MAX_COMPOSER_TEXTAREA_HEIGHT ? "auto" : "hidden";
}

function StatusDot({ status }) {
  return <span className={`status-dot ${status}`} aria-hidden="true" />;
}

function relativeTime(timestamp) {
  if (!timestamp) return "";
  const seconds = Math.round(Date.now() / 1000 - timestamp);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function summarizePlanProgress(plan) {
  if (!Array.isArray(plan) || plan.length === 0) return null;
  return {
    completed: plan.filter((step) => step?.status === "completed").length,
    total: plan.length
  };
}

function normalizePlanProgress(value) {
  const total = Number.isFinite(value?.total) ? Math.max(0, Math.floor(value.total)) : 0;
  if (!total) return null;
  const completed = Number.isFinite(value?.completed)
    ? Math.min(total, Math.max(0, Math.floor(value.completed)))
    : 0;
  return { completed, total };
}

function SidebarNavItem({ icon: Icon, label, active, badge, badgeVisible = true, badgeTone = "neutral", shortcut, tone = "", disabled, onClick }) {
  const systemReducedMotion = useReducedMotion();
  return (
    <button
      className={`rail-nav-item ${active ? "active" : ""} ${tone}`}
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
    >
      {active && <span className="thread-indicator"><i /></span>}
      <span className="rail-icon"><Icon size={17} weight={active ? "fill" : "regular"} /></span>
      <span className="rail-label">{label}</span>
      {shortcut && <kbd className="rail-shortcut">{shortcut}</kbd>}
      {tone === "new-task" && <span className="new-task-hover-plus" aria-hidden="true"><Plus size={18} /></span>}
      {badgeVisible && (
        <AnimatePresence initial={false}>
          {badge > 0 && (
            <motion.span
              className={`rail-badge ${badgeTone}`}
              initial={systemReducedMotion ? false : { opacity: 0, scale: 0.72, filter: "blur(2px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              exit={systemReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.82, filter: "blur(2px)" }}
              transition={{ duration: systemReducedMotion ? 0 : 0.18, ease: MOTION_EASE }}
            >
              <MorphText value={badge > 99 ? "99+" : badge} duration={240} scale />
            </motion.span>
          )}
        </AnimatePresence>
      )}
    </button>
  );
}

const SidebarThreadRow = memo(function SidebarThreadRow({ task, active, finished, animateLayout, onSelectThread, onDeleteThread }) {
  const title = threadTitle(task);
  const titleParts = [title];
  if (task.forkedFromId) titleParts.push("Forked conversation");
  if (finished) titleParts.push("Finished");
  const running = threadIsRunning(task);
  const savedPlanProgress = normalizePlanProgress(task.planProgress);
  const finishedPlanComplete = Boolean(savedPlanProgress)
    && savedPlanProgress.completed === savedPlanProgress.total
    && Boolean(threadCompletionRevision(task));
  const planProgress = finishedPlanComplete ? null : savedPlanProgress;
  const planProgressPercent = planProgress ? (planProgress.completed / planProgress.total) * 100 : 0;
  return (
    <motion.div
      className={`task-row ${active ? "active" : ""} ${running ? "running" : ""} ${finished ? "finished" : ""}`}
      data-thread-id={task.id}
      layout={animateLayout ? "position" : false}
      transition={animateLayout ? { layout: { duration: 0.22, ease: [0.22, 1, 0.36, 1] } } : undefined}
      data-layout-animation={animateLayout ? "true" : "false"}
    >
      <button
        className="task-select"
        onClick={() => onSelectThread(task.id)}
        title={titleParts.join(" · ")}
        aria-current={active ? "page" : undefined}
        aria-description={task.forkedFromId ? "Forked conversation" : undefined}
      >
        {task.forkedFromId && <span className="task-fork-icon" aria-hidden="true"><GitBranch size={11} /></span>}
        <span className="task-title">{title}</span>
        {running && (
          <ReasoningOrb
            className="task-state task-reasoning-orb"
            size={16}
            label="Task is reasoning"
            decorative
          />
        )}
        {finished && (
          <span className="task-state task-finished-badge" title="Finished" aria-hidden="true">
            <Check size={9} />
          </span>
        )}
      </button>
      <IconButton className="task-delete" label={`Delete ${title}`} onClick={() => onDeleteThread(task.id)}>
        <Trash size={13} />
      </IconButton>
      {planProgress && (
        <div
          className="task-row-progress"
          role="progressbar"
          aria-label={`${planProgress.completed} of ${planProgress.total} complete`}
          aria-valuemin="0"
          aria-valuemax={planProgress.total}
          aria-valuenow={planProgress.completed}
        >
          <span style={{ width: `${planProgressPercent}%` }} />
        </div>
      )}
    </motion.div>
  );
});

function SidebarThreadList({ tasks, seenThreadCompletions, selectedThreadId, activeView, onSelectThread, onDeleteThread, ariaLabel, emptyMessage, reduceMotion = false }) {
  const systemReducedMotion = useReducedMotion();
  const animateLayout = !reduceMotion && !systemReducedMotion;
  return (
    <div className="task-tree" aria-label={ariaLabel}>
      {emptyMessage && tasks.length === 0 && <p>{emptyMessage}</p>}
      {tasks.map((task) => {
        const active = task.id === selectedThreadId && activeView === "task";
        const completionRevision = threadCompletionRevision(task);
        const finished = Boolean(completionRevision)
          && !active
          && !threadCompletionWasSeen(task, completionRevision, seenThreadCompletions);
        return (
          <SidebarThreadRow
            key={task.id}
            task={task}
            active={active}
            finished={finished}
            animateLayout={animateLayout}
            onSelectThread={onSelectThread}
            onDeleteThread={onDeleteThread}
          />
        );
      })}
    </div>
  );
}

function linkedThreadIdentity(link) {
  return `${link.executionHostId}:${link.executionProjectId}:${link.rawThreadId}`;
}

function LinkedThreadList({ links, onOpenThread, hostStates = {}, selectedIdentity = null, ariaLabel = "Linked threads" }) {
  if (!links?.length) return null;
  return (
    <div className="linked-thread-group">
      <div className="rail-section-heading linked-thread-heading"><span className="rail-group-label"><i />Linked</span></div>
      <div className="task-tree linked-thread-tree" aria-label={ariaLabel}>
        {links.map((link) => {
          const title = link.cachedThreadTitle || link.rawTaskName || link.cachedProjectLabel || "Linked task";
          const host = link.cachedExecutionHostLabel || link.executionHostId;
          const project = link.cachedProjectLabel || link.executionProjectId;
          const state = hostStates[link.executionHostId]?.state;
          const availability = state === "forgotten" ? "Forgotten" : ["error", "unauthorized"].includes(state) ? "Unavailable" : state === "reconnecting" ? "Offline" : null;
          return (
            <div className={`task-row linked-thread-row${selectedIdentity === linkedThreadIdentity(link) ? " selected" : ""}`} key={linkedThreadIdentity(link)}>
              <button
                className="task-select"
                aria-current={selectedIdentity === linkedThreadIdentity(link) ? "page" : undefined}
                onClick={() => onOpenThread(link)}
                title={`${title} · ${host} · ${project}`}
              >
                <span className="task-fork-icon" aria-hidden="true"><GitBranch size={11} /></span>
                <span className="task-title"><strong>{title}</strong><small>{host} · {project}{availability ? ` · ${availability}` : ""}</small></span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SidebarThreadScroll({ children, heading, className = "" }) {
  const scrollRef = useRef(null);
  const [hasMoreBelow, setHasMoreBelow] = useState(false);
  const updateOverflow = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    setHasMoreBelow(element.scrollHeight - element.scrollTop - element.clientHeight > 1);
  }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;

    updateOverflow();
    if (typeof ResizeObserver === "undefined") return undefined;

    const observer = new ResizeObserver(updateOverflow);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [children, updateOverflow]);

  return (
    <div className={`thread-scroll-region${className ? ` ${className}` : ""}`}>
      {heading}
      <div className="thread-list-scroll" ref={scrollRef} onScroll={updateOverflow} data-overflow={hasMoreBelow}>
        <div className="thread-list-content">{children}</div>
      </div>
    </div>
  );
}

export function Sidebar({
  projects,
  projectActivity,
  seenThreadCompletions,
  selectedProjectId,
  onSelectProject,
  onDeleteProject,
  tasks,
  selectedThreadId,
  onSelectThread,
  onDeleteThread,
  onCleanupThreads,
  protectedThreadIds,
  threadCleanupAgeDays,
  onNewTask,
  onEnterFocus,
  onOpenProject,
  activeView,
  onView,
  attentionCount,
  changedCount,
  toolCount,
  runtime,
  legacySidebar = false,
  recentProjectLimit = 6,
  reduceMotion = false,
  collapseForPreview = false,
  onExpandedChange,
  width,
  onWidthChange,
  storage = localStorage,
  linkedThreads = [],
  linkedThreadHostStates = {},
  onOpenLinkedThread = () => {},
  selectedLinkedThread = null
}) {
  const [pinnedExpanded, setPinnedExpanded] = useState(() => storage.getItem("pixice.sidebarPinned") !== "false");
  const [previewPinnedExpanded, setPreviewPinnedExpanded] = useState(false);
  const sidebarHoveredRef = useRef(false);
  const previewModeRef = useRef(collapseForPreview);
  const resizeCleanup = useRef(null);
  const enteringPreview = collapseForPreview && !previewModeRef.current;
  const expanded = collapseForPreview
    ? enteringPreview ? sidebarHoveredRef.current : previewPinnedExpanded
    : pinnedExpanded;

  useLayoutEffect(() => onExpandedChange(expanded), [expanded, onExpandedChange]);
  useEffect(() => {
    if (collapseForPreview && !previewModeRef.current) {
      setPreviewPinnedExpanded(sidebarHoveredRef.current);
    }
    if (!collapseForPreview) setPreviewPinnedExpanded(false);
    previewModeRef.current = collapseForPreview;
  }, [collapseForPreview]);
  useEffect(() => () => resizeCleanup.current?.(), []);
  useEffect(() => {
    const handleShortcut = (event) => {
      if (event.defaultPrevented || event.altKey || !(event.metaKey || event.ctrlKey)) return;
      if (!event.shiftKey && event.key.toLowerCase() === "n" && selectedProjectId) {
        event.preventDefault();
        onNewTask();
      }
      if (!event.shiftKey && event.key === ",") {
        event.preventDefault();
        onView("settings");
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [onNewTask, onView, selectedProjectId]);

  const newTaskShortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘N" : "Ctrl N";
  const settingsShortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘," : "Ctrl ,";

  const togglePinned = () => {
    if (collapseForPreview) {
      setPreviewPinnedExpanded((current) => !current);
      return;
    }
    const next = !expanded;
    setPinnedExpanded(next);
    storage.setItem("pixice.sidebarPinned", String(next));
  };

  const keepExpanded = () => {
    if (collapseForPreview) {
      setPreviewPinnedExpanded(true);
      return;
    }
    setPinnedExpanded(true);
    storage.setItem("pixice.sidebarPinned", "true");
  };

  const resizeFromPointer = (event) => {
    event.preventDefault();
    keepExpanded();

    const startX = event.clientX;
    const startWidth = width;
    let nextWidth = width;
    const move = (moveEvent) => {
      nextWidth = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
      onWidthChange(nextWidth);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.classList.remove("sidebar-resizing");
      storage.setItem("pixice.sidebarWidth", String(nextWidth));
      resizeCleanup.current = null;
    };

    document.body.classList.add("sidebar-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    resizeCleanup.current = stop;
  };

  const resizeFromKeyboard = (event) => {
    const adjustments = {
      ArrowLeft: width - 16,
      ArrowRight: width + 16,
      Home: MIN_SIDEBAR_WIDTH,
      End: MAX_SIDEBAR_WIDTH
    };
    if (!(event.key in adjustments)) return;
    event.preventDefault();
    keepExpanded();
    const nextWidth = clampSidebarWidth(adjustments[event.key]);
    onWidthChange(nextWidth);
    storage.setItem("pixice.sidebarWidth", String(nextWidth));
  };

  return (
    <aside
      className="sidebar"
      aria-label="Primary navigation"
      data-expanded={expanded}
      data-preview-mode={collapseForPreview}
      data-sidebar-mode={legacySidebar ? "legacy" : "projects"}
      onMouseEnter={() => {
        sidebarHoveredRef.current = true;
      }}
      onMouseLeave={() => {
        sidebarHoveredRef.current = false;
      }}
    >
      {legacySidebar ? (
        <div className="rail-header">
          <div className="brand-mark"><img src={pixiceIcon} alt="" /></div>
          <div className="brand-copy">
            <strong>Pixice</strong>
            <small>{runtime?.connected ? "Codex connected" : "Codex offline"}</small>
          </div>
          <IconButton
            label={expanded ? "Collapse navigation labels" : "Expand navigation labels"}
            aria-expanded={expanded}
            onClick={togglePinned}
            className="rail-toggle"
          >
            {expanded ? <CaretLeft size={18} /> : <CaretRight size={18} />}
          </IconButton>
        </div>
      ) : null}

      <nav className="rail-scroll">
        <div className="rail-group">
          <div className="workspace-heading">
            <div className="rail-group-label"><i />Workspace</div>
            {!legacySidebar && (
              <IconButton
                label={expanded ? "Collapse navigation labels" : "Expand navigation labels"}
                aria-expanded={expanded}
                onClick={togglePinned}
                className="rail-toggle"
              >
                {expanded ? <CaretLeft size={18} /> : <CaretRight size={18} />}
              </IconButton>
            )}
          </div>
          {onEnterFocus && <SidebarNavItem icon={Sparkle} label="Focus" onClick={onEnterFocus} disabled={!selectedProjectId} />}
          <SidebarNavItem icon={NewTaskIcon} label="New task" tone="new-task" shortcut={newTaskShortcut} active={Boolean(selectedProjectId) && activeView === "task" && !selectedThreadId} disabled={!selectedProjectId} onClick={onNewTask} />
          <SidebarNavItem icon={BoardIcon} label="Board" active={activeView === "board"} disabled={!selectedProjectId} onClick={() => onView("board")} />
          <SidebarNavItem icon={AttentionIcon} label="Attention" active={activeView === "attention"} badge={attentionCount} badgeVisible={expanded} badgeTone="attention" onClick={() => onView("attention")} />
          <SidebarNavItem icon={ReviewIcon} label="Review" active={activeView === "review"} badge={changedCount} badgeVisible={expanded} disabled={!selectedProjectId} onClick={() => onView("review")} />
          <SidebarNavItem icon={Stack} label="Tools" active={activeView === "tools"} badge={toolCount} badgeVisible={expanded} disabled={!selectedProjectId} onClick={() => onView("tools")} />
          <div className="workflow-nav-slot" data-workflow-nav-slot />
        </div>

        {legacySidebar ? (
          <SidebarThreadScroll className="legacy-thread-scroll">
            <>
              <div className="rail-divider" />
              <div className="rail-section-heading">
                <span className="rail-group-label"><i />Projects</span>
                <IconButton label="New project" onClick={onOpenProject}><Plus size={15} /></IconButton>
              </div>
              <div className="project-list">
                {projects.length === 0 && <p className="rail-empty">Create a project to begin.</p>}
                {projects.map((project) => {
                  const selected = project.id === selectedProjectId;
                  return (
                    <div className={`project-node ${selected ? "selected" : ""}`} key={project.id}>
                      <button
                        className="project-row"
                        onClick={() => onSelectProject(project.id)}
                        aria-current={selected ? "true" : undefined}
                        aria-expanded={selected}
                        title={project.displayName}
                      >
                        <span className="rail-icon project-icon"><Folder size={16} /></span>
                        <span className="project-copy"><strong>{project.displayName}</strong></span>
                      </button>
                      {onDeleteProject && (
                        <IconButton className="project-delete" label={`Delete ${project.displayName}`} onClick={() => onDeleteProject(project.id)}>
                          <Trash size={13} />
                        </IconButton>
                      )}
                      {selected && (
                        <SidebarThreadList
                          tasks={tasks}
                          seenThreadCompletions={seenThreadCompletions}
                          selectedThreadId={selectedThreadId}
                          activeView={activeView}
                          onSelectThread={onSelectThread}
                          onDeleteThread={onDeleteThread}
                          ariaLabel={`${project.displayName} tasks`}
                          emptyMessage="No Codex threads yet"
                          reduceMotion={reduceMotion}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
              <LinkedThreadList links={linkedThreads} hostStates={linkedThreadHostStates} selectedIdentity={selectedLinkedThread} onOpenThread={onOpenLinkedThread} />
            </>
          </SidebarThreadScroll>
        ) : (
          <SidebarThreadScroll
            heading={<div className="rail-section-heading thread-section-heading">
              <span className="rail-group-label"><i />Threads</span>
              <span className="rail-section-rule" aria-hidden="true" />
              <ThreadCleanupPopover
                tasks={tasks}
                selectedThreadId={selectedThreadId}
                protectedThreadIds={protectedThreadIds}
                disabled={!selectedProjectId}
                onDeleteThread={onDeleteThread}
                onCleanupAll={onCleanupThreads}
                ageDays={threadCleanupAgeDays}
                reduceMotion={reduceMotion}
              />
            </div>}
          >
            <SidebarThreadList
              tasks={tasks}
              seenThreadCompletions={seenThreadCompletions}
              selectedThreadId={selectedThreadId}
              activeView={activeView}
              onSelectThread={onSelectThread}
              onDeleteThread={onDeleteThread}
              ariaLabel={selectedProjectId ? "Project threads" : "Threads"}
              emptyMessage={selectedProjectId ? "No Codex threads yet" : "Choose a project above"}
              reduceMotion={reduceMotion}
            />
            <LinkedThreadList links={linkedThreads} hostStates={linkedThreadHostStates} selectedIdentity={selectedLinkedThread} onOpenThread={onOpenLinkedThread} />
          </SidebarThreadScroll>
        )}
      </nav>

      {!legacySidebar && (
        <div className="project-rail-header">
          <div className="project-rail-heading">
            <span>Projects</span>
          </div>
          <ProjectSwitcher
            projects={projects}
            activityByProject={projectActivity}
            selectedProjectId={selectedProjectId}
            onSelectProject={onSelectProject}
            onDeleteProject={onDeleteProject}
            onCreateProject={onOpenProject}
            expanded={expanded}
            recentProjectLimit={recentProjectLimit}
          />
        </div>
      )}

      <button className={`rail-footer ${activeView === "settings" ? "active" : ""}`} onClick={() => onView("settings")} aria-label="Settings" aria-current={activeView === "settings" ? "page" : undefined}>
        <span className="runtime-slot"><Gear size={17} weight={activeView === "settings" ? "fill" : "regular"} /></span>
        <span className="rail-label"><strong>Settings</strong></span>
        <kbd className="rail-shortcut">{settingsShortcut}</kbd>
      </button>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={Math.round(width)}
        tabIndex={expanded ? 0 : -1}
        onPointerDown={resizeFromPointer}
        onKeyDown={resizeFromKeyboard}
      />
    </aside>
  );
}

function AppToolbar({ icon: Icon = Folder, title, subtitle, inspectorOpen, onInspectorToggle, showInspector = false, previewOpen, onPreviewToggle, showPreview = false, executionStatus = null, executionAction = null }) {
  return (
    <header className="app-toolbar">
      <div className="toolbar-title">
        <Icon size={16} />
        <span><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</span>
      </div>
      <div className="toolbar-actions">
        {executionStatus}
        {executionAction}
        {showPreview && (
          <IconButton label={previewOpen ? "Close preview workspace" : "Open preview workspace"} className={previewOpen ? "active" : ""} onClick={onPreviewToggle}>
            <PreviewIcon size={18} />
          </IconButton>
        )}
        {showInspector && (
          <IconButton label="Toggle task inspector" className={inspectorOpen ? "active" : ""} onClick={onInspectorToggle}>
            <TaskMapIcon size={18} />
          </IconButton>
        )}
      </div>
    </header>
  );
}

function fileTabFromPayload(file) {
  return {
    ...file,
    id: `file:${file.path}`,
    type: "file",
    previewKind: file.kind,
    draft: file.content ?? "",
    editing: false,
    dirty: false,
    saving: false,
    error: null
  };
}

function FileSurface({ file, onUpdate, onSave, onDownload = null, onDownloadCancel = null, downloadBusy = false, downloadProgress = null, downloadError = "", visible = true }) {
  const source = file.draft ?? file.content ?? "";

  useEffect(() => {
    if (!visible || !file.editing) return undefined;
    const saveShortcut = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void onSave(file);
    };
    window.addEventListener("keydown", saveShortcut);
    return () => window.removeEventListener("keydown", saveShortcut);
  }, [file, onSave]);

  let content;
  if (file.editing) {
    content = (
      <div className="file-editor-shell">
        <textarea
          className="file-editor"
          aria-label={`Edit ${file.name}`}
          value={source}
          onChange={(event) => onUpdate(file.id, { draft: event.target.value, dirty: event.target.value !== file.content, error: null })}
          spellCheck={file.previewKind === "markdown"}
        />
        {file.error && <div className="file-save-error"><Warning size={13} />{file.error}</div>}
      </div>
    );
  } else if (file.previewKind === "markdown") content = <div className="file-document markdown-document"><MarkdownMessage text={source} /></div>;
  else if (file.previewKind === "html") content = <iframe className="html-preview" title={`Preview ${file.name}`} srcDoc={source} sandbox="allow-scripts allow-forms allow-modals" />;
  else if (file.previewKind === "image") content = <div className="file-media-preview"><img src={file.dataUrl} alt={file.name} /></div>;
  else if (file.previewKind === "pdf") content = <iframe className="pdf-preview" title={file.name} src={file.dataUrl} />;
  else if (file.previewKind === "unsupported") content = <div className="file-empty"><File size={28} /><strong>Preview unavailable</strong><small>This binary format cannot be displayed or edited in Pixice yet.</small></div>;
  else content = <pre className="text-file-preview"><code>{source}</code></pre>;
  return <div className="file-surface">
    {(onDownload || downloadError) && <div className="file-surface-actions">
      {onDownload && <button type="button" className="settings-action" onClick={() => void onDownload(file)} disabled={downloadBusy}>{downloadBusy ? <SpinnerGap className="spin-icon" size={13} /> : <ArrowClockwise size={13} />}{downloadBusy ? "Downloading…" : "Download file"}</button>}
      {downloadBusy && onDownloadCancel && <button type="button" className="settings-action" onClick={onDownloadCancel}>Cancel download</button>}
      {downloadBusy && downloadProgress && <small className="file-download-progress">{attachmentSize(downloadProgress.loaded ?? 0)}{Number.isFinite(downloadProgress.total) ? ` of ${attachmentSize(downloadProgress.total)}` : ""}</small>}
      {downloadError && <span className="file-save-error" role="alert"><Warning size={13} />{downloadError}</span>}
    </div>}
    {content}
  </div>;
}

function PreviewTabSurface({ workspaceId, reduceMotion }) {
  return (
    <motion.span
      aria-hidden="true"
      className="browser-tab-active-indicator"
      initial={false}
      layoutId={`preview-tab-${workspaceId}`}
      transition={reduceMotion ? { duration: 0 } : PREVIEW_TAB_SPRING}
    />
  );
}

function PreviewCustomTabIcon({ kind }) {
  if (kind === "workflow") return <TreeStructure size={12} />;
  if (kind === "task") return <Circle size={12} />;
  if (kind === "plan") return <Gauge size={12} />;
  if (kind === "thread") return <GitBranch size={12} />;
  if (kind === "task-map") return <TaskMapIcon size={12} />;
  if (kind === "new") return <Plus size={12} />;
  if (kind === "simulator") return <Desktop size={12} />;
  return <File size={12} />;
}

function PreviewNewTab({ api, projectId, hostThreadId, threads, onChooseBrowser, onChooseFile, onChooseCustom, onChooseSimulator }) {
  const [mode, setMode] = useState(null);
  const [path, setPath] = useState("");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const browserReadiness = api?.remote?.readiness?.browser;
  const browserAvailable = !api?.remote || !browserReadiness || browserReadiness.available === true || browserReadiness.canStart === true;

  const loadItems = useCallback(async (nextMode) => {
    setMode(nextMode);
    setLoading(true);
    setError("");
    try {
      if (nextMode === "thread") {
        setItems((threads ?? []).filter((candidate) => candidate.id !== hostThreadId && isSidebarThread(candidate)));
      } else {
        const response = nextMode === "task"
          ? await api?.board?.list?.({ projectId })
          : await api?.workflows?.list?.({ projectId });
        setItems(response?.data ?? []);
      }
    } catch (cause) {
      setItems([]);
      setError(cause.message);
    } finally {
      setLoading(false);
    }
  }, [api, hostThreadId, projectId, threads]);

  const openFile = async (event) => {
    event.preventDefault();
    if (!path.trim()) return;
    setLoading(true);
    setError("");
    try {
      await onChooseFile(path.trim());
    } catch (cause) {
      setError(cause.message);
      setLoading(false);
    }
  };

  return (
    <div className="preview-new-tab">
      <div className="preview-new-tab-inner">
        <div className="preview-new-tab-grid" aria-label="New preview tab options">
          <button type="button" disabled={!browserAvailable} title={!browserAvailable ? browserReadiness?.reason || "The host browser is unavailable." : undefined} onClick={() => void onChooseBrowser()}><Globe size={16} /><span><strong>Browser</strong><small>{browserAvailable ? "Open a web page" : "Host browser unavailable"}</small></span></button>
          <button type="button" onClick={() => { setMode("file"); setItems([]); setError(""); }}><Files size={16} /><span><strong>File</strong><small>Open a local file</small></span></button>
          <button type="button" onClick={() => void loadItems("thread")}><GitBranch size={16} /><span><strong>Side thread</strong><small>Chat beside this task</small></span></button>
          <button type="button" onClick={() => void loadItems("task")}><Circle size={16} /><span><strong>Work item</strong><small>Open a Board item</small></span></button>
          <button type="button" onClick={() => void loadItems("workflow")}><TreeStructure size={16} /><span><strong>Workflow</strong><small>Open a workflow canvas</small></span></button>
          {hostThreadId && <button type="button" onClick={() => onChooseCustom({ id: `task-map:${hostThreadId}`, kind: "task-map", title: "Task map", payload: { projectId, threadId: hostThreadId, hostThreadId } })}><TaskMapIcon size={16} /><span><strong>Task map</strong><small>Watch plans and agents</small></span></button>}
          <button type="button" onClick={onChooseSimulator}><Desktop size={16} /><span><strong>iOS Simulator</strong><small>Build and run SwiftUI</small></span></button>
        </div>
        {mode === "file" && (
          <form className="preview-new-tab-file" onSubmit={openFile}>
            <File size={14} />
            <input autoFocus aria-label="Local file path" placeholder="Project-relative or absolute path" value={path} onChange={(event) => setPath(event.target.value)} />
            <button type="submit" disabled={!path.trim() || loading}>{loading ? <SpinnerGap className="spin-icon" size={13} /> : "Open"}</button>
          </form>
        )}
        {(mode === "task" || mode === "workflow" || mode === "thread") && (
          <div className="preview-new-tab-list" aria-label={mode === "task" ? "Work items" : mode === "thread" ? "Side threads" : "Workflows"}>
            {mode === "thread" && !loading && (
              <button type="button" className="preview-new-side-thread" onClick={() => onChooseCustom(newSideThreadTab(projectId, hostThreadId))}>
                <Plus size={13} />
                <span>New side thread</span>
              </button>
            )}
            {loading ? <span><SpinnerGap className="spin-icon" size={14} />Loading</span> : items.map((item) => (
              <button type="button" key={item.id} onClick={() => onChooseCustom(mode === "thread"
                ? threadPreviewTab(projectId, item, hostThreadId)
                : {
                  id: `${mode}:${item.id}`,
                  kind: mode,
                  title: item.title ?? item.name ?? (mode === "task" ? "Work item" : "Workflow"),
                  payload: mode === "task"
                    ? { projectId, taskId: item.id, reason: "edit", actorKind: "user" }
                    : { projectId, workflowId: item.id, workflowName: item.name, reason: "open" }
                })}>
                {mode === "task" ? <Circle size={13} /> : mode === "thread" ? <GitBranch size={13} /> : <TreeStructure size={13} />}
                <span>{mode === "thread" ? threadTitle(item) : item.title ?? item.name}</span>
              </button>
            ))}
            {!loading && !items.length && !error && mode !== "thread" && <span>No {mode === "task" ? "work items" : "workflows"} yet.</span>}
          </div>
        )}
        {error && <p className="preview-new-tab-error"><Warning size={13} />{error}</p>}
      </div>
    </div>
  );
}

function BrowserPanel({ api, workspaceId, apiWorkspaceId = workspaceId, state, onState, onBrowserCreated, onClose, onBrowserClose, projectId, hostThreadId, fileTabs, instrumentTabs, customTabs, activeTabId, onActiveTabChange, onFileUpdate, onFileClose, onInstrumentClose, onCustomTabOpen, onCustomTabUpdate, onCustomTabClose, onNewTab, onInstrumentRefresh, onInstrumentEvent, onInstrumentInvoke, onInstrumentPin, onOpenResource, onOpenBoardWorkspace, onOpenWorkflowWorkspace, sideThreadProps, taskMapProps, visible = true }) {
  const viewportRef = useRef(null);
  const systemReducedMotion = useReducedMotion();
  const isPresent = useIsPresent();
  const activeFile = fileTabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeInstrument = instrumentTabs.find((tab) => `instrument:${tab.id}` === activeTabId) ?? null;
  const activeCustomTab = customTabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeTab = activeFile || activeInstrument || activeCustomTab ? null : state.tabs.find((tab) => tab.id === activeTabId) ?? state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
  const [address, setAddress] = useState(activeTab?.url ?? "");
  const [downloadState, setDownloadState] = useState(null);
  const downloadAbortRef = useRef(null);
  const downloadMountedRef = useRef(true);

  useEffect(() => () => {
    downloadMountedRef.current = false;
    downloadAbortRef.current?.abort(new DOMException("The preview closed.", "AbortError"));
  }, []);

  useEffect(() => setAddress(activeTab?.url ?? ""), [activeTab?.id, activeTab?.url]);
  useEffect(() => {
    if (!visible || !isPresent || api?.remote) return undefined;
    if (!api?.browser || !activeTab || !viewportRef.current) {
      if (apiWorkspaceId) void api?.browser?.setViewport({ workspaceId: apiWorkspaceId, visible: false }).catch(() => {});
      return undefined;
    }
    const occluderSelector = '[aria-modal="true"], [data-native-preview-occluder="true"]';
    const previewOccluded = () => Boolean(document.querySelector(occluderSelector));
    const mutationChangesOcclusion = (mutation) => {
      if (mutation.type === "attributes") return true;
      return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => (
        typeof node.matches === "function"
        && (node.matches(occluderSelector) || node.querySelector?.(occluderSelector))
      ));
    };
    const updateBounds = () => {
      if (previewOccluded()) {
        void api.browser.setViewport({ workspaceId: apiWorkspaceId, visible: false }).catch(() => {});
        return;
      }
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      void api.browser.setViewport({
        workspaceId: apiWorkspaceId,
        visible: true,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }).then(onState).catch(() => {});
    };
    updateBounds();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(updateBounds) : null;
    observer?.observe(viewportRef.current);
    const occlusionObserver = document.body && typeof MutationObserver === "function"
      ? new MutationObserver((mutations) => {
        if (mutations.some(mutationChangesOcclusion)) updateBounds();
      })
      : null;
    occlusionObserver?.observe(document.body, {
      attributes: true,
      attributeFilter: ["aria-modal", "data-native-preview-occluder"],
      childList: true,
      subtree: true
    });
    window.addEventListener("resize", updateBounds);
    return () => {
      observer?.disconnect();
      occlusionObserver?.disconnect();
      window.removeEventListener("resize", updateBounds);
      void api.browser.setViewport({ workspaceId: apiWorkspaceId, visible: false }).catch(() => {});
    };
  }, [activeTab?.id, api, apiWorkspaceId, isPresent, onState, visible, workspaceId]);

  const run = async (operation, activate = false) => {
    try {
      const next = await operation();
      if (next) {
        onState(next);
        if (activate && next.activeTabId) onActiveTabChange(next.activeTabId);
      }
    } catch {
      // Navigation errors are reflected on the tab state by the Electron browser surface.
    }
  };
  const submitAddress = (event) => {
    event.preventDefault();
    if (!address.trim()) return;
    void run(() => api.browser.navigate({ workspaceId: apiWorkspaceId, tabId: activeTab?.id, url: address }));
  };
  const saveFile = useCallback(async (file) => {
    if (!file?.editable || !file.dirty || file.saving) return;
    onFileUpdate(file.id, { saving: true, error: null });
    try {
      const saved = await api.files.write({ projectId, path: file.path, content: file.draft ?? file.content ?? "", expectedMtimeMs: file.mtimeMs });
      onFileUpdate(file.id, {
        ...saved,
        previewKind: saved.kind,
        draft: saved.content ?? "",
        dirty: false,
        saving: false,
        error: null
      });
    } catch (cause) {
      onFileUpdate(file.id, { saving: false, error: cause.message });
    }
  }, [api, onFileUpdate, projectId]);
  const downloadFile = useCallback(async (file) => {
    if (!canDownloadRemoteFile(api, file) || !projectId || (downloadState?.path === file.path && !downloadState.error)) return;
    const controller = new AbortController();
    downloadAbortRef.current?.abort(new DOMException("A newer download started.", "AbortError"));
    downloadAbortRef.current = controller;
    setDownloadState({ path: file.path, loaded: 0, total: file.size ?? null, error: "" });
    try {
      const result = await downloadRemoteFile({
        api,
        projectId,
        path: file.path,
        signal: controller.signal,
        onProgress: (progress) => setDownloadState((current) => current?.path === file.path ? { ...current, ...progress } : current)
      });
      if (controller.signal.aborted || !downloadMountedRef.current) return;
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename || file.name || "download";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setDownloadState(null);
    } catch (cause) {
      if (downloadMountedRef.current) setDownloadState({ path: file.path, loaded: 0, total: file.size ?? null, error: cause.message });
    } finally {
      if (downloadAbortRef.current === controller) downloadAbortRef.current = null;
    }
  }, [api, downloadState?.path, projectId]);
  const cancelDownload = useCallback(() => {
    const controller = downloadAbortRef.current;
    if (!controller) return;
    controller.abort(new DOMException("The download was cancelled.", "AbortError"));
    setDownloadState((current) => current ? { ...current, error: "Download cancelled." } : current);
  }, []);

  return (
    <motion.section
      className="browser-panel"
      data-preview-workspace-id={workspaceId}
      aria-label="Preview workspace"
      aria-hidden={!isPresent || !visible}
      inert={!isPresent || !visible ? true : undefined}
      initial={systemReducedMotion ? false : { opacity: 0, x: 12, filter: "blur(2px)" }}
      animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
      exit={systemReducedMotion ? { opacity: 0 } : { opacity: 0, x: 10, filter: "blur(2px)" }}
      transition={{ duration: systemReducedMotion ? 0 : 0.24, ease: MOTION_EASE }}
    >
      <div className="browser-tabbar">
        <div className="browser-tabs" role="tablist" aria-label="Workspace tabs">
          {state.tabs.map((tab) => (
            <div className={`browser-tab${tab.id === activeTabId ? " active" : ""}`} role="presentation" key={tab.id}>
              {tab.id === activeTabId && <PreviewTabSurface workspaceId={workspaceId} reduceMotion={systemReducedMotion} />}
              <button role="tab" aria-selected={tab.id === activeTabId} onClick={() => void run(() => api.browser.activate({ workspaceId: apiWorkspaceId, tabId: tab.id }), true)}>
                {tab.loading ? <SpinnerGap className="spin-icon" size={12} /> : <Globe size={12} />}
                <span>{tab.title || "New tab"}</span>
              </button>
              <IconButton label={`Close ${tab.title || "tab"}`} onClick={() => onBrowserClose(tab.id)}><X size={11} /></IconButton>
            </div>
          ))}
          {fileTabs.map((file) => (
            <div className={`browser-tab file-tab${file.id === activeTabId ? " active" : ""}${file.dirty ? " dirty" : ""}`} role="presentation" key={file.id}>
              {file.id === activeTabId && <PreviewTabSurface workspaceId={workspaceId} reduceMotion={systemReducedMotion} />}
              <button role="tab" aria-selected={file.id === activeTabId} onClick={() => onActiveTabChange(file.id)}>
                {file.previewKind === "html" ? <Code size={12} /> : <File size={12} />}
                <span>{file.name}</span>
              </button>
              <IconButton label={`Close ${file.name}`} onClick={() => onFileClose(file.id)}>{file.dirty ? <Circle size={8} weight="fill" /> : <X size={11} />}</IconButton>
            </div>
          ))}
          {instrumentTabs.map((instrument) => (
            <div className={`browser-tab instrument-tab${`instrument:${instrument.id}` === activeTabId ? " active" : ""}`} role="presentation" key={instrument.id}>
              {`instrument:${instrument.id}` === activeTabId && <PreviewTabSurface workspaceId={workspaceId} reduceMotion={systemReducedMotion} />}
              <button role="tab" aria-selected={`instrument:${instrument.id}` === activeTabId} onClick={() => onActiveTabChange(`instrument:${instrument.id}`)}>
                <Gauge size={12} />
                <span>{instrument.document.title}</span>
              </button>
              <IconButton label={`Close ${instrument.document.title}`} onClick={() => onInstrumentClose(instrument.id)}><X size={11} /></IconButton>
            </div>
          ))}
          {customTabs.map((tab) => (
            <div className={`browser-tab custom-tab${tab.id === activeTabId ? " active" : ""}`} role="presentation" key={tab.id}>
              {tab.id === activeTabId && <PreviewTabSurface workspaceId={workspaceId} reduceMotion={systemReducedMotion} />}
              <button role="tab" aria-selected={tab.id === activeTabId} onClick={() => onActiveTabChange(tab.id)}>
                <PreviewCustomTabIcon kind={tab.kind} />
                <span>{tab.title || "Preview"}</span>
              </button>
              <IconButton label={`Close ${tab.title || "preview"}`} onClick={() => onCustomTabClose(tab.id)}><X size={11} /></IconButton>
            </div>
          ))}
          <IconButton label="New preview tab" className="browser-new-tab" onClick={onNewTab}><Plus size={15} /></IconButton>
        </div>
        <IconButton label="Close preview workspace" className="browser-close" onClick={onClose}><X size={15} /></IconButton>
      </div>
      {activeCustomTab ? null : activeInstrument ? (
        <div className="file-navigation instrument-navigation">
          <span className="file-breadcrumb"><Gauge size={14} /><span>Native Instrument</span></span>
          <div className="file-actions"><span>v{activeInstrument.documentVersion}</span></div>
        </div>
      ) : activeFile ? (
        <div className="file-navigation">
          <span className="file-breadcrumb"><Folder size={14} /><span>{activeFile.relativePath}</span></span>
          <div className="file-actions">
            {activeFile.editing && <button type="button" onClick={() => onFileUpdate(activeFile.id, { editing: false })}><Eye size={14} />Preview</button>}
            {!activeFile.editing && activeFile.editable && <button type="button" onClick={() => onFileUpdate(activeFile.id, { editing: true })}><Code size={14} />Edit</button>}
            {activeFile.editing && <button type="button" className="save-file" disabled={!activeFile.dirty || activeFile.saving} onClick={() => void saveFile(activeFile)}>{activeFile.saving ? <SpinnerGap className="spin-icon" size={13} /> : <Check size={13} />}Save</button>}
          </div>
        </div>
      ) : (
        <div className="browser-navigation">
          <IconButton label="Back" disabled={!activeTab?.canGoBack} onClick={() => void run(() => api.browser.history({ workspaceId: apiWorkspaceId, action: "back" }))}><CaretLeft size={16} /></IconButton>
          <IconButton label="Forward" disabled={!activeTab?.canGoForward} onClick={() => void run(() => api.browser.history({ workspaceId: apiWorkspaceId, action: "forward" }))}><CaretRight size={16} /></IconButton>
          <IconButton label={activeTab?.loading ? "Stop loading" : "Reload"} onClick={() => void run(() => api.browser.history({ workspaceId: apiWorkspaceId, action: activeTab?.loading ? "stop" : "reload" }))}>{activeTab?.loading ? <X size={14} /> : <ArrowClockwise size={15} />}</IconButton>
          <form className="browser-address" onSubmit={submitAddress}>
            <LockKey size={13} />
            <input aria-label="Browser address" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Search or enter address" spellCheck="false" />
          </form>
        </div>
      )}
      {activeTab?.error && <div className="browser-error"><Warning size={13} />{activeTab.error}</div>}
      {activeCustomTab?.kind === "new" ? (
        <PreviewNewTab
          api={api}
          projectId={projectId}
          hostThreadId={hostThreadId}
          threads={sideThreadProps?.threads}
          onChooseBrowser={async () => {
            const next = await api.browser.create({ workspaceId: apiWorkspaceId });
            onBrowserCreated(activeCustomTab.id, next);
          }}
          onChooseFile={async (path) => {
            await onOpenResource(path);
            onCustomTabClose(activeCustomTab.id, { ensureTab: false });
          }}
          onChooseCustom={(tab) => {
            onCustomTabClose(activeCustomTab.id, { ensureTab: false });
            onCustomTabOpen(tab);
          }}
          onChooseSimulator={() => {
            onCustomTabClose(activeCustomTab.id, { ensureTab: false });
            onCustomTabOpen({
              id: `simulator:${workspaceId}`,
              kind: "simulator",
              title: "iOS Simulator",
              payload: { projectId }
            });
          }}
        />
      ) : activeCustomTab?.kind === "thread" ? (
        <SideThreadSurface
          {...sideThreadProps}
          api={api}
          tab={activeCustomTab}
          onTabUpdate={(patch) => onCustomTabUpdate(activeCustomTab.id, patch)}
          key={activeCustomTab.id}
        />
      ) : activeCustomTab?.kind === "task-map" ? (
        <TaskMapPreview {...taskMapProps} />
      ) : activeCustomTab?.kind === "simulator" ? (
        <IosSimulatorPreview
          api={api}
          projectId={activeCustomTab.payload.projectId ?? projectId}
          workspaceId={apiWorkspaceId}
          initialSession={activeCustomTab.payload.session ?? null}
          onTitleChange={(title) => onCustomTabUpdate(activeCustomTab.id, { title })}
          onSessionChange={(session) => onCustomTabUpdate(activeCustomTab.id, {
            payload: { ...activeCustomTab.payload, session }
          })}
          onOpenResource={onOpenResource}
        />
      ) : activeCustomTab?.kind === "workflow" ? (
        <WorkflowPreview
          api={api}
          hostId={api?.remote?.hostId ?? "local"}
          previewWorkspaceId={apiWorkspaceId}
          projectId={activeCustomTab.payload.projectId}
          workflowId={activeCustomTab.payload.workflowId}
          workflowName={activeCustomTab.payload.workflowName ?? activeCustomTab.title}
          reason={activeCustomTab.payload.reason}
          tabbed
          onTitleChange={(title) => onCustomTabUpdate(activeCustomTab.id, { title })}
          onOpenWorkspace={(workflowId) => onOpenWorkflowWorkspace?.({ workflowId, projectId }) ?? window.dispatchEvent(new CustomEvent("pixice:open-workflow-workspace", { detail: { workflowId, projectId, hostId: api?.remote?.hostId ?? "local" } }))}
          onClose={() => onCustomTabClose(activeCustomTab.id)}
        />
      ) : activeCustomTab?.kind === "task" || activeCustomTab?.kind === "plan" ? (
        <TaskPreviewContent
          api={api}
          target={activeCustomTab.payload}
          tabbed
          onTitleChange={(title) => onCustomTabUpdate(activeCustomTab.id, { title })}
          onOpenWorkspace={() => onOpenBoardWorkspace?.(activeCustomTab.payload) ?? window.dispatchEvent(new CustomEvent("pixice:open-board-workspace", { detail: { ...activeCustomTab.payload, hostId: api?.remote?.hostId ?? "local" } }))}
          onClose={() => onCustomTabClose(activeCustomTab.id)}
        />
      ) : activeInstrument ? (
        <InstrumentHost
          instrument={activeInstrument}
          onOpenResource={onOpenResource}
          onRefreshData={(source) => onInstrumentRefresh(activeInstrument.id, source)}
          onAgentEvent={(actionId, payload) => onInstrumentEvent(activeInstrument.id, actionId, payload)}
          onInvokeCapability={(actionId, argumentsValue) => onInstrumentInvoke(activeInstrument.id, actionId, argumentsValue)}
          onSetPinned={(pinned) => onInstrumentPin(activeInstrument.id, pinned)}
        />
      ) : activeFile ? (
        <FileSurface
          file={activeFile}
          onUpdate={onFileUpdate}
          onSave={saveFile}
          onDownload={canDownloadRemoteFile(api, activeFile) ? downloadFile : null}
          onDownloadCancel={downloadState?.path === activeFile.path ? cancelDownload : null}
          downloadBusy={downloadState?.path === activeFile.path && !downloadState?.error}
          downloadProgress={downloadState?.path === activeFile.path ? downloadState : null}
          downloadError={downloadState?.path === activeFile.path ? downloadState.error : ""}
          visible={visible}
        />
      ) : activeTab && api.remote ? (
        <RemoteBrowserSurface api={api} workspaceId={apiWorkspaceId} tabId={activeTab.id} key={`${workspaceId}:${activeTab.id}`} />
      ) : activeTab ? (
        <div className="browser-viewport" ref={viewportRef}>
          {!state.native && (
            <div className="browser-mock-page">
              <span><Globe size={23} /></span>
              <strong>{activeTab.title || "Browse with Pixice"}</strong>
              <small>{activeTab.url || "Enter an address above or ask Codex to investigate a page."}</small>
            </div>
          )}
        </div>
      ) : <div className="file-empty"><PreviewIcon size={28} /><strong>Open something</strong><small>Use + to open a browser, file, side thread, work item, or Workflow.</small></div>}
    </motion.section>
  );
}

function PlanAgentAvatar({ index }) {
  const icons = [Brain, GitBranch, Code, Sparkle];
  const Icon = icons[index % icons.length];
  return <span className={`progress-agent-avatar tone-${index % icons.length}`}><Icon size={10} weight="bold" /></span>;
}

function planStepDetail(step, index, workingAgents, running) {
  if (step.status === "inProgress" && !running) return "Paused";
  const explicit = step.detail || step.description || step.owner || step.assignee || step.role;
  if (explicit) return explicit;
  if (step.status === "inProgress" && workingAgents.length) {
    const agent = workingAgents[index % workingAgents.length];
    return agent.agentNickname || agent.agentRole || agent.agentStatusMessage || threadTitle(agent) || "Delegated agent";
  }
  if (step.status === "completed") return "Lead";
  return step.status === "inProgress" ? "Lead" : "Queued";
}

function PlanPanel({ plan, fallbackText, thread, agents = [], fileCount = 0, running, inspectorOpen, onInspectorToggle, defaultExpanded = true }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const systemReducedMotion = useReducedMotion();
  useEffect(() => setExpanded(defaultExpanded), [defaultExpanded]);
  if (!plan?.length && !fallbackText) return null;
  const complete = plan?.filter((step) => step.status === "completed").length ?? 0;
  const total = plan?.length ?? 0;
  const progress = total ? (complete / total) * 100 : 0;
  const workingAgents = agents.filter((agent) => ["running", "inProgress", "active"].includes(threadStatus(agent)));
  const allComplete = total > 0 && complete === total;
  const phase = allComplete ? "Ready for review" : running ? "Implementation" : "Paused";
  const agentCount = agents.length + 1;
  const visibleAgents = Array.from({ length: Math.min(3, agentCount) });
  const workingCopy = allComplete
    ? "All work complete"
    : !running
      ? "Task is inactive"
      : workingAgents.length
        ? `${workingAgents.length} agent${workingAgents.length === 1 ? "" : "s"} working in parallel`
        : "Lead agent working";
  return (
    <section className="task-progress" data-expanded={expanded} data-active={running || allComplete} aria-label="Task progress">
      <button className="progress-head" type="button" aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} task progress`} onClick={() => setExpanded((open) => !open)}>
        <span className="progress-glyph"><TaskProgressIcon size={17} weight="fill" /></span>
        <span className="progress-title"><strong>Task progress</strong><small>{thread ? threadTitle(thread) : "Codex plan"}</small></span>
        {total > 0 && <span className="progress-count" aria-label={`${complete} of ${total} complete`}><strong><MorphText value={complete} duration={280} scale /> / {total}</strong><small>complete</small></span>}
        <CaretDown className="progress-caret" size={15} />
      </button>
      {total > 0 && (
        <div className="progress-track" role="progressbar" aria-label="Task completion" aria-valuemin="0" aria-valuemax={total} aria-valuenow={complete}>
          <span style={{ width: `${progress}%` }} />
        </div>
      )}
      <div className="task-progress-disclosure" aria-hidden={!expanded}>
        <div className="task-progress-disclosure-inner">
          {plan?.length ? (
            <div className="progress-content">
              <div className="progress-phase">
                <span><Circle size={10} weight="fill" /><strong><MorphText value={phase} /></strong></span>
                <small><MorphText value={workingCopy} duration={360} /></small>
              </div>
              <div className="progress-steps">
                {plan.map((step, index) => (
                  <motion.div layout="position" className={`progress-step ${step.status}${step.status === "inProgress" && !running ? " inactive" : ""}`} transition={{ duration: systemReducedMotion ? 0 : 0.2, ease: MOTION_EASE }} key={step.step}>
                    <AnimatePresence initial={false} mode="wait">
                      <motion.span
                        className="progress-status-icon"
                        key={`${step.status}-${step.status === "inProgress" && running}`}
                        initial={systemReducedMotion ? false : { opacity: 0, scale: 0.72, rotate: -12, filter: "blur(2px)" }}
                        animate={{ opacity: 1, scale: 1, rotate: 0, filter: "blur(0px)" }}
                        exit={systemReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.82, filter: "blur(2px)" }}
                        transition={{ duration: systemReducedMotion ? 0 : 0.18, ease: MOTION_EASE }}
                      >
                        {step.status === "completed" ? <CheckCircle size={15} weight="fill" /> : step.status === "inProgress" && running ? <SpinnerGap className="spin-icon" size={15} /> : step.status === "inProgress" ? <Pause size={15} weight="fill" /> : <Circle size={15} />}
                      </motion.span>
                    </AnimatePresence>
                    <span className="progress-step-copy"><strong>{step.step}</strong><small>{planStepDetail(step, index, workingAgents, running)}</small></span>
                  </motion.div>
                ))}
              </div>
            </div>
          ) : <p className="plan-text">{fallbackText}</p>}
          <footer className="progress-footer">
            <div className="progress-agent-summary">
              <span className="progress-agent-stack" aria-hidden="true">
                {visibleAgents.map((_, index) => <PlanAgentAvatar index={index} key={index} />)}
              </span>
              <span><strong>{agentCount} agent{agentCount === 1 ? "" : "s"}</strong><small>{fileCount ? `${fileCount} file${fileCount === 1 ? "" : "s"} touched` : "No files touched yet"}</small></span>
            </div>
            <button className="task-map-button" type="button" onClick={onInspectorToggle}>
              {inspectorOpen ? "Hide task map" : "Open task map"}<CaretRight size={13} />
            </button>
          </footer>
        </div>
      </div>
    </section>
  );
}

function CommandOutput({ output }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="trace-command-output" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><span>View output</span><CaretRight className="activity-caret" size={12} /></summary>
      {open && <pre>{output}</pre>}
    </details>
  );
}

function ActivityItem({ item }) {
  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary)
      ? item.summary.map((part) => typeof part === "string" ? part : part?.text ?? "").filter(Boolean).join("\n")
      : item.summary;
    if (!summary) return null;
    return <div className="trace-entry reasoning"><Sparkle size={14} /><p>{summary}</p></div>;
  }
  if (item.type === "commandExecution") {
    const command = Array.isArray(item.command) ? item.command.join(" ") : item.command;
    return (
      <div className="trace-tool-block">
        <div className="trace-entry">
          <TerminalWindow size={14} />
          <span className="trace-entry-copy"><strong>Command</strong><code title={command}>{command}</code></span>
          <StatusDot status={item.status === "completed" ? "complete" : item.status === "failed" ? "error" : "running"} />
        </div>
        {item.aggregatedOutput && <CommandOutput output={item.aggregatedOutput} />}
      </div>
    );
  }
  if (item.type === "fileChange") {
    const count = normalizedFileChanges(item).length;
    return <div className="trace-entry"><Files size={14} /><span className="trace-entry-copy"><strong>Updated files</strong><small>{count} file{count === 1 ? "" : "s"}</small></span><StatusDot status={item.status === "completed" ? "complete" : "running"} /></div>;
  }
  if (item.type === "contextCompaction") {
    const failed = item.status === "failed" || Boolean(item.failure);
    const completed = Boolean(item.completedAt) || item.status === "completed";
    const label = failed ? "Compaction failed" : completed ? "Compacted context" : "Compacting context";
    const detail = failed ? item.failure?.message ?? "Conversation summary failed" : completed ? "Conversation summary ready" : "Summarizing the conversation";
    return <div className="trace-entry"><Brain size={14} /><span className="trace-entry-copy"><strong>{label}</strong><small>{detail}</small></span><StatusDot status={failed ? "error" : completed ? "complete" : "running"} /></div>;
  }
  if (item.type === "collabAgentToolCall") {
    const count = item.receiverThreadIds?.length ?? 0;
    return <div className="trace-entry"><GitBranch size={14} /><span className="trace-entry-copy"><strong>{item.tool}</strong><small>{count} agent{count === 1 ? "" : "s"}</small></span><StatusDot status={item.status === "completed" ? "complete" : "running"} /></div>;
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    return <div className="trace-entry"><PlugsConnected size={14} /><span className="trace-entry-copy"><strong>{item.tool}</strong>{item.server && <small>{item.server}</small>}</span><StatusDot status={item.status === "completed" ? "complete" : item.status === "failed" ? "error" : "running"} /></div>;
  }
  return null;
}

function precedingImageGenerationTool(items, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = items[cursor];
    if (candidate.type === "userMessage") break;
    if ((candidate.type === "mcpToolCall" || candidate.type === "dynamicToolCall") && /image(?:_gen|gen|generation)/i.test(candidate.tool ?? "")) {
      return candidate;
    }
  }
  return null;
}

function imageGenerationPrompt(items, index, item) {
  const tool = precedingImageGenerationTool(items, index);
  return item.revisedPrompt || item.prompt || item.arguments?.prompt || item.input?.prompt || tool?.arguments?.prompt || tool?.input?.prompt || null;
}

function imageGenerationResolution(items, index, item) {
  const tool = precedingImageGenerationTool(items, index);
  const resolution = item.resolution || item.size || item.arguments?.size || item.input?.size || tool?.arguments?.size || tool?.input?.size;
  return resolution ? String(resolution).replace(/\s*[x×]\s*/i, " × ") : "1024 × 1024";
}

export function generatedImageRevisionPrompt(comment, originalPrompt = null, attached = true) {
  const changes = String(comment ?? "").trim();
  const context = originalPrompt ? `\n\nOriginal direction:\n${String(originalPrompt).trim()}` : "";
  const imageReference = attached ? "the attached image" : "the most recent generated image in this conversation";
  return `Generate a new version of ${imageReference}. Apply these requested changes:\n\n${changes}${context}\n\nKeep details that were not mentioned unchanged.`;
}

export function generatedImageAttachment(source) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif|avif));base64,([a-z\d+/=]+)$/i.exec(String(source ?? ""));
  if (!match) return [];
  const padding = match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0;
  const size = Math.max(0, Math.floor(match[2].length * 3 / 4) - padding);
  const extension = { "image/jpeg": "jpg" }[match[1].toLowerCase()] ?? match[1].split("/")[1].toLowerCase();
  return [{ name: `generated-image.${extension}`, type: match[1].toLowerCase(), size, dataUrl: source }];
}

function MessageReference({ label, target }) {
  const onOpen = useContext(WorkspaceOpenContext);
  const supported = /^(https?:\/\/|file:\/\/)/i.test(target) || (!/^[a-z][a-z\d+.-]*:/i.test(target) && !target.startsWith("#"));
  if (!onOpen || !supported) return <a className="message-reference" href={target} target="_blank" rel="noreferrer" title={target}>{label}</a>;
  return <button type="button" className="message-reference" title={target} aria-label={`Open ${target}`} onClick={() => onOpen(target)}>{label}</button>;
}

function inlineMarkdown(text, keyPrefix) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g).filter(Boolean).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={`${keyPrefix}-${index}`}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={`${keyPrefix}-${index}`}>{part.slice(2, -2)}</strong>;
    const reference = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (reference) return <MessageReference label={reference[1]} target={reference[2]} key={`${keyPrefix}-${index}`} />;
    return part;
  });
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

function MarkdownTable({ headers, rows }) {
  return (
    <div className="message-table-wrap">
      <table>
        <thead>
          <tr>{headers.map((cell, cellIndex) => <th key={`head-${cellIndex}`}>{inlineMarkdown(cell, `head-${cellIndex}`)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`}>
              {row.map((cell, cellIndex) => {
                const branded = cellIndex === 0 && modelBrand(cell);
                return (
                  <td key={`cell-${rowIndex}-${cellIndex}`}>
                    <span className={branded ? "model-cell" : "table-cell-text"}>
                      {branded && <ModelBrandIcon model={cell} />}
                      <span className="table-cell-text">{inlineMarkdown(cell, `cell-${rowIndex}-${cellIndex}`)}</span>
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function appendTrailing(blocks, trailing) {
  if (!trailing) return blocks;
  if (!blocks.length) return [<p key="trailing-only">{trailing}</p>];

  const next = [...blocks];
  const index = next.length - 1;
  const last = next[index];
  if (["p", "h1", "h2", "h3", "blockquote"].includes(last.type)) {
    next[index] = cloneElement(last, undefined, ...Children.toArray(last.props.children), trailing);
    return next;
  }
  if (last.type === "ul" || last.type === "ol") {
    const items = Children.toArray(last.props.children);
    const itemIndex = items.length - 1;
    if (itemIndex >= 0) {
      items[itemIndex] = cloneElement(items[itemIndex], undefined, ...Children.toArray(items[itemIndex].props.children), trailing);
      next[index] = cloneElement(last, undefined, ...items);
      return next;
    }
  }
  next.push(<span className="message-trailing" key="message-trailing">{trailing}</span>);
  return next;
}

export function MarkdownMessage({ text, trailing }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      const source = code.join("\n");
      blocks.push(<FencedMessageBlock source={source} language={language} key={`fence-${index}`} />);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const Heading = `h${level}`;
      blocks.push(<Heading key={`heading-${index}`}>{inlineMarkdown(heading[2], `heading-${index}`)}</Heading>);
      index += 1;
      continue;
    }

    if (/^\s*\|.+\|\s*$/.test(line) && /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[index + 1] ?? "")) {
      const headers = tableCells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && /^\s*\|.+\|\s*$/.test(lines[index])) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      blocks.push(<MarkdownTable headers={headers} rows={rows} key={`table-${index}`} />);
      continue;
    }

    const unordered = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      const listItems = [];
      const expression = unordered ? /^[-*]\s+(.+)$/ : /^\d+\.\s+(.+)$/;
      while (index < lines.length) {
        const item = lines[index].match(expression);
        if (!item) break;
        listItems.push(<li key={`item-${index}`}>{inlineMarkdown(item[1], `item-${index}`)}</li>);
        index += 1;
      }
      const List = unordered ? "ul" : "ol";
      blocks.push(<List key={`list-${index}`}>{listItems}</List>);
      continue;
    }

    if (line.startsWith(">")) {
      const quote = [];
      while (index < lines.length && lines[index].startsWith(">")) {
        quote.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(<blockquote key={`quote-${index}`}>{inlineMarkdown(quote.join(" "), `quote-${index}`)}</blockquote>);
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,3})\s|^```|^[-*]\s|^\d+\.\s|^>|^\s*\|.+\|\s*$/.test(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(<p key={`paragraph-${index}`}>{inlineMarkdown(paragraph.join(" "), `paragraph-${index}`)}</p>);
  }

  return <div className="markdown-body">{appendTrailing(blocks, trailing)}</div>;
}

function FencedMessageBlock({ source, language }) {
  const visualization = useMemo(() => parseVisualizationSpec(source, language), [language, source]);
  return visualization
    ? <InlineVisualization spec={visualization} />
    : <pre className="message-code"><code data-language={language || undefined}>{source}</code></pre>;
}

function responseDisplayKey(threadId, turnId, item, index = 0) {
  return `${threadId}:${turnId}:${item.renderId ?? item.id ?? `agent-${index}`}`;
}

function markResponsesSeen(thread, seenResponseIds) {
  (thread?.turns ?? []).forEach((turn) => {
    (turn.items ?? []).forEach((item, index) => {
      if (item.type === "agentMessage") {
        seenResponseIds.add(responseDisplayKey(thread.id, turn.renderId ?? turn.id, item, index));
      }
    });
  });
}

function samePlan(left, right) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((step, index) => {
    const candidate = right[index];
    return step.step === candidate?.step && step.status === candidate?.status;
  });
}

function sameThreadSummary(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.id === right.id
    && left.name === right.name
    && left.preview === right.preview
    && left.parentThreadId === right.parentThreadId
    && left.forkedFromId === right.forkedFromId
    && left.agentStatusMessage === right.agentStatusMessage
    && left.liveProjection === right.liveProjection
    && threadStatus(left) === threadStatus(right)
    && left.bridge?.kind === right.bridge?.kind
    && left.bridge?.parentThreadId === right.bridge?.parentThreadId
    && left.bridge?.model === right.bridge?.model
    && left.bridge?.effort === right.bridge?.effort;
}

function AssistantAnswerActions({ timestamp = null, showTimestamp = true, onFork = null }) {
  const [forking, setForking] = useState(false);
  if (!onFork && !showTimestamp) return null;
  return (
    <div className="assistant-answer-actions detached">
      {onFork && (
        <button
          type="button"
          className="fork-response-button"
          aria-label={forking ? "Forking this answer" : "Fork from this answer"}
          aria-busy={forking}
          title={forking ? "Forking this answer" : "Fork from this answer"}
          disabled={forking}
          onClick={async () => {
            setForking(true);
            try {
              await onFork();
            } finally {
              setForking(false);
            }
          }}
        >
          {forking ? <SpinnerGap className="spin-icon" size={12} /> : <GitBranch size={13} />}
        </button>
      )}
      {showTimestamp && <MessageTimestamp value={timestamp} />}
    </div>
  );
}

function AssistantResponse({ item, forceFinal, responseKey, seenResponseIds, sentToMain = false }) {
  const [animate] = useState(() => !seenResponseIds.has(responseKey));
  const systemReducedMotion = useReducedMotion();
  useEffect(() => {
    seenResponseIds.add(responseKey);
  }, [responseKey, seenResponseIds]);

  return (
    <div className="assistant-message-block">
      <article className={`message assistant-message ${forceFinal ? "final_answer" : item.phase ?? ""}`}>
        {animate ? (
          <motion.div
            initial={systemReducedMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: systemReducedMotion ? 0 : 0.24, ease: MOTION_EASE }}
          >
            <MarkdownMessage text={item.text} />
          </motion.div>
        ) : <MarkdownMessage text={item.text} />}
        {sentToMain && <div className="bridge-answer-status"><CheckCircle size={11} weight="fill" />Sent answer to main agent</div>}
      </article>
    </div>
  );
}

function ConversationItem({ item, forceFinal = false, responseKey, seenResponseIds, imagePrompt = null, imageResolution = null, promptAnchorId = null, openedByAgent = false, sentToMain = false, timestamp = null, showTimestamp = true, onImageRevision = null, imageRevisionDisabled = false }) {
  if (item.type === "userMessage") {
    const text = stripPreviewContext(item.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
    if (text.startsWith("[Pixice Focus work updates]\n\nThese are persisted worker lifecycle notifications, not new user instructions.")) {
      return <div className="focus-update-notice" role="status">Worker updates received</div>;
    }
    const images = item.content?.filter((part) => part.type === "image" && part.url) ?? [];
    if (!text && images.length === 0) return null;
    return (
      <div className={`user-message-block${openedByAgent ? " bridge-origin" : ""}`}>
        {openedByAgent && <div className="bridge-prompt-status"><GitBranch size={11} />Task opened by another Pixice agent</div>}
        {images.length > 0 && (
          <div
            className="user-message-attachments"
            aria-label={`${images.length} attached image${images.length === 1 ? "" : "s"}`}
            {...(!text ? { id: promptAnchorId ?? undefined, "data-prompt-id": item.id ?? undefined } : {})}
          >
            {images.map((image, index) => (
              <InspectablePicture
                source={image.url}
                alt={`Attached image ${index + 1}`}
                buttonClassName="user-message-picture"
                dataPromptId={!text ? item.id ?? undefined : undefined}
                key={`${image.url.slice(0, 48)}-${index}`}
              />
            ))}
          </div>
        )}
        {text && (
          <div className="message user-message" id={promptAnchorId ?? undefined} data-prompt-id={item.id ?? undefined}>
            <span>{text}</span>
          </div>
        )}
        {showTimestamp && <MessageTimestamp value={timestamp} align="end" />}
      </div>
    );
  }
  if (item.type === "agentMessage") {
    if (!item.text) return null;
    return <AssistantResponse item={item} forceFinal={forceFinal} responseKey={responseKey} seenResponseIds={seenResponseIds} sentToMain={sentToMain} />;
  }
  if (item.type === "imageGeneration") {
    return (
      <ImageGeneration
        prompt={imagePrompt}
        resolution={imageResolution}
        result={item.result}
        savedPath={item.savedPath}
        revisedPrompt={item.revisedPrompt}
        status={item.status}
        failure={item.failure}
        onRequestRevision={onImageRevision}
        revisionDisabled={imageRevisionDisabled}
      />
    );
  }
  if (item.type === "plan") return null;
  return <ActivityItem item={item} />;
}

const TRACE_ITEM_TYPES = new Set(["reasoning", "commandExecution", "fileChange", "contextCompaction", "collabAgentToolCall", "mcpToolCall", "dynamicToolCall"]);
const TOOL_CALL_TRACE_ITEM_TYPES = new Set(["commandExecution", "fileChange", "collabAgentToolCall", "mcpToolCall", "dynamicToolCall"]);

function turnIsRunning(status) {
  return status === "inProgress" || status === "running" || status === "active";
}

function promptAnchorId(turn, item, index) {
  const source = item.renderId ?? item.id ?? `${turn.renderId ?? turn.id ?? "turn"}-${index}`;
  return `prompt-${encodeURIComponent(String(source))}`;
}

function userMessageText(item) {
  return stripPreviewContext((item.content ?? [])
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n"));
}

function compactPreviewText(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " Code sample. ")
    .replace(/(?:^|\s)[#>*_`~-]+/g, " ")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const promptPreviewTurnCache = new WeakMap();
const conversationTurnProjectionCache = new WeakMap();

function promptPreviewTurnItems(turn) {
  let projected = promptPreviewTurnCache.get(turn);
  if (projected) return projected;
  const turnItems = turn.items ?? [];
  projected = turnItems.flatMap((item, index) => {
    if (item.type !== "userMessage") return [];
    const text = compactPreviewText(userMessageText(item));
    const imageCount = (item.content ?? []).filter((part) => part.type === "image").length;
    if (!text && imageCount === 0) return [];
    const response = [...turnItems.slice(index + 1)]
      .reverse()
      .find((candidate) => candidate.type === "agentMessage" && candidate.text);
    return [{
      id: item.renderId ?? item.id ?? `${turn.renderId ?? turn.id ?? "turn"}-${index}`,
      anchorId: promptAnchorId(turn, item, index),
      label: text || `${imageCount} attached image${imageCount === 1 ? "" : "s"}`,
      description: compactPreviewText(response?.text) || (turnIsRunning(turn.status) ? "Codex is working on this prompt." : "Open this prompt in the conversation."),
    }];
  });
  promptPreviewTurnCache.set(turn, projected);
  return projected;
}

export function promptPreviewItems(thread) {
  return (thread?.turns ?? []).flatMap(promptPreviewTurnItems);
}

function projectConversationTurn(turn) {
  let projected = conversationTurnProjectionCache.get(turn);
  if (projected) return projected;
  let latestPlanText = null;
  const touchedPaths = new Set();
  for (const item of turn.items ?? []) {
    if (item.type === "plan") latestPlanText = item.text ?? latestPlanText;
    if (item.type !== "fileChange") continue;
    const paths = normalizedFileChanges(item).map((change) => change.path || change.filePath).filter(Boolean);
    if (paths.length) paths.forEach((path) => touchedPaths.add(path));
    else if (item.path || item.filePath) touchedPaths.add(item.path || item.filePath);
  }
  projected = { itemCount: turn.items?.length ?? 0, latestPlanText, touchedPaths: [...touchedPaths] };
  conversationTurnProjectionCache.set(turn, projected);
  return projected;
}

function projectConversation(thread) {
  let itemCount = 0;
  let latestPlanText = null;
  const touchedPaths = new Set();
  for (const turn of thread?.turns ?? []) {
    const projected = projectConversationTurn(turn);
    itemCount += projected.itemCount;
    if (projected.latestPlanText) latestPlanText = projected.latestPlanText;
    projected.touchedPaths.forEach((path) => touchedPaths.add(path));
  }
  return { itemCount, latestPlanText, touchedFileCount: touchedPaths.size };
}

const PERMISSION_OPTIONS = [
  {
    value: "read-only",
    label: "Read only",
    description: "Inspect the project without changing files.",
    icon: LockKey
  },
  {
    value: "workspace-write",
    label: "Workspace access",
    description: "Read and edit this project; ask before broader access.",
    icon: ShieldCheck
  },
  {
    value: "auto-approve",
    label: "Auto-review",
    description: "Let a Codex subagent review and decide approval requests.",
    icon: AutoReviewIcon
  },
  {
    value: "full-access",
    label: "Full access",
    description: "Use the computer and network without approval prompts.",
    icon: Warning,
    danger: true
  }
];

const EFFORT_META = {
  none: { label: "None", description: "Answer directly without deliberate reasoning.", icon: Circle },
  minimal: { label: "Minimal", description: "Fast responses for straightforward work.", icon: Gauge },
  low: { label: "Low", description: "A quick pass with light reasoning.", icon: Gauge },
  medium: { label: "Medium", description: "Balanced speed and problem solving.", icon: Brain },
  high: { label: "High", description: "Deeper reasoning for complex tasks.", icon: Sparkle },
  xhigh: { label: "Extra high", description: "Maximum depth for the hardest problems.", icon: Sparkle }
};

function PickerGlyph({ option, kind }) {
  if (kind === "model") {
    const branded = modelBrand(option.value, option.provider);
    return (
      <span className="picker-glyph model-picker-glyph">
        {branded ? <ModelBrandIcon model={option.value} provider={option.provider} /> : <Sparkle size={14} weight="fill" />}
      </span>
    );
  }
  const Glyph = option.icon ?? Sparkle;
  return <span className={`picker-glyph${option.danger ? " danger" : ""}`}><Glyph size={15} weight="regular" /></span>;
}

export function ComposerPicker({ label, hint, value, options, onChange, kind, align = "right", disabled = false, providers = [], onProviderLogin, onProvidersRefresh, className = "", triggerLabel = null, triggerAriaLabel = null, footer = null }) {
  const [open, setOpen] = useState(false);
  const systemReducedMotion = useReducedMotion();
  const [activeProvider, setActiveProvider] = useState("codex");
  const [pendingProvider, setPendingProvider] = useState(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const rootRef = useRef(null);
  const popoverRef = useRef(null);
  const optionRefs = useRef([]);
  const listboxId = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex] ?? options[0];
  const providerOptions = kind === "model"
    ? [
        { value: "codex", label: "Codex" },
        { value: "claude", label: "Claude" }
      ]
    : [];
  const visibleOptions = providerOptions.length
    ? options.filter((option) => option.provider === activeProvider)
    : options;
  const activeProviderState = providers.find((provider) => provider.id === activeProvider);
  const authenticationRequired = Boolean(activeProviderState?.requiresAuth && !providerIsAuthenticated(activeProviderState));
  const providerUnavailable = activeProviderState?.status?.state === "unavailable" || activeProviderState?.connected === false;
  const visibleSelectedIndex = Math.max(0, visibleOptions.findIndex((option) => option.value === value));
  const triggerText = triggerLabel ?? selected?.label ?? "Choose model";
  const accessibleTriggerLabel = triggerAriaLabel ?? `${label}: ${selected?.label ?? "Choose model"}`;

  useEffect(() => {
    if (pendingProvider && providerIsAuthenticated(providers.find((provider) => provider.id === pendingProvider))) {
      setPendingProvider(null);
    }
  }, [pendingProvider, providers]);

  useEffect(() => {
    if (!pendingProvider || !onProvidersRefresh) return undefined;
    const refreshOnFocus = () => onProvidersRefresh();
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [onProvidersRefresh, pendingProvider]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        rootRef.current?.querySelector(".picker-trigger")?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.setTimeout(() => optionRefs.current[visibleSelectedIndex]?.focus(), 0);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [activeProvider, open, visibleSelectedIndex]);

  useLayoutEffect(() => {
    if (!open || !popoverRef.current) return undefined;
    const boundary = rootRef.current?.closest(".composer") ?? document.documentElement;
    const reposition = () => {
      const popover = popoverRef.current;
      if (!popover) return;
      popover.style.removeProperty("--picker-shift-x");
      const boundaryRect = boundary.getBoundingClientRect();
      popover.style.setProperty("--picker-max-width", `${Math.floor(boundaryRect.width)}px`);
      const shift = horizontalPopoverShift(popover.getBoundingClientRect(), boundaryRect, 0);
      popover.style.setProperty("--picker-shift-x", `${Math.round(shift)}px`);
    };
    reposition();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(reposition) : null;
    observer?.observe(boundary);
    window.addEventListener("resize", reposition);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

  const choose = (next) => {
    onChange(next.value);
    setOpen(false);
    window.setTimeout(() => rootRef.current?.querySelector(".picker-trigger")?.focus(), 0);
  };

  const startProviderLogin = async () => {
    if (!onProviderLogin || loginBusy) return;
    if (pendingProvider === activeProvider) {
      await onProvidersRefresh?.();
      return;
    }
    setLoginBusy(true);
    try {
      const opened = await onProviderLogin(activeProvider);
      if (opened !== false) setPendingProvider(activeProvider);
    } finally {
      setLoginBusy(false);
    }
  };

  const moveFocus = (event) => {
    if (!visibleOptions.length) return;
    const currentIndex = optionRefs.current.indexOf(document.activeElement);
    let nextIndex = currentIndex;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1 + visibleOptions.length) % visibleOptions.length;
    else if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + visibleOptions.length) % visibleOptions.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = visibleOptions.length - 1;
    else return;
    event.preventDefault();
    optionRefs.current[nextIndex]?.focus();
  };

  return (
    <div className={`composer-picker ${kind}${className ? ` ${className}` : ""}`} data-open={open} ref={rootRef}>
      <button
        type="button"
        className="picker-trigger"
        aria-label={accessibleTriggerLabel}
        title={accessibleTriggerLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled || (!selected && kind !== "model")}
        onClick={() => setOpen((current) => {
          const next = !current;
          if (next && selected?.provider) setActiveProvider(selected.provider);
          return next;
        })}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (selected?.provider) setActiveProvider(selected.provider);
            setOpen(true);
          }
        }}
      >
        {selected && <PickerGlyph option={selected} kind={kind} />}
        <span className="picker-trigger-label">{triggerText}</span>
        <CaretDown className="picker-chevron" size={12} weight="bold" />
      </button>
      {open && (
        <div className="picker-popover" data-align={align} ref={popoverRef}>
          <div className="picker-head">
            <span>{label}</span>
            <small>{hint}</small>
          </div>
          {providerOptions.length > 0 && (
            <div className="model-provider-tabs" role="tablist" aria-label="Model provider">
              {providerOptions.map((provider) => {
                const available = options.some((option) => option.provider === provider.value)
                  || providers.some((candidate) => candidate.id === provider.value);
                return (
                  <button
                    type="button"
                    role="tab"
                    aria-label={provider.label}
                    aria-selected={activeProvider === provider.value}
                    className={activeProvider === provider.value ? "active" : ""}
                    disabled={!available}
                    onClick={() => {
                      setActiveProvider(provider.value);
                      window.setTimeout(() => optionRefs.current[0]?.focus(), 0);
                    }}
                    key={provider.value}
                  >
                    {activeProvider === provider.value && (
                      <motion.span
                        className="model-provider-tab-pill"
                        layoutId={`model-provider-${listboxId}`}
                        transition={{ duration: systemReducedMotion ? 0 : 0.2, ease: MOTION_EASE }}
                      />
                    )}
                    <ModelBrandIcon model={provider.value === "codex" ? "gpt" : "claude"} provider={provider.value} />
                    <span>{provider.label}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="picker-options" id={listboxId} role={authenticationRequired ? undefined : "listbox"} aria-label={label} onKeyDown={moveFocus}>
            {authenticationRequired ? (
              <div className="model-auth-required" role="status">
                <ModelBrandIcon model={activeProvider === "claude" ? "claude" : "gpt"} provider={activeProvider} />
                <span>
                  <strong>{activeProvider === "claude" ? "Claude isn't authenticated" : "Codex isn't authenticated"}</strong>
                  <small>{providerUnavailable ? "The provider runtime is unavailable." : `Sign in to use ${activeProvider === "claude" ? "Anthropic" : "OpenAI"} models.`}</small>
                </span>
                {!providerUnavailable && activeProviderState?.loginAvailable && (
                  <button type="button" disabled={loginBusy} onClick={startProviderLogin}>
                    {loginBusy ? "Opening..." : pendingProvider === activeProvider ? "Check sign-in" : `Sign in to ${activeProvider === "claude" ? "Anthropic" : "OpenAI"}`}
                  </button>
                )}
              </div>
            ) : visibleOptions.map((option, index) => (
              <button
                type="button"
                className={`picker-option${option.value === value ? " selected" : ""}${option.danger ? " danger" : ""}`}
                role="option"
                aria-selected={option.value === value}
                ref={(node) => { optionRefs.current[index] = node; }}
                onClick={() => choose(option)}
                key={option.value}
              >
                <PickerGlyph option={option} kind={kind} />
                <span className="picker-option-copy">
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                <span className="picker-check" aria-hidden="true"><Check size={12} weight="bold" /></span>
              </button>
            ))}
          </div>
          {footer}
        </div>
      )}
    </div>
  );
}

export function WorkingTrace({ items, running, settled, startedAt = null, completedAt = null, defaultDisclosure = "auto", hideToolCalls = false }) {
  const disclosureId = useId();
  const [manualExpanded, setManualExpanded] = useState(null);
  const wasSettled = useRef(settled);
  const systemReducedMotion = useReducedMotion();
  const now = useLiveNow(running);
  const visibleItems = hideToolCalls ? items.filter((item) => !TOOL_CALL_TRACE_ITEM_TYPES.has(item.type)) : items;
  const toolCount = visibleItems.filter((item) => item.type !== "agentMessage" && item.type !== "reasoning").length;
  const reasoningItems = visibleItems.filter((item) => item.type === "reasoning" || (item.type === "agentMessage" && item.text));
  const latestTraceIndex = visibleItems.findLastIndex((item) => item.type === "agentMessage" ? Boolean(item.text) : TRACE_ITEM_TYPES.has(item.type));
  const latestTraceItem = latestTraceIndex === -1 ? null : visibleItems[latestTraceIndex];
  const latestAction = latestTraceItem && latestTraceItem.type !== "agentMessage" && latestTraceItem.type !== "reasoning"
    ? latestTraceItem
    : null;
  const latestActivity = (() => {
    if (!latestAction) return { label: "Thinking", detail: latestTraceItem ? "" : "Getting started" };
    if (latestAction.type === "commandExecution") {
      const command = Array.isArray(latestAction.command) ? latestAction.command.join(" ") : latestAction.command;
      return { label: latestAction.status === "completed" ? "Ran command" : "Running command", detail: command };
    }
    if (latestAction.type === "fileChange") {
      const count = normalizedFileChanges(latestAction).length;
      return { label: latestAction.status === "completed" ? "Updated files" : "Updating files", detail: `${count} file${count === 1 ? "" : "s"}` };
    }
    if (latestAction.type === "contextCompaction") {
      if (latestAction.status === "failed" || latestAction.failure) return { label: "Compaction failed", detail: latestAction.failure?.message ?? "Conversation summary failed" };
      if (latestAction.status === "completed" || latestAction.completedAt) return { label: "Compacted context", detail: "Conversation summary ready" };
      return { label: "Compacting…", detail: "Compacting context" };
    }
    if (latestAction.type === "collabAgentToolCall") {
      const count = latestAction.receiverThreadIds?.length ?? 0;
      return { label: latestAction.status === "completed" ? "Delegated work" : "Delegating work", detail: `${count} agent${count === 1 ? "" : "s"}` };
    }
    if (latestAction.type === "mcpToolCall" || latestAction.type === "dynamicToolCall") {
      return { label: latestAction.status === "completed" ? "Used tool" : "Using tool", detail: latestAction.tool };
    }
    return { label: "Working", detail: "" };
  })();
  const start = timestampMillis(startedAt);
  const end = timestampMillis(completedAt) || now;
  const elapsed = start ? formatElapsedDuration(Math.max(0, end - start)) : "";
  const doneLabel = elapsed
    ? `${toolCount ? "Worked" : "Thought"} for ${elapsed}`
    : toolCount
      ? `Ran ${toolCount} action${toolCount === 1 ? "" : "s"}`
      : "Thought through the task";
  const label = settled ? doneLabel : "Work details";
  const automaticExpanded = defaultDisclosure === "expanded" || (defaultDisclosure === "auto" && !settled);
  const expanded = manualExpanded ?? automaticExpanded;

  useEffect(() => {
    if (!wasSettled.current && settled) setManualExpanded(null);
    wasSettled.current = settled;
  }, [settled]);

  return (
    <section className="working-trace" data-expanded={expanded} data-working={running}>
      {running ? (
        <>
          {reasoningItems.length > 0 && (
            <div className="trace-reasoning-list">
              {reasoningItems.map((item, index) => item.type === "agentMessage" ? (
                <div className="trace-commentary" key={item.renderId ?? item.id ?? `commentary-${index}`}><MarkdownMessage text={item.text} /></div>
              ) : (
                <ActivityItem item={item} key={item.renderId ?? item.id ?? `reasoning-${index}`} />
              ))}
            </div>
          )}
          <div className="trace-toggle trace-live-toggle" role="status" aria-live="polite" aria-label={`${latestActivity.label}${latestActivity.detail ? `: ${latestActivity.detail}` : ""}`}>
            <ReasoningOrb className="trace-status-orb" label={latestActivity.label} decorative />
            <span className="trace-live-viewport">
              <span className="trace-live-item">
                <ThinkingState><MorphText value={latestActivity.label} duration={360} /></ThinkingState>
                {latestActivity.detail && <span>{latestActivity.detail}</span>}
              </span>
            </span>
            {elapsed && <span className="elapsed-time">Working for {elapsed}</span>}
          </div>
        </>
      ) : (
        <>
          <button
            type="button"
            className="trace-toggle"
            aria-expanded={expanded}
            aria-controls={disclosureId}
            onClick={() => setManualExpanded((current) => !(current ?? automaticExpanded))}
          >
            <Sparkle className="trace-status-icon" size={15} weight="regular" />
            <span className="trace-toggle-label">{label}</span>
            <CaretRight className="trace-caret" size={13} />
          </button>
          <div id={disclosureId} className="trace-disclosure" aria-hidden={!expanded} inert={!expanded}>
            <div className="trace-disclosure-inner">
              <div className="trace-list">
                {visibleItems.map((item, index) => item.type === "agentMessage" ? (
                  item.text ? <div className="trace-commentary" key={item.renderId ?? item.id ?? `commentary-${index}`}><MarkdownMessage text={item.text} /></div> : null
                ) : (
                  <ActivityItem item={item} key={item.renderId ?? item.id ?? `${item.type}-${index}`} />
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

const TurnConversation = memo(function TurnConversation({ thread, turn, turnIndex, seenResponseIds, showTimestamps = true, completedWorkDetails = "auto", hideToolCalls = false, onImageRevision = null, imageRevisionDisabled = false, onFork = null, receipt = null, onReceiptCompare = null }) {
  const items = turn.items ?? [];
  const threadId = thread.id;
  const running = turnIsRunning(turn.status);
  const bridgeTurn = turnIndex === 0 && (thread.bridge?.kind === "pixiceBridge" || thread.bridgeModel);
  const firstUserIndex = items.findIndex((item) => item.type === "userMessage");
  const explicitFinalIndex = items.findLastIndex((item) => item.type === "agentMessage" && item.phase === "final_answer");
  const fallbackFinalIndex = explicitFinalIndex === -1 && turn.status === "completed"
    ? items.findLastIndex((item) => item.type === "agentMessage" && item.text)
    : -1;
  const finalIndex = explicitFinalIndex === -1 ? fallbackFinalIndex : explicitFinalIndex;
  const finalItem = finalIndex === -1 ? null : items[finalIndex];
  const settled = !running && finalIndex !== -1;
  const startedAt = turn.startedAt ?? turn.createdAt;
  const completedAt = turn.completedAt;
  const rendered = [];
  const workingTraceIndexes = [];
  let traceItems = [];
  let renderedWorkingTrace = false;

  const flushTrace = () => {
    if (!traceItems.length) return;
    const key = traceItems[0].renderId ?? traceItems[0].id ?? `trace-${rendered.length}`;
    workingTraceIndexes.push(rendered.length);
    rendered.push(<WorkingTrace items={traceItems} running={false} settled={settled} startedAt={startedAt} completedAt={completedAt} defaultDisclosure={completedWorkDetails} hideToolCalls={hideToolCalls} key={key} />);
    renderedWorkingTrace = true;
    traceItems = [];
  };

  items.forEach((item, index) => {
    if (item.type === "plan") return;
    if (hideToolCalls && TOOL_CALL_TRACE_ITEM_TYPES.has(item.type)) return;
    const isFinal = index === finalIndex;
    const isTrace = !isFinal && (item.type === "agentMessage" || TRACE_ITEM_TYPES.has(item.type));
    if (isTrace) {
      traceItems.push(item);
      return;
    }
    flushTrace();
    const timestamp = item.type === "userMessage"
      ? item.createdAt ?? startedAt
      : isFinal
        ? item.createdAt ?? item.completedAt ?? completedAt
        : item.createdAt;
    rendered.push(
      <ConversationItem
        item={item}
        forceFinal={isFinal}
        responseKey={responseDisplayKey(threadId, turn.renderId ?? turn.id, item, index)}
        seenResponseIds={seenResponseIds}
        imagePrompt={item.type === "imageGeneration" ? imageGenerationPrompt(items, index, item) : null}
        imageResolution={item.type === "imageGeneration" ? imageGenerationResolution(items, index, item) : null}
        promptAnchorId={item.type === "userMessage" ? promptAnchorId(turn, item, index) : null}
        openedByAgent={bridgeTurn && index === firstUserIndex}
        sentToMain={bridgeTurn && isFinal && turn.status === "completed"}
        timestamp={timestamp}
        showTimestamp={showTimestamps}
        onImageRevision={onImageRevision}
        imageRevisionDisabled={imageRevisionDisabled}
        key={item.renderId ?? item.id ?? `${item.type}-${index}`}
      />
    );
  });
  flushTrace();
  if (turn.status === "completed" && finalItem) {
    const timestamp = finalItem.createdAt ?? finalItem.completedAt ?? completedAt;
    const answerActions = <AssistantAnswerActions
      timestamp={timestamp}
      showTimestamp={showTimestamps}
      onFork={finalItem.id && onFork ? () => onFork({ threadId, turnId: turn.id, itemId: finalItem.id }) : null}
    />;
    rendered.push(receipt ? <TaskReceipt
      receipt={receipt} onCompare={onReceiptCompare}
      renderDiff={renderCapturedChanges} leadingAction={answerActions}
      key={`answer-actions-${finalItem.renderId ?? finalItem.id ?? turn.id}`}
    /> : cloneElement(answerActions, { key: `answer-actions-${finalItem.renderId ?? finalItem.id ?? turn.id}` }));
  } else if (receipt) {
    rendered.push(<TaskReceipt receipt={receipt} onCompare={onReceiptCompare} renderDiff={renderCapturedChanges} key="task-result" />);
  }
  if (running && workingTraceIndexes.length) {
    const activeTraceIndex = workingTraceIndexes.at(-1);
    rendered[activeTraceIndex] = cloneElement(rendered[activeTraceIndex], { running: true });
  }
  if (running && !renderedWorkingTrace && finalIndex === -1) {
    rendered.push(<WorkingTrace items={[]} running settled={false} startedAt={startedAt} defaultDisclosure={completedWorkDetails} hideToolCalls={hideToolCalls} key={`pending-${turn.renderId ?? turn.id}`} />);
  }

  return <div className="conversation-turn" data-turn-id={turn.id}>{rendered}</div>;
}, (previous, next) => previous.turn === next.turn
  && previous.turnIndex === next.turnIndex
  && previous.thread?.id === next.thread?.id
  && previous.thread?.bridge === next.thread?.bridge
  && previous.thread?.bridgeModel === next.thread?.bridgeModel
  && previous.showTimestamps === next.showTimestamps
  && previous.completedWorkDetails === next.completedWorkDetails
  && previous.hideToolCalls === next.hideToolCalls
  && previous.onImageRevision === next.onImageRevision
  && previous.imageRevisionDisabled === next.imageRevisionDisabled
  && previous.onFork === next.onFork
  && previous.receipt === next.receipt
  && previous.onReceiptCompare === next.onReceiptCompare
  && previous.seenResponseIds === next.seenResponseIds);

function isApprovalRequest(request) {
  return request?.method?.includes("requestApproval") || ["applyPatchApproval", "execCommandApproval"].includes(request?.method);
}

function isQuestionRequest(request) {
  return request?.method?.includes("requestUserInput") && Array.isArray(request.params?.questions) && request.params.questions.length > 0;
}

function normalizedRequestGeneration(request) {
  const value = request?.requestGeneration;
  if (value === undefined || value === null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}

function requestGenerationPayload(request) {
  return request?.requestGeneration === undefined || request?.requestGeneration === null
    ? {}
    : { requestGeneration: request.requestGeneration };
}

function sameAttentionRequest(request, other) {
  return String(request?.id) === String(other?.id)
    && normalizedRequestGeneration(request) === normalizedRequestGeneration(other);
}

function mergeAttentionRequests(current, incoming) {
  const next = [...current];
  for (const request of incoming ?? []) {
    if (request?.id === undefined || request?.id === null) continue;
    const index = next.findIndex((candidate) => String(candidate?.id) === String(request.id));
    if (index === -1) {
      next.push(request);
      continue;
    }
    const existingGeneration = normalizedRequestGeneration(next[index]);
    const incomingGeneration = normalizedRequestGeneration(request);
    if (typeof existingGeneration === "number" && typeof incomingGeneration === "number" && incomingGeneration < existingGeneration) continue;
    next[index] = request;
  }
  return next;
}

function attentionResolvedRequest(request, payload) {
  if (String(request?.id) !== String(payload?.requestId)) return false;
  const resolvedGeneration = normalizedRequestGeneration(payload);
  return resolvedGeneration === null || resolvedGeneration === normalizedRequestGeneration(request);
}

function questionRequestKey(request) {
  return `${request?.id}:${normalizedRequestGeneration(request) ?? "legacy"}`;
}

function optionIsRecommended(option) {
  return option?.recommended === true || /\(recommended\)\s*$/i.test(option?.label ?? "");
}

function optionDisplayLabel(option) {
  return String(option?.label ?? "").replace(/\s*\(recommended\)\s*$/i, "").trim();
}

function ComposerQuestion({ request, onResolve }) {
  const questions = request.params.questions;
  const asynchronous = request.params.isBlocking === false;
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({});
  const [phase, setPhase] = useState("idle");
  const [customOpen, setCustomOpen] = useState(false);
  const [customAnswer, setCustomAnswer] = useState("");
  const timersRef = useRef([]);
  const customInputRef = useRef(null);
  const question = questions[Math.min(step, questions.length - 1)];
  const questionId = question.id ?? `question-${step + 1}`;
  const showCustomInput = customOpen || !question.options?.length;
  const moveToQuestion = (index) => {
    const nextQuestion = questions[index];
    const saved = answers[nextQuestion.id ?? `question-${index + 1}`] ?? "";
    const custom = Boolean(saved && !nextQuestion.options?.some((option) => option.label === saved));
    setStep(index);
    setCustomOpen(custom);
    setCustomAnswer(custom ? saved : "");
  };

  useEffect(() => {
    setStep(0);
    setAnswers({});
    setPhase("idle");
    setCustomOpen(false);
    setCustomAnswer("");
    return () => timersRef.current.splice(0).forEach(window.clearTimeout);
  }, [request.id, request.requestGeneration]);

  useEffect(() => {
    if (customOpen) customInputRef.current?.focus();
  }, [customOpen]);

  const after = (callback, delay) => {
    const timer = window.setTimeout(callback, delay);
    timersRef.current.push(timer);
  };

  const complete = (action, nextAnswers = answers) => {
    if (phase === "leaving") return;
    setPhase("leaving");
    after(async () => {
      const accepted = await onResolve(request, { action, answers: action === "cancel" ? {} : nextAnswers });
      if (accepted === false) setPhase("idle");
    }, 150);
  };

  const choose = (answer) => {
    if (phase === "leaving" || !String(answer).trim()) return;
    const nextAnswers = { ...answers, [questionId]: String(answer).trim() };
    setAnswers(nextAnswers);
    if (asynchronous) return;
    setPhase("leaving");
    after(() => {
      if (step === questions.length - 1) {
        void onResolve(request, { action: "answer", answers: nextAnswers }).then((accepted) => {
          if (accepted === false) setPhase("idle");
        });
        return;
      }
      setStep((current) => current + 1);
      setCustomOpen(false);
      setCustomAnswer("");
      setPhase("entering");
      after(() => setPhase("idle"), 20);
    }, 150);
  };

  return (
    <section className="composer-question" data-asynchronous={asynchronous} aria-live="polite">
      {asynchronous && <div className="question-async-status">Answer when ready · work continues</div>}
      <div className="question-step" data-phase={phase} key={questionId}>
        <header className="question-header">
          <div>
            <span>{question.header ?? `Question ${step + 1}`}</span>
            <h2>{question.question ?? `Question ${step + 1}`}</h2>
          </div>
          <button type="button" className="question-close" aria-label="Skip questions" onClick={() => complete("cancel")}><X size={18} /></button>
        </header>

        <div className="question-options" role="radiogroup" aria-label={question.question}>
          {(question.options ?? []).map((option, index) => {
            const recommended = optionIsRecommended(option);
            return (
              <button
                type="button"
                className="question-option"
                data-recommended={recommended}
                role="radio"
                aria-checked={answers[questionId] === option.label}
                onClick={() => { setCustomOpen(false); choose(option.label); }}
                key={`${option.label}-${index}`}
              >
                <span className="question-option-number">{index + 1}</span>
                <span className="question-option-copy">
                  <strong>{optionDisplayLabel(option)}{recommended && <em>Recommended</em>}</strong>
                  {option.description && <small>{option.description}</small>}
                </span>
                <CaretRight className="question-option-arrow" size={20} />
              </button>
            );
          })}
        </div>

        <div className="question-footer">
          {showCustomInput ? (
            <form className="question-custom-form" onSubmit={(event) => { event.preventDefault(); choose(customAnswer); }}>
              <PencilSimple size={16} />
              <input ref={customInputRef} type={question.isSecret ? "password" : "text"} aria-label="Custom answer" value={customAnswer} onChange={(event) => { setCustomAnswer(event.target.value); if (asynchronous) setAnswers((current) => ({ ...current, [questionId]: event.target.value })); }} placeholder="Type a different answer" />
              <button type="submit" disabled={!customAnswer.trim()} aria-label="Use custom answer"><CaretRight size={18} /></button>
            </form>
          ) : (
            <button type="button" className="question-custom" onClick={() => { setCustomOpen(true); if (asynchronous) setAnswers((current) => ({ ...current, [questionId]: customAnswer })); }}><PencilSimple size={17} /><span>Type a different answer</span></button>
          )}
          <div className="question-progress" aria-label={`Question ${step + 1} of ${questions.length}`}>
            {questions.map((candidate, index) => <i className={index === step ? "active" : index < step ? "complete" : ""} key={candidate.id ?? index} />)}
          </div>
          {asynchronous && <>
            {step > 0 && <button type="button" className="question-skip" onClick={() => moveToQuestion(step - 1)}>Back</button>}
            <button type="button" className="question-submit" disabled={phase === "leaving" || !answers[questionId]?.trim()} onClick={() => {
              if (step === questions.length - 1) complete("answer", answers);
              else moveToQuestion(step + 1);
            }}>{step === questions.length - 1 ? "Submit answer" : "Next"}</button>
          </>}
          <button type="button" className="question-skip" onClick={() => complete("cancel")}>Skip</button>
        </div>
      </div>
    </section>
  );
}

export function Composer({ disabled, busy, draftKey, draftReloadToken = 0, preserveDrafts, sendShortcut, spellCheckComposer, autoFocusComposer, showSlashCommands, slashCommands, showPermissionPicker = true, running, questionRequest, onQuestionResolve, models, selectedModel, onModelChange, effort, onEffortChange, fastMode, onFastModeChange, permissionMode, onPermissionModeChange, providers, onProviderLogin, onProvidersRefresh, onSubmit, onInterrupt, onDraftStateChange, ariaLabel = "Task prompt", placeholder = "Describe the task you want to work on", runningPlaceholder = "Steer the active task", globalFileDrop = true, storage = localStorage, attachmentContext = null, attachmentScopeKey = null, transcription = null, micDeviceId = null, dictationApi = null, accentColor = "coral" }) {
  const blockingQuestion = questionRequest && questionRequest.params?.isBlocking !== false;
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [attachmentNotice, setAttachmentNotice] = useState("");
  const [commandSelection, setCommandSelection] = useState(0);
  const [commandsDismissed, setCommandsDismissed] = useState(false);
  const [caretPosition, setCaretPosition] = useState(0);
  const [draftHydratedKey, setDraftHydratedKey] = useState(null);
  const [uploadState, setUploadState] = useState(null);
  const [submissionBusy, setSubmissionBusy] = useState(false);
  const [dictationPhase, setDictationPhase] = useState("idle");
  const [showDictationBeam, setShowDictationBeam] = useState(false);
  const storageKey = `pixice.draft.${draftKey}`;
  const attachmentStorageKey = `${storageKey}.attachments`;
  const currentAttachmentScope = useMemo(() => attachmentContext?.scope ?? createAttachmentScope(attachmentContext ?? {}), [
    attachmentContext?.api,
    attachmentContext?.deviceId,
    attachmentContext?.hostId,
    attachmentContext?.projectId,
    attachmentContext?.scope?.deviceId,
    attachmentContext?.scope?.hostId,
    attachmentContext?.scope?.projectId
  ]);
  const currentAttachmentScopeKey = attachmentScopeKey ?? attachmentContext?.scopeKey ?? transferScopeKey(currentAttachmentScope);
  const commandListId = useId();
  const composerRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const reselectInputRefs = useRef(new Map());
  const uploadAbortRef = useRef(null);
  const uploadStateRef = useRef(null);
  const submissionRef = useRef(null);
  const draftInteractionRef = useRef(false);
  const hydratedDraftIdentityRef = useRef(null);
  const attachmentScopeRef = useRef(currentAttachmentScopeKey);
  const attachmentsRef = useRef(attachments);
  const textRef = useRef(text);
  const mountedRef = useRef(true);
  const uploadAttemptRef = useRef(null);
  const reselectAttemptsRef = useRef(new Map());
  const storageKeyRef = useRef(storageKey);
  const attachmentScopeKeyRef = useRef(currentAttachmentScopeKey);
  const dictationLevelRef = useRef(0);
  const dictationBeamTimerRef = useRef(null);
  const voiceGlowPalette = VOICE_GLOW_ACCENT_PALETTES[accentColor] ?? VOICE_GLOW_ACCENT_PALETTES.coral;
  attachmentsRef.current = attachments;
  textRef.current = text;
  storageKeyRef.current = storageKey;
  attachmentScopeKeyRef.current = currentAttachmentScopeKey;
  const selected = models.find((model) => model.model === selectedModel);
  const fastTier = fastServiceTier(selected);
  const efforts = selected?.supportedReasoningEfforts ?? [];
  const modelOptions = models.map((model) => ({
    value: model.model,
    label: model.displayName ?? model.model,
    description: model.isDefault ? `${model.model} · Default` : model.description ?? model.model,
    provider: model.provider ?? (modelBrand(model.model)?.id === "anthropic" ? "claude" : "codex")
  }));
  const effortOptions = (efforts.length ? efforts : [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }]).map((option) => {
    const value = option.reasoningEffort ?? option.effort ?? option;
    return { value, ...(EFFORT_META[value] ?? { label: String(value).replace(/^./, (letter) => letter.toUpperCase()), description: "Adjust how deeply Codex reasons.", icon: Brain }) };
  });
  const selectedEffort = effortOptions.find((option) => option.value === effort) ?? effortOptions[0];
  const fullModelLabel = selected?.displayName ?? selected?.model ?? "Choose model";
  const compactModelLabel = (() => {
    const compact = fullModelLabel
      .replace(/^GPT(?:[- ]?\d+(?:\.\d+)?)(?:[- ]+)?/i, "")
      .replace(/^Claude\s+/i, "")
      .trim();
    return compact || fullModelLabel;
  })();
  const runProfileLabel = selected ? `${compactModelLabel} · ${selectedEffort?.label ?? effort}` : "Choose model";
  const runProfileAriaLabel = selected
    ? `Run profile: ${fullModelLabel}, ${selectedEffort?.label ?? effort} reasoning${fastTier ? `, Fast ${fastMode ? "on" : "off"}` : ""}`
    : "Run profile: Choose model";
  const hasSteeringDraft = Boolean(text.trim() || attachments.length > 0);
  const runActionState = running && !hasSteeringDraft ? "stop" : "send";
  const runActionLabel = runActionState === "stop" ? "Stop task" : running ? "Steer task" : "Send message";
  const runActionDisabled = runActionState === "stop"
    ? disabled
    : disabled || busy || submissionBusy || uploadState?.activeCount > 0 || uploadState?.state === "preparing" || attachments.some((attachment) => attachment.needsReselect) || !selected || !hasSteeringDraft;
  useEffect(() => {
    const identityChanged = hydratedDraftIdentityRef.current !== storageKey;
    if (identityChanged) reselectAttemptsRef.current.clear();
    if (identityChanged && (submissionRef.current || uploadAbortRef.current)) {
      if (submissionRef.current?.adoptedStorageKeys?.has(storageKey)) {
        hydratedDraftIdentityRef.current = storageKey;
        setDraftHydratedKey(storageKey);
        return;
      }
      if (uploadAttemptRef.current) uploadAttemptRef.current.cancelled = true;
      uploadAttemptRef.current = null;
      uploadAbortRef.current?.abort(new DOMException("The draft changed.", "AbortError"));
      submissionRef.current?.controller.abort(new DOMException("The draft changed.", "AbortError"));
      uploadStateRef.current = null;
      setUploadState(null);
      hydratedDraftIdentityRef.current = storageKey;
      setDraftHydratedKey(storageKey);
      return;
    }
    if (!identityChanged && draftReloadToken > 0 && draftInteractionRef.current) return;
    const restoredText = preserveDrafts ? storage.getItem(storageKey) ?? "" : "";
    setText(restoredText);
    setCaretPosition(restoredText.length);
    let restored = [];
    if (preserveDrafts) {
      try {
        const value = JSON.parse(storage.getItem(attachmentStorageKey) || "[]");
        restored = restoreAttachmentMetadata(value, currentAttachmentScope);
      } catch { /* A damaged attachment draft is disposable; text remains recoverable. */ }
    }
    setAttachments(restored);
    setAttachmentNotice("");
    setCommandsDismissed(false);
    setCommandSelection(0);
    setDraftHydratedKey(storageKey);
    hydratedDraftIdentityRef.current = storageKey;
    draftInteractionRef.current = false;
    if (!preserveDrafts) {
      storage.removeItem(storageKey);
      storage.removeItem(attachmentStorageKey);
    }
  }, [draftReloadToken, preserveDrafts, storage, storageKey]);

  useEffect(() => {
    const previous = attachmentScopeRef.current;
    if (previous && previous !== currentAttachmentScopeKey) {
      reselectAttemptsRef.current.clear();
      if (uploadAttemptRef.current) uploadAttemptRef.current.cancelled = true;
      uploadAttemptRef.current = null;
      uploadAbortRef.current?.abort(new DOMException("The upload target changed.", "AbortError"));
      if (submissionRef.current) {
        submissionRef.current.cancelled = true;
        submissionRef.current.controller.abort(new DOMException("The upload target changed.", "AbortError"));
      }
      uploadStateRef.current = null;
      setUploadState(null);
      setAttachments((current) => current.map((attachment) => ({
        ...attachment,
        transferId: null,
        transferState: null,
        uploadOffset: 0,
        scope: currentAttachmentScope,
        scopeKey: currentAttachmentScopeKey,
        needsReselect: !attachment.file
      })));
      setAttachmentNotice("The target changed. Selected files remain here and will upload to the new target.");
    }
    attachmentScopeRef.current = currentAttachmentScopeKey;
  }, [currentAttachmentScope, currentAttachmentScopeKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (uploadAttemptRef.current) uploadAttemptRef.current.cancelled = true;
      uploadAttemptRef.current = null;
      reselectAttemptsRef.current.clear();
      uploadAbortRef.current?.abort(new DOMException("The composer closed.", "AbortError"));
      if (submissionRef.current) {
        submissionRef.current.cancelled = true;
        submissionRef.current.controller.abort(new DOMException("The composer closed.", "AbortError"));
      }
      attachmentsRef.current.forEach(disposeComposerAttachment);
    };
  }, []);

  useEffect(() => {
    if (!preserveDrafts || draftHydratedKey !== storageKey) return;
    try {
      if (attachments.length) storage.setItem(attachmentStorageKey, JSON.stringify(serializeAttachmentMetadata(attachments, currentAttachmentScope)));
      else if (!busy) storage.removeItem(attachmentStorageKey);
    } catch { /* Large or unavailable storage must not prevent sending. */ }
  }, [attachmentStorageKey, attachments, busy, currentAttachmentScope, draftHydratedKey, preserveDrafts, storage, storageKey]);

  useLayoutEffect(() => {
    resizeComposerTextarea(textareaRef.current);
  }, [text]);

  useEffect(() => {
    onDraftStateChange?.({ hasText: Boolean(text), attachmentCount: attachments.length });
  }, [attachments.length, onDraftStateChange, text]);

  useEffect(() => {
    if (!autoFocusComposer || disabled || blockingQuestion) return undefined;
    const frame = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocusComposer, disabled, draftKey, questionRequest]);

  const addAttachmentFiles = useCallback(async (files) => {
    if (disabled) return;
    const candidates = Array.from(files ?? []);
    const withinLimit = candidates.filter((file) => file.size <= MAX_COMPOSER_ATTACHMENT_BYTES);
    if (withinLimit.length !== candidates.length) setAttachmentNotice("Files must be 25 MB or smaller.");
    else setAttachmentNotice("");
    const available = Math.max(0, MAX_COMPOSER_ATTACHMENTS - attachments.length);
    if (available === 0) {
      setAttachmentNotice(`You can attach up to ${MAX_COMPOSER_ATTACHMENTS} files.`);
      return;
    }
    try {
      const additions = withinLimit.slice(0, available).map((file) => readComposerAttachment(file, currentAttachmentScope));
      draftInteractionRef.current = true;
      setAttachments((current) => [...current, ...additions].slice(0, MAX_COMPOSER_ATTACHMENTS));
      if (withinLimit.length > available) setAttachmentNotice(`You can attach up to ${MAX_COMPOSER_ATTACHMENTS} files.`);
      textareaRef.current?.focus();
    } catch {
      setAttachmentNotice("One of the files could not be read.");
    }
  }, [attachments.length, currentAttachmentScope, disabled]);

  useEffect(() => {
    const target = globalFileDrop ? window : composerRef.current;
    if (!target) return undefined;
    const belongsToScopedComposer = (event) => globalFileDrop && event.target?.closest?.('[data-composer-drop-scope="local"]');
    const onDragEnter = (event) => {
      if (belongsToScopedComposer(event) || disabled || blockingQuestion || !transferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      setDraggingFiles(true);
    };
    const onDragOver = (event) => {
      if (belongsToScopedComposer(event) || disabled || blockingQuestion || !transferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setDraggingFiles(true);
    };
    const onDragLeave = (event) => {
      if (globalFileDrop ? !event.relatedTarget : !composerRef.current?.contains(event.relatedTarget)) setDraggingFiles(false);
    };
    const onDrop = (event) => {
      if (belongsToScopedComposer(event) || disabled || blockingQuestion || !transferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      setDraggingFiles(false);
      addAttachmentFiles(attachmentFilesFromTransfer(event.dataTransfer));
    };
    target.addEventListener("dragenter", onDragEnter);
    target.addEventListener("dragover", onDragOver);
    target.addEventListener("dragleave", onDragLeave);
    target.addEventListener("drop", onDrop);
    return () => {
      target.removeEventListener("dragenter", onDragEnter);
      target.removeEventListener("dragover", onDragOver);
      target.removeEventListener("dragleave", onDragLeave);
      target.removeEventListener("drop", onDrop);
    };
  }, [addAttachmentFiles, disabled, globalFileDrop, questionRequest]);
  const isClaude = modelProvider(selected) === "claude";
  const availableCommands = isClaude
    ? (Array.isArray(slashCommands) ? slashCommands : CLAUDE_SLASH_COMMANDS)
    : CODEX_SLASH_COMMANDS;
  const slashToken = showSlashCommands ? slashCommandAtCaret(text, caretPosition) : null;
  const matchingCommands = !slashToken ? [] : availableCommands.filter((command) => {
    return command.name.toLowerCase().includes(slashToken.query) || command.description.toLowerCase().includes(slashToken.query);
  });
  const commandMenuOpen = !disabled && !commandsDismissed && matchingCommands.length > 0;
  const activeCommandIndex = Math.min(commandSelection, Math.max(0, matchingCommands.length - 1));
  const activeCommand = matchingCommands[activeCommandIndex];
  const readDictationLevel = useCallback(() => dictationLevelRef.current, []);
  const handleDictationLevel = useCallback((level) => {
    dictationLevelRef.current = level;
  }, []);
  const handleDictationPhase = useCallback((phase) => {
    if (!mountedRef.current) return;
    if (phase !== "recording") dictationLevelRef.current = 0;
    if (dictationBeamTimerRef.current) {
      window.clearTimeout(dictationBeamTimerRef.current);
      dictationBeamTimerRef.current = null;
    }
    if (phase === "idle") {
      dictationBeamTimerRef.current = window.setTimeout(() => {
        setShowDictationBeam(false);
        dictationBeamTimerRef.current = null;
      }, 520);
    } else {
      setShowDictationBeam(true);
    }
    setDictationPhase(phase);
  }, []);
  useEffect(() => () => {
    if (dictationBeamTimerRef.current) window.clearTimeout(dictationBeamTimerRef.current);
  }, []);

  const completeCommand = (command) => {
    if (!command || disabled || !slashToken) return;
    const before = text.slice(0, slashToken.start);
    const after = text.slice(slashToken.end);
    const insertion = `/${command.name}${after && /^\s/.test(after) ? "" : " "}`;
    const value = `${before}${insertion}${after}`;
    const caret = before.length + insertion.length;
    draftInteractionRef.current = true;
    setText(value);
    setCaretPosition(caret);
    setCommandsDismissed(true);
    if (preserveDrafts) storage.setItem(storageKey, value);
    window.setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    }, 0);
  };
  // Dictated text lands at the cursor and is never submitted on its own, so a
  // misheard word can be fixed before the turn starts.
  const insertTranscript = (transcript) => {
    const addition = String(transcript ?? "").trim();
    if (!addition || disabled) return;
    const field = textareaRef.current;
    const current = textRef.current ?? "";
    const start = field?.selectionStart ?? current.length;
    const end = field?.selectionEnd ?? current.length;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const spacer = before && !/\s$/.test(before) ? " " : "";
    const value = `${before}${spacer}${addition}${after}`;
    const caret = before.length + spacer.length + addition.length;
    draftInteractionRef.current = true;
    setText(value);
    setCaretPosition(caret);
    if (preserveDrafts) storage.setItem(storageKey, value);
    window.setTimeout(() => {
      const target = textareaRef.current;
      if (!target) return;
      target.focus();
      target.setSelectionRange(caret, caret);
      resizeComposerTextarea(target);
    }, 0);
  };

  const updateAttachment = useCallback((updated) => {
    setAttachments((current) => current.map((attachment) => attachment.id === updated.id ? { ...attachment, ...updated } : attachment));
  }, []);
  const prepareAttachments = useCallback(async (submittedAttachments, signal, resumeOnly = false, attempt = null) => {
    const attemptIsCurrent = () => mountedRef.current
      && (!attempt || (uploadAttemptRef.current === attempt
        && storageKeyRef.current === attempt.storageKey
        && attachmentScopeKeyRef.current === attempt.scopeKey
        && !attempt.cancelled))
      && !signal?.aborted;
    const prepared = await (resumeOnly ? resumeAttachmentUploads : prepareSubmissionAttachments)({
      ...(attachmentContext ?? {}),
      projectId: attachmentContext?.projectId ?? null,
      attachments: submittedAttachments,
      signal,
      resumeOnly,
      onProgress: (progress) => {
        if (!attemptIsCurrent()) return;
        uploadStateRef.current = progress;
        setUploadState(progress);
      },
      onAttachmentUpdate: (updated) => { if (attemptIsCurrent()) updateAttachment(updated); }
    });
    return prepared;
  }, [attachmentContext, updateAttachment]);
  const reselectAttachment = useCallback(async (attachment, file) => {
    if (!file || disabled || !attachment?.needsReselect) return;
    const reselectAttempt = (reselectAttemptsRef.current.get(attachment.id) ?? 0) + 1;
    reselectAttemptsRef.current.set(attachment.id, reselectAttempt);
    const expectedStorageKey = storageKey;
    const expectedScopeKey = currentAttachmentScopeKey;
    const isCurrentAttempt = () => mountedRef.current
      && storageKeyRef.current === expectedStorageKey
      && attachmentScopeKeyRef.current === expectedScopeKey
      && reselectAttemptsRef.current.get(attachment.id) === reselectAttempt
      && attachmentsRef.current.some((candidate) => candidate.id === attachment.id && candidate === attachment);
    if (file.size !== attachment.size) {
      setAttachmentNotice(`${attachment.name} must be ${attachmentSize(attachment.size)}.`);
      return;
    }
    setAttachmentNotice(`Checking ${attachment.name}…`);
    let hash;
    try {
      hash = await sha256File(file);
    } catch (cause) {
      if (isCurrentAttempt()) setAttachmentNotice(cause.message);
      return;
    }
    if (!isCurrentAttempt()) return;
    if (attachment.sha256 && hash !== attachment.sha256) {
      setAttachmentNotice(`${attachment.name} does not match the saved attachment. Choose the original file.`);
      return;
    }
    const canReuseTransfer = Boolean(attachment.sha256 && hash === attachment.sha256 && attachment.transferId);
    const replacement = {
      ...createComposerAttachment(file, {
        id: attachment.id,
        name: attachment.name,
        type: attachment.type,
        size: attachment.size,
        sha256: hash,
        transferId: canReuseTransfer ? attachment.transferId : null,
        transferState: canReuseTransfer ? attachment.transferState : null,
        uploadOffset: canReuseTransfer ? attachment.uploadOffset : 0,
        scopeKey: currentAttachmentScopeKey
      }),
      scope: currentAttachmentScope,
      scopeKey: currentAttachmentScopeKey,
      needsReselect: false
    };
    draftInteractionRef.current = true;
    let replacementDisposed = false;
    const disposeReplacement = () => {
      if (replacementDisposed) return;
      replacementDisposed = true;
      disposeComposerAttachment(replacement);
    };
    setAttachments((current) => {
      if (!isCurrentAttempt()) {
        disposeReplacement();
        return current;
      }
      return current.map((candidate) => candidate.id === attachment.id && candidate === attachment ? replacement : candidate);
    });
    if (!isCurrentAttempt()) {
      disposeReplacement();
      return;
    }
    setAttachmentNotice(canReuseTransfer ? `${attachment.name} is ready to resume.` : `${attachment.name} selected.`);
  }, [currentAttachmentScope, currentAttachmentScopeKey, disabled, storageKey]);
  const resumeUploads = async () => {
    const resumable = attachments.filter((attachment) => attachment.file && attachment.transferId && attachment.transferState !== "ready");
    if (!resumable.length || disabled || busy || submissionBusy) return;
    const controller = new AbortController();
    const attempt = { controller, kind: "resume", attachmentIds: new Set(resumable.map((attachment) => attachment.id)), storageKey, scopeKey: currentAttachmentScopeKey, cancelled: false };
    uploadAttemptRef.current = attempt;
    uploadAbortRef.current = controller;
    uploadStateRef.current = { files: resumable.map((attachment) => ({ id: attachment.id, name: attachment.name, size: attachment.size, offset: attachment.uploadOffset ?? 0, state: "resuming" })), totalBytes: resumable.reduce((total, attachment) => total + attachment.size, 0), uploadedBytes: 0, activeCount: resumable.length };
    setUploadState(uploadStateRef.current);
    try {
      await prepareAttachments(resumable, controller.signal, true, attempt);
      if (!mountedRef.current || uploadAttemptRef.current !== attempt || controller.signal.aborted || attempt.cancelled) return;
      uploadStateRef.current = null;
      setUploadState(null);
      setAttachmentNotice("Uploads resumed. Send the message when you are ready.");
    } catch (cause) {
      if (mountedRef.current && uploadAttemptRef.current === attempt) {
        const cancelled = controller.signal.aborted || cause?.code === "REQUEST_ABORTED";
        const message = cancelled ? "Upload cancelled. Send again to restart." : cause.message;
        if (message) setAttachmentNotice(message);
        uploadStateRef.current = uploadStateRef.current
          ? { ...uploadStateRef.current, state: cancelled ? "cancelled" : "failed", activeCount: 0, message }
          : null;
        setUploadState(uploadStateRef.current);
      }
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
      if (uploadAttemptRef.current === attempt) uploadAttemptRef.current = null;
    }
  };
  const removeAttachment = (attachment) => {
    reselectAttemptsRef.current.delete(attachment.id);
    const attempt = uploadAttemptRef.current;
    if (attempt?.attachmentIds.has(attachment.id)) {
      attempt.cancelled = true;
      attempt.controller.abort(new DOMException("The attachment was removed.", "AbortError"));
      uploadAttemptRef.current = null;
      uploadStateRef.current = uploadStateRef.current
        ? { ...uploadStateRef.current, state: "cancelled", activeCount: 0, message: "Upload cancelled. Send again to restart." }
        : null;
      setUploadState(uploadStateRef.current);
      setAttachmentNotice("Upload cancelled. Send again to restart.");
    }
    draftInteractionRef.current = true;
    disposeComposerAttachment(attachment);
    setAttachments((current) => current.filter((candidate) => candidate.id !== attachment.id));
  };
  const cancelUploads = () => {
    const controller = uploadAbortRef.current;
    if (!controller) return;
    controller.abort(new DOMException("The upload was cancelled.", "AbortError"));
    if (uploadAttemptRef.current) uploadAttemptRef.current.cancelled = true;
    uploadAttemptRef.current = null;
    uploadStateRef.current = { ...(uploadStateRef.current ?? {}), state: "cancelled", activeCount: 0, message: "Upload cancelled. Send again to restart." };
    setUploadState(uploadStateRef.current);
    setAttachmentNotice("Upload cancelled. Send again to restart.");
  };
  const submit = async () => {
    const value = prepareSlashCommandPrompt(text, availableCommands);
    if (attachments.some((attachment) => attachment.needsReselect)) {
      setAttachmentNotice("Reselect each saved attachment before sending.");
      return;
    }
    if ((!value && attachments.length === 0) || disabled || busy || submissionBusy || submissionRef.current || !selected || uploadStateRef.current?.activeCount > 0) return;
    const submittedText = text;
    const submittedAttachments = attachments.slice();
    const submittedAttachmentIds = new Set(submittedAttachments.map((attachment) => attachment.id));
    const displayAttachments = submittedAttachments.map((attachment) => ({
      name: attachment.name,
      type: attachment.type,
      size: attachment.size,
      dataUrl: attachment.dataUrl ?? attachment.url
    }));
    const controller = new AbortController();
    const attempt = {
      controller,
      kind: "submit",
      attachmentIds: submittedAttachmentIds,
      cancelled: false,
      storageKey,
      scopeKey: currentAttachmentScopeKey,
      adoptedStorageKeys: new Set([storageKey])
    };
    submissionRef.current = attempt;
    uploadAttemptRef.current = attempt;
    setSubmissionBusy(true);
    uploadAbortRef.current = controller;
    setAttachmentNotice("");
    uploadStateRef.current = { files: submittedAttachments.map((attachment) => ({ id: attachment.id, name: attachment.name, size: attachment.size, offset: attachment.uploadOffset ?? 0, state: "preparing" })), totalBytes: submittedAttachments.reduce((total, attachment) => total + attachment.size, 0), uploadedBytes: 0, activeCount: submittedAttachments.length };
    setUploadState(uploadStateRef.current);
    try {
      const prepared = await prepareAttachments(submittedAttachments, controller.signal, false, attempt);
      if (!mountedRef.current || uploadAttemptRef.current !== attempt || controller.signal.aborted || submissionRef.current?.cancelled) return;
      const accepted = await onSubmit(value, displayAttachments, prepared, submittedAttachments, controller.signal, {
        adoptDraftKey: (nextDraftKey) => {
          if (submissionRef.current === attempt && nextDraftKey) attempt.adoptedStorageKeys.add(`pixice.draft.${nextDraftKey}`);
        }
      });
      if (!mountedRef.current || uploadAttemptRef.current !== attempt || controller.signal.aborted || submissionRef.current?.cancelled) return;
      if (accepted === false) {
        uploadStateRef.current = null;
        setUploadState(null);
      } else {
        const textUnchanged = textRef.current === submittedText;
        if (textUnchanged) {
          setText("");
        }
        setAttachments((current) => current.filter((attachment) => !submittedAttachmentIds.has(attachment.id)));
        for (const adoptedStorageKey of attempt.adoptedStorageKeys) {
          if (!textUnchanged && adoptedStorageKey === storageKeyRef.current) continue;
          storage.removeItem(adoptedStorageKey);
          storage.removeItem(`${adoptedStorageKey}.attachments`);
        }
      }
    } catch (cause) {
      if (mountedRef.current && uploadAttemptRef.current === attempt && !controller.signal.aborted && !attempt.cancelled) {
        setAttachmentNotice(cause.message);
        uploadStateRef.current = uploadStateRef.current
          ? { ...uploadStateRef.current, state: "failed", activeCount: 0, message: cause.message }
          : { state: "failed", activeCount: 0, message: cause.message };
        setUploadState(uploadStateRef.current);
      }
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
      if (submissionRef.current?.controller === controller) submissionRef.current = null;
      if (uploadAttemptRef.current === attempt) uploadAttemptRef.current = null;
      if (!mountedRef.current) return;
      setSubmissionBusy(false);
      if (!controller.signal.aborted && uploadStateRef.current?.state !== "failed") {
        uploadStateRef.current = null;
        setUploadState(null);
      } else if (controller.signal.aborted && uploadStateRef.current?.activeCount > 0) {
        uploadStateRef.current = { ...uploadStateRef.current, state: "cancelled", activeCount: 0, message: "Upload cancelled. Send again to restart." };
        setUploadState(uploadStateRef.current);
      }
    }
  };
  if (blockingQuestion) {
    return (
      <div className="composer" data-question-active="true" data-question-present="true" data-composer-drop-scope={globalFileDrop ? "global" : "local"} ref={composerRef}>
        <ComposerQuestion key={questionRequestKey(questionRequest)} request={questionRequest} onResolve={onQuestionResolve} />
      </div>
    );
  }
  return (
    <div className="composer" data-question-present={Boolean(questionRequest)} data-dragging-files={draggingFiles} data-composer-drop-scope={globalFileDrop ? "global" : "local"} ref={composerRef}>
      {showDictationBeam && (
        <VoiceBeam
          className="composer-voice-beam"
          aria-hidden="true"
          level={readDictationLevel}
          active={dictationPhase !== "idle"}
          processing={dictationPhase === "transcribing"}
          theme="dark"
          colors={voiceGlowPalette.colors}
          bandColors={voiceGlowPalette.bandColors}
          hueRange={10}
          hueDuration={16}
          idle={0.12}
          attack={0.12}
          release={0.46}
          strength={0.82}
          distortion={0}
          borderRadius={18}
          data-accent-color={accentColor}
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          <span className="composer-voice-beam-host" />
        </VoiceBeam>
      )}
      {questionRequest && <ComposerQuestion key={questionRequestKey(questionRequest)} request={questionRequest} onResolve={onQuestionResolve} />}
      {draggingFiles && (
        <div className="composer-drop-target" role="status">
          <Files size={22} />
          <span>Drop files to attach</span>
        </div>
      )}
      {commandMenuOpen && (
        <div className="slash-command-menu" id={commandListId} role="listbox" aria-label="Slash commands">
          <div className="slash-command-head">
            <span>{isClaude ? "Claude commands" : "Codex commands"}</span>
            <small><kbd>↑↓</kbd> navigate <kbd>Tab</kbd> complete</small>
          </div>
          <div className="slash-command-options">
            {matchingCommands.map((command, index) => {
              const active = index === activeCommandIndex;
              return (
                <button
                  type="button"
                  id={`${commandListId}-${command.name}`}
                  className={`slash-command-option${active ? " active" : ""}`}
                  role="option"
                  aria-selected={active}
                  key={command.name}
                  onPointerMove={() => setCommandSelection(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => completeCommand(command)}
                >
                  <code>/{command.name}</code>
                  <span>{command.description}</span>
                  {active && <kbd>↵</kbd>}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="composer-attachments" aria-label="Attached files">
          {attachments.map((attachment) => (
            <figure className="composer-attachment" key={attachment.id} title={`${attachment.name} · ${attachmentSize(attachment.size)}`}>
              {COMPOSER_IMAGE_TYPES.has(attachment.type) && !attachment.needsReselect ? (
                <img src={attachment.url || "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="} alt={attachment.name} />
              ) : (
                <div className="composer-file-tile">
                  {attachment.needsReselect ? <Warning size={24} /> : <File size={24} />}
                  <strong>{attachmentExtension(attachment.name)}</strong>
                  <span>{attachment.needsReselect ? "Reselect file" : attachment.name}</span>
                </div>
              )}
              {attachment.needsReselect && <>
                <input
                  ref={(node) => { if (node) reselectInputRefs.current.set(attachment.id, node); else reselectInputRefs.current.delete(attachment.id); }}
                  className="composer-file-input"
                  type="file"
                  aria-label={`Choose ${attachment.name}`}
                  onChange={(event) => { void reselectAttachment(attachment, event.target.files?.[0]); event.target.value = ""; }}
                />
                <button type="button" className="composer-reselect" onClick={() => reselectInputRefs.current.get(attachment.id)?.click()}>Reselect file</button>
              </>}
              <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => removeAttachment(attachment)}>
                <X size={10} weight="bold" />
              </button>
            </figure>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={commandMenuOpen}
        aria-controls={commandMenuOpen ? commandListId : undefined}
        aria-activedescendant={commandMenuOpen && activeCommand ? `${commandListId}-${activeCommand.name}` : undefined}
        placeholder={disabled ? "Connect a provider and select a project to begin" : running ? runningPlaceholder : placeholder}
        spellCheck={spellCheckComposer}
        value={text}
        disabled={disabled}
        onPaste={(event) => {
          const files = attachmentFilesFromTransfer(event.clipboardData);
          if (files.length > 0) addAttachmentFiles(files);
        }}
        onFocus={() => setCommandsDismissed(false)}
        onBlur={() => setCommandsDismissed(true)}
        onSelect={(event) => setCaretPosition(event.currentTarget.selectionStart)}
        onChange={(event) => {
          const value = event.target.value;
          draftInteractionRef.current = true;
          setText(value);
          setCaretPosition(event.target.selectionStart);
          setCommandsDismissed(false);
          setCommandSelection(0);
          if (preserveDrafts) storage.setItem(storageKey, value);
        }}
        onKeyDown={(event) => {
          if (commandMenuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            const direction = event.key === "ArrowDown" ? 1 : -1;
            setCommandSelection((current) => (current + direction + matchingCommands.length) % matchingCommands.length);
            return;
          }
          if (commandMenuOpen && (event.key === "Enter" || event.key === "Tab") && !event.nativeEvent.isComposing) {
            event.preventDefault();
            completeCommand(activeCommand);
            return;
          }
          if (commandMenuOpen && event.key === "Escape") {
            event.preventDefault();
            setCommandsDismissed(true);
            return;
          }
          const sendWithEnter = sendShortcut === "enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey;
          const sendWithModifier = sendShortcut === "mod-enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey;
          if (event.key === "Enter" && (sendWithEnter || sendWithModifier) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {attachmentNotice && <div className="composer-image-notice" role="status">{attachmentNotice}</div>}
      {uploadState && (
        <div className="composer-upload-status" role="status" aria-label="Attachment upload progress">
          <span>{uploadState.state === "failed" ? "Upload failed" : uploadState.state === "cancelled" ? "Upload cancelled" : "Uploading attachments"}</span>
          <small>{uploadState.files?.filter((file) => file.state === "ready").length ?? 0}/{uploadState.files?.length ?? 0} files · {attachmentSize(uploadState.uploadedBytes ?? 0)} of {attachmentSize(uploadState.totalBytes ?? 0)}</small>
          <div className="composer-upload-actions">
            {uploadState.activeCount > 0 && <button type="button" className="settings-action" onClick={cancelUploads}>Cancel upload</button>}
            {uploadState.activeCount === 0 && !["preparing", "cancelled"].includes(uploadState.state) && attachments.some((attachment) => attachment.file && attachment.transferId && attachment.transferState !== "ready") && <button type="button" className="settings-action" onClick={() => void resumeUploads()}>Resume upload</button>}
          </div>
        </div>
      )}
      <div className="composer-controls">
        <div className="composer-primary-actions">
          <input
            ref={fileInputRef}
            className="composer-file-input"
            type="file"
            multiple
            tabIndex={-1}
            disabled={disabled}
            onChange={(event) => {
              addAttachmentFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <IconButton label="Attach files" className="composer-attach" onClick={() => fileInputRef.current?.click()} disabled={disabled || attachments.length >= MAX_COMPOSER_ATTACHMENTS}>
            <Plus size={18} />
          </IconButton>
          {showPermissionPicker && <ComposerPicker
            label="Permissions"
            hint="Applied to this task"
            value={permissionMode}
            options={PERMISSION_OPTIONS}
            onChange={onPermissionModeChange}
            kind="permission"
            align="left"
            disabled={disabled || running}
          />}
        </div>
        <div className="composer-actions">
          <ComposerPicker
            label="Model"
            hint={null}
            value={selectedModel}
            options={modelOptions}
            onChange={onModelChange}
            kind="model"
            className="run-profile"
            triggerLabel={runProfileLabel}
            triggerAriaLabel={runProfileAriaLabel}
            disabled={disabled || running}
            providers={providers}
            onProviderLogin={onProviderLogin}
            onProvidersRefresh={onProvidersRefresh}
            footer={(
              <div className="run-profile-footer">
                <div className="run-profile-setting">
                  <span>Reasoning</span>
                  <div className="run-profile-efforts" role="group" aria-label="Reasoning">
                    {effortOptions.map((option) => (
                      <button
                        type="button"
                        className={option.value === effort ? "selected" : ""}
                        aria-pressed={option.value === effort}
                        onClick={() => onEffortChange(option.value)}
                        key={option.value}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                {fastTier && (
                  <button
                    type="button"
                    className="run-profile-fast"
                    aria-label="Fast mode"
                    aria-pressed={fastMode}
                    title="Use faster inference with increased usage"
                    onClick={() => onFastModeChange(!fastMode)}
                  >
                    <span><FastModeIcon size={14} weight={fastMode ? "fill" : "regular"} /> Fast</span>
                    <i aria-hidden="true" />
                  </button>
                )}
              </div>
            )}
          />
          <DictationButton
            api={dictationApi}
            state={transcription}
            deviceId={micDeviceId}
            disabled={disabled}
            onTranscript={insertTranscript}
            onError={(error) => setAttachmentNotice(error.message)}
            onPhaseChange={handleDictationPhase}
            onLevelChange={handleDictationLevel}
          />
          <button
            type="button"
            className="icon-button send composer-run-action"
            data-state={runActionState}
            aria-label={runActionLabel}
            title={runActionLabel}
            onClick={runActionState === "stop" ? onInterrupt : submit}
            disabled={runActionDisabled}
          >
            <span className="composer-run-icon composer-run-icon-send"><PaperPlaneTilt size={17} weight="fill" /></span>
            <span className="composer-run-icon composer-run-icon-stop" aria-hidden="true"><i /></span>
          </button>
        </div>
      </div>
    </div>
  );
}

function applySideThreadRuntimePayload(current, payload) {
  if (payload.method === "thread/name/updated") {
    return current?.id === payload.threadId ? { ...current, name: payload.name } : current;
  }
  if (payload.method === "thread/slash-commands/updated") {
    return current?.id === payload.threadId ? { ...current, slashCommands: payload.slashCommands } : current;
  }
  return applyRuntimePayload(current ?? payload.thread ?? null, payload);
}

function SideThreadSurface({
  api,
  tab,
  runtime,
  models,
  defaultModel,
  defaultEffort,
  defaultFastMode,
  defaultPermissionMode,
  enforcedPermissionMode = null,
  providers,
  threads,
  attention,
  preferences,
  seenResponseIds,
  onQuestionResolve,
  onProviderLogin,
  onProvidersRefresh,
  onThreadCreated,
  onThreadActivity,
  onThreadViewed,
  onOpenMain,
  onForkResponse,
  onTabUpdate,
  onError,
  storage = localStorage
}) {
  const projectId = tab.payload?.projectId;
  const threadId = tab.payload?.threadId ?? null;
  const threadIdRef = useRef(threadId);
  const initialThread = threads?.find((candidate) => candidate.id === threadId) ?? null;
  const [snapshot, setSnapshot] = useState(initialThread);
  const [loading, setLoading] = useState(Boolean(threadId));
  const [busy, setBusy] = useState(false);
  const [surfaceError, setSurfaceError] = useState("");
  const [selectedModel, setSelectedModel] = useState(defaultModel || models?.[0]?.model || "");
  const [effort, setEffort] = useState(defaultEffort || "high");
  const [fastMode, setFastMode] = useState(Boolean(defaultFastMode));
  const [permissionMode, setPermissionMode] = useState(enforcedPermissionMode || defaultPermissionMode || "workspace-write");
  const scrollRef = useRef(null);
  const followLatestRef = useRef(true);
  const followedThreadRef = useRef(threadId);
  const pendingDeltasRef = useRef([]);
  const deltaFrameRef = useRef(null);
  const mountedRef = useRef(true);
  threadIdRef.current = threadId;
  const selectedModelInfo = models.find((candidate) => candidate.model === selectedModel);
  const selectedProvider = selectedModelInfo?.provider
    ? providers.find((provider) => provider.id === selectedModelInfo.provider)
    : null;
  const providerReady = selectedProvider
    ? selectedProvider.connected !== false && !["error", "stopped", "unavailable"].includes(selectedProvider.status?.state)
    : selectedModelInfo
      ? selectedModelInfo.connected !== false && selectedModelInfo.availability !== "disconnected"
      : false;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!models?.length) return;
    const saved = loadThreadConfiguration(threadId, storage);
    const model = models.find((candidate) => candidate.model === saved?.model)
      ?? models.find((candidate) => candidate.model === defaultModel)
      ?? models[0];
    setSelectedModel(model.model);
    setEffort(resolveReasoningEffort(saved?.effort, model, defaultEffort));
    setFastMode(Boolean(saved?.fastMode ?? defaultFastMode) && Boolean(fastServiceTier(model)));
    setPermissionMode(enforcedPermissionMode || (PERMISSION_OPTIONS.some((option) => option.value === saved?.permissionMode)
      ? saved.permissionMode
      : defaultPermissionMode));
  }, [defaultEffort, defaultFastMode, defaultModel, defaultPermissionMode, enforcedPermissionMode, models, storage, threadId]);

  const refresh = useCallback(async (targetThreadId = threadIdRef.current) => {
    if (!api?.threads?.read || !projectId || !targetThreadId) return;
    try {
      const response = await api.threads.read({ projectId, threadId: targetThreadId });
      if (!mountedRef.current || threadIdRef.current !== targetThreadId) return;
      markResponsesSeen(response.thread, seenResponseIds);
      onThreadViewed(response.thread);
      setSnapshot((current) => mergeThreadSnapshot(current, response.thread));
      setSurfaceError("");
    } catch (cause) {
      if (!mountedRef.current || threadIdRef.current !== targetThreadId) return;
      setSurfaceError(cause.message);
    } finally {
      if (mountedRef.current && threadIdRef.current === targetThreadId) setLoading(false);
    }
  }, [api, onThreadViewed, projectId, seenResponseIds]);

  useEffect(() => {
    if (!threadId) {
      setLoading(false);
      setSnapshot(null);
      return undefined;
    }
    setLoading(true);
    void refresh(threadId);
    return undefined;
  }, [refresh, threadId]);

  const flushDeltas = useCallback(() => {
    deltaFrameRef.current = null;
    const pending = coalesceRuntimeDeltas(pendingDeltasRef.current.splice(0));
    if (!pending.length || !mountedRef.current) return;
    setSnapshot((current) => pending.reduce(applySideThreadRuntimePayload, current));
  }, []);

  const commitPayload = useCallback((payload) => {
    if (!mountedRef.current) return;
    if (payload.method === "item/agentMessage/delta") {
      pendingDeltasRef.current.push(payload);
      if (deltaFrameRef.current !== null) return;
      deltaFrameRef.current = typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame(flushDeltas)
        : window.setTimeout(flushDeltas, 16);
      return;
    }
    const pending = coalesceRuntimeDeltas(pendingDeltasRef.current.splice(0));
    if (deltaFrameRef.current !== null) {
      if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(deltaFrameRef.current);
      else window.clearTimeout(deltaFrameRef.current);
      deltaFrameRef.current = null;
    }
    setSnapshot((current) => applySideThreadRuntimePayload(pending.reduce(applySideThreadRuntimePayload, current), payload));
  }, [flushDeltas]);

  useEffect(() => {
    if (!api?.events?.subscribe) return undefined;
    return api.events.subscribe((event) => {
      if (!mountedRef.current) return;
      const payload = event.payload ?? {};
      const targetThreadId = threadIdRef.current;
      if (event.type === "ApplicationResync" && targetThreadId) { void refresh(targetThreadId); return; }
      if (!targetThreadId || (payload.threadId ?? payload.thread?.id) !== targetThreadId) return;
      commitPayload(payload);
      if (payload.method === "turn/completed") {
        window.setTimeout(() => void refresh(targetThreadId), 120);
      }
    });
  }, [api, commitPayload, refresh]);

  useEffect(() => () => {
    pendingDeltasRef.current = [];
    if (deltaFrameRef.current !== null) {
      if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(deltaFrameRef.current);
      else window.clearTimeout(deltaFrameRef.current);
    }
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    const title = threadTitle(snapshot);
    const status = threadStatus(snapshot);
    if (tab.title === title && tab.payload?.status === status) return;
    onTabUpdate({
      title,
      payload: { ...tab.payload, status }
    });
  }, [onTabUpdate, snapshot, tab.payload, tab.title]);

  useLayoutEffect(() => {
    if (followedThreadRef.current !== threadId) {
      followedThreadRef.current = threadId;
      followLatestRef.current = true;
    }
    const node = scrollRef.current;
    if (node && followLatestRef.current) node.scrollTop = node.scrollHeight;
  }, [snapshot?.turns, threadId]);

  const persistConfiguration = (patch) => {
    const next = { selectedModel, effort, fastMode, permissionMode, ...patch };
    if (patch.selectedModel !== undefined) setSelectedModel(patch.selectedModel);
    if (patch.effort !== undefined) setEffort(patch.effort);
    if (patch.fastMode !== undefined) setFastMode(patch.fastMode);
    if (patch.permissionMode !== undefined) setPermissionMode(patch.permissionMode);
    if (threadId) saveThreadConfiguration(threadId, {
      model: next.selectedModel,
      effort: next.effort,
      fastMode: next.fastMode,
      permissionMode: next.permissionMode
    }, storage);
  };

  const changeModel = (modelName) => {
    const model = models.find((candidate) => candidate.model === modelName);
    const nextEffort = resolveReasoningEffort(effort, model, defaultEffort);
    persistConfiguration({ selectedModel: modelName, effort: nextEffort, fastMode: Boolean(fastMode && fastServiceTier(model)) });
  };

  const submit = async (text, attachments = [], preparedAttachments = null, sourceAttachments = attachments, signal = null, draftLifecycle = null) => {
    if (!api || !projectId || !runtime?.connected || busy || !selectedModel || !providerReady) return false;
    assertSubmissionActive(signal);
    followLatestRef.current = true;
    setBusy(true);
    setSurfaceError("");
    let targetThreadId = threadIdRef.current;
    let optimisticTurnId = null;
    let optimisticMessageId = null;
    let removeEmptyTurn = false;
    const model = models.find((candidate) => candidate.model === selectedModel);
    const availableFastTier = fastServiceTier(model);
    const serviceTier = availableFastTier ? (fastMode ? availableFastTier : null) : undefined;
    try {
      const prepared = preparedAttachments ?? await prepareSubmissionAttachments({
        api,
        projectId,
        hostId: api?.remote?.hostId ?? "local",
        deviceId: api?.remote?.deviceId,
        attachments,
        signal
      });
      if (!mountedRef.current) return false;
      assertSubmissionActive(signal);
      if (!targetThreadId) {
        const prospectivePayload = requestPayloadWithAttachments({
          projectId,
          threadId: PROSPECTIVE_THREAD_ID,
          text,
          model: selectedModel || undefined,
          ...(serviceTier !== undefined ? { serviceTier } : {}),
          effort,
          permissionMode
        }, prepared);
        assertSubmissionRequestBudget({ api, operation: "turns.start", payload: prospectivePayload });
      }
      if (!targetThreadId) {
        const created = await api.threads.create({
          projectId,
          model: selectedModel || undefined,
          ...(serviceTier !== undefined ? { serviceTier } : {}),
          ...(enforcedPermissionMode && tab.payload?.hostThreadId ? { parentThreadId: tab.payload.hostThreadId } : {}),
          permissionMode
        });
        assertSubmissionActive(signal);
        targetThreadId = created.thread.id;
        draftLifecycle?.adoptDraftKey(`${projectId}:side:${targetThreadId}`);
        threadIdRef.current = targetThreadId;
        setSnapshot(created.thread);
        saveThreadConfiguration(targetThreadId, { model: selectedModel, effort, fastMode, permissionMode }, storage);
        onThreadCreated(tab.id, created.thread, {
          ...tab.payload,
          projectId,
          threadId: targetThreadId
        });
      }

      const currentSnapshot = snapshot?.id === targetThreadId ? snapshot : null;
      const activeTurn = [...(currentSnapshot?.turns ?? [])].reverse().find((turn) => turnIsRunning(turn.status));
      if (activeTurn) {
        optimisticTurnId = activeTurn.id;
        optimisticMessageId = `local-user:${activeTurn.id}:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
        setSnapshot((current) => appendLocalUserMessage(current, {
          turnId: activeTurn.id,
          text,
          attachments,
          messageId: optimisticMessageId
        }));
        const steerPayload = requestPayloadWithAttachments({ projectId, threadId: targetThreadId, turnId: activeTurn.id, text }, prepared);
        assertSubmissionRequestBudget({ api, operation: "turns.steer", payload: steerPayload });
        await api.turns.steer(steerPayload);
        assertSubmissionActive(signal);
        window.setTimeout(() => void refresh(targetThreadId), 250);
      } else {
        optimisticTurnId = `local-turn:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
        optimisticMessageId = `local-user:${optimisticTurnId}`;
        removeEmptyTurn = true;
        setSnapshot((current) => appendLocalUserMessage(current, {
          turnId: optimisticTurnId,
          text,
          attachments,
          messageId: optimisticMessageId
        }));
        const startPayload = requestPayloadWithAttachments({
          projectId,
          threadId: targetThreadId,
          text,
          model: selectedModel || undefined,
          ...(serviceTier !== undefined ? { serviceTier } : {}),
          effort,
          permissionMode
        }, prepared);
        assertSubmissionRequestBudget({ api, operation: "turns.start", payload: startPayload });
        const response = await api.turns.start(startPayload);
        assertSubmissionActive(signal);
        const temporaryTurnId = optimisticTurnId;
        const localMessageId = optimisticMessageId;
        setSnapshot((current) => {
          if (!current) return current;
          const createdAt = response.turn.startedAt ?? response.turn.createdAt;
          const responseAlreadyArrived = (current.turns ?? []).some((turn) => turn.id === response.turn.id);
          const withoutTemporaryTurn = removeLocalUserMessage(current, {
            turnId: temporaryTurnId,
            messageId: localMessageId,
            removeEmptyTurn: true
          });
          if (!responseAlreadyArrived) {
            const incoming = appendLocalUserMessage({
              id: current.id,
              turns: [{ ...response.turn, renderId: temporaryTurnId }]
            }, {
              turnId: response.turn.id,
              text,
              attachments,
              createdAt,
              messageId: localMessageId,
              skipIfMatching: true
            });
            return mergeThreadSnapshot(withoutTemporaryTurn, incoming);
          }
          const keyedThread = {
            ...withoutTemporaryTurn,
            turns: (withoutTemporaryTurn.turns ?? []).map((turn) => turn.id === response.turn.id
              ? { ...turn, renderId: turn.renderId ?? temporaryTurnId }
              : turn)
          };
          const started = applyRuntimePayload(keyedThread, { method: "turn/started", threadId: targetThreadId, turn: response.turn });
          return appendLocalUserMessage(started, {
            turnId: response.turn.id,
            text,
            attachments,
            createdAt,
            messageId: localMessageId,
            skipIfMatching: true
          });
        });
        window.setTimeout(() => void refresh(targetThreadId), 250);
        window.setTimeout(() => void refresh(targetThreadId), 900);
      }
      onThreadActivity(targetThreadId);
      return true;
    } catch (cause) {
      if (mountedRef.current && optimisticTurnId && optimisticMessageId) {
        setSnapshot((current) => removeLocalUserMessage(current, {
          turnId: optimisticTurnId,
          messageId: optimisticMessageId,
          removeEmptyTurn
        }));
      }
      if (!signal?.aborted) {
        setSurfaceError(cause.message);
        onError(cause.message);
      }
      return false;
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const activeTurn = [...(snapshot?.turns ?? [])].reverse().find((turn) => turnIsRunning(turn.status));
  const questionRequest = attention.find((request) => isQuestionRequest(request) && request.params?.threadId === threadId) ?? null;
  const title = snapshot ? threadTitle(snapshot) : tab.title || "New side thread";
  const forkFromSideThread = useCallback((details) => onForkResponse({
    ...details,
    configuration: { model: selectedModel, effort, fastMode, permissionMode }
  }), [effort, fastMode, onForkResponse, permissionMode, selectedModel]);
  const updateDraftState = useCallback(({ hasText, attachmentCount }) => {
    if (tab.payload?.draftHasText === hasText && tab.payload?.draftAttachmentCount === attachmentCount) return;
    onTabUpdate({
      payload: {
        ...tab.payload,
        draftHasText: hasText,
        draftAttachmentCount: attachmentCount
      }
    });
  }, [onTabUpdate, tab.payload]);

  return (
    <section className="side-thread-surface" aria-label={`Side thread: ${title}`} data-composer-drop-scope="local">
      <header className="side-thread-header">
        <div>
          {snapshot ? <StatusDot status={threadStatus(snapshot)} /> : <GitBranch size={14} />}
          <span><strong>{title}</strong><small>{activeTurn ? "Working" : tab.payload?.forkedFromId ? "Forked side thread" : threadId ? "Side thread" : "Starts when you send"}</small></span>
        </div>
        <button type="button" disabled={!threadId} onClick={() => onOpenMain(threadId)}><Eye size={13} />Open as main task</button>
      </header>
      <div
        className="side-thread-scroll"
        ref={scrollRef}
        onScroll={() => {
          const node = scrollRef.current;
          if (node) followLatestRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 96;
        }}
      >
        {loading ? (
          <div className="loading-state"><SpinnerGap className="spin-icon" size={18} />Loading side thread…</div>
        ) : !snapshot ? (
          <div className="side-thread-empty"><GitBranch size={22} /><strong>Start a side thread</strong><p>Ask a related question without leaving the main task.</p></div>
        ) : (
          <div className="side-thread-messages">
            {(snapshot.turns ?? []).length === 0 && <p className="quiet-empty">This side thread has no messages yet.</p>}
            {(snapshot.turns ?? []).map((turn, turnIndex) => (
              <TurnConversation
                thread={snapshot}
                turn={turn}
                turnIndex={turnIndex}
                seenResponseIds={seenResponseIds}
                showTimestamps={preferences.showMessageTimestamps}
                completedWorkDetails={preferences.completedWorkDetails}
                onFork={activeTurn ? null : forkFromSideThread}
                key={turn.renderId ?? turn.id}
              />
            ))}
          </div>
        )}
      </div>
      {surfaceError && <div className="side-thread-error" role="alert"><Warning size={13} />{surfaceError}</div>}
      <Composer
        disabled={!runtime?.connected || !models.length || !providerReady}
        busy={busy}
        draftKey={`${projectId}:side:${threadId ?? tab.payload?.draftId ?? tab.id}`}
        preserveDrafts={preferences.preserveDrafts}
        sendShortcut={preferences.sendShortcut}
        spellCheckComposer={preferences.spellCheckComposer}
        autoFocusComposer={false}
        showSlashCommands={preferences.showSlashCommands}
        slashCommands={snapshot?.slashCommands}
        showPermissionPicker={!enforcedPermissionMode}
        running={Boolean(activeTurn)}
        questionRequest={questionRequest}
        onQuestionResolve={onQuestionResolve}
        models={models}
        selectedModel={selectedModel}
        onModelChange={changeModel}
        effort={effort}
        onEffortChange={(nextEffort) => persistConfiguration({ effort: nextEffort })}
        fastMode={fastMode}
        onFastModeChange={(enabled) => persistConfiguration({ fastMode: enabled })}
        permissionMode={permissionMode}
        onPermissionModeChange={(mode) => persistConfiguration({ permissionMode: mode })}
        providers={providers}
        onProviderLogin={onProviderLogin}
        onProvidersRefresh={onProvidersRefresh}
        onSubmit={submit}
        onDraftStateChange={updateDraftState}
        onInterrupt={async () => {
          if (!threadId || !activeTurn) return;
          try {
            await api.turns.interrupt({ projectId, threadId, turnId: activeTurn.id });
          } catch (cause) {
            setSurfaceError(cause.message);
            onError(cause.message);
          }
        }}
        ariaLabel="Side thread prompt"
        placeholder="Ask a related question"
        runningPlaceholder="Steer the side thread"
        globalFileDrop={false}
        storage={storage}
        accentColor={preferences.accentColor}
        attachmentContext={{ api, hostId: api?.remote?.hostId ?? "local", deviceId: api?.remote?.deviceId, projectId }}
      />
    </section>
  );
}

function TaskMapPreview({ thread, threads, plan, attention, onResolve }) {
  if (!thread) {
    return <div className="file-empty"><TaskMapIcon size={28} /><strong>No active task</strong><small>Open a task before using its Task map.</small></div>;
  }
  const agents = descendantsOf(threads, thread.id);
  return (
    <section className="task-map-preview" aria-label="Task map preview">
      <header><span><TaskMapIcon size={15} />Task map</span><StatusDot status={threadStatus(thread)} /></header>
      <div className="task-map-preview-scroll">
        <section className="inspector-section">
          <span className="section-label">Plan</span>
          {plan?.length ? (
            <div className="inspector-plan">
              {plan.map((step) => <div key={step.step} className={step.status}>{step.status === "completed" ? <CheckCircle size={14} weight="fill" /> : step.status === "inProgress" ? <SpinnerGap className="spin-icon" size={14} /> : <Circle size={14} />}<span>{step.step}</span></div>)}
            </div>
          ) : <p className="inspector-empty">No structured plan reported yet.</p>}
        </section>
        <section className="inspector-section">
          <div className="section-heading"><span className="section-label">Agents</span><small>{agents.length + 1}</small></div>
          <div className="agent-list">
            <InspectorAgentRow agent={thread} lead />
            {agents.map((agent) => <InspectorAgentRow agent={agent} parentTitle={threadTitle(thread)} key={agent.id} />)}
            {agents.length === 0 && <p className="inspector-empty">No delegated agents yet.</p>}
          </div>
        </section>
        {attention.filter((request) => request.params?.threadId === thread.id && !isQuestionRequest(request)).map((request) => <ApprovalCard request={request} onResolve={onResolve} key={request.id} />)}
      </div>
    </section>
  );
}

function EmptyConversation({ project, runtime, onOpenProject }) {
  if (!project) {
    return (
      <div className="empty-state">
        <span className="empty-mark"><FolderOpen size={25} /></span>
        <h1>Create a project</h1>
        <p>Choose a local folder. Pixice will keep its tasks, board, review, and workflows together.</p>
        <button type="button" className="primary-button" onClick={onOpenProject}><FolderOpen size={16} />New project</button>
      </div>
    );
  }
  return (
    <div className="empty-state">
      <span className="empty-mark"><Sparkle size={25} /></span>
      <h1>What are we working on?</h1>
      <p>{runtime.connected ? `Pixice is ready in ${project.displayName}. Start a task to see its conversation, plan, agents, and changes here.` : "The project is ready, but the local agent runtime is not connected yet."}</p>
    </div>
  );
}

function FocusProjectTiles({ project, projects, visibleProjectLimit, onSelectProject }) {
  const menuId = useId();
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const initialMenuFocusRef = useRef("first");
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const visibleProjects = projects.slice(0, visibleProjectLimit);
  const overflowProjects = projects.slice(visibleProjectLimit);

  const restoreTriggerFocus = () => window.setTimeout(() => triggerRef.current?.focus(), reduceMotion ? 0 : 180);

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event) => {
      if (event.type === "keydown" && event.key !== "Escape") return;
      if (event.type === "pointerdown" && rootRef.current?.contains(event.target)) return;
      setOpen(false);
      if (event.type === "keydown") restoreTriggerFocus();
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [open]);

  const selectProject = (projectId) => {
    setOpen(false);
    onSelectProject(projectId);
  };

  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll('[role="menuitemradio"]');
    const target = initialMenuFocusRef.current === "last" ? items?.[items.length - 1] : items?.[0];
    target?.focus();
  }, [open]);

  const openMenu = (focus = "first") => {
    initialMenuFocusRef.current = focus;
    setOpen(true);
  };

  const handleMenuKeyDown = (event) => {
    const items = [...(menuRef.current?.querySelectorAll('[role="menuitemradio"]') ?? [])];
    const currentIndex = items.indexOf(document.activeElement);
    if (!items.length) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      restoreTriggerFocus();
      return;
    }
    let nextIndex = null;
    if (event.key === "ArrowDown") nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    if (event.key === "ArrowUp") nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex == null) return;
    event.preventDefault();
    items[nextIndex].focus();
  };

  return (
    <div className="focus-project-tiles" role="group" aria-label="Projects">
      {visibleProjects.map((candidate) => {
        const selected = candidate.id === project?.id;
        const label = candidate.displayName || "Untitled project";
        return (
          <button
            type="button"
            className={`focus-project-shortcut${selected ? " active" : ""}`}
            style={projectTileStyle(candidate)}
            aria-label={selected ? `${label}, current project` : `Switch to ${label}`}
            aria-current={selected ? "page" : undefined}
            aria-pressed={selected}
            title={label}
            key={candidate.id}
            onClick={() => onSelectProject(candidate.id)}
          >
            <ProjectGlyph icon={candidate.icon} size={14} />
          </button>
        );
      })}
      {overflowProjects.length > 0 && <div className="focus-project-overflow" ref={rootRef}>
        <button
          type="button"
          className="focus-project-overflow-trigger"
          ref={triggerRef}
          aria-label="More projects"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => open ? setOpen(false) : openMenu()}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            openMenu(event.key === "ArrowUp" ? "last" : "first");
          }}
        >
          <CaretDown size={12} />
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              className="focus-project-menu"
              id={menuId}
              ref={menuRef}
              role="menu"
              aria-label="More projects"
              onKeyDown={handleMenuKeyDown}
              initial={reduceMotion ? false : { opacity: 0, y: -5, scale: .975 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: .98 }}
              transition={{ duration: reduceMotion ? 0 : .15, ease: [0.2, 0.8, 0.2, 1] }}
            >
              <div className="focus-project-grid">
                {overflowProjects.map((candidate) => {
                  const selected = candidate.id === project?.id;
                  const label = candidate.displayName || "Untitled project";
                  return (
                    <button
                      type="button"
                      className={`focus-project-option${selected ? " active" : ""}`}
                      role="menuitemradio"
                      aria-checked={selected}
                      aria-label={label}
                      title={label}
                      key={candidate.id}
                      onClick={() => selectProject(candidate.id)}
                    >
                      <span className="focus-project-tile" style={projectTileStyle(candidate)} aria-hidden="true">
                        <ProjectGlyph icon={candidate.icon} size={20} />
                      </span>
                      <span className="focus-project-option-label">{label}</span>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>}
    </div>
  );
}

function focusTaskProgressEntries(threads, focusThreadId) {
  return (threads ?? [])
    .filter((candidate) => candidate.id !== focusThreadId && isSidebarThread(candidate))
    .map((candidate) => {
      const status = threadStatus(candidate);
      const progress = normalizePlanProgress(candidate.planProgress);
      const running = ["running", "inProgress", "active"].includes(status);
      const attention = status === "attention";
      const incomplete = Boolean(progress && progress.completed < progress.total);
      if (!running && !attention && !incomplete) return null;
      return {
        id: candidate.id,
        title: threadTitle(candidate),
        progress,
        state: attention ? "attention" : running ? "running" : "paused",
        updatedAt: candidate.updatedAt ?? 0
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const priority = { attention: 0, running: 1, paused: 2 };
      return priority[left.state] - priority[right.state] || Number(right.updatedAt) - Number(left.updatedAt);
    });
}

function FocusTaskProgressRail({ tasks }) {
  const reduceMotion = useReducedMotion();
  if (!tasks.length) return null;
  return (
    <motion.aside
      className="focus-task-rail"
      aria-label="Task progress overview"
      initial={reduceMotion ? false : { opacity: 0, x: 10, filter: "blur(4px)" }}
      animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
      transition={{ duration: reduceMotion ? 0 : .28, ease: [0.16, 1, 0.3, 1] }}
    >
      <header className="focus-task-rail-header">
        <span><TaskProgressIcon size={14} weight="fill" />Work in flight</span>
        <strong>{tasks.length}</strong>
      </header>
      <div className="focus-task-list">
        {tasks.map((task) => {
          const complete = task.progress?.completed ?? 0;
          const total = task.progress?.total ?? 0;
          const percent = total ? (complete / total) * 100 : 0;
          const stateLabel = task.state === "attention" ? "Needs input" : task.state === "running" ? "Working" : "Paused";
          return (
            <article className="focus-task-item" data-state={task.state} key={task.id}>
              <div className="focus-task-copy">
                <span className="focus-task-state" aria-hidden="true">
                  {task.state === "attention" ? <Warning size={11} weight="fill" /> : task.state === "paused" ? <Pause size={10} weight="fill" /> : <i />}
                </span>
                <span>
                  <strong>{task.title}</strong>
                  <small>{stateLabel}{total ? ` · ${complete} of ${total}` : " · Plan forming"}</small>
                </span>
              </div>
              <div
                className={`focus-task-track${total ? "" : " indeterminate"}`}
                role="progressbar"
                aria-label={`${task.title} progress`}
                aria-valuemin={total ? 0 : undefined}
                aria-valuemax={total || undefined}
                aria-valuenow={total ? complete : undefined}
                aria-valuetext={total ? `${complete} of ${total} complete` : `${stateLabel}, plan forming`}
              >
                <span style={total ? { width: `${percent}%` } : undefined} />
              </div>
            </article>
          );
        })}
      </div>
    </motion.aside>
  );
}

function FocusMemoryControl({ api, projectId, memory, onMemoryChange }) {
  const rootRef = useRef(null);
  const projectIdRef = useRef(projectId);
  const activeRef = useRef(true);
  const [open, setOpen] = useState(false);
  const [projectMemory, setProjectMemory] = useState(memory?.projectMemory ?? "");
  const [userMemory, setUserMemory] = useState(memory?.userMemory ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    projectIdRef.current = projectId;
    setProjectMemory(memory?.projectMemory ?? "");
    setUserMemory(memory?.userMemory ?? "");
  }, [projectId, memory?.projectMemory, memory?.userMemory]);

  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event) => {
      if (event.type === "keydown" && event.key !== "Escape") return;
      if (event.type === "pointerdown" && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [open]);

  if (!api?.focus?.readMemory || !projectId) return null;
  const refresh = async () => {
    const requestedProjectId = projectId;
    const next = await api.focus.readMemory({ projectId });
    if (!activeRef.current || projectIdRef.current !== requestedProjectId) return null;
    onMemoryChange(next);
    return next;
  };
  const toggle = async () => {
    const nextOpen = !open;
    setOpen(nextOpen);
    setError(null);
    if (nextOpen) {
      try { await refresh(); }
      catch (cause) { setError(cause.message); }
    }
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.focus.updateMemory({ projectId, expectedRevision: memory?.revision ?? 0, projectMemory, userMemory });
      if (!activeRef.current || projectIdRef.current !== projectId) return;
      onMemoryChange(next);
      setOpen(false);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    if (!window.confirm("Clear the curated Focus memory for this project? Conversation history will remain available.")) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.focus.clearMemory({ projectId, expectedRevision: memory?.revision ?? 0 });
      if (!activeRef.current || projectIdRef.current !== projectId) return;
      onMemoryChange(next);
      setOpen(false);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="focus-memory-control" ref={rootRef}>
      <IconButton className={`focus-memory-button${open ? " active" : ""}`} label="Focus memory" onClick={toggle}><Brain size={16} /></IconButton>
      {open && <div className="focus-memory-popover" role="dialog" aria-label="Focus memory">
        <header><strong>Project memory</strong><small>Revision {memory?.revision ?? 0}</small></header>
        <label>Project decisions<textarea value={projectMemory} maxLength={6000} onChange={(event) => setProjectMemory(event.target.value)} /></label>
        <label>User preferences<textarea value={userMemory} maxLength={2000} onChange={(event) => setUserMemory(event.target.value)} /></label>
        {error && <p role="alert">{error}</p>}
        <footer><button type="button" onClick={clear} disabled={busy}>Clear</button><button type="button" className="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button></footer>
      </div>}
    </div>
  );
}

function FocusWorkspace({
  api,
  storage,
  project,
  projects,
  thread,
  threads,
  loading,
  runtime,
  models,
  defaultModel,
  defaultEffort,
  defaultFastMode,
  providers,
  attention,
  focusQuestions = [],
  preferences,
  plan,
  seenResponseIds,
  showMessageTimestamps,
  completedWorkDetails,
  composerProps,
  connectionError,
  onRetry,
  memory,
  onMemoryChange,
  onExit,
  onOpenSettings,
  onSelectProject,
  previewOpen,
  onPreviewToggle,
  previewWorkspaceId,
  previewApiWorkspaceId,
  browserState,
  onBrowserState,
  onPreviewBrowserCreated,
  previewFileTabs,
  previewInstrumentTabs,
  previewCustomTabs,
  previewActiveTabId,
  onPreviewActiveTabChange,
  onPreviewBrowserClose,
  onPreviewFileUpdate,
  onPreviewFileClose,
  onPreviewInstrumentClose,
  onPreviewCustomTabOpen,
  onPreviewCustomTabUpdate,
  onPreviewCustomTabClose,
  onPreviewNewTab,
  onPreviewInstrumentRefresh,
  onPreviewInstrumentEvent,
  onPreviewInstrumentInvoke,
  onPreviewInstrumentPin,
  onOpenWorkspaceReference,
  onQuestionResolve,
  onProviderLogin,
  onProvidersRefresh,
  onThreadCreated,
  onThreadActivity,
  onThreadViewed,
  onOpenMain,
  onForkResponse,
  onError,
  onResolveAttention
}) {
  const scrollRef = useRef(null);
  const workspaceRef = useRef(null);
  const composerWrapRef = useRef(null);
  const followLatestRef = useRef(true);
  const [activityPanelOpen, setActivityPanelOpen] = useState(false);
  const [widgetReloadToken, setWidgetReloadToken] = useState(0);
  const [widgetSubmissionError, setWidgetSubmissionError] = useState('');
  const widgetProjectRef = useRef(project?.id);
  widgetProjectRef.current = project?.id;
  const projection = useMemo(() => projectConversation(thread), [thread]);
  const hasConversation = projection.itemCount > 0 || focusQuestions.length > 0;
  const focusActivityAvailable = Boolean(api?.focus?.state && project?.id);
  const progressTasks = useMemo(() => focusTaskProgressEntries(threads, thread?.id), [thread?.id, threads]);
  const taskRailVisible = !previewOpen && progressTasks.length > 0;

  const submitFocusPrompt = async (text, attachments, prepared, sourceAttachments, signal, draftLifecycle) => {
    const sendToConversation = () => composerProps.onSubmit(text, attachments, prepared, sourceAttachments, signal, draftLifecycle);
    if (attachments?.length || !api?.widgets?.draft || !api?.widgets?.commit || !project?.id) return sendToConversation();
    setWidgetSubmissionError('');
    const requestId = globalThis.crypto?.randomUUID?.();
    const cancelDraft = () => { if (requestId) void api.widgets.cancelDraft?.({ projectId: project.id, requestId }); };
    signal?.addEventListener('abort', cancelDraft, { once: true });
    let draft;
    try {
      draft = await api.widgets.draft({ projectId: project.id, text, ...(requestId ? { requestId } : {}), context: { projectName: project.displayName } });
    } catch {
      if (signal?.aborted) return false;
      return sendToConversation();
    } finally {
      signal?.removeEventListener('abort', cancelDraft);
    }
    if (signal?.aborted || widgetProjectRef.current !== project.id) return false;
    if (draft?.status !== 'draft' || draft.projectId !== project.id || !draft.spec) return sendToConversation();
    try {
      await api.widgets.commit({ projectId: project.id, spec: draft.spec });
      if (widgetProjectRef.current === project.id) setWidgetReloadToken((value) => value + 1);
      return true;
    } catch (cause) {
      setWidgetSubmissionError(cause?.message || 'Could not save this widget.');
      return false;
    }
  };

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    const composer = composerWrapRef.current;
    if (!workspace || !composer) return undefined;
    const measure = () => {
      const bounds = workspace.getBoundingClientRect();
      const composerBounds = composer.getBoundingClientRect();
      const rail = workspace.querySelector('.focus-task-rail');
      const railBottom = rail && getComputedStyle(rail).display !== 'none' ? rail.getBoundingClientRect().bottom - bounds.top + 12 : 96;
      const bottom = Math.max(24, Math.ceil(bounds.bottom - composerBounds.top + 16));
      workspace.style.setProperty('--focus-composer-clearance', `${bottom}px`);
      workspace.style.setProperty('--widget-shelf-top-clearance', `${Math.ceil(railBottom)}px`);
      if ((followLatestRef.current || (previewOpen && focusQuestions.length > 0)) && scrollRef.current) {
        requestAnimationFrame(() => {
          if ((followLatestRef.current || (previewOpen && focusQuestions.length > 0)) && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        });
      }
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(workspace);
    observer?.observe(composer);
    const rail = workspace.querySelector('.focus-task-rail');
    if (rail) observer?.observe(rail);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [project?.id, previewOpen, hasConversation, taskRailVisible, focusQuestions.length]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node && followLatestRef.current) node.scrollTop = node.scrollHeight;
  }, [thread?.id, thread?.turns]);

  const previewAvailable = Boolean(
    browserState?.tabs?.length
    || previewFileTabs?.length
    || previewInstrumentTabs?.length
    || previewCustomTabs?.length
  );

  return (
    <WorkspaceOpenContext.Provider value={onOpenWorkspaceReference}>
    <div className={`focus-layout${previewOpen ? " preview-open" : ""}`}>
    <main
      ref={workspaceRef}
      className="focus-workspace"
      data-has-conversation={hasConversation}
      data-question-active={focusQuestions.length > 0}
      data-task-rail={taskRailVisible}
      data-activity-panel={activityPanelOpen}
      style={{ "--focus-background-image": `url(${focusBackgroundDark})` }}
    >
      <div className="focus-atmosphere" aria-hidden="true" />
      <header className="focus-chrome">
        <div className="focus-chrome-start">
          <FocusProjectTiles project={project} projects={projects} visibleProjectLimit={preferences.showThirdProjectRow ? 9 : 6} onSelectProject={onSelectProject} />
        </div>
        <div className="focus-chrome-actions">
          {focusActivityAvailable && <IconButton
            className={`focus-activity-button${activityPanelOpen ? " active" : ""}`}
            label={activityPanelOpen ? "Close activity panel" : "Open activity panel"}
            aria-expanded={activityPanelOpen}
            aria-controls="focus-activity-panel"
            onClick={() => setActivityPanelOpen((current) => !current)}
          >
            <TreeStructure size={16} />
          </IconButton>}
          <FocusMemoryControl key={project?.id} api={api} projectId={project?.id} memory={memory} onMemoryChange={onMemoryChange} />
          {previewAvailable && (
            <IconButton
              className={`focus-preview-button${previewOpen ? " active" : ""}`}
              label={previewOpen ? "Close preview workspace" : "Open preview workspace"}
              onClick={onPreviewToggle}
            >
              <PreviewIcon size={16} />
            </IconButton>
          )}
        </div>
      </header>

      <nav className="focus-navigation-dock" aria-label="Focus navigation">
        <button type="button" className="focus-workspace-button" aria-label="Workspace" title="Workspace" onClick={onExit}>
          <CaretLeft size={15} />
          <span>Workspace</span>
        </button>
        <span className="focus-dock-divider" aria-hidden="true" />
        <IconButton className="focus-settings-button" label="Settings" onClick={onOpenSettings}><Gear size={15} /></IconButton>
      </nav>

      <div
        className="focus-conversation-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          followLatestRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 96;
        }}
      >
        {loading ? (
          <div className="focus-loading"><SpinnerGap className="spin-icon" size={17} />Opening {project?.displayName ?? "project"}…</div>
        ) : hasConversation ? (
          <div className="focus-conversation-column">
            {(thread.turns ?? []).map((turn, turnIndex) => (
              <TurnConversation
                thread={thread}
                turn={turn}
                turnIndex={turnIndex}
                seenResponseIds={seenResponseIds}
                showTimestamps={showMessageTimestamps}
                completedWorkDetails={completedWorkDetails}
                hideToolCalls
                key={turn.renderId ?? turn.id}
              />
            ))}
          </div>
        ) : (
          <div className="focus-intro" aria-live="polite">
            <span className="focus-intro-mark"><Sparkle size={17} weight="fill" /></span>
            <p>One conversation for the whole project</p>
            <h1>Talk to {project?.displayName ?? "your project"}</h1>
          </div>
        )}
        <FocusCoordinatorQuestions key={project?.id} api={api} projectId={project?.id} storage={storage} requests={focusQuestions} onResolve={onQuestionResolve} />
      </div>

      {focusActivityAvailable && <FocusCoordination api={api} projectId={project?.id} models={models} open={activityPanelOpen} onClose={() => setActivityPanelOpen(false)} />}

      {taskRailVisible && <FocusTaskProgressRail tasks={progressTasks} />}

      {project?.id && api?.widgets?.list && !previewOpen && <WidgetShelf key={project.id} projectId={project.id} api={api} storage={storage} reloadToken={widgetReloadToken} hideWhenEmpty className="focus-widget-shelf" />}

      {project && (
        <div className="focus-composer-wrap" ref={composerWrapRef}>
          <Composer
            {...composerProps}
            onSubmit={submitFocusPrompt}
            questionRequest={null}
            disabled={composerProps.disabled || loading || !thread}
            draftKey={`${project.id}:focus`}
            ariaLabel="Project Focus prompt"
            placeholder="Ask, decide, or start something"
            runningPlaceholder="Add direction while Focus is working"
          />
          {widgetSubmissionError && <p className="focus-widget-submit-error" role="alert">{widgetSubmissionError}</p>}
        </div>
      )}
      {connectionError ? (
        <div className="focus-offline focus-connection-error" role="status">
          <span>Coordinator unavailable. Your draft and Focus history are still saved.</span>
          <button type="button" onClick={onRetry}>Retry</button>
        </div>
      ) : !runtime?.connected ? (
        <div className="focus-offline">The agent runtime is reconnecting. Your draft and Focus history are still saved.</div>
      ) : null}
    </main>
    <AnimatePresence initial={false}>
      {previewOpen && (
        <BrowserPanel
          api={api}
          workspaceId={previewWorkspaceId}
          apiWorkspaceId={previewApiWorkspaceId}
          state={browserState}
          onState={onBrowserState}
          onBrowserCreated={onPreviewBrowserCreated}
          onClose={onPreviewToggle}
          projectId={project?.id}
          hostThreadId={thread?.id ?? null}
          fileTabs={previewFileTabs}
          instrumentTabs={previewInstrumentTabs}
          customTabs={previewCustomTabs}
          activeTabId={previewActiveTabId}
          onActiveTabChange={onPreviewActiveTabChange}
          onBrowserClose={onPreviewBrowserClose}
          onFileUpdate={onPreviewFileUpdate}
          onFileClose={onPreviewFileClose}
          onInstrumentClose={onPreviewInstrumentClose}
          onCustomTabOpen={onPreviewCustomTabOpen}
          onCustomTabUpdate={onPreviewCustomTabUpdate}
          onCustomTabClose={onPreviewCustomTabClose}
          onNewTab={onPreviewNewTab}
          onInstrumentRefresh={onPreviewInstrumentRefresh}
          onInstrumentEvent={onPreviewInstrumentEvent}
          onInstrumentInvoke={onPreviewInstrumentInvoke}
          onInstrumentPin={onPreviewInstrumentPin}
          onOpenResource={onOpenWorkspaceReference}
          sideThreadProps={{
            runtime,
            storage,
            models,
            defaultModel,
            defaultEffort,
            defaultFastMode,
            defaultPermissionMode: "full-access",
            enforcedPermissionMode: "full-access",
            providers,
            threads,
            attention,
            preferences,
            seenResponseIds,
            onQuestionResolve,
            onProviderLogin,
            onProvidersRefresh,
            onThreadCreated,
            onThreadActivity,
            onThreadViewed,
            onOpenMain,
            onForkResponse,
            onError
          }}
          taskMapProps={{ thread, threads, plan, attention, onResolve: onResolveAttention }}
        />
      )}
    </AnimatePresence>
    </div>
    </WorkspaceOpenContext.Provider>
  );
}

function ProactiveSuggestionCard({ suggestion, onResolve }) {
  const [busy, setBusy] = useState(false);
  const isWorkflow = suggestion.type === "workflow-pattern";
  const isTaskStatus = suggestion.type === "task-status";
  const steps = isWorkflow ? suggestion.payload?.steps ?? [] : [];
  const acceptLabel = isWorkflow ? "Create draft" : isTaskStatus ? "Mark done" : null;
  const dismissLabel = isTaskStatus ? "Keep active" : isWorkflow ? "Not now" : "Dismiss";
  const Icon = isWorkflow ? TreeStructure : isTaskStatus ? CheckCircle : Sparkle;
  const resolve = async (decision) => {
    setBusy(true);
    try {
      await onResolve(suggestion, decision);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="proactive-suggestion" aria-label={suggestion.title} data-kind={suggestion.type}>
      <span className="proactive-suggestion-icon"><Icon size={15} weight={isWorkflow ? "regular" : "fill"} /></span>
      <div className="proactive-suggestion-copy">
        <span className="proactive-suggestion-eyebrow">Pixice noticed</span>
        <strong>{suggestion.title}</strong>
        <p>{suggestion.message}</p>
        {steps.length > 0 && (
          <ol>
            {steps.slice(0, 4).map((step) => <li key={step.action}>{step.label}</li>)}
            {steps.length > 4 && <li>And {steps.length - 4} more step{steps.length - 4 === 1 ? "" : "s"}</li>}
          </ol>
        )}
      </div>
      <div className="proactive-suggestion-actions">
        <button type="button" onClick={() => void resolve("dismiss")} disabled={busy}>{dismissLabel}</button>
        {acceptLabel && <button type="button" className="primary" onClick={() => void resolve("accept")} disabled={busy}>{busy ? "Working…" : acceptLabel}</button>}
      </div>
    </section>
  );
}

export function ConversationWorkspace({
  api = getPixiceApi(),
  storage = localStorage,
  project,
  thread,
  threads,
  loading,
  runtime,
  plan,
  changedCount,
  seenResponseIds,
  inspectorOpen,
  onInspectorToggle,
  onOpenProject,
  showTaskProgress,
  expandTaskProgress,
  showMessageTimestamps,
  completedWorkDetails,
  previewOpen,
  previewVisible = true,
  onPreviewToggle,
  previewWorkspaceId,
  previewApiWorkspaceId = previewWorkspaceId,
  browserState,
  onBrowserState,
  onPreviewBrowserCreated,
  previewFileTabs,
  previewInstrumentTabs,
  previewCustomTabs,
  previewActiveTabId,
  onPreviewActiveTabChange,
  onPreviewBrowserClose,
  onPreviewFileUpdate,
  onPreviewFileClose,
  onPreviewInstrumentClose,
  onPreviewCustomTabOpen,
  onPreviewCustomTabUpdate,
  onPreviewCustomTabClose,
  onPreviewNewTab,
  onPreviewInstrumentRefresh,
  onPreviewInstrumentEvent,
  onPreviewInstrumentInvoke,
  onPreviewInstrumentPin,
  onOpenWorkspaceReference,
  onOpenBoardWorkspace,
  onOpenWorkflowWorkspace,
  readOnly = false,
  proactiveSuggestions,
  onProactiveSuggestionResolve,
  sideThreadProps,
  taskMapProps,
  receipt,
  onReceiptCompare,
  composerProps,
  executionTargetControl = null,
  executionStatus = null,
  executionAction = null
}) {
  const [previewPresent, setPreviewPresent] = useState(previewOpen);
  const [previewChatWidth, setPreviewChatWidth] = useState(() => {
    const saved = Number.parseInt(storage.getItem(PREVIEW_CHAT_WIDTH_KEY) ?? "", 10);
    return Number.isFinite(saved) ? clampPreviewChatWidth(saved) : null;
  });
  const conversationProjection = useMemo(() => projectConversation(thread), [thread]);
  const promptItems = useMemo(() => promptPreviewItems(thread), [thread]);
  const latestPlanText = conversationProjection.latestPlanText;
  const agents = thread ? descendantsOf(threads, thread.id) : [];
  const touchedFiles = conversationProjection.touchedFileCount || changedCount;
  const scrollRef = useRef(null);
  const workspaceRef = useRef(null);
  const mainCanvasRef = useRef(null);
  const previewResizeCleanupRef = useRef(null);
  const scrollFrameRef = useRef(null);
  const followLatestRef = useRef(true);
  const followedThreadRef = useRef(thread?.id);
  const [activePromptId, setActivePromptId] = useState("");
  useEffect(() => {
    if (previewOpen) setPreviewPresent(true);
  }, [previewOpen]);
  const previewLayoutOpen = previewOpen || previewPresent;
  const updateActivePrompt = useCallback(() => {
    const node = scrollRef.current;
    if (!node || promptItems.length === 0) return;
    const scrollerTop = node.getBoundingClientRect().top;
    const readingLine = scrollerTop + Math.min(node.clientHeight * 0.32, 180);
    let nextId = promptItems[0].id;
    for (const item of promptItems) {
      const target = document.getElementById(item.anchorId);
      if (!target || target.getBoundingClientRect().top > readingLine) break;
      nextId = item.id;
    }
    if (node.scrollHeight - node.scrollTop - node.clientHeight <= 48) {
      nextId = promptItems.at(-1)?.id ?? nextId;
    }
    setActivePromptId((current) => current === nextId ? current : nextId);
  }, [promptItems]);
  useLayoutEffect(() => {
    if (followedThreadRef.current !== thread?.id) {
      followedThreadRef.current = thread?.id;
      followLatestRef.current = true;
      setActivePromptId(promptItems.at(-1)?.id ?? "");
    }
    const node = scrollRef.current;
    if (node && followLatestRef.current) node.scrollTop = node.scrollHeight;
    const frame = window.requestAnimationFrame(updateActivePrompt);
    return () => window.cancelAnimationFrame(frame);
  }, [thread?.id, thread?.turns, promptItems, updateActivePrompt]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node && followLatestRef.current) node.scrollTop = node.scrollHeight;
  }, [composerProps.questionRequest?.id]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
    previewResizeCleanupRef.current?.();
  }, []);

  const previewWorkspaceWidth = () => workspaceRef.current?.getBoundingClientRect().width || window.innerWidth - 64;
  const currentPreviewChatWidth = () => previewChatWidth
    ?? mainCanvasRef.current?.getBoundingClientRect().width
    ?? defaultPreviewChatWidth();

  const resizePreviewFromPointer = (event) => {
    if (!previewOpen) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = currentPreviewChatWidth();
    let nextWidth = startWidth;
    const move = (moveEvent) => {
      nextWidth = clampPreviewChatWidth(startWidth + moveEvent.clientX - startX, previewWorkspaceWidth());
      setPreviewChatWidth(nextWidth);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.classList.remove("preview-resizing");
      storage.setItem(PREVIEW_CHAT_WIDTH_KEY, String(Math.round(nextWidth)));
      previewResizeCleanupRef.current = null;
    };

    document.body.classList.add("preview-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    previewResizeCleanupRef.current = stop;
  };

  const resizePreviewFromKeyboard = (event) => {
    const currentWidth = currentPreviewChatWidth();
    const maximum = clampPreviewChatWidth(MAX_PREVIEW_CHAT_WIDTH, previewWorkspaceWidth());
    const adjustments = {
      ArrowLeft: currentWidth - 16,
      ArrowRight: currentWidth + 16,
      Home: MIN_PREVIEW_CHAT_WIDTH,
      End: maximum
    };
    if (!(event.key in adjustments)) return;
    event.preventDefault();
    const nextWidth = clampPreviewChatWidth(adjustments[event.key], previewWorkspaceWidth());
    setPreviewChatWidth(nextWidth);
    storage.setItem(PREVIEW_CHAT_WIDTH_KEY, String(Math.round(nextWidth)));
  };

  const resetPreviewSplit = () => {
    setPreviewChatWidth(null);
    storage.removeItem(PREVIEW_CHAT_WIDTH_KEY);
  };

  const handleConversationScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    followLatestRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 96;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      updateActivePrompt();
    });
  };

  const handlePromptSelect = (item) => {
    const node = scrollRef.current;
    const target = document.getElementById(item.anchorId);
    if (!node || !target) return;
    const top = node.scrollTop + target.getBoundingClientRect().top - node.getBoundingClientRect().top - 28;
    const reduceMotion = document.querySelector(".pixice-app")?.dataset.reduceMotion === "true"
      || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    followLatestRef.current = false;
    setActivePromptId(item.id);
    node.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? "auto" : "smooth" });
  };

  return (
    <WorkspaceOpenContext.Provider value={onOpenWorkspaceReference}>
    <div
      className={`task-workspace${previewLayoutOpen ? " preview-mode" : ""}`}
      data-question-active={Boolean(composerProps.questionRequest && composerProps.questionRequest.params?.isBlocking !== false)}
      ref={workspaceRef}
      style={previewChatWidth === null ? undefined : { "--preview-chat-width": `${previewChatWidth}px` }}
    >
      <main className="main-canvas" ref={mainCanvasRef}>
        <AppToolbar
          title={thread ? threadTitle(thread) : project?.displayName ?? "Pixice"}
          subtitle={thread ? project?.displayName : project?.canonicalPath}
          inspectorOpen={inspectorOpen}
          onInspectorToggle={onInspectorToggle}
          showInspector={Boolean(thread) && !previewLayoutOpen && !readOnly}
          previewOpen={previewOpen}
          onPreviewToggle={onPreviewToggle}
          showPreview={Boolean(project) && !readOnly}
          executionStatus={executionStatus}
          executionAction={executionAction}
        />
        {!previewLayoutOpen && thread && (
          <PromptPreviewRail
            items={promptItems}
            activeId={activePromptId}
            onItemSelect={handlePromptSelect}
          />
        )}
        <div className="conversation-scroll" ref={scrollRef} onScroll={handleConversationScroll}>
          {loading ? (
            <div className="loading-state"><SpinnerGap className="spin-icon" size={20} />Loading conversation…</div>
          ) : !thread ? (
            <EmptyConversation project={project} runtime={runtime} onOpenProject={onOpenProject} />
          ) : (
            <div className="conversation-column">
              <div className="message-stream">
                {conversationProjection.itemCount === 0 && <p className="quiet-empty">This task has no messages yet.</p>}
                {(thread.turns ?? []).map((turn, turnIndex) => (
                  <TurnConversation
                    thread={thread}
                    turn={turn}
                    turnIndex={turnIndex}
                    seenResponseIds={seenResponseIds}
                    showTimestamps={showMessageTimestamps}
                    completedWorkDetails={completedWorkDetails}
                    onImageRevision={readOnly ? undefined : composerProps.onImageRevision}
                    imageRevisionDisabled={composerProps.busy}
                    onFork={readOnly || composerProps.running ? null : composerProps.onForkResponse}
                    receipt={turnIndex === thread.turns.length - 1 ? receipt : null}
                    onReceiptCompare={onReceiptCompare}
                    key={turn.renderId ?? turn.id}
                  />
                ))}
              </div>
              {proactiveSuggestions.some((suggestion) => !receipt || suggestion.type !== "task-status") && (
                <div className="proactive-suggestions" aria-label="Pixice suggestions">
                  {proactiveSuggestions.filter((suggestion) => !receipt || suggestion.type !== "task-status").map((suggestion) => <ProactiveSuggestionCard suggestion={suggestion} onResolve={onProactiveSuggestionResolve} key={suggestion.id} />)}
                </div>
              )}
              {showTaskProgress && (
                <PlanPanel
                  plan={plan}
                  fallbackText={latestPlanText}
                  thread={thread}
                  agents={agents}
                  fileCount={touchedFiles}
                  running={composerProps.running}
                  inspectorOpen={inspectorOpen}
                  onInspectorToggle={onInspectorToggle}
                  defaultExpanded={expandTaskProgress}
                />
              )}
            </div>
          )}
        </div>
        {project && !readOnly && (executionTargetControl ? (
          <div className="composer-dock">
            <div className="execution-preflight">{executionTargetControl}</div>
            <Composer {...composerProps} />
          </div>
        ) : <Composer {...composerProps} />)}
      </main>
      {previewLayoutOpen && (
        <div
          className="preview-resizer"
          role="separator"
          aria-label="Resize chat and preview"
          aria-orientation="vertical"
          aria-valuemin={MIN_PREVIEW_CHAT_WIDTH}
          aria-valuemax={MAX_PREVIEW_CHAT_WIDTH}
          aria-valuenow={Math.round(previewChatWidth ?? defaultPreviewChatWidth())}
          tabIndex={previewOpen ? 0 : -1}
          title="Drag to resize · Double-click to reset"
          onDoubleClick={resetPreviewSplit}
          onPointerDown={resizePreviewFromPointer}
          onKeyDown={resizePreviewFromKeyboard}
        />
      )}
      <AnimatePresence initial={false} onExitComplete={() => setPreviewPresent(false)}>
        {previewOpen && !readOnly && (
          <BrowserPanel
            api={api}
            workspaceId={previewWorkspaceId}
            apiWorkspaceId={previewApiWorkspaceId}
            state={browserState}
            onState={onBrowserState}
            onBrowserCreated={onPreviewBrowserCreated}
            onClose={onPreviewToggle}
            projectId={project?.id}
            hostThreadId={thread?.id ?? null}
            fileTabs={previewFileTabs}
            instrumentTabs={previewInstrumentTabs}
            customTabs={previewCustomTabs}
            activeTabId={previewActiveTabId}
            onActiveTabChange={onPreviewActiveTabChange}
            onBrowserClose={onPreviewBrowserClose}
            onFileUpdate={onPreviewFileUpdate}
            onFileClose={onPreviewFileClose}
            onInstrumentClose={onPreviewInstrumentClose}
            onCustomTabOpen={onPreviewCustomTabOpen}
            onCustomTabUpdate={onPreviewCustomTabUpdate}
            onCustomTabClose={onPreviewCustomTabClose}
            onNewTab={onPreviewNewTab}
            onInstrumentRefresh={onPreviewInstrumentRefresh}
            onInstrumentEvent={onPreviewInstrumentEvent}
            onInstrumentInvoke={onPreviewInstrumentInvoke}
            onInstrumentPin={onPreviewInstrumentPin}
            onOpenResource={onOpenWorkspaceReference}
            onOpenBoardWorkspace={onOpenBoardWorkspace}
            onOpenWorkflowWorkspace={onOpenWorkflowWorkspace}
            sideThreadProps={sideThreadProps}
            taskMapProps={taskMapProps}
            visible={previewVisible}
          />
        )}
      </AnimatePresence>
    </div>
    </WorkspaceOpenContext.Provider>
  );
}

function elicitationInitialValues(schema) {
  return Object.fromEntries(Object.entries(schema?.properties ?? {}).map(([name, field]) => {
    if (field.default !== undefined) return [name, field.default];
    if (field.type === "boolean") return [name, false];
    if (field.type === "array") return [name, []];
    return [name, ""];
  }));
}

function elicitationOptions(field) {
  const source = field.type === "array" ? field.items ?? {} : field;
  if (Array.isArray(source.oneOf)) return source.oneOf.map((option) => ({ value: option.const, label: option.title ?? String(option.const) }));
  if (Array.isArray(source.anyOf)) return source.anyOf.map((option) => ({ value: option.const, label: option.title ?? String(option.const) }));
  return (source.enum ?? []).map((value, index) => ({ value, label: source.enumNames?.[index] ?? String(value) }));
}

function coerceElicitationValue(field, value) {
  if (field.type === "number") return Number(value);
  if (field.type === "integer") return Number.parseInt(value, 10);
  return value;
}

export function ApprovalCard({ request, onResolve }) {
  const method = request.method ?? "Approval";
  const params = request.params ?? {};
  const isApproval = method.includes("requestApproval") || method === "applyPatchApproval" || method === "execCommandApproval";
  const isUserInput = method.includes("requestUserInput");
  const isElicitation = method.toLowerCase().includes("elicitation");
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const [answers, setAnswers] = useState({});
  const elicitationSchema = params.requestedSchema ?? {};
  const elicitationFields = Object.entries(elicitationSchema.properties ?? {});
  const requiredElicitationFields = new Set(elicitationSchema.required ?? []);
  const [elicitationValues, setElicitationValues] = useState(() => elicitationInitialValues(elicitationSchema));
  const summary = params.message || params.command || params.reason || params.cwd || method.replaceAll("/", " · ");
  const submitAnswers = () => onResolve(request, Object.fromEntries(questions.map((question, index) => {
    const id = question.id ?? `question-${index + 1}`;
    return [id, { answers: [answers[id]?.trim()].filter(Boolean) }];
  })));
  const submitElicitation = () => onResolve(request, {
    action: "accept",
    content: Object.fromEntries(elicitationFields.map(([name, field]) => [name, coerceElicitationValue(field, elicitationValues[name])]))
  });
  const elicitationComplete = elicitationFields.every(([name, field]) => {
    if (!requiredElicitationFields.has(name)) return true;
    const value = elicitationValues[name];
    if (field.type === "boolean") return typeof value === "boolean";
    if (field.type === "array") return Array.isArray(value) && value.length > 0;
    return String(value ?? "").trim().length > 0;
  });
  return (
    <section className="approval-card">
      <div className="approval-title"><Warning size={17} weight="fill" /><strong>{isApproval ? "Approval required" : isElicitation ? (params.serverName ? `${params.serverName} needs input` : "Input required") : "Attention required"}</strong></div>
      <p>{summary}</p>
      {(params.cwd || request.projectId) && <small className="approval-context">{params.cwd ?? `Project ${request.projectId}`}</small>}
      {isApproval ? (
        <div className="approval-actions">
          <button className="approve" onClick={() => onResolve(request, "accept")}><Check size={15} />Approve</button>
          <button onClick={() => onResolve(request, "decline")}><X size={15} />Decline</button>
          {params.allowForSession !== false && <button onClick={() => onResolve(request, "acceptForSession")}>Allow for session</button>}
        </div>
      ) : isElicitation ? (
        <div className="approval-questions elicitation-form">
          {params.mode === "url" && params.url && (
            <a className="elicitation-link" href={params.url} target="_blank" rel="noreferrer"><Globe size={15} />Open request</a>
          )}
          {elicitationFields.map(([name, field]) => {
            const options = elicitationOptions(field);
            const label = field.title ?? name.replaceAll("_", " ");
            const value = elicitationValues[name];
            if (field.type === "boolean") {
              return (
                <label className="elicitation-checkbox" key={name}>
                  <input type="checkbox" checked={Boolean(value)} onChange={(event) => setElicitationValues((current) => ({ ...current, [name]: event.target.checked }))} />
                  <span>{label}{field.description && <small>{field.description}</small>}</span>
                </label>
              );
            }
            if (field.type === "array" && options.length) {
              return (
                <fieldset key={name}>
                  <legend>{label}{requiredElicitationFields.has(name) ? " *" : ""}</legend>
                  {field.description && <small>{field.description}</small>}
                  {options.map((option) => (
                    <label key={String(option.value)}>
                      <input type="checkbox" checked={(value ?? []).includes(option.value)} onChange={(event) => setElicitationValues((current) => ({
                        ...current,
                        [name]: event.target.checked ? [...(current[name] ?? []), option.value] : (current[name] ?? []).filter((candidate) => candidate !== option.value)
                      }))} />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </fieldset>
              );
            }
            return (
              <label className="elicitation-field" key={name}>
                <span>{label}{requiredElicitationFields.has(name) ? " *" : ""}{field.description && <small>{field.description}</small>}</span>
                {options.length ? (
                  <select aria-label={label} value={value ?? ""} onChange={(event) => setElicitationValues((current) => ({ ...current, [name]: event.target.value }))}>
                    <option value="">Select…</option>
                    {options.map((option) => <option value={option.value} key={String(option.value)}>{option.label}</option>)}
                  </select>
                ) : (
                  <input
                    aria-label={label}
                    type={field.type === "number" || field.type === "integer" ? "number" : field.format === "password" ? "password" : "text"}
                    value={value ?? ""}
                    min={field.minimum}
                    max={field.maximum}
                    minLength={field.minLength}
                    maxLength={field.maxLength}
                    onChange={(event) => setElicitationValues((current) => ({ ...current, [name]: event.target.value }))}
                  />
                )}
              </label>
            );
          })}
          <div className="approval-actions">
            <button className="approve" disabled={elicitationFields.length > 0 && !elicitationComplete} onClick={() => params.mode === "url" || elicitationFields.length === 0 ? onResolve(request, { action: "accept" }) : submitElicitation()}><Check size={15} />Continue</button>
            <button onClick={() => onResolve(request, { action: "decline" })}><X size={15} />Decline</button>
            <button onClick={() => onResolve(request, { action: "cancel" })}>Cancel task</button>
          </div>
        </div>
      ) : isUserInput && questions.length ? (
        <div className="approval-questions">
          {questions.map((question, index) => {
            const id = question.id ?? `question-${index + 1}`;
            return (
              <fieldset key={id}>
                <legend>{question.question ?? question.header ?? `Question ${index + 1}`}</legend>
                {(question.options ?? []).map((option) => (
                  <label key={option.label}>
                    <input type="radio" name={`${request.id}-${id}`} checked={answers[id] === option.label} onChange={() => setAnswers((current) => ({ ...current, [id]: option.label }))} />
                    <span>{option.label}{option.description && <small>{option.description}</small>}</span>
                  </label>
                ))}
                <input aria-label={`Custom answer for ${question.header ?? id}`} value={(question.options ?? []).some((option) => option.label === answers[id]) ? "" : answers[id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [id]: event.target.value }))} placeholder="Custom answer" />
              </fieldset>
            );
          })}
          <button className="approve" disabled={questions.some((question, index) => !(answers[question.id ?? `question-${index + 1}`] ?? "").trim())} onClick={submitAnswers}><Check size={15} />Submit answers</button>
        </div>
      ) : <small>This request type is not supported by this Pixice version.</small>}
    </section>
  );
}

function agentStatusCopy(agent) {
  const activeTurn = [...(agent?.turns ?? [])].reverse().find((turn) => turnIsRunning(turn.status));
  if (turnIsCompacting(activeTurn)) return "Compacting";
  const status = threadStatus(agent);
  if (status === "running" || status === "inProgress") return "Working";
  if (status === "completed" || status === "idle") return "Completed";
  if (status === "failed" || status === "systemError") return "Failed";
  if (status === "interrupted") return "Interrupted";
  return "Waiting";
}

function activeAgentStartedAt(agent) {
  const activeTurn = [...(agent?.turns ?? [])].reverse().find((turn) => turnIsRunning(turn.status));
  return activeTurn?.startedAt ?? activeTurn?.createdAt ?? agent?.startedAt ?? agent?.createdAt;
}

function InspectorAgentRow({ agent, lead = false, parentTitle = "" }) {
  const status = threadStatus(agent);
  const running = status === "running" || status === "inProgress";
  const activeTurn = [...(agent?.turns ?? [])].reverse().find((turn) => turnIsRunning(turn.status));
  const compacting = turnIsCompacting(activeTurn);
  const startedAt = activeAgentStartedAt(agent);
  const title = threadTitle(agent);
  const detail = lead
    ? title
    : agent.agentStatusMessage || (title !== parentTitle ? title : "");
  const name = lead ? "Lead" : agent.agentNickname || agent.agentRole || "Delegated agent";
  return (
    <div className={`agent-row ${lead ? "lead" : "child"}`}>
      {!lead && <span className="branch-line" />}
      <StatusDot status={status} />
      <span>
        <strong>{name}</strong>
        <small>
          {running && timestampMillis(startedAt)
            ? <ElapsedTime startedAt={startedAt} running prefix={compacting ? "Compacting for " : "Working for "} />
            : agentStatusCopy(agent)}
          {detail ? ` · ${detail}` : ""}
        </small>
      </span>
    </div>
  );
}

export function Inspector({ open, thread, threads, plan, attention, onResolve }) {
  const systemReducedMotion = useReducedMotion();
  if (!thread) return null;
  const agents = descendantsOf(threads, thread.id);
  return (
    <AnimatePresence initial={false}>
    {open && <motion.aside
      className="inspector open"
      aria-label="Task inspector"
      initial={systemReducedMotion ? false : { opacity: 0, x: 12, y: 2, scale: 0.985, filter: "blur(2px)" }}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1, filter: "blur(0px)" }}
      exit={systemReducedMotion ? { opacity: 0 } : { opacity: 0, x: 10, scale: 0.99, filter: "blur(2px)" }}
      transition={{ duration: systemReducedMotion ? 0 : 0.22, ease: MOTION_EASE }}
    >
      <div className="inspector-head"><span>Task</span><StatusDot status={threadStatus(thread)} /></div>
      <section className="inspector-section">
        <span className="section-label">Plan</span>
        {plan?.length ? (
          <div className="inspector-plan">
            {plan.map((step) => <motion.div layout="position" transition={{ duration: systemReducedMotion ? 0 : 0.2, ease: MOTION_EASE }} key={step.step} className={step.status}>{step.status === "completed" ? <CheckCircle size={14} weight="fill" /> : step.status === "inProgress" ? <SpinnerGap className="spin-icon" size={14} /> : <Circle size={14} />}<span>{step.step}</span></motion.div>)}
          </div>
        ) : <p className="inspector-empty">No structured plan reported yet.</p>}
      </section>
      <section className="inspector-section">
        <div className="section-heading"><span className="section-label">Agents</span><small>{agents.length + 1}</small></div>
        <div className="agent-list">
          <InspectorAgentRow agent={thread} lead />
          {agents.map((agent) => <InspectorAgentRow agent={agent} parentTitle={threadTitle(thread)} key={agent.id} />)}
          {agents.length === 0 && <p className="inspector-empty">No delegated agents yet.</p>}
        </div>
      </section>
      {attention.filter((request) => request.params?.threadId === thread.id && !isQuestionRequest(request)).map((request) => <ApprovalCard request={request} onResolve={onResolve} key={request.id} />)}
    </motion.aside>}
    </AnimatePresence>
  );
}

function FileDiff({ file }) {
  if (!file) return null;
  const rows = Array.isArray(file.rows) ? file.rows : [];
  return (
    <div className="file-diff">
      <div className="file-diff-head">
        <span className="file-diff-name">
          <Code size={15} aria-hidden="true" />
          <span>{file.path}</span>
        </span>
        <span className="file-diff-stat" aria-label={`${file.plus} additions and ${file.minus} deletions`}>
          <span className="add">+{file.plus}</span>
          <span className="del">−{file.minus}</span>
        </span>
      </div>
      <div className="file-diff-body">
        {rows.length ? rows.map((row, index) => (
          <div className={`file-diff-row ${row.type}`} key={`${index}-${row.old ?? ""}-${row.cur ?? ""}`}>
            <span className="line-number old-line">{row.old ?? ""}</span>
            <span className="line-number new-line">{row.cur ?? ""}</span>
            <span className="diff-sign" aria-hidden="true">{row.type === "add" ? "+" : row.type === "del" ? "−" : ""}</span>
            <code>{row.text || " "}</code>
          </div>
        )) : <p className="file-diff-empty">No textual diff is available for this file.</p>}
      </div>
    </div>
  );
}

export function renderCapturedChanges(changes) {
  const roots = [...new Set(changes.files.map((file) => file.root))];
  const parsedByRoot = new Map(roots.map((root) => [root, reviewFiles(changes.repositoryPatches?.find((entry) => entry.root === root)?.patch ?? (roots.length === 1 ? changes.patch ?? "" : ""), [])]));
  return changes.files.map((file, index) => {
    const diff = parsedByRoot.get(file.root)?.find((candidate) => candidate.path === file.path);
    return <details className="receipt-captured-file" key={`${file.root}:${file.path}:${index}`}>
      <summary><File size={13} /><span>{file.path}{roots.length > 1 && <small> · {file.root}</small>}</span><span className="file-diff-stat"><span className="add">+{file.plus}</span><span className="del">−{file.minus}</span></span></summary>
      {diff?.rows?.length ? <FileDiff file={{ ...file, ...diff }} /> : <p className="receipt-note">{file.binary ? "Binary file changed." : "No captured text diff is available for this file."}</p>}
    </details>;
  });
}

export function preserveReceiptEvidence(incoming, previous) {
  return incoming.map((receipt) => {
    const cached = previous.find((candidate) => candidate.threadId === receipt.threadId);
    if (receipt.changes?.patch !== undefined || !cached?.changes || cached.revision !== receipt.revision || cached.status !== receipt.status || cached.completedAt !== receipt.completedAt) return receipt;
    return { ...receipt, changes: { ...receipt.changes, patch: cached.changes.patch, repositoryPatches: cached.changes.repositoryPatches } };
  });
}

function ReviewWorkspace({ project, review, loading, fileLoadingPath, gitStatus, gitBusy, onLoadFile, onRefresh, onInstallGit, onExternal }) {
  const currentReview = review?.projectId === project?.id ? review : null;
  const legacyFiles = useMemo(
    () => reviewFiles(currentReview?.diff, currentReview?.repository?.dirtyPaths),
    [currentReview?.diff, currentReview?.repository?.dirtyPaths]
  );
  const files = Array.isArray(currentReview?.files) ? currentReview.files : legacyFiles;
  const [selectedPath, setSelectedPath] = useState(null);
  useEffect(() => {
    setSelectedPath((current) => current && files.some((file) => file.path === current)
      ? current
      : files[0]?.path ?? null);
  }, [files]);
  const selectedManifest = files.find((file) => file.path === selectedPath) ?? files[0];
  const selectedPatch = selectedManifest ? currentReview?.fileDiffs?.[selectedManifest.path] : undefined;
  const selectedParsed = selectedPatch === undefined
    ? legacyFiles.find((file) => file.path === selectedManifest?.path)
    : reviewFiles(selectedPatch, [selectedManifest.path])[0];
  const selected = selectedManifest ? { ...selectedManifest, ...selectedParsed } : null;
  const selectedDiffPending = Boolean(selectedManifest && Array.isArray(currentReview?.files) && selectedPatch === undefined);
  const dirtyCount = currentReview?.repository?.dirtyPaths?.length ?? 0;
  const blockingLoad = loading && !currentReview;
  const repositoryGit = currentReview?.repository?.git;
  const effectiveGit = gitStatus?.installRequested ? gitStatus : repositoryGit;
  const gitUnavailable = Boolean(effectiveGit && effectiveGit.available === false);

  useEffect(() => {
    if (!selectedManifest || !Array.isArray(currentReview?.files) || selectedPatch !== undefined || fileLoadingPath === selectedManifest.path) return;
    onLoadFile(selectedManifest.path);
  }, [currentReview?.files, fileLoadingPath, onLoadFile, selectedManifest, selectedPatch]);

  return (
    <main className="main-canvas workspace">
      <AppToolbar title="Review changes" subtitle={project?.displayName} />
      <div className="workspace-header">
        <div>
          <span>Working tree</span>
          <h1>{project?.displayName ?? "Review"}</h1>
          <p>{gitUnavailable ? "Git features unavailable" : `${dirtyCount} changed file${dirtyCount === 1 ? "" : "s"}`}</p>
        </div>
        <div>
          <button onClick={() => onExternal("terminal")}><TerminalWindow size={16} />Terminal</button>
          <button onClick={() => onExternal("editor", selected?.path)}><Desktop size={16} />Editor</button>
          <button onClick={() => onExternal("reveal")}><FolderOpen size={16} />Reveal</button>
          <IconButton label="Refresh review" onClick={onRefresh}><ArrowClockwise className={loading ? "spin-icon" : ""} size={17} /></IconButton>
        </div>
      </div>
      {blockingLoad ? <div className="loading-state"><SpinnerGap className="spin-icon" size={20} />Reading Git changes…</div> : gitUnavailable ? (
        <div className="empty-state compact git-unavailable-state">
          <GitBranch size={28} />
          <h2>{effectiveGit.state === "install-requested" ? "Finish installing Git" : "Git is not available yet"}</h2>
          <p>{effectiveGit.message} File editing, agents, Preview, Board, and Workflows remain available.</p>
          <div className="git-empty-actions">
            {effectiveGit.installSupported && effectiveGit.state !== "install-requested" && <button className="settings-action primary" disabled={gitBusy} onClick={onInstallGit}>{gitBusy ? <SpinnerGap className="spin-icon" size={14} /> : null}Install Apple Command Line Tools</button>}
            <button className="settings-action" disabled={gitBusy} onClick={onRefresh}><ArrowClockwise className={gitBusy ? "spin-icon" : ""} size={14} />Check again</button>
          </div>
        </div>
      ) : files.length === 0 ? (
        <div className="empty-state compact"><CheckCircle size={28} weight="fill" /><h2>Working tree is clean</h2><p>Changes made by Codex will appear here.</p></div>
      ) : (
        <div className="review-layout">
          <aside className="file-browser">
            <div className="list-label">Changed files</div>
            {files.map((file) => {
              const displayPath = file.path.replace(/\/$/, "");
              const parts = displayPath.split("/");
              return (
                <button key={file.path} className={file.path === selected?.path ? "selected" : ""} onClick={() => setSelectedPath(file.path)}>
                  {file.path.endsWith("/") ? <Folder size={16} /> : <File size={16} />}
                  <span><strong>{parts.pop()}</strong><small>{parts.join("/")}</small></span><b>+{file.plus}</b><em>−{file.minus}</em>
                </button>
              );
            })}
          </aside>
          <section className="diff-panel">
            {selectedDiffPending
              ? <div className="loading-state"><SpinnerGap className="spin-icon" size={18} />Reading file diff…</div>
              : <FileDiff file={selected} />}
          </section>
        </div>
      )}
    </main>
  );
}

function SettingsToggle({ label, checked, onChange }) {
  return (
    <label className="settings-toggle">
      <input type="checkbox" aria-label={label} checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span aria-hidden="true"><i /></span>
    </label>
  );
}

const ACCENT_COLOR_OPTIONS = [
  { value: "coral", label: "Coral" },
  { value: "rose", label: "Rose" },
  { value: "amber", label: "Amber" },
  { value: "green", label: "Green" },
  { value: "teal", label: "Teal" },
  { value: "blue", label: "Blue" },
  { value: "violet", label: "Violet" },
  { value: "graphite", label: "Graphite" }
];

function AccentColorPicker({ value, onChange }) {
  return (
    <div className="accent-color-picker" role="radiogroup" aria-label="Accent color">
      {ACCENT_COLOR_OPTIONS.map((option) => {
        const selected = value === option.value;
        return (
          <button
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`${option.label} accent`}
            title={option.label}
            data-color={option.value}
            onClick={() => onChange(option.value)}
            key={option.value}
          >
            {selected && <Check size={11} weight="bold" />}
          </button>
        );
      })}
    </div>
  );
}

function SettingsRow({ title, description, children, hostOnly = false }) {
  const disabled = hostOnly && Boolean(getPixiceApi()?.remote);
  return (
    <div className="preference-row">
      <span><strong>{title}</strong><small>{description}{disabled ? " Change this on the host desktop." : ""}</small></span>
      {disabled ? <fieldset className="preference-control connect-host-setting" disabled>{children}</fieldset> : <div className="preference-control">{children}</div>}
    </div>
  );
}

function SettingsGroup({ title, description, children }) {
  return (
    <section className="settings-group">
      <header><h2>{title}</h2>{description && <p>{description}</p>}</header>
      <div className="settings-card">{children}</div>
    </section>
  );
}

function SlidingSegmented({ value, options, onChange, label, className = "" }) {
  const layoutId = useId();
  const systemReducedMotion = useReducedMotion();
  return (
    <div className={`segmented sliding-segmented ${className}`.trim()} aria-label={label}>
      {options.map((option) => (
        <button type="button" className={value === option.value ? "selected" : ""} onClick={() => onChange(option.value)} key={option.value}>
          {value === option.value && <motion.span className="segmented-pill" layoutId={`segmented-${layoutId}`} transition={{ duration: systemReducedMotion ? 0 : 0.2, ease: MOTION_EASE }} />}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

function LoadingSkeleton({ label, rows = 3, inline = true }) {
  return (
    <div className={`loading-skeleton${inline ? " inline" : ""}`} role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <span className="loading-skeleton-row" style={{ "--skeleton-width": `${92 - index * 11}%` }} key={index}><i /><b /></span>
      ))}
      <span className="visually-hidden">{label}</span>
    </div>
  );
}

function CapabilitiesSettings({ extensions, loading, onRefresh }) {
  const [tab, setTab] = useState("skills");
  const [query, setQuery] = useState("");
  const groups = {
    skills: extensions.skills.flatMap((entry) => entry.skills ?? []),
    apps: extensions.apps,
    mcp: extensions.mcp
  };
  const visible = groups[tab].filter((item) => {
    const name = item.name || item.displayName || item.id || "";
    return name.toLowerCase().includes(query.toLowerCase());
  });
  const Icon = tab === "skills" ? Sparkle : tab === "apps" ? Globe : PlugsConnected;
  return (
    <div className="capabilities-pane">
      <div className="settings-controls">
        <SlidingSegmented
          value={tab}
          options={Object.keys(groups).map((name) => ({ value: name, label: name === "mcp" ? "MCP servers" : name[0].toUpperCase() + name.slice(1) }))}
          onChange={setTab}
          label="Capability type"
        />
        <IconButton label="Refresh capabilities" onClick={onRefresh}><ArrowClockwise size={17} /></IconButton>
      </div>
      <label className="search-field"><MagnifyingGlass size={17} /><input aria-label="Search capabilities" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${tab === "mcp" ? "MCP servers" : tab}`} /></label>
      {loading ? <LoadingSkeleton label="Loading capabilities" rows={4} /> : (
        <div className="capabilities-list">
          {visible.map((item, index) => {
            const name = item.name || item.displayName || item.id || `Capability ${index + 1}`;
            const detail = item.description || item.shortDescription || item.serverInfo?.description || (tab === "mcp" ? `${Object.keys(item.tools ?? {}).length} tools · ${item.authStatus ?? "available"}` : "Available");
            return <div className="capability-row" key={item.id ?? item.path ?? name}><span className="extension-icon"><Icon size={19} /></span><span><strong>{name}</strong><small>{detail}</small></span><span className="availability"><CheckCircle size={15} weight="fill" />Available</span></div>;
          })}
          {visible.length === 0 && <p className="settings-empty">No matching {tab === "mcp" ? "MCP servers" : tab} reported by Codex.</p>}
        </div>
      )}
      {extensions.errors.length > 0 && <div className="policy-row"><Info size={17} /><span><strong>Some capability sources did not load</strong><small>{extensions.errors.join(" · ")}</small></span></div>}
    </div>
  );
}

function providerAccountDetail(provider) {
  const account = provider.account;
  if (!account) return provider.accountError || "No account detected";
  const identity = account.email || account.organization || (account.type === "apiKey" ? "API key" : "Connected account");
  const plan = account.planType || account.subscriptionType;
  return plan ? `${identity} · ${String(plan).replaceAll("_", " ")}` : identity;
}

function providerIsAuthenticated(provider) {
  if (!provider) return false;
  return provider.authenticated ?? (Boolean(provider.account) || provider.requiresAuth === false);
}

const PROVIDER_SETTINGS_DEFINITIONS = [
  { id: "codex", label: "OpenAI Codex", runtimeLabel: "Codex", model: "gpt" },
  { id: "claude", label: "Anthropic Claude", runtimeLabel: "Claude Code", model: "claude" }
];

function providerLifecycle(provider) {
  const installed = provider.installed ?? Boolean(provider.executablePath || provider.connected);
  const healthState = provider.health?.state;
  const installBusy = Boolean(provider.installState?.operation && !["failed", "succeeded", "idle"].includes(provider.installState?.state));
  const updateBusy = ["checking", "updating"].includes(provider.updateState?.state);
  const busy = installBusy || updateBusy;
  const requiresRepair = healthState === "broken" || (provider.compatible === false && healthState !== "missing" && (installed || healthState === undefined));
  const missing = healthState === "missing" || (!installed && !requiresRepair);
  const actionAvailable = (action, fallback) => provider.actions?.[action] ?? provider[`${action}Available`] ?? fallback;
  return {
    installed,
    missing,
    requiresRepair,
    busy,
    updateAvailable: provider.updateState?.state === "available" && Boolean(provider.updateState?.availableVersion),
    detail: provider.updateState?.error || provider.updateState?.message || provider.installState?.error || provider.installState?.progress || provider.installState?.message || provider.health?.message || provider.status?.message || null,
    actions: {
      install: actionAvailable("install", missing && !busy),
      locate: actionAvailable("locate", !busy),
      repair: actionAvailable("repair", requiresRepair && !busy),
      checkUpdate: actionAvailable("checkUpdate", installed && !requiresRepair && !busy),
      update: actionAvailable("update", provider.updateState?.state === "available" && !busy),
      login: actionAvailable("login", installed && !requiresRepair && !busy),
      logout: actionAvailable("logout", installed && !requiresRepair && !busy)
    }
  };
}

function providerStatusLabel(provider, lifecycle, connected) {
  if (provider.updateState?.state === "checking") return "Checking updates";
  if (provider.updateState?.state === "updating") return "Updating";
  if (lifecycle.busy) return provider.installState?.message || "Working";
  if (lifecycle.missing) return "Not installed";
  if (lifecycle.requiresRepair) return "Needs repair";
  if (lifecycle.updateAvailable) return "Update available";
  if (provider.externallyManagedAuth) return "Managed externally";
  if (connected) return "Connected";
  if (provider.status?.state === "unavailable") return "Unavailable";
  return "Sign in required";
}

function providerRuntimeHealth(provider, lifecycle, loading) {
  if (loading && !provider.status && provider.installed === undefined) {
    return { label: "Checking", tone: "", detail: "Reading this provider's runtime status." };
  }
  if (lifecycle.missing) {
    return { label: "Not installed", tone: "offline", detail: provider.health?.message || "Install or locate this provider to make it available." };
  }
  if (lifecycle.requiresRepair) {
    return { label: "Needs repair", tone: "offline", detail: provider.health?.message || "The installed runtime could not complete its health check." };
  }
  if (provider.connected) {
    return { label: "Connected", tone: "ready", detail: provider.status?.message || provider.health?.message || "The runtime is ready." };
  }
  if (["connecting", "reconnecting"].includes(provider.status?.state)) {
    return { label: "Starting", tone: "", detail: provider.status?.message || "Pixice is starting this runtime." };
  }
  const failed = provider.status?.state === "error";
  return {
    label: failed ? "Error" : "Offline",
    tone: "offline",
    detail: provider.status?.message || provider.health?.message || "This runtime is not currently available."
  };
}

function JevKeySettings({ credentials }) {
  const [configured, setConfigured] = useState(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!credentials?.keyStatus) return;
    let active = true;
    credentials.keyStatus().then((status) => {
      if (active) setConfigured(Boolean(status?.configured));
    }).catch((cause) => {
      if (active) setError(cause?.message || "Could not check the TypeSafe key.");
    });
    return () => { active = false; };
  }, [credentials]);

  const save = async (event) => {
    event.preventDefault();
    if (!key.trim() || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const status = await credentials.keySave({ key: key.trim() });
      setConfigured(Boolean(status?.configured));
      setKey("");
      setNotice("API key saved on this device.");
    } catch (cause) {
      setError(cause?.message || "Could not save the TypeSafe key.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const status = await credentials.keyRemove();
      setConfigured(Boolean(status?.configured));
      setKey("");
      setNotice("API key removed.");
    } catch (cause) {
      setError(cause?.message || "Could not remove the TypeSafe key.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup title="Jev widget creation" description="Add a TypeSafe API key to create widgets from the normal composer. The key is encrypted on this device and is never shown again.">
      <div className="jev-key-settings">
        <div className="jev-key-heading">
          <span><strong>TypeSafe API key</strong><small>{configured ? "A key is saved. Enter a new one to replace it." : "Enter your key to enable widget creation."}</small></span>
          <span className={`settings-status ${configured ? "ready" : ""}`} role="status"><i />{!credentials?.keyStatus ? "Unavailable" : configured === null ? "Checking…" : configured ? "Saved" : "Not configured"}</span>
        </div>
        {credentials?.keySave ? (
          <form className="jev-key-form" onSubmit={save}>
            <input aria-label="TypeSafe API key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} placeholder={configured ? "Replace saved key" : "Paste TypeSafe API key"} disabled={busy} />
            <button className="settings-action primary" type="submit" disabled={busy || !key.trim()}>{busy ? "Saving…" : "Save key"}</button>
            {configured && credentials?.keyRemove && <button className="settings-action" type="button" disabled={busy} onClick={remove}>Remove key</button>}
          </form>
        ) : <p className="jev-key-message">Open this setting in the Pixice desktop app.</p>}
        {error && <p className="jev-key-error" role="alert">{error}</p>}
        {notice && <p className="jev-key-message" role="status">{notice}</p>}
      </div>
    </SettingsGroup>
  );
}

function ProvidersSettings({ providers, models, loading, onRefresh, onLogin, onAction, updateChecksEnabled, onUpdateChecksEnabledChange, widgetCredentials }) {
  const [providerOperations, setProviderOperations] = useState({});
  const [pendingProvider, setPendingProvider] = useState(null);
  const [actionErrors, setActionErrors] = useState({});
  const bridgeModels = models.filter((model) => model.bridge?.eligible);
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const providerRows = PROVIDER_SETTINGS_DEFINITIONS.map((definition) => ({
    ...definition,
    ...(providerById.get(definition.id) ?? { id: definition.id })
  }));

  useEffect(() => {
    if (pendingProvider && providers.some((provider) => provider.id === pendingProvider && providerIsAuthenticated(provider))) {
      setPendingProvider(null);
    }
  }, [pendingProvider, providers]);

  useEffect(() => {
    const refreshOnFocus = () => { void onRefresh(); };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [onRefresh]);

  const startLogin = async (providerId) => {
    if (pendingProvider === providerId) {
      await onRefresh();
      return;
    }
    if (providerOperations[providerId]) return;
    setProviderOperations((current) => ({ ...current, [providerId]: "login" }));
    try {
      const opened = await onLogin(providerId);
      if (opened !== false) setPendingProvider(providerId);
    } finally {
      setProviderOperations((current) => {
        const next = { ...current };
        delete next[providerId];
        return next;
      });
    }
  };

  const runAction = async (providerId, action) => {
    if (!onAction || providerOperations[providerId]) return;
    setProviderOperations((current) => ({ ...current, [providerId]: action }));
    setActionErrors((current) => ({ ...current, [providerId]: null }));
    try {
      await onAction(providerId, action);
    } catch (cause) {
      setActionErrors((current) => ({ ...current, [providerId]: cause.message || "Provider action failed." }));
    } finally {
      setProviderOperations((current) => {
        const next = { ...current };
        delete next[providerId];
        return next;
      });
    }
  };

  return (
    <div className="providers-pane">
      <div className="settings-controls">
        <p className="providers-intro">Set up each runtime separately. Accounts stay with the provider, and Pixice only reads the resulting connection status.</p>
        <IconButton label="Refresh providers" onClick={onRefresh} disabled={loading}><ArrowClockwise className={loading ? "spin-icon" : ""} size={17} /></IconButton>
      </div>
      <JevKeySettings credentials={widgetCredentials} />
      <SettingsGroup title="Runtime health" description="Codex and Claude start independently. One unavailable runtime never blocks the other or unrelated Pixice features.">
        {providerRows.map((provider) => {
          const lifecycle = providerLifecycle(provider);
          const health = providerRuntimeHealth(provider, lifecycle, loading);
          const providerModels = models.filter((model) => modelProvider(model) === provider.id).length;
          const modelDetail = provider.connected ? `${providerModels} model${providerModels === 1 ? "" : "s"} available` : null;
          return (
            <SettingsRow key={provider.id} title={provider.runtimeLabel} description={[health.detail, modelDetail].filter(Boolean).join(" · ")}>
              <span className={`settings-status ${health.tone}`}><i />{health.label}</span>
            </SettingsRow>
          );
        })}
      </SettingsGroup>
      <div className="provider-list" aria-label="AI providers">
        {loading && providers.length === 0 && <LoadingSkeleton label="Loading providers" rows={2} />}
        {providerRows.map((provider) => {
          const providerModels = models.filter((model) => modelProvider(model) === provider.id).length;
          const connected = providerIsAuthenticated(provider);
          const waiting = pendingProvider === provider.id;
          const lifecycle = providerLifecycle(provider);
          const busyOperation = providerOperations[provider.id] ?? null;
          const busyAction = Boolean(busyOperation && busyOperation !== "login");
          const busyLogin = busyOperation === "login";
          const status = providerStatusLabel(provider, lifecycle, connected);
          const actionError = actionErrors[provider.id];
          const statusTone = lifecycle.missing || lifecycle.requiresRepair ? "offline" : connected || provider.externallyManagedAuth ? "ready" : "";
          return (
            <article className="provider-card" aria-label={`${provider.label} provider`} key={provider.id} aria-busy={busyAction || lifecycle.busy || undefined}>
              <span className="provider-brand"><ModelBrandIcon model={provider.model} provider={provider.id} /></span>
              <div className="provider-copy">
                <div className="provider-heading">
                  <h2>{provider.label}</h2>
                  <span className={`settings-status ${statusTone}`}><i />{status}</span>
                </div>
                <p>{provider.externallyManagedAuth ? "Credentials are supplied by the environment." : providerAccountDetail(provider)}</p>
                <div className="provider-meta">
                  {lifecycle.installed && <span>{provider.version ? `Version ${provider.version}` : "Version unknown"}</span>}
                  {lifecycle.updateAvailable && <span>Version {provider.updateState.availableVersion} available</span>}
                  {provider.executablePath && <span className="provider-path" title={provider.executablePath}>{provider.executablePath}</span>}
                  {Number.isFinite(providerModels) && <span>{providerModels} model{providerModels === 1 ? "" : "s"}</span>}
                  {Number.isFinite(provider.sessionCount) && <span>{provider.sessionCount} previous session{provider.sessionCount === 1 ? "" : "s"}</span>}
                  {lifecycle.detail && <span>{lifecycle.detail}</span>}
                  {actionError && <span className="provider-error" role="alert">{actionError}</span>}
                </div>
              </div>
              <div className="provider-actions">
                {lifecycle.missing && <>
                  <button className="settings-action primary" disabled={!lifecycle.actions.install || Boolean(busyOperation)} onClick={() => runAction(provider.id, "install")}>{busyOperation === "install" ? <><SpinnerGap className="spin-icon" size={14} />Installing…</> : "Install"}</button>
                  <button className="settings-action" disabled={!lifecycle.actions.locate || Boolean(busyOperation)} onClick={() => runAction(provider.id, "locate")}>Locate</button>
                </>}
                {lifecycle.requiresRepair && <>
                  <button className="settings-action primary" disabled={!lifecycle.actions.repair || Boolean(busyOperation)} onClick={() => runAction(provider.id, "repair")}>{busyOperation === "repair" ? <><SpinnerGap className="spin-icon" size={14} />Repairing…</> : "Repair"}</button>
                  <button className="settings-action" disabled={!lifecycle.actions.locate || Boolean(busyOperation)} onClick={() => runAction(provider.id, "locate")}>Locate</button>
                </>}
                {!lifecycle.missing && !lifecycle.requiresRepair && lifecycle.updateAvailable && (
                  <button className="settings-action primary" disabled={!lifecycle.actions.update || Boolean(busyOperation)} onClick={() => runAction(provider.id, "update")}>{busyOperation === "update" || provider.updateState?.state === "updating" ? <><SpinnerGap className="spin-icon" size={14} />Updating…</> : `Update to ${provider.updateState.availableVersion}`}</button>
                )}
                {!lifecycle.missing && !lifecycle.requiresRepair && !lifecycle.updateAvailable && lifecycle.actions.checkUpdate && (
                  <button className="settings-action" disabled={Boolean(busyOperation) || lifecycle.busy} onClick={() => runAction(provider.id, "checkUpdates")}>{busyOperation === "checkUpdates" || provider.updateState?.state === "checking" ? <><SpinnerGap className="spin-icon" size={14} />Checking…</> : "Check update"}</button>
                )}
                {!lifecycle.missing && !lifecycle.requiresRepair && !provider.externallyManagedAuth && connected && lifecycle.actions.logout && (
                  <button className="settings-action" disabled={busyAction || lifecycle.busy} onClick={() => runAction(provider.id, "logout")}>{busyOperation === "logout" ? <><SpinnerGap className="spin-icon" size={14} />Signing out…</> : "Sign out"}</button>
                )}
                {!lifecycle.missing && !lifecycle.requiresRepair && !provider.externallyManagedAuth && !connected && lifecycle.actions.login && (
                  <button className="settings-action primary provider-login" disabled={busyLogin || lifecycle.busy} onClick={() => startLogin(provider.id)}>
                    {busyLogin ? <><SpinnerGap className="spin-icon" size={15} />Opening…</> : waiting ? "Check sign-in" : "Sign in"}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <SettingsGroup title="Provider updates" description="Each installed provider checks and updates through its own official release path.">
        <SettingsRow title="Automatic checks" description="Check quietly after startup and every six hours. Installation still requires a click in the provider row.">
          <SettingsToggle label="Check provider updates automatically" checked={updateChecksEnabled} onChange={onUpdateChecksEnabledChange} />
        </SettingsRow>
      </SettingsGroup>
      {bridgeModels.length > 0 && (
        <section className="bridge-model-overview" aria-labelledby="bridge-model-title">
          <header>
            <span><h2 id="bridge-model-title">Pixice bridge routing</h2><p>Internal fit ratings used when agents choose a model for a new Pixice thread.</p></span>
            <small>1–5 heuristic</small>
          </header>
          <div className="bridge-model-list">
            {bridgeModels.map((model) => (
              <article className="bridge-model-row" key={model.id ?? `${model.provider}:${model.model}`}>
                <span className="bridge-model-brand"><ModelBrandIcon model={model.model} provider={model.provider} /></span>
                <span className="bridge-model-copy">
                  <strong>{model.displayName ?? model.model}</strong>
                  <small>{model.bridge.summary}</small>
                </span>
                {model.bridge.ratings ? (
                  <span className="bridge-ratings" aria-label={`${model.displayName ?? model.model} capability ratings`}>
                    {["coding", "reasoning", "ui", "taste", "speed", "costEfficiency"].map((metric) => (
                      <span key={metric}><i>{metric === "costEfficiency" ? "Cost" : metric === "ui" ? "UI" : metric[0].toUpperCase() + metric.slice(1)}</i><b>{model.bridge.ratings[metric]}</b></span>
                    ))}
                  </span>
                ) : <span className="bridge-unrated">Not yet rated</span>}
              </article>
            ))}
          </div>
          <p className="bridge-model-note">Connected models only. Pixice chooses among them using task fit, availability, and project preferences.</p>
        </section>
      )}
    </div>
  );
}

function GitHubSettings({ status, loading, progress, onRefresh, onLogin, onLogout }) {
  const connected = status.authenticated;
  const busy = loading || progress?.state === "starting" || progress?.state === "waiting";
  const accountLabel = status.account?.name || status.account?.login;
  const stateLabel = connected ? "Connected" : status.available ? "Sign in required" : "Unavailable";
  const detail = connected
    ? `${accountLabel}${status.account?.name && status.account?.login ? ` · @${status.account.login}` : ""}`
    : status.message;

  return (
    <div className="github-settings-pane">
      <div className="settings-controls">
        <p className="providers-intro">Pixice includes GitHub CLI in release builds so agents can use <code>gh</code> without a separate install.</p>
        <IconButton label="Refresh GitHub connection" onClick={onRefresh} disabled={loading}><ArrowClockwise className={loading ? "spin-icon" : ""} size={17} /></IconButton>
      </div>
      <article className="github-account-card" aria-label="GitHub account">
        <span className="github-account-brand"><GitBranch size={22} /></span>
        <span className="github-account-copy">
          <span className="github-account-heading"><strong>GitHub</strong><span className={`settings-status ${connected ? "ready" : "offline"}`}><i />{stateLabel}</span></span>
          <span>{detail}</span>
          <small>{status.version ? `GitHub CLI ${status.version} · ${status.source === "bundled" ? "Included with Pixice" : "System install"}` : "GitHub CLI is missing from this development build."}</small>
        </span>
        {connected ? (
          <button className="settings-action" disabled={busy} onClick={onLogout}>{busy ? <SpinnerGap className="spin-icon" size={14} /> : null}Disconnect</button>
        ) : (
          <button className="settings-action primary" disabled={busy || !status.available} onClick={onLogin}>{busy ? <><SpinnerGap className="spin-icon" size={14} />Waiting…</> : "Sign in"}</button>
        )}
      </article>
      {progress?.state === "waiting" && (
        <div className="github-login-progress" role="status">
          <Info size={16} />
          <span><strong>{progress.message}</strong><small>The browser flow may ask for the one-time code.</small></span>
          {progress.code && <kbd>{progress.code}</kbd>}
        </div>
      )}
      <SettingsGroup title="Where the connection is used">
        <SettingsRow title="Pixice agents" description="Agents can run GitHub CLI commands for repositories, pull requests, issues, releases, fetch, and push."><span className="settings-value">gh</span></SettingsRow>
        <SettingsRow title="Workflow Git nodes" description="These inspect the local repository and stay read-only, so they work without a GitHub account."><span className="settings-value">No login needed</span></SettingsRow>
      </SettingsGroup>
      <p className="settings-footnote">GitHub CLI owns the account session and uses its normal credential storage. Disconnecting here signs GitHub CLI out of github.com.</p>
    </div>
  );
}

function GitSettings({ status, loading, onRefresh, onInstall }) {
  const ready = status.available;
  const installRequested = status.state === "install-requested";
  const stateLabel = ready ? "Ready" : installRequested ? "Installer open" : status.state === "checking" ? "Checking" : "Unavailable";
  const actionLabel = status.installSupported && !installRequested ? "Install Command Line Tools" : "Check again";
  const action = status.installSupported && !installRequested ? onInstall : onRefresh;
  return (
    <div className="git-settings-pane">
      <div className="settings-controls">
        <p className="providers-intro">Pixice can open ordinary folders without Git. Review, worktrees, checkpoints, and Git Workflow nodes require a working Git installation.</p>
        <IconButton label="Refresh local Git" onClick={onRefresh} disabled={loading}><ArrowClockwise className={loading ? "spin-icon" : ""} size={17} /></IconButton>
      </div>
      <article className="github-account-card git-runtime-card" aria-label="Local Git">
        <span className="github-account-brand"><GitBranch size={22} /></span>
        <span className="github-account-copy">
          <span className="github-account-heading"><strong>Local Git</strong><span className={`settings-status ${ready ? "ready" : "offline"}`}><i />{stateLabel}</span></span>
          <span>{status.message}</span>
          <small>{status.executablePath ? status.executablePath : "No executable selected"}{status.version ? ` · ${status.version}` : ""}</small>
        </span>
        <button className={`settings-action${status.installSupported && !installRequested ? " primary" : ""}`} disabled={loading} onClick={action}>{loading ? <SpinnerGap className="spin-icon" size={14} /> : null}{actionLabel}</button>
      </article>
    </div>
  );
}

function formatUsd(value, compact = false) {
  const amount = Number(value) || 0;
  if (compact && amount >= 1_000) return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(amount);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: amount > 0 && amount < 0.01 ? 3 : 2,
    maximumFractionDigits: amount > 0 && amount < 0.01 ? 4 : 2
  }).format(amount);
}

function formatApiRate(value) {
  const amount = Number(value) || 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  }).format(amount);
}

function formatTokens(value) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value) || 0);
}

function UsageCostTicker({ value, compact = false, className = "" }) {
  const scale = 10_000;
  return (
    <NumberTicker
      value={(Number(value) || 0) * scale}
      format={(scaledValue) => formatUsd(scaledValue / scale, compact)}
      blur
      className={className}
    />
  );
}

function UsageTokenTicker({ value, className = "" }) {
  return <NumberTicker value={Number(value) || 0} format={formatTokens} blur className={className} />;
}

function usageModelLabel(model) {
  if (!model) return "Unidentified model";
  return model
    .replace(/^claude-/, "Claude ")
    .replace(/^gpt-/, "GPT-")
    .replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "")
    .replace(/\b(opus|sonnet|haiku|fable|mythos)\b/g, (value) => value[0].toUpperCase() + value.slice(1));
}

function usagePlanLabel(planType, provider) {
  if (!planType) return provider === "claude" ? "Claude account" : "ChatGPT account";
  const labels = { prolite: "Pro Lite", plus: "Plus", pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise" };
  return labels[planType.toLowerCase()] ?? planType.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function usageLimitName(limit) {
  if (limit.name) return limit.name;
  if (limit.id === "codex") return "Codex";
  return limit.id.replace(/^codex[_-]?/i, "Codex ").replace(/[_-]+/g, " ").trim();
}

function usageLimitWindowLabel(minutes) {
  if (minutes === 10_080) return "Weekly window";
  if (minutes === 1_440) return "Daily window";
  if (minutes === 60) return "Hourly window";
  if (minutes && minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return minutes ? `${minutes}-minute window` : "Usage window";
}

function usageLimitCountdown(resetsAt, now) {
  const remainingSeconds = Math.max(0, Math.floor(Number(resetsAt) - now / 1000));
  const days = Math.floor(remainingSeconds / 86_400);
  const hours = Math.floor((remainingSeconds % 86_400) / 3_600);
  const minutes = Math.max(1, Math.floor((remainingSeconds % 3_600) / 60));
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return remainingSeconds ? `${minutes}m` : "now";
}

function UsageLimitResetTime({ resetsAt }) {
  const now = useLiveNow(Boolean(resetsAt));
  if (!resetsAt) return <span>Reset time unavailable</span>;
  const date = new Date(Number(resetsAt) * 1000);
  return <time dateTime={date.toISOString()} title={date.toLocaleString()}>Resets in {usageLimitCountdown(resetsAt, now)}</time>;
}

function ProviderUsageLimits({ data, loading, error, onRefresh, snapshotAt }) {
  const providers = data?.providers ?? [];
  const [selectedProvider, setSelectedProvider] = useState(providers[0]?.provider ?? "codex");
  useEffect(() => {
    if (providers.length && !providers.some((provider) => provider.provider === selectedProvider)) {
      setSelectedProvider(providers[0].provider);
    }
  }, [providers, selectedProvider]);

  if (loading && !data) {
    return <section className="usage-limits-card"><LoadingSkeleton label="Checking provider limits" rows={2} /></section>;
  }

  const active = providers.find((provider) => provider.provider === selectedProvider) ?? providers[0] ?? null;
  const unavailable = Boolean(error) || !active || active.status === "unavailable";
  const limits = active?.limits ?? [];
  const availableResetCredits = active?.resetCredits?.availableCount ?? 0;
  const providerLabel = active?.label ?? "Provider";
  return (
    <section className="usage-limits-card" aria-label={`${providerLabel} usage limits`}>
      <header>
        <span><h2>Usage limits</h2><p>{snapshotAt ? `Last reported allowance · ${new Date(snapshotAt).toLocaleString()}` : "Live allowance from signed-in provider accounts"}</p></span>
        <span className="usage-limits-actions">
          {providers.length > 1 && <SlidingSegmented value={active?.provider} options={providers.map((provider) => ({ value: provider.provider, label: provider.label }))} onChange={setSelectedProvider} label="Usage provider" className="usage-provider-switch" />}
          {active && <strong><i />{usagePlanLabel(active.planType, active.provider)}</strong>}
          <button className="settings-action" onClick={onRefresh} disabled={loading} aria-label="Refresh usage limits">
            <ArrowClockwise size={14} className={loading ? "spin-icon" : ""} />Refresh
          </button>
        </span>
      </header>

      {unavailable ? (
        <div className="usage-limits-unavailable"><Warning size={16} /><span><strong>Live limits are unavailable</strong><small>{error || active?.message || data?.message || "Sign in through Providers to see your remaining allowance."}</small></span></div>
      ) : limits.length ? (
        <div className="usage-limit-grid">
          {limits.map((limit) => (
            <article key={limit.id} className={limit.rateLimitReachedType || limit.spendControlReached ? "reached" : ""}>
              <header><span><strong>{usageLimitName(limit)}</strong><small>{limit.windows.length === 1 ? usageLimitWindowLabel(limit.windows[0].windowDurationMins) : `${limit.windows.length} limit windows`}</small></span>{(limit.rateLimitReachedType || limit.spendControlReached) && <em>Limit reached</em>}</header>
              <div className="usage-limit-windows">
                {limit.windows.map((window, index) => {
                  const remaining = window.remainingPercent == null ? null : Math.round(window.remainingPercent);
                  const used = window.usedPercent == null ? null : Math.round(window.usedPercent);
                  const windowLabel = window.label || usageLimitWindowLabel(window.windowDurationMins);
                  return (
                    <div className="usage-limit-window" data-state={remaining !== null && remaining <= 10 ? "critical" : remaining !== null && remaining <= 25 ? "low" : "normal"} key={`${limit.id}:${index}`}>
                      <div><span>{windowLabel}</span><strong>{remaining === null ? "Not reported" : `${remaining}% left`}</strong></div>
                      <div className="usage-limit-track" role="progressbar" aria-label={`${usageLimitName(limit)} ${windowLabel} remaining`} aria-valuemin={0} aria-valuemax={100} {...(remaining === null ? {} : { "aria-valuenow": remaining })}><i style={{ width: `${remaining ?? 0}%` }} /></div>
                      <footer><span>{window.detail ? `${formatUsd(window.detail.used)} of ${formatUsd(window.detail.limit)} used` : used === null ? "Usage not reported" : `${used}% used`}</span>{window.resetsAt ? <UsageLimitResetTime resetsAt={window.resetsAt} /> : <span>Reset time unavailable</span>}</footer>
                    </div>
                  );
                })}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="usage-limits-unavailable"><Info size={16} /><span><strong>No limit buckets reported</strong><small>The connected {providerLabel} account did not return an allowance.</small></span></div>
      )}

      {!unavailable && availableResetCredits > 0 && <footer className="usage-reset-credit"><Sparkle size={14} /><span><strong>{availableResetCredits} free full reset{availableResetCredits === 1 ? "" : "s"} available</strong><small>Reported by {providerLabel} for this account.</small></span></footer>}
    </section>
  );
}

function chartDateLabel(value) {
  if (!value) return "";
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function UsagePage(props) {
  const [scope, setScope] = useState(props.unifiedOnly ? "unified" : "instance");
  const [limitsInstance, setLimitsInstance] = useState("");
  const unified = useUnifiedUsage(scope === "unified", props.rangeDays);
  const available = unified.entries.filter((entry) => entry.summary);
  const limitHost = available.find((entry) => entry.id === limitsInstance) ?? available[0];
  const pending = unified.entries.some((entry) => entry.status === "loading");
  const cachedCount = available.filter((entry) => entry.cached).length;
  return <>
    <div className="usage-scope-bar">
      {!props.unifiedOnly && <SlidingSegmented value={scope} options={[{ value: "instance", label: "This instance" }, { value: "unified", label: "Unified Usage" }]} onChange={setScope} label="Usage scope" />}
      {scope === "unified" && <button className="settings-action" onClick={unified.refresh} disabled={unified.loading} aria-label="Refresh unified usage"><ArrowClockwise size={14} />{unified.loading ? "Refreshing…" : "Refresh"}</button>}
    </div>
    {scope === "instance" ? <UsageSettings {...props} /> : <>
      <section className="usage-instances-card" aria-label="Unified usage instances">
        <header><span><h2>Unified Usage</h2><p>Combined usage from instances paired on this device{window.pixice ? " and this desktop" : ""}.</p></span><strong role="status">{unified.loading ? "Updating · " : ""}{available.length} of {unified.entries.length} included</strong></header>
        <div className="usage-instances-scroll"><table>
          <thead><tr><th>Instance</th><th>Status</th><th>Month to date</th><th>Tokens · {props.rangeDays}d</th></tr></thead>
          <tbody>{unified.entries.map((entry) => <tr key={entry.id}>
            <th scope="row"><strong>{entry.name}</strong><small>{entry.local ? "This device" : entry.endpoint}</small></th>
            <td><span className="usage-instance-status" data-state={entry.status}>{entry.status === "online" ? "Synced" : entry.status === "loading" ? "Syncing…" : entry.cached ? (entry.status === "unauthorized" ? "Saved · pair again" : "Saved · offline") : entry.status === "unauthorized" ? "Pair again" : "Unavailable"}</span><small>{entry.checkedAt ? `Last synced ${new Date(entry.checkedAt).toLocaleString()}` : "Not synced yet"}</small>{entry.error && <small>{entry.error}</small>}{entry.cacheError && <small>{entry.cacheError}</small>}</td>
            <td>{entry.summary ? formatUsd(entry.summary.stats.currentMonthCostUsd) : "—"}</td>
            <td>{entry.summary ? entry.summary.selected.totalTokens.toLocaleString() : "—"}</td>
          </tr>)}</tbody>
        </table></div>
        <p className="settings-footnote">{available.length < unified.entries.length ? "Partial totals: instances without a saved snapshot are missing. " : ""}{cachedCount > 0 ? `${cachedCount} instance${cachedCount === 1 ? " uses its" : "s use their"} last saved usage; newer activity may be missing. ` : ""}Usage is saved on this device and syncs every 30 seconds while visible. Dates follow each host’s local calendar.</p>
        {!unified.entries.length && !unified.loading && <p className="settings-footnote">Pair an instance in Connections to include its usage.</p>}
        {unified.error && <p role="alert" className="connect-error">{unified.error}</p>}
      </section>
      <UsageSettings {...props} summary={unified.summary} loading={unified.loading || pending} error={!unified.summary && !unified.loading ? "No saved usage yet. Connect an instance and refresh to sync its history." : null} unified onRefresh={unified.refresh} limitsContent={limitHost ? <>
        <div className="usage-limits-scope"><label>Provider limits for <select value={limitHost.id} onChange={(event) => setLimitsInstance(event.target.value)}>{available.map((entry) => <option value={entry.id} key={entry.id}>{entry.name}</option>)}</select></label><p>Account allowances stay separate. Instances using the same provider account share its limits.</p></div>
        {limitHost.cached && <p className="settings-footnote">Saved allowance from {new Date(limitHost.checkedAt).toLocaleString()}; current limits may differ.</p>}
        <ProviderUsageLimits data={limitHost.limits} snapshotAt={limitHost.cached ? limitHost.checkedAt : null} error={limitHost.limitsError} loading={unified.loading} onRefresh={unified.refresh} />
      </> : null} />
    </>}
  </>;
}

function UsageSettings({ summary, loading, error, limits, limitsLoading, limitsError, rangeDays, onRangeChange, onRefresh, unified = false, limitsContent }) {
  const [rateProvider, setRateProvider] = useState("codex");
  const providerLimits = unified ? limitsContent : <ProviderUsageLimits data={limits} loading={limitsLoading} error={limitsError} onRefresh={onRefresh} />;
  if (loading && !summary) return <div className="usage-pane">{providerLimits}<LoadingSkeleton label="Calculating usage" rows={5} /></div>;
  if (error && !summary) return <div className="usage-pane">{providerLimits}<div className="usage-error"><Warning size={18} /><span><strong>Usage history could not be loaded</strong><small>{error}</small></span><button className="settings-action" onClick={onRefresh}>Try again</button></div></div>;

  const data = summary ?? {
    stats: {}, selected: {}, daily: [], heatmapDaily: [], models: [], pricing: [], pricingVerifiedAt: null, recordingStartedAt: null
  };
  const stats = data.stats ?? {};
  const selected = data.selected ?? {};
  const modelRows = (data.models ?? []).slice(0, 8).map((row, index) => ({
    ...row,
    label: usageModelLabel(row.model),
    cost: row.costUsd,
    color: row.provider === "claude" ? (index % 2 ? "pink" : "orange") : (index % 2 ? "purple" : "blue")
  }));
  const tokenMix = [
    { label: "Uncached input", value: selected.inputTokens ?? 0, color: "blue" },
    { label: "Cached input", value: selected.cachedInputTokens ?? 0, color: "green" },
    { label: "Cache writes", value: selected.cacheWriteInputTokens ?? 0, color: "orange" },
    { label: "Output", value: selected.outputTokens ?? 0, color: "pink" }
  ];
  const totalMix = tokenMix.reduce((total, item) => total + item.value, 0);
  const heatmapDaily = data.heatmapDaily ?? data.daily ?? [];
  const heatmapActiveDays = heatmapDaily.filter((item) => item.events > 0 || item.costUsd > 0).length;
  const heatmapPeak = heatmapDaily.reduce((peak, item) => Math.max(peak, Number(item.costUsd) || 0), 0);
  const rateRows = (data.pricing ?? []).filter((entry) => entry.provider === rateProvider);
  const coverage = selected.events ? ((selected.events - selected.unpricedEvents) / selected.events) * 100 : 100;

  return (
    <div className="usage-pane">
      <section className="usage-hero" aria-label="Usage overview">
        <div className="usage-hero-totals">
          <div className="usage-hero-heading">
            <span>Month to date</span>
            <strong><UsageCostTicker value={stats.currentMonthCostUsd} compact /></strong>
            <small>{formatUsd(stats.projectedMonthCostUsd)} projected at the current pace</small>
          </div>
          <div className="usage-hero-heading usage-hero-lifetime">
            <span>Total spend · all time</span>
            <strong><UsageCostTicker value={stats.allTimeCostUsd} compact /></strong>
            <small>{data.recordingStartedAt ? `tracked since ${new Date(data.recordingStartedAt).toLocaleDateString()}` : "starts with the next completed turn"}</small>
          </div>
        </div>
        <div className="usage-hero-status"><i />Measured tokens · API-equivalent USD</div>
        <div className="usage-stat-grid">
          <article><span>Today</span><strong><UsageCostTicker value={stats.todayCostUsd} /></strong><small>{unified ? "each host’s local day" : "local calendar day"}</small></article>
          <article><span>This week</span><strong><UsageCostTicker value={stats.currentWeekCostUsd} /></strong><small>since Monday</small></article>
          <article><span>Daily average</span><strong><UsageCostTicker value={stats.dailyAverageCostUsd} /></strong><small>since tracking began</small></article>
          <article><span>Weekly average</span><strong><UsageCostTicker value={stats.weeklyAverageCostUsd} /></strong><small>normalized from history</small></article>
          <article><span>Monthly average</span><strong><UsageCostTicker value={stats.monthlyAverageCostUsd} /></strong><small>30.44-day average</small></article>
          <article><span>Tokens tracked</span><strong><UsageTokenTicker value={stats.allTimeTokens} /></strong><small>{data.recordingStartedAt ? `since ${new Date(data.recordingStartedAt).toLocaleDateString()}` : "starts with the next turn"}</small></article>
        </div>
      </section>

      {providerLimits}

      <section className="usage-heatmap-card">
        <header>
          <span><h2>Spend calendar</h2><p>API-equivalent cost over the last 365 days</p></span>
          <strong><span><NumberTicker value={heatmapActiveDays} blur /> active day{heatmapActiveDays === 1 ? "" : "s"}</span><small>Peak <UsageCostTicker value={heatmapPeak} /></small></strong>
        </header>
        <UsageHeatMap
          data={heatmapDaily}
          valueFormatter={(value) => formatUsd(value)}
          ariaLabel="Daily API-equivalent spend heat map over the last 365 days"
        />
      </section>

      <section className="usage-chart-card">
        <header>
          <span><h2>Spend over time</h2><p><UsageCostTicker value={selected.costUsd} /> across <UsageTokenTicker value={selected.totalTokens} /> tokens</p></span>
          <SlidingSegmented value={rangeDays} options={[7, 30, 90].map((days) => ({ value: days, label: `${days}d` }))} onChange={onRangeChange} label="Usage range" className="usage-range" />
        </header>
        <DitherAreaChart
          data={data.daily ?? []}
          series={[{ key: "costUsd", label: "API cost", color: "blue", variant: "gradient" }]}
          labelKey="date"
          labelFormatter={chartDateLabel}
          valueFormatter={(value) => formatUsd(value)}
          ariaLabel={`Daily API-equivalent spend over ${rangeDays} days`}
          height={220}
        />
      </section>

      <div className="usage-chart-grid">
        <section className="usage-chart-card compact">
          <header><span><h2>Cost by model</h2><p>{data.modelHistoryUnavailable ? "Some saved hosts need an update to show model history in this range." : "Top models in this range"}</p></span></header>
          <DitherBarChart
            data={modelRows}
            series={[{ key: "cost", label: "Cost", color: "purple", variant: "hatched" }]}
            valueFormatter={(value) => formatUsd(value)}
            ariaLabel="API-equivalent cost by model"
            height={175}
          />
        </section>
        <section className="usage-token-card">
          <header><h2>Token composition</h2><p>Reasoning tokens are included in output.</p></header>
          <div className="usage-token-total"><strong><UsageTokenTicker value={totalMix} /></strong><span>tokens in range</span></div>
          <div className={`usage-token-stack${totalMix ? "" : " empty"}`} aria-label="Token composition">
            {tokenMix.map((item) => <i key={item.label} title={`${item.label}: ${item.value.toLocaleString()}`} style={{ width: `${totalMix ? (item.value / totalMix) * 100 : 0}%`, "--token-color": `var(--dither-${item.color})` }} />)}
          </div>
          <div className="usage-token-legend">
            {tokenMix.map((item) => <span key={item.label}><i style={{ "--token-color": `var(--dither-${item.color})` }} /><b>{item.label}</b><strong><UsageTokenTicker value={item.value} /></strong></span>)}
          </div>
          <p className="usage-cache-note">{selected.cachedInputTokens ? `${Math.round((selected.cachedInputTokens / Math.max(1, selected.inputTokens + selected.cachedInputTokens)) * 100)}% of readable input came from cache.` : "Cached input savings will appear here when reported."}</p>
        </section>
      </div>


      <section className="settings-group usage-rates">
        <header className="usage-rates-header">
          <span><h2>Current API rate card</h2><p>USD per 1M text tokens</p></span>
          <SlidingSegmented value={rateProvider} options={[{ value: "codex", label: "OpenAI" }, { value: "claude", label: "Anthropic" }]} onChange={setRateProvider} label="Rate provider" />
        </header>
        <div className="settings-card usage-rate-card">
          <div className="usage-rate-row usage-rate-heading"><span>Model</span><span>Input</span><span>Cached</span><span>Cache write</span><span>Output</span></div>
          <div className="usage-rate-scroll">
            {rateRows.map((entry) => (
              <div className="usage-rate-row" key={`${entry.provider}:${entry.model}`}>
                <span><strong>{entry.label}</strong><small>{entry.model}{entry.fastRates ? " · fast supported" : ""} · verified {entry.verifiedAt ?? data.pricingVerifiedAt ?? "with provider docs"}</small></span>
                <span>{formatApiRate(entry.rates.input)}</span>
                <span>{formatApiRate(entry.rates.cachedInput)}</span>
                <span>{formatApiRate(entry.rates.cacheWriteInput)}</span>
                <span>{formatApiRate(entry.rates.output)}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="usage-accuracy-note">
        <Info size={17} />
        <span><strong>{coverage.toFixed(coverage === 100 ? 0 : 1)}% cost coverage in this range</strong><small>Claude provider totals are used when reported. Codex is priced from measured uncached input, cached input, cache writes, and output tokens. Subscription quotas, regional uplifts, and tool fees that a runtime does not report are not treated as invoice charges.</small></span>
      </div>
    </div>
  );
}

const SETTINGS_PAGES = [
  { id: "general", label: "General", description: "Defaults, safety, and alerts", icon: Gear, keywords: "permissions model reasoning thread names workflow generation title luna terra claude automatic delete drafts cleanup age days custom awake sleep system notifications alerts sound shortcuts keyboard" },
  { id: "conversation", label: "Conversation", description: "Writing, reading, and live output", icon: PencilSimple, keywords: "composer enter send shortcut drafts autofocus spellcheck slash commands timestamps work details expanded collapsed" },
  { id: "voice", label: "Voice", description: "Dictation and transcription models", icon: Microphone, keywords: "voice dictation speech transcription microphone mic parakeet whisper moonshine sensevoice model download offline on-device audio input language threads" },
  { id: "agents", label: "Agents", description: "Behavior and orchestration", icon: Brain, keywords: "agent behavior instructions markdown skills planning delegation verification workflows board thread spawning orchestration tools instruments interactive progress task map approvals" },
  { id: "providers", label: "Providers", description: "Accounts, runtimes, and models", icon: Stack, keywords: "openai codex anthropic claude login sign in account models sessions runtime health status connected update install locate repair widgets jev typesafe api key" },
  { id: "connections", label: "Connections", description: "Remote instances and paired devices", icon: Globe, keywords: "connect remote network tunnel web https pairing devices host instance tailscale" },
  { id: "capabilities", label: "Capabilities", description: "GitHub, skills, apps, and MCP", icon: PlugsConnected, keywords: "extensions plugins tools servers github gh cli login pull request issues push fetch workflow" },
  { id: "appearance", label: "Appearance", description: "Layout, text, color, and motion", icon: Eye, keywords: "compact comfortable conversation width focused balanced wide text size small large accent coral rose amber green teal blue violet graphite transparency projects sidebar recent third row nine legacy old nested shortcuts animation" },
  { id: "usage", label: "Usage", description: "Tokens, trends, and API cost", icon: ChartLineUp, keywords: "cost spend pricing tokens input output cache daily weekly monthly charts unified instances combined" }
];

const SETTINGS_ABOUT_PAGE = { id: "about", label: "About Pixice", description: "Version and app updates", icon: Info, keywords: "about pixice version release download install github update" };
const ALL_SETTINGS_PAGES = [...SETTINGS_PAGES, SETTINGS_ABOUT_PAGE];

function SettingsSidebar({ page, onPageChange, onBack }) {
  const [query, setQuery] = useState("");
  const visiblePages = SETTINGS_PAGES.filter((candidate) => `${candidate.label} ${candidate.description} ${candidate.keywords}`.toLowerCase().includes(query.trim().toLowerCase()));
  const showAbout = `${SETTINGS_ABOUT_PAGE.label} ${SETTINGS_ABOUT_PAGE.description} ${SETTINGS_ABOUT_PAGE.keywords}`.toLowerCase().includes(query.trim().toLowerCase());

  return (
    <aside className="settings-sidebar" aria-label="Settings navigation">
      <button className="settings-back" onClick={onBack}><CaretLeft size={16} />Back to task</button>
      <label className="settings-search"><MagnifyingGlass size={16} /><input aria-label="Search settings" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search settings" /></label>
      <nav>
        {visiblePages.map(({ id, label, description, icon: Icon }) => (
          <button key={id} className={page === id ? "selected" : ""} onClick={() => onPageChange(id)} aria-current={page === id ? "page" : undefined}>
            <Icon size={17} weight={page === id ? "fill" : "regular"} />
            <span><strong>{label}</strong><small>{description}</small></span>
            <CaretRight size={13} />
          </button>
        ))}
      </nav>
      {visiblePages.length === 0 && !showAbout && <p className="settings-nav-empty">No matching settings.</p>}
      {showAbout && (
        <div className="settings-sidebar-footer">
          <button className={page === SETTINGS_ABOUT_PAGE.id ? "selected" : ""} onClick={() => onPageChange(SETTINGS_ABOUT_PAGE.id)} aria-current={page === SETTINGS_ABOUT_PAGE.id ? "page" : undefined}>
            <Info size={17} weight={page === SETTINGS_ABOUT_PAGE.id ? "fill" : "regular"} />
            <span><strong>{SETTINGS_ABOUT_PAGE.label}</strong><small>{SETTINGS_ABOUT_PAGE.description}</small></span>
            <CaretRight size={13} />
          </button>
        </div>
      )}
    </aside>
  );
}

// Speech models are large enough that a download deserves the same background
// capsule a provider update gets, rather than progress that is only visible
// while the Voice settings page happens to be open.
export function transcriptionDownloadOperation(progress, api) {
  const id = `transcription-model:${progress.id}`;
  const title = progress.label ?? "Speech model";
  const percent = progress.totalBytes
    ? Math.max(0, Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100)))
    : null;

  if (progress.phase === "installed") {
    return { id, kind: "update", tone: "success", status: "Model ready", title, label: `${title} ready`, detail: "Dictation is available in the composer.", progress: 100, autoDismiss: 4500 };
  }
  if (progress.phase === "cancelled") return { id, dismiss: true };
  if (progress.phase === "failed") {
    return { id, kind: "update", tone: "error", status: "Download failed", title, label: `${title} download failed`, detail: progress.error ?? "The download did not finish.", autoDismiss: 9000 };
  }
  if (progress.phase === "extracting") {
    return { id, kind: "update", tone: "working", status: "Unpacking", title, label: `Unpacking ${title}`, indeterminate: true, dismissible: false };
  }
  return {
    id,
    kind: "update",
    tone: "working",
    status: "Downloading",
    title,
    label: `Downloading ${title}`,
    detail: progress.totalBytes ? `${formatModelBytes(progress.receivedBytes)} of ${formatModelBytes(progress.totalBytes)}` : undefined,
    progress: percent,
    indeterminate: percent === null,
    dismissible: false,
    actionLabel: "Cancel",
    onAction: () => { void api?.transcription?.cancelInstall({ modelId: progress.id }).catch(() => {}); }
  };
}

function VoiceModelRow({ model, selected, progress, onInstall, onCancel, onRemove, onSelect }) {
  const active = progress && !["installed", "failed", "cancelled"].includes(progress.phase);
  const percent = active && progress.totalBytes
    ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
    : 0;
  const detail = [
    model.languages,
    model.installed ? `${formatModelBytes(model.installedBytes)} on disk` : `${formatModelBytes(model.downloadBytes)} download`,
    model.license.name
  ].join(" · ");

  return (
    <SettingsRow title={`${model.label}${model.recommended ? " · Recommended" : ""}`} description={`${model.summary} ${detail}`}>
      <div className="settings-controls voice-model-actions">
        {active && (
          <span className="settings-status ready" role="status">
            <i />
            {progress.phase === "extracting" ? "Unpacking…" : `${percent}%`}
          </span>
        )}
        {progress?.phase === "failed" && <span className="settings-status offline" role="status"><i />{progress.error ?? "Download failed"}</span>}
        {active && <button type="button" className="settings-action" onClick={() => onCancel(model.id)}>Cancel</button>}
        {!active && !model.installed && (
          <button type="button" className="settings-action primary" onClick={() => onInstall(model.id)}>
            Download {formatModelBytes(model.downloadBytes)}
          </button>
        )}
        {!active && model.installed && !selected && (
          <button type="button" className="settings-action primary" onClick={() => onSelect(model.id)}>Use this model</button>
        )}
        {!active && model.installed && selected && <span className="settings-status ready"><i />In use</span>}
        {!active && model.installed && <button type="button" className="settings-action" onClick={() => onRemove(model.id)}>Remove</button>}
      </div>
    </SettingsRow>
  );
}

function VoiceSettings({ transcription, micDeviceId, onMicDeviceChange }) {
  const { state, progress, install, cancelInstall, remove, select, configure } = transcription ?? {};
  const [devices, setDevices] = useState([]);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    listAudioInputs().then((found) => { if (!cancelled) setDevices(found); });
    return () => { cancelled = true; };
  }, []);

  const guard = (action) => async (...args) => {
    setNotice("");
    try { await action(...args); }
    catch (error) { setNotice(error.message); }
  };

  if (!state) {
    return (
      <SettingsGroup title="Dictation" description="Speak into the composer and have Pixice transcribe it.">
        <SettingsRow title="Unavailable" description="This Pixice host does not offer transcription. Update the host, or open Pixice on the machine running the backend." />
      </SettingsGroup>
    );
  }

  const selectedModel = state.models.find((model) => model.id === state.selectedModelId) ?? null;
  const installedCount = state.models.filter((model) => model.installed).length;
  const unsupportedHere = dictationUnsupportedReason();

  return (
    <>
      {notice && <p className="settings-footnote" role="alert">{notice}</p>}
      <SettingsGroup
        title="Dictation"
        description="Audio is recorded on this device and transcribed by the Pixice host. Nothing is sent to a speech service."
      >
        <SettingsRow title="Status" description={state.available
          ? selectedModel
            ? `Ready with ${selectedModel.label}. The microphone button sits next to Send.`
            : "Download a model below to turn on the microphone button."
          : "Speech recognition could not start on the host."}>
          <span className={`settings-status ${state.ready ? "ready" : "offline"}`}><i />{state.ready ? "Ready" : "Not ready"}</span>
        </SettingsRow>
        {!state.available && state.reason && (
          <SettingsRow title="Why" description={state.reason} />
        )}
        {unsupportedHere && <SettingsRow title="This device" description={unsupportedHere} />}
        <SettingsRow title="Microphone" description="Chosen per device. Labels appear after you allow microphone access once.">
          <select className="settings-select" aria-label="Microphone" value={micDeviceId ?? ""} onChange={(event) => onMicDeviceChange(event.target.value)}>
            <option value="">System default</option>
            {devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow title="Recording limit" description="A single dictation is capped so an abandoned recording cannot fill host memory.">
          <span className="settings-value">{Math.round(state.maxSeconds / 60)} minutes</span>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Models"
        description="Pixice ships without a speech model. Download one here and it is stored on the host, where every paired device can use it."
      >
        {state.models.map((model) => (
          <VoiceModelRow
            key={model.id}
            model={model}
            selected={model.id === state.selectedModelId}
            progress={progress?.[model.id] ?? model.install}
            onInstall={guard(install)}
            onCancel={guard(cancelInstall)}
            onRemove={guard(remove)}
            onSelect={guard(select)}
          />
        ))}
        <SettingsRow title="Disk used" description={`${installedCount} of ${state.models.length} models installed on the host.`}>
          <span className="settings-value">{formatModelBytes(state.diskBytes)}</span>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Performance" description="Applies to the host machine that runs the model.">
        <SettingsRow title="Threads" description="More threads transcribe faster and use more CPU while decoding.">
          <select className="settings-select" aria-label="Decoding threads" value={state.settings.numThreads} onChange={(event) => void guard(configure)({ numThreads: Number(event.target.value) })}>
            {[1, 2, 4, 6, 8].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow title="Compute" description="CoreML runs the model on the Apple Neural Engine. It is ignored on other platforms.">
          <select className="settings-select" aria-label="Compute provider" value={state.settings.provider} onChange={(event) => void guard(configure)({ provider: event.target.value })}>
            <option value="cpu">CPU</option>
            <option value="coreml">CoreML (Apple Silicon)</option>
          </select>
        </SettingsRow>
        {selectedModel?.supportsLanguageHint && (
          <SettingsRow title="Language hint" description="A two-letter code such as en or de. Leave empty to let the model detect the language.">
            <input
              className="settings-select"
              aria-label="Language hint"
              value={state.settings.language}
              placeholder="auto"
              maxLength={16}
              onChange={(event) => void guard(configure)({ language: event.target.value })}
            />
          </SettingsRow>
        )}
      </SettingsGroup>

      <SettingsGroup title="Attribution" description="Model licences require these credits.">
        {state.models.filter((model) => model.installed).map((model) => (
          <SettingsRow key={model.id} title={model.label} description={model.license.attribution}>
            <span className="settings-value">{model.license.name}</span>
          </SettingsRow>
        ))}
        {installedCount === 0 && <SettingsRow title="No models installed" description="Credits appear here once you download a model." />}
      </SettingsGroup>
    </>
  );
}

function SettingsWorkspace({
  page,
  models,
  selectedModel,
  onModelChange,
  effort,
  onEffortChange,
  permissionMode,
  onPermissionModeChange,
  defaultFastMode,
  onDefaultFastModeChange,
  threadNamingModel,
  onThreadNamingModelChange,
  workflowGenerationModel,
  onWorkflowGenerationModelChange,
  preferences,
  onPreferenceChange,
  transcription,
  attentionNotifications,
  onAttentionNotificationsChange,
  completionNotifications,
  onCompletionNotificationsChange,
  notificationSound,
  onNotificationSoundChange,
  keepSystemAwake,
  onKeepSystemAwakeChange,
  agentBehaviorCatalog,
  agentBehaviors,
  onAgentBehaviorChange,
  extensions,
  extensionsLoading,
  providers,
  providersLoading,
  onRefreshProviders,
  onProviderLogin,
  onProviderAction,
  providerUpdateChecksEnabled,
  onProviderUpdateChecksEnabledChange,
  widgetCredentials,
  githubStatus,
  githubLoading,
  githubProgress,
  onRefreshGitHub,
  onGitHubLogin,
  onGitHubLogout,
  gitStatus,
  gitLoading,
  onRefreshGit,
  onInstallGit,
  usageSummary,
  usageLoading,
  usageError,
  usageLimits,
  usageLimitsLoading,
  usageLimitsError,
  usageRangeDays,
  onUsageRangeChange,
  onRefreshUsage,
  onRefreshCapabilities,
  updateStatus,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate
}) {
  const selectedPage = ALL_SETTINGS_PAGES.find((candidate) => candidate.id === page) ?? SETTINGS_PAGES[0];
  const systemReducedMotion = useReducedMotion();
  const settingsScrollRef = useRef(null);
  const selectedPageIndex = ALL_SETTINGS_PAGES.findIndex((candidate) => candidate.id === selectedPage.id);
  const previousPageIndexRef = useRef(selectedPageIndex);
  const pageDirection = selectedPageIndex >= previousPageIndexRef.current ? 1 : -1;
  const selectedModelInfo = models.find((model) => model.model === selectedModel);
  const namingModels = threadNamingModels(models);
  const automaticNamingModel = resolveThreadNamingModel(THREAD_NAMING_AUTO, models);
  const generationModels = workflowGenerationModels(models);
  const automaticGenerationModel = resolveWorkflowGenerationModel(WORKFLOW_GENERATION_AUTO, models);
  const generationModelValue = (model) => String(model.id ?? "").includes(":") ? model.id : `${model.provider}:${model.model}`;
  const effortOptions = selectedModelInfo?.supportedReasoningEfforts?.map((option) => option.reasoningEffort ?? option.effort ?? option) ?? ["medium", "high"];
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  useEffect(() => {
    previousPageIndexRef.current = selectedPageIndex;
    settingsScrollRef.current?.scrollTo?.({ top: 0, behavior: "auto" });
  }, [selectedPageIndex]);

  let pageContent;
  if (page === "general") {
    const cleanupAgePreset = [30, 14, 7].includes(preferences.threadCleanupAgeDays) ? String(preferences.threadCleanupAgeDays) : "custom";
    pageContent = (
      <>
        <SettingsGroup title="Task defaults" description="Used whenever you begin work in a project.">
          <SettingsRow title="Default permissions" description={PERMISSION_OPTIONS.find((option) => option.value === permissionMode)?.description ?? "Choose what Codex may do before a task starts."}>
            <select className="settings-select" aria-label="Default permissions" value={permissionMode} onChange={(event) => onPermissionModeChange(event.target.value)}>
              {PERMISSION_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
            </select>
          </SettingsRow>
          <SettingsRow title="Default model" description="The model selected for new tasks.">
            <select className="settings-select" aria-label="Default model" value={selectedModel} onChange={(event) => onModelChange(event.target.value)} disabled={!models.length}>
              {models.map((model) => <option value={model.model} key={model.model}>{model.displayName ?? model.model}</option>)}
            </select>
          </SettingsRow>
          <SettingsRow title="Reasoning effort" description="How deeply the lead agent reasons by default.">
            <select className="settings-select" aria-label="Default reasoning effort" value={effort} onChange={(event) => onEffortChange(event.target.value)}>
              {effortOptions.map((value) => <option value={value} key={value}>{String(value).replace(/^./, (letter) => letter.toUpperCase())}</option>)}
            </select>
          </SettingsRow>
          <SettingsRow title="Fast mode" description="Start new tasks on the provider's faster service tier when the selected model supports it.">
            <SettingsToggle label="Use Fast mode for new tasks" checked={defaultFastMode} onChange={onDefaultFastModeChange} />
          </SettingsRow>
          <SettingsRow hostOnly title="Thread names" description="Generate concise names in a separate read-only turn. Automatic prefers Luna, then Haiku.">
            <select className="settings-select" aria-label="Thread name model" value={threadNamingModel} onChange={(event) => onThreadNamingModelChange(event.target.value)}>
              <option value={THREAD_NAMING_AUTO}>Automatic{automaticNamingModel ? ` (${automaticNamingModel.displayName})` : " (no model available)"}</option>
              {namingModels.map((model) => {
                const value = `${model.provider}:${model.model}`;
                return <option value={value} key={value}>{model.displayName ?? model.model}</option>;
              })}
              {threadNamingModel !== THREAD_NAMING_AUTO && threadNamingModel !== THREAD_NAMING_OFF && !namingModels.some((model) => `${model.provider}:${model.model}` === threadNamingModel) && (
                <option value={threadNamingModel}>Selected model (unavailable)</option>
              )}
              <option value={THREAD_NAMING_OFF}>Off</option>
            </select>
          </SettingsRow>
          <SettingsRow hostOnly title="Workflow generation model" description="Used by the hidden read-only agent that builds a canvas from its description. Automatic prefers Terra and falls back to Claude.">
            <select className="settings-select" aria-label="Workflow generation model" value={workflowGenerationModel} onChange={(event) => onWorkflowGenerationModelChange(event.target.value)}>
              <option value={WORKFLOW_GENERATION_AUTO}>Automatic{automaticGenerationModel ? ` (${automaticGenerationModel.displayName})` : " (no model available)"}</option>
              {["codex", "claude"].map((provider) => {
                const providerModels = generationModels.filter((model) => model.provider === provider);
                if (!providerModels.length) return null;
                return (
                  <optgroup label={provider === "codex" ? "Codex" : "Claude"} key={provider}>
                    {providerModels.map((model) => <option value={generationModelValue(model)} key={generationModelValue(model)}>{model.displayName ?? model.model}</option>)}
                  </optgroup>
                );
              })}
              {workflowGenerationModel !== WORKFLOW_GENERATION_AUTO && !generationModels.some((model) => generationModelValue(model) === workflowGenerationModel) && (
                <option value={workflowGenerationModel}>Selected model (unavailable)</option>
              )}
            </select>
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup title="Safety and continuity">
          <SettingsRow hostOnly title="Keep System awake" description="Prevent idle sleep while Pixice is running. The display may still turn off.">
            <SettingsToggle label="Keep System awake" checked={keepSystemAwake} onChange={onKeepSystemAwakeChange} />
          </SettingsRow>
          <SettingsRow title="Confirm before deleting tasks" description="Ask before removing a conversation from the task list.">
            <SettingsToggle label="Confirm before deleting tasks" checked={preferences.confirmBeforeDelete} onChange={(value) => onPreferenceChange("confirmBeforeDelete", value)} />
          </SettingsRow>
          <SettingsRow title="Thread cleanup age" description="Suggest inactive chats after this many days without use.">
            <div className="settings-inline-controls">
              <select className="settings-select compact" aria-label="Thread cleanup age" value={cleanupAgePreset} onChange={(event) => onPreferenceChange("threadCleanupAgeDays", event.target.value === "custom" ? 21 : Number(event.target.value))}>
                <option value="30">30 days</option>
                <option value="14">14 days</option>
                <option value="7">7 days</option>
                <option value="custom">Custom…</option>
              </select>
              {cleanupAgePreset === "custom" && (
                <label className="settings-day-input">
                  <input
                    type="number"
                    aria-label="Custom thread cleanup age"
                    min={THREAD_CLEANUP_MIN_DAYS}
                    max={THREAD_CLEANUP_MAX_DAYS}
                    value={preferences.threadCleanupAgeDays}
                    onChange={(event) => {
                      const days = Number(event.target.value);
                      if (Number.isInteger(days) && days >= THREAD_CLEANUP_MIN_DAYS && days <= THREAD_CLEANUP_MAX_DAYS) {
                        onPreferenceChange("threadCleanupAgeDays", days);
                      }
                    }}
                  />
                  <span>days</span>
                </label>
              )}
            </div>
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup title="Notifications" description="Choose when the desktop app asks for attention or reports finished work.">
          <SettingsRow hostOnly title="Questions and approvals" description="Notify when an agent needs a decision before it can continue.">
            <SettingsToggle label="Notify for questions and approvals" checked={attentionNotifications} onChange={onAttentionNotificationsChange} />
          </SettingsRow>
          <SettingsRow hostOnly title="Task completion" description="Notify when a lead task finishes its active turn.">
            <SettingsToggle label="Notify when tasks finish" checked={completionNotifications} onChange={onCompletionNotificationsChange} />
          </SettingsRow>
          <SettingsRow hostOnly title="Notification sound" description="Allow task notifications to play the operating system's alert sound.">
            <SettingsToggle label="Play notification sounds" checked={notificationSound} onChange={onNotificationSoundChange} />
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup title="Keyboard shortcuts" description="These shortcuts are available anywhere in Pixice.">
          <SettingsRow title="New task" description="Start a blank task in the selected project."><kbd className="settings-shortcut">{isMac ? "⌘ N" : "Ctrl N"}</kbd></SettingsRow>
          <SettingsRow title="Open settings" description="Jump directly to this settings workspace."><kbd className="settings-shortcut">{isMac ? "⌘ ," : "Ctrl ,"}</kbd></SettingsRow>
        </SettingsGroup>
      </>
    );
  } else if (page === "conversation") {
    pageContent = (
      <>
        <SettingsGroup title="Composer" description="Choose how Pixice behaves while you write and send prompts.">
          <SettingsRow title="Send shortcut" description="Choose whether Enter sends immediately or inserts a new line.">
            <select className="settings-select" aria-label="Send shortcut" value={preferences.sendShortcut} onChange={(event) => onPreferenceChange("sendShortcut", event.target.value)}>
              <option value="enter">Enter sends</option>
              <option value="mod-enter">⌘/Ctrl + Enter sends</option>
            </select>
          </SettingsRow>
          <SettingsRow title="Keep message drafts" description="Restore unsent text when you move between tasks.">
            <SettingsToggle label="Keep message drafts" checked={preferences.preserveDrafts} onChange={(value) => onPreferenceChange("preserveDrafts", value)} />
          </SettingsRow>
          <SettingsRow title="Focus the composer" description="Put the cursor in the prompt field when you open or switch tasks.">
            <SettingsToggle label="Focus the composer automatically" checked={preferences.autoFocusComposer} onChange={(value) => onPreferenceChange("autoFocusComposer", value)} />
          </SettingsRow>
          <SettingsRow title="Check spelling" description="Use the operating system's spelling suggestions in prompts.">
            <SettingsToggle label="Check spelling in prompts" checked={preferences.spellCheckComposer} onChange={(value) => onPreferenceChange("spellCheckComposer", value)} />
          </SettingsRow>
          <SettingsRow title="Slash command suggestions" description="Suggest commands at the cursor for the selected provider.">
            <SettingsToggle label="Show slash command suggestions" checked={preferences.showSlashCommands} onChange={(value) => onPreferenceChange("showSlashCommands", value)} />
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup title="Reading" description="Control the detail Pixice keeps visible around the answer.">
          <SettingsRow title="Message timestamps" description="Show the send time below user prompts and final answers.">
            <SettingsToggle label="Show message timestamps" checked={preferences.showMessageTimestamps} onChange={(value) => onPreferenceChange("showMessageTimestamps", value)} />
          </SettingsRow>
          <SettingsRow title="Completed work details" description="Choose the initial disclosure state for commands, file edits, and tool activity.">
            <select className="settings-select" aria-label="Completed work details" value={preferences.completedWorkDetails} onChange={(event) => onPreferenceChange("completedWorkDetails", event.target.value)}>
              <option value="auto">Auto</option>
              <option value="expanded">Expanded</option>
              <option value="collapsed">Collapsed</option>
            </select>
          </SettingsRow>
        </SettingsGroup>
      </>
    );
  } else if (page === "agents") {
    const coreBehaviors = agentBehaviorCatalog.filter((behavior) => behavior.category !== "pixice-native");
    const pixiceNativeBehaviors = agentBehaviorCatalog.filter((behavior) => behavior.category === "pixice-native");
    const renderBehavior = (behavior) => (
      <SettingsRow hostOnly key={behavior.id} title={behavior.label} description={behavior.description}>
        <SettingsToggle label={behavior.label} checked={agentBehaviors[behavior.id] ?? behavior.defaultEnabled} onChange={(value) => onAgentBehaviorChange(behavior.id, value)} />
      </SettingsRow>
    );
    pageContent = (
      <>
        <SettingsGroup title="Behavior packs" description="Bundled Markdown guidance added to every new or resumed Pixice agent.">
          {coreBehaviors.map(renderBehavior)}
        </SettingsGroup>
        {pixiceNativeBehaviors.length > 0 && (
          <SettingsGroup title="Pixice-native features" description="Optional guidance that makes agents more proactive with Pixice's own coordination tools.">
            {pixiceNativeBehaviors.map(renderBehavior)}
          </SettingsGroup>
        )}
        <SettingsGroup title="Live orchestration" description="Decide how Pixice reveals parallel work and decisions.">
          <SettingsRow title="Show task progress" description="Keep live plans, completion, agents, and touched files in the conversation.">
            <SettingsToggle label="Show task progress" checked={preferences.showTaskProgress} onChange={(value) => onPreferenceChange("showTaskProgress", value)} />
          </SettingsRow>
          <SettingsRow title="Expand task progress by default" description="Open the plan steps when a task progress card first appears.">
            <SettingsToggle label="Expand task progress by default" checked={preferences.expandTaskProgress} onChange={(value) => onPreferenceChange("expandTaskProgress", value)} />
          </SettingsRow>
          <SettingsRow title="Open task map when agents join" description="Reveal the inspector when a task delegates work to another agent.">
            <SettingsToggle label="Open task map when agents join" checked={preferences.autoOpenTaskMap} onChange={(value) => onPreferenceChange("autoOpenTaskMap", value)} />
          </SettingsRow>
          <SettingsRow title="Bring approvals forward" description="Open Attention automatically when an active task needs your decision.">
            <SettingsToggle label="Bring approvals forward" checked={preferences.bringApprovalsForward} onChange={(value) => onPreferenceChange("bringApprovalsForward", value)} />
          </SettingsRow>
        </SettingsGroup>
        <p className="settings-footnote">New agents use changes immediately. Existing sessions pick them up when Pixice next resumes them; an active turn keeps its current guidance.</p>
      </>
    );
  } else if (page === "appearance") {
    pageContent = (
      <>
        <SettingsGroup title="Conversation" description="Adjust the reading surface without changing the rest of the shell.">
          <SettingsRow title="Conversation width" description="Choose how much horizontal room messages and the composer use.">
            <select className="settings-select" aria-label="Conversation width" value={preferences.conversationWidth} onChange={(event) => onPreferenceChange("conversationWidth", event.target.value)}>
              <option value="focused">Focused</option>
              <option value="balanced">Balanced</option>
              <option value="wide">Wide</option>
            </select>
          </SettingsRow>
          <SettingsRow title="Conversation text size" description="Change message and composer text while leaving application chrome compact.">
            <select className="settings-select" aria-label="Conversation text size" value={preferences.conversationTextSize} onChange={(event) => onPreferenceChange("conversationTextSize", event.target.value)}>
              <option value="small">Small</option>
              <option value="standard">Standard</option>
              <option value="large">Large</option>
            </select>
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup title="Shell" description="Tune Pixice's color and material while keeping its restrained desktop character.">
          <SettingsRow title="Accent color" description="Used for focus, active controls, and live task state.">
            <AccentColorPicker value={preferences.accentColor} onChange={(value) => onPreferenceChange("accentColor", value)} />
          </SettingsRow>
          <SettingsRow title="Interface density" description="Choose tighter or roomier navigation and setting rows.">
            <select className="settings-select" aria-label="Interface density" value={preferences.density} onChange={(event) => onPreferenceChange("density", event.target.value)}>
              <option value="compact">Compact</option>
              <option value="comfortable">Comfortable</option>
            </select>
          </SettingsRow>
          <SettingsRow title="Reduce transparency" description="Use an opaque charcoal window material for stronger separation.">
            <SettingsToggle label="Reduce transparency" checked={preferences.reduceTransparency} onChange={(value) => onPreferenceChange("reduceTransparency", value)} />
          </SettingsRow>
          <SettingsRow title="Reduce motion" description="Minimize panel, progress, and loading animations.">
            <SettingsToggle label="Reduce motion" checked={preferences.reduceMotion} onChange={(value) => onPreferenceChange("reduceMotion", value)} />
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup title="Navigation">
          <SettingsRow title="Show shortcut hints" description="Display available keyboard shortcuts beside navigation actions.">
            <SettingsToggle label="Show shortcut hints" checked={preferences.showShortcutHints} onChange={(value) => onPreferenceChange("showShortcutHints", value)} />
          </SettingsRow>
          <SettingsRow title="Show third project row" description="Show up to nine project shortcuts in the Workspace sidebar and Focus header instead of six.">
            <SettingsToggle label="Show third project row" checked={preferences.showThirdProjectRow} onChange={(value) => onPreferenceChange("showThirdProjectRow", value)} />
          </SettingsRow>
          <SettingsRow title="Legacy sidebar" description="Restore the original project list with threads nested under the active project.">
            <SettingsToggle label="Legacy sidebar" checked={preferences.legacySidebar} onChange={(value) => onPreferenceChange("legacySidebar", value)} />
          </SettingsRow>
        </SettingsGroup>
      </>
    );
  } else if (page === "about") {
    const updateBusy = ["checking", "downloading", "protecting-data"].includes(updateStatus.state);
    const action = updateStatus.state === "available"
      ? { label: `Download ${updateStatus.availableVersion}`, run: onDownloadUpdate }
      : updateStatus.state === "downloaded" || updateStatus.state === "install-error"
        ? { label: updateStatus.state === "install-error" ? "Retry install" : "Restart and install", run: onInstallUpdate, primary: true }
        : { label: updateStatus.state === "error" ? "Try again" : updateStatus.state === "not-available" ? "Check again" : "Check for updates", run: onCheckForUpdates };
    pageContent = (
      <>
        <SettingsGroup title="Pixice updates" description="Packaged releases are downloaded directly from the official GitHub repository.">
          <SettingsRow title="Current version" description={`Pixice ${updateStatus.currentVersion}`}>
            <span className="settings-value">{updateStatus.supported ? "Release build" : "Development build"}</span>
          </SettingsRow>
          <SettingsRow title={["downloaded", "install-error"].includes(updateStatus.state) ? "Ready to install" : "Update status"} description={updateStatus.message}>
            <button className={`settings-action${action.primary ? " primary" : ""}`} disabled={!updateStatus.supported || updateBusy} onClick={action.run}>
              {updateBusy && <SpinnerGap className="spin-icon" size={14} />}{updateStatus.state === "downloading" ? `${Math.round(updateStatus.percent)}%` : updateStatus.state === "protecting-data" ? "Preserving data…" : action.label}
            </button>
          </SettingsRow>
          {updateStatus.state === "downloading" && (
            <div className="update-progress" role="progressbar" aria-label="Update download" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(updateStatus.percent)}>
              <span style={{ width: `${Math.max(0, Math.min(100, updateStatus.percent))}%` }} />
            </div>
          )}
        </SettingsGroup>
        <p className="settings-footnote">Provider runtime updates live with their separate installation and account controls under Providers.</p>
      </>
    );
  } else if (page === "voice") {
    pageContent = <VoiceSettings transcription={transcription} micDeviceId={preferences.micDeviceId} onMicDeviceChange={(value) => onPreferenceChange("micDeviceId", value)} />;
  } else if (page === "providers") {
    pageContent = <ProvidersSettings providers={providers} models={models} loading={providersLoading} onRefresh={onRefreshProviders} onLogin={onProviderLogin} onAction={onProviderAction} updateChecksEnabled={providerUpdateChecksEnabled} onUpdateChecksEnabledChange={onProviderUpdateChecksEnabledChange} widgetCredentials={widgetCredentials} />;
  } else if (page === "connections") {
    pageContent = <ConnectionsSettings />;
  } else if (page === "usage") {
    pageContent = <UsagePage summary={usageSummary} loading={usageLoading} error={usageError} limits={usageLimits} limitsLoading={usageLimitsLoading} limitsError={usageLimitsError} rangeDays={usageRangeDays} onRangeChange={onUsageRangeChange} onRefresh={onRefreshUsage} />;
  } else if (page === "capabilities") {
    pageContent = (
      <>
        <section className="settings-combined-section">
          <header><h2>Local development</h2><p>Manage the Git executable used for projects and local review.</p></header>
          <GitSettings status={gitStatus} loading={gitLoading} onRefresh={onRefreshGit} onInstall={onInstallGit} />
        </section>
        <section className="settings-combined-section">
          <header><h2>GitHub</h2><p>Connect the GitHub CLI account used by agents and release operations.</p></header>
          <GitHubSettings status={githubStatus} loading={githubLoading} progress={githubProgress} onRefresh={onRefreshGitHub} onLogin={onGitHubLogin} onLogout={onGitHubLogout} />
        </section>
        <section className="settings-combined-section">
          <header><h2>Agent capabilities</h2><p>Inspect the Skills, Apps, and MCP servers currently available to agents.</p></header>
          <CapabilitiesSettings extensions={extensions} loading={extensionsLoading} onRefresh={onRefreshCapabilities} />
        </section>
      </>
    );
  }

  return (
    <main className="main-canvas workspace settings-workspace">
      <div className={`settings-content-scroll${page === "usage" ? " usage-scrollbar-hidden" : ""}`} ref={settingsScrollRef}>
        <motion.div
          className={`settings-content${page === "usage" ? " usage-settings-content" : ""}`}
          key={page}
          initial={systemReducedMotion ? false : { opacity: 0, x: pageDirection * 8, filter: "blur(3px)" }}
          animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
          transition={{ duration: systemReducedMotion ? 0 : 0.17, ease: MOTION_EASE }}
        >
          <header className="settings-page-title"><span>Settings</span><h1>{selectedPage.label}</h1><p>{selectedPage.description}</p></header>
          {pageContent}
        </motion.div>
      </div>
    </main>
  );
}

function AttentionWorkspace({ attention, projects, onResolve }) {
  const approvals = attention.filter(isApprovalRequest);
  return <main className="main-canvas workspace">
    <AppToolbar icon={ShieldCheck} title="Attention" subtitle={`${approvals.length} approval${approvals.length === 1 ? "" : "s"}`} />
    <div className="attention-column">
      {approvals.length ? approvals.map((request) => <div key={request.id}>
        <p className="approval-task-context">{projects.find((project) => project.id === request.projectId)?.displayName ?? "Pixice"} · {request.taskTitle || request.params?.threadId || "Task"}</p>
        <ApprovalCard request={request} onResolve={onResolve} />
      </div>) : <div className="empty-state compact"><ShieldCheck size={28} /><h2>No approvals waiting</h2><p>Requests for permission appear here.</p></div>}
    </div>
  </main>;
}

function BoardWorkspace({ project, threads, tasks, phases, attention, loading, onCreate, onCreatePhase, onUpdate, onMove, onDelete, onOpenThread, onOpenTask, onScheduleMove, onStartTask, storage = localStorage }) {
  return (
    <main className="main-canvas workspace">
      <AppToolbar icon={BoardIcon} title="Board" subtitle={project?.displayName} />
      <KanbanBoard
        project={project}
        threads={threads}
        tasks={tasks}
        phases={phases}
        attention={attention}
        loading={loading}
        onCreate={onCreate}
        onCreatePhase={onCreatePhase}
        onUpdate={onUpdate}
        onMove={onMove}
        onDelete={onDelete}
        onOpenThread={onOpenThread}
        onOpenTask={onOpenTask}
        onScheduleMove={onScheduleMove}
        onStartTask={onStartTask}
        storage={storage}
      />
    </main>
  );
}

function ExecutionTargetControl({ connect, value, projects, currentHostId, currentProjectId, onChange, onProjectChange, disabled = false }) {
  if (!connect) return null;
  const roleFor = (instance) => connect.clientStates[instance.id]?.role ?? connect.hostCatalogs[instance.id]?.role ?? instance.role ?? 'operator';
  const hosts = [
    ...(connect.local ? [{ id: "local", label: "This device", state: connect.localState?.state ?? "connected", projects: connect.hostCatalogs.local?.projects ?? (currentHostId === "local" ? projects : []) }] : []),
    ...connect.instances.map((instance) => ({
      id: instance.id,
      label: instance.name,
      state: connect.clientStates[instance.id]?.state ?? "saved",
      role: roleFor(instance),
      disabled: roleFor(instance) === "observer",
      projects: connect.hostCatalogs[instance.id]?.projects ?? (currentHostId === instance.id ? projects : [])
    }))
  ];
  const selectedHost = hosts.find((host) => host.id === value.hostId) ?? hosts[0];
  const targetChanged = selectedHost && selectedHost.id !== currentHostId;
  return <div className="execution-target-control" data-execution-target={selectedHost?.id ?? "local"}>
    <label><span>Run on</span><select aria-label="Run on" value={value.hostId} disabled={disabled} onChange={(event) => onChange({ hostId: event.target.value, projectId: event.target.value === currentHostId ? currentProjectId ?? "" : "" })}>
      {hosts.map((host) => <option key={host.id} value={host.id} disabled={host.disabled}>{host.label} · {host.disabled ? "view only" : host.state}</option>)}
    </select></label>
    {targetChanged && <label><span>Project</span><select aria-label="Target project" required value={value.projectId} disabled={disabled} onChange={(event) => onProjectChange(event.target.value)}>
      <option value="">Choose target project</option>
      {(selectedHost.projects ?? []).map((project) => <option key={project.id} value={project.id}>{project.displayName ?? project.name} · {project.canonicalPath ?? project.path}</option>)}
    </select></label>}
  </div>;
}

export function App({ readOnly = false } = {}) {
  const [serviceRevision, setServiceRevision] = useState(0);
  const bootstrapLoaded = useRef(false);
  const systemReducedMotion = useReducedMotion();
  const api = getPixiceApi();
  const connect = useConnect();
  const storage = connect?.storage ?? localStorage;
  const transcription = useTranscription(api);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectActivity, setProjectActivity] = useState({});
  const [seenThreadCompletions, setSeenThreadCompletions] = useState(() => loadSeenThreadCompletions(storage));
  const [seenThreadCompletionsHydrated, setSeenThreadCompletionsHydrated] = useState(false);
  const [threadMessageRecency, setThreadMessageRecency] = useState(() => loadThreadMessageRecency(storage));
  const [linkedThreads, setLinkedThreads] = useState(() => listRemoteThreadLinks(storage));
  const [selectedLinkedThread, setSelectedLinkedThread] = useState(null);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectCreateBusy, setProjectCreateBusy] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const selectedProjectIdRef = useRef(null);
  const [surfaceMode, setSurfaceMode] = useState(() => api?.focus && (storage.getItem("pixice.surfaceMode") === "focus" || (import.meta.env.DEV && new URLSearchParams(window.location.search).has("focus-v2-preview"))) ? "focus" : "workspace");
  const surfaceModeRef = useRef(surfaceMode);
  const [focusThreadId, setFocusThreadId] = useState(null);
  const focusThreadIdRef = useRef(null);
  const [focusLoading, setFocusLoading] = useState(false);
  const [focusConnectionError, setFocusConnectionError] = useState(null);
  const [focusMemory, setFocusMemory] = useState(null);
  const focusEnsureRequestRef = useRef(0);
  const workspaceThreadByProjectRef = useRef(new Map());
  const [threads, setThreads] = useState([]);
  const [selectedThreadId, setSelectedThreadId] = useState(null);
  const selectedThreadIdRef = useRef(null);
  const bridgeThreadIdsRef = useRef(new Set());
  const lastRuntimeActivityAtRef = useRef(Date.now());
  const optimisticThreadsRef = useRef(new Map());
  const threadLoadRequestRef = useRef(0);
  const threadsLoadRequestRef = useRef(0);
  const reviewLoadRequestRef = useRef(0);
  const reviewFileRequestRef = useRef(new Map());
  const boardLoadRequestRef = useRef(0);
  const proactivityLoadRequestRef = useRef(0);
  const toolsLoadRequestRef = useRef(0);
  const extensionsLoadRequestRef = useRef(0);
  const usageLoadRequestRef = useRef(0);
  const usageLimitsLoadRequestRef = useRef(0);
  const submittingRef = useRef(false);
  const seenResponseIdsRef = useRef(new Set());
  const pendingRuntimeDeltasRef = useRef([]);
  const runtimeDeltaFrameRef = useRef(null);
  const runtimeDeltaUsesAnimationFrameRef = useRef(false);
  const attentionRevisionRef = useRef(0);
  const attentionSnapshotReadTokenRef = useRef(0);
  const [thread, setThread] = useState(null);
  const [plan, setPlan] = useState([]);
  const [attention, setAttention] = useState([]);
  const [taskReceipts, setTaskReceipts] = useState([]);
  const [receiptRefreshKey, setReceiptRefreshKey] = useState(0);
  const [comparisonThreadId, setComparisonThreadId] = useState(null);
  const [review, setReview] = useState({ projectId: null, repository: null, files: [], fileDiffs: {} });
  const [boardTasks, setBoardTasks] = useState([]);
  const [boardPhases, setBoardPhases] = useState([]);
  const [proactiveSuggestions, setProactiveSuggestions] = useState([]);
  const [projectTools, setProjectTools] = useState([]);
  const [selectedProjectToolId, setSelectedProjectToolId] = useState(null);
  const [extensions, setExtensions] = useState(EMPTY_EXTENSIONS);
  const [providers, setProviders] = useState([]);
  const [gitStatus, setGitStatus] = useState(EMPTY_GIT_STATUS);
  const [githubStatus, setGithubStatus] = useState(EMPTY_GITHUB_STATUS);
  const [githubProgress, setGithubProgress] = useState(null);
  const [usageSummary, setUsageSummary] = useState(null);
  const [usageError, setUsageError] = useState(null);
  const [usageLimits, setUsageLimits] = useState(null);
  const [usageLimitsError, setUsageLimitsError] = useState(null);
  const [usageRangeDays, setUsageRangeDays] = useState(30);
  const [usageRefreshKey, setUsageRefreshKey] = useState(0);
  const [usageLimitsRefreshKey, setUsageLimitsRefreshKey] = useState(0);
  const [models, setModels] = useState([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [defaultEffort, setDefaultEffort] = useState("");
  const [defaultsHydrated, setDefaultsHydrated] = useState(false);
  const [effort, setEffort] = useState("");
  const [fastMode, setFastMode] = useState(false);
  const [defaultFastMode, setDefaultFastMode] = useState(false);
  const [threadNamingModel, setThreadNamingModel] = useState(THREAD_NAMING_AUTO);
  const [workflowGenerationModel, setWorkflowGenerationModel] = useState(WORKFLOW_GENERATION_AUTO);
  const [defaultPermissionMode, setDefaultPermissionMode] = useState(() => {
    const saved = storage.getItem("pixice.permissionMode");
    return PERMISSION_OPTIONS.some((option) => option.value === saved) ? saved : "workspace-write";
  });
  const [permissionMode, setPermissionMode] = useState(defaultPermissionMode);
  const [preferences, setPreferences] = useState(() => loadPreferences(storage));
  const preferencesRef = useRef(preferences);
  const [agentBehaviorCatalog, setAgentBehaviorCatalog] = useState(EMPTY_AGENT_BEHAVIORS);
  const [agentBehaviors, setAgentBehaviors] = useState({});
  const [runtime, setRuntime] = useState({ state: "starting", connected: false });
  const [activeView, setActiveView] = useState("task");
  const [settingsPage, setSettingsPage] = useState("general");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [previewWorkspaces, setPreviewWorkspaces] = useState({});
  const previewWorkspaceSequenceRef = useRef(0);
  const [updateStatus, setUpdateStatus] = useState(EMPTY_UPDATE_STATUS);
  const [attentionNotifications, setAttentionNotifications] = useState(true);
  const [completionNotifications, setCompletionNotifications] = useState(false);
  const [notificationSound, setNotificationSound] = useState(true);
  const [keepSystemAwake, setKeepSystemAwake] = useState(false);
  const [providerUpdateChecksEnabled, setProviderUpdateChecksEnabled] = useState(true);
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number.parseInt(storage.getItem("pixice.sidebarWidth") ?? "", 10);
    return Number.isFinite(saved) && saved !== 296 ? clampSidebarWidth(saved) : DEFAULT_SIDEBAR_WIDTH;
  });
  const [executionTarget, setExecutionTarget] = useState(() => ({ hostId: connect?.active ?? "local", projectId: null }));
  const [executionTargetConfig, setExecutionTargetConfig] = useState(null);
  const executionTargetRequestRef = useRef(0);

  const markThreadMessaged = useCallback((threadId) => {
    if (!threadId) return;
    setThreadMessageRecency((current) => {
      const latestKnown = Object.values(current).reduce((latest, value) => Math.max(latest, value), 0);
      const next = { ...current, [threadId]: Math.max(Date.now(), latestKnown + 1) };
      storage.setItem(THREAD_MESSAGE_RECENCY_KEY, JSON.stringify(next));
      return next;
    });
  }, [storage]);
  const [draftMode, setDraftMode] = useState(false);
  const draftModeRef = useRef(false);
  const [loading, setLoading] = useState({ app: true, threads: false, thread: false, review: false, reviewFile: null, board: false, tools: false, extensions: false, providers: false, git: false, github: false, usage: false, usageLimits: false });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const refreshLinkedThreads = useCallback((projectId) => {
    if (!projectId) {
      setLinkedThreads([]);
      return [];
    }
    const originHostId = connect?.active ?? "local";
    const next = loadRemoteThreadLinks(originHostId, projectId, storage);
    setLinkedThreads(next);
    return next;
  }, [connect?.active, storage]);

  const rememberLinkedThread = useCallback((reference) => {
    const originHostId = connect?.active ?? "local";
    const originStorage = reference.originHostId === originHostId
      ? storage
      : createWorkspaceStorage(reference.originHostId);
    const saved = upsertRemoteThreadLink(reference, originStorage) ?? reference;
    if (saved.originHostId !== originHostId || saved.originProjectId !== selectedProjectIdRef.current) return;
    setLinkedThreads((current) => [saved, ...current.filter((candidate) => !(
      candidate.originHostId === saved.originHostId
      && candidate.originProjectId === saved.originProjectId
      && candidate.executionHostId === saved.executionHostId
      && candidate.executionProjectId === saved.executionProjectId
      && candidate.rawThreadId === saved.rawThreadId
    ))]);
  }, [connect?.active, storage]);

  useEffect(() => {
    refreshLinkedThreads(selectedProjectId);
  }, [refreshLinkedThreads, selectedProjectId]);

  const openLinkedThread = useCallback(async (reference) => {
    if (!connect?.openExecution) return false;
    setSelectedLinkedThread(`${reference.executionHostId}:${reference.executionProjectId}:${reference.rawThreadId}`);
    try {
      await connect.openExecution({
        ...reference,
        hostId: reference.executionHostId,
        projectId: reference.executionProjectId,
        threadId: reference.rawThreadId,
        onThreadLinked: rememberLinkedThread
      });
      return true;
    } catch (cause) {
      setError(cause.message);
      return false;
    }
  }, [connect, rememberLinkedThread]);

  const savePersistentDefaults = useCallback((patch) => {
    if (patch.defaultModel !== undefined) storage.setItem("pixice.model", patch.defaultModel);
    if (patch.defaultEffort !== undefined) storage.setItem("pixice.effort", patch.defaultEffort);
    if (patch.defaultPermissionMode !== undefined) storage.setItem("pixice.permissionMode", patch.defaultPermissionMode);
    if (!api?.app?.saveSettings) return;
    void api.app.saveSettings(patch).catch((cause) => setError(cause.message));
  }, [api, storage]);

  useEffect(() => {
    if (!defaultsHydrated) return;
    savePersistentDefaults({
      accentColor: preferences.accentColor,
      reduceTransparency: preferences.reduceTransparency
    });
  }, [defaultsHydrated, preferences.accentColor, preferences.reduceTransparency, savePersistentDefaults]);

  const previewWorkspaceId = selectedThreadId ?? (selectedProjectId ? `draft:${selectedProjectId}` : null);
  const previewWorkspace = previewWorkspaces[previewWorkspaceId] ?? EMPTY_PREVIEW_WORKSPACE;
  const previewApiWorkspaceId = previewWorkspace.presentedFromWorkspaceId ?? previewWorkspaceId;
  const previewOpen = previewWorkspace.open;
  const browserState = previewWorkspace.browserState;
  const previewFileTabs = previewWorkspace.fileTabs;
  const previewInstrumentTabs = previewWorkspace.instrumentTabs ?? [];
  const previewCustomTabs = previewWorkspace.customTabs ?? [];
  const previewActiveTabId = previewWorkspace.activeTabId;
  const currentPreviewContext = useMemo(
    () => previewContextForWorkspace({
      open: previewOpen,
      browserState,
      fileTabs: previewFileTabs,
      instrumentTabs: previewInstrumentTabs,
      customTabs: previewCustomTabs,
      activeTabId: previewActiveTabId
    }),
    [browserState, previewActiveTabId, previewCustomTabs, previewFileTabs, previewInstrumentTabs, previewOpen]
  );
  useEffect(() => {
    if (!api?.preview?.setContext || !previewWorkspaceId) return;
    void api.preview.setContext({ threadId: previewWorkspaceId, context: currentPreviewContext }).catch(() => {});
  }, [api, currentPreviewContext, previewWorkspaceId]);
  const updatePreviewWorkspace = useCallback((workspaceId, updater) => {
    if (!workspaceId) return;
    setPreviewWorkspaces((current) => {
      const workspace = current[workspaceId] ?? EMPTY_PREVIEW_WORKSPACE;
      const updated = typeof updater === "function" ? updater(workspace) : updater;
      previewWorkspaceSequenceRef.current += 1;
      return { ...current, [workspaceId]: { ...updated, lastUsed: previewWorkspaceSequenceRef.current } };
    });
  }, []);
  const mirrorPreviewPresentations = useCallback((sourceWorkspaceId) => {
    if (!sourceWorkspaceId) return;
    setPreviewWorkspaces((current) => {
      const source = current[sourceWorkspaceId];
      if (!source) return current;
      let changed = false;
      const next = Object.fromEntries(Object.entries(current).map(([workspaceId, workspace]) => {
        if (workspace.presentedFromWorkspaceId !== sourceWorkspaceId) return [workspaceId, workspace];
        changed = true;
        return [workspaceId, {
          ...source,
          presentedFromWorkspaceId: sourceWorkspaceId,
          presentationTitle: workspace.presentationTitle ?? null,
          lastUsed: workspace.lastUsed
        }];
      }));
      return changed ? next : current;
    });
  }, []);
  const setPreviewOpen = useCallback((value) => {
    updatePreviewWorkspace(previewWorkspaceId, (workspace) => ({
      ...workspace,
      open: typeof value === "function" ? value(workspace.open) : value
    }));
  }, [previewWorkspaceId, updatePreviewWorkspace]);
  const setBrowserState = useCallback((value) => {
    updatePreviewWorkspace(previewWorkspaceId, (workspace) => ({
      ...workspace,
      browserState: typeof value === "function" ? value(workspace.browserState) : value
    }));
  }, [previewWorkspaceId, updatePreviewWorkspace]);
  const setPreviewFileTabs = useCallback((value) => {
    updatePreviewWorkspace(previewWorkspaceId, (workspace) => ({
      ...workspace,
      fileTabs: typeof value === "function" ? value(workspace.fileTabs) : value
    }));
  }, [previewWorkspaceId, updatePreviewWorkspace]);
  const setPreviewInstrumentTabs = useCallback((value) => {
    updatePreviewWorkspace(previewWorkspaceId, (workspace) => ({
      ...workspace,
      instrumentTabs: typeof value === "function" ? value(workspace.instrumentTabs ?? []) : value
    }));
  }, [previewWorkspaceId, updatePreviewWorkspace]);
  const setPreviewCustomTabs = useCallback((value) => {
    updatePreviewWorkspace(previewWorkspaceId, (workspace) => ({
      ...workspace,
      customTabs: typeof value === "function" ? value(workspace.customTabs ?? []) : value
    }));
  }, [previewWorkspaceId, updatePreviewWorkspace]);
  const setPreviewActiveTabId = useCallback((value) => {
    updatePreviewWorkspace(previewWorkspaceId, (workspace) => ({
      ...workspace,
      activeTabId: typeof value === "function" ? value(workspace.activeTabId) : value
    }));
  }, [previewWorkspaceId, updatePreviewWorkspace]);

  useEffect(() => {
    const currentHostId = api?.remote?.hostId ?? "local";
    const openPreview = (event) => {
      const detail = event.detail ?? {};
      if (detail.hostId !== currentHostId) return;
      const activeWorkspaceId = selectedThreadIdRef.current ?? (selectedProjectIdRef.current ? `draft:${selectedProjectIdRef.current}` : null);
      if (!detail.workspaceId || detail.workspaceId !== activeWorkspaceId) return;
      if (detail.projectId && detail.projectId !== selectedProjectIdRef.current) return;
      setInspectorOpen(false);
      setActiveView("task");
      updatePreviewWorkspace(detail.workspaceId, (workspace) => ({ ...workspace, open: true }));
    };
    const openBoard = (event) => {
      const detail = event.detail ?? {};
      if (detail.hostId !== currentHostId) return;
      if (detail.projectId && detail.projectId !== selectedProjectIdRef.current) return;
      if (detail.taskId) storage.setItem(`pixice.boardSelection.${detail.projectId}`, detail.taskId);
      setPreviewOpen(false);
      setActiveView("board");
    };
    const openTab = (event) => {
      const detail = event.detail ?? {};
      if (detail.hostId !== currentHostId) return;
      const workspaceId = detail.workspaceId ?? detail.threadId;
      const tab = detail.tab;
      if (!workspaceId || !tab?.id || !tab.kind) return;
      updatePreviewWorkspace(workspaceId, (workspace) => {
        const current = workspace.customTabs ?? [];
        return {
          ...workspace,
          open: true,
          activeTabId: tab.id,
          customTabs: current.some((candidate) => candidate.id === tab.id)
            ? current.map((candidate) => candidate.id === tab.id ? { ...candidate, ...tab } : candidate)
            : [...current, tab]
        };
      });
      const activeWorkspaceId = selectedThreadIdRef.current ?? (selectedProjectIdRef.current ? `draft:${selectedProjectIdRef.current}` : null);
      if (workspaceId === activeWorkspaceId) {
        setInspectorOpen(false);
        setActiveView("task");
      }
    };
    window.addEventListener("pixice:request-task-preview", openPreview);
    window.addEventListener("pixice:open-board-workspace", openBoard);
    window.addEventListener("pixice:open-preview-tab", openTab);
    return () => {
      window.removeEventListener("pixice:request-task-preview", openPreview);
      window.removeEventListener("pixice:open-board-workspace", openBoard);
      window.removeEventListener("pixice:open-preview-tab", openTab);
    };
  }, [api, setPreviewOpen, updatePreviewWorkspace]);

  useEffect(() => {
    const entries = Object.entries(previewWorkspaces);
    const excess = entries.length - MAX_RETAINED_PREVIEW_WORKSPACES;
    if (excess <= 0) return;
    const runningThreadIds = new Set(threads.filter((candidate) => ["running", "inProgress", "active"].includes(threadStatus(candidate))).map((candidate) => candidate.id));
    const removable = entries
      .filter(([workspaceId, workspace]) => workspaceId !== previewWorkspaceId
        && !workspace.open
        && !runningThreadIds.has(workspaceId)
        && !(workspace.fileTabs ?? []).some((file) => file.dirty))
      .sort((left, right) => (left[1].lastUsed ?? 0) - (right[1].lastUsed ?? 0))
      .slice(0, excess);
    if (!removable.length) return;
    const removedIds = removable.map(([workspaceId]) => workspaceId);
    setPreviewWorkspaces((current) => {
      const next = { ...current };
      removedIds.forEach((workspaceId) => delete next[workspaceId]);
      return next;
    });
    removedIds.forEach((workspaceId) => {
      if (!api?.remote) void api?.browser?.destroy?.({ workspaceId }).catch(() => {});
    });
  }, [api, previewWorkspaceId, previewWorkspaces, threads]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const projectActivityKey = projects.map((project) => project.id).sort().join("|");
  const activeTurn = useMemo(() => [...(thread?.turns ?? [])].reverse().find((turn) => turnIsRunning(turn.status)), [thread]);
  const sidebarThreads = useMemo(() => threads
    .filter((candidate) => candidate.id !== focusThreadId)
    .filter(isSidebarThread)
    .map((candidate) => {
      const selected = candidate.id === thread?.id;
      const running = selected ? Boolean(activeTurn) : threadIsRunning(candidate);
      const sidebarCompleted = !running && (
        candidate.completionRevision !== undefined
        || candidate.turns?.at(-1)?.status === "completed"
        || threadStatus(candidate) === "completed"
      );
      const status = selected ? { type: activeTurn ? "active" : "idle", activeFlags: [] } : candidate.status;
      return candidate.sidebarCompleted === sidebarCompleted && threadStatus({ status }) === threadStatus(candidate)
        ? candidate
        : { ...candidate, sidebarCompleted, status };
    })
    .map((candidate, originalIndex) => ({ candidate, originalIndex }))
    .sort((left, right) => {
      const leftRecency = threadMessageRecency[left.candidate.id];
      const rightRecency = threadMessageRecency[right.candidate.id];
      if (Number.isFinite(leftRecency) && Number.isFinite(rightRecency)) return rightRecency - leftRecency;
      if (Number.isFinite(leftRecency)) return -1;
      if (Number.isFinite(rightRecency)) return 1;
      const leftWasAgentSpawned = left.candidate.bridge?.kind === "pixiceBridge" || Boolean(left.candidate.bridgeModel);
      const rightWasAgentSpawned = right.candidate.bridge?.kind === "pixiceBridge" || Boolean(right.candidate.bridgeModel);
      if (leftWasAgentSpawned !== rightWasAgentSpawned) return leftWasAgentSpawned ? 1 : -1;
      return left.originalIndex - right.originalIndex;
    })
    .map(({ candidate }) => candidate), [activeTurn, focusThreadId, thread?.id, threadMessageRecency, threads]);
  const selectedThreadCompletionRevision = threadCompletionRevision(sidebarThreads.find((candidate) => candidate.id === selectedThreadId));
  const changedCount = review.projectId === selectedProjectId ? review.repository?.dirtyPaths?.length ?? 0 : 0;

  const markThreadCompletionSeen = useCallback((candidate) => {
    const threadId = candidate?.id;
    const completionRevision = threadCompletionRevision(candidate);
    if (!threadId || !completionRevision) return;
    setSeenThreadCompletions((current) => {
      if (current[threadId] === completionRevision) return current;
      return { ...current, [threadId]: completionRevision };
    });
  }, []);

  useEffect(() => {
    if (!selectedThreadId || !selectedThreadCompletionRevision) return;
    markThreadCompletionSeen(sidebarThreads.find((candidate) => candidate.id === selectedThreadId));
  }, [markThreadCompletionSeen, selectedThreadCompletionRevision, selectedThreadId, sidebarThreads]);

  useEffect(() => {
    if (!seenThreadCompletionsHydrated) return;
    storage.setItem(THREAD_COMPLETIONS_SEEN_KEY, JSON.stringify(seenThreadCompletions));
    if (!api?.app?.saveSettings) return;
    void api.app.saveSettings({ threadCompletionsSeen: seenThreadCompletions }).catch((cause) => setError(cause.message));
  }, [api, seenThreadCompletions, seenThreadCompletionsHydrated, storage]);

  const normalizePlan = useCallback((steps) => (steps ?? []).map((step) => ({
    ...step,
    status: step.status === "in_progress" ? "inProgress" : step.status
  })), []);

  const cancelRuntimeDeltaFrame = useCallback(() => {
    if (runtimeDeltaFrameRef.current === null) return;
    if (runtimeDeltaUsesAnimationFrameRef.current) window.cancelAnimationFrame(runtimeDeltaFrameRef.current);
    else window.clearTimeout(runtimeDeltaFrameRef.current);
    runtimeDeltaFrameRef.current = null;
  }, []);

  const flushRuntimeDeltas = useCallback(() => {
    runtimeDeltaFrameRef.current = null;
    const pending = pendingRuntimeDeltasRef.current.splice(0);
    if (!pending.length) return;
    const payloads = coalesceRuntimeDeltas(pending.map((entry) => entry.payload));
    const fallback = pending.findLast((entry) => entry.fallback)?.fallback ?? null;
    setThread((current) => payloads.reduce((next, payload) => applyRuntimePayload(next ?? fallback, payload), current));
  }, []);

  const commitRuntimePayload = useCallback((payload, fallback = null) => {
    if (payload.method === "item/agentMessage/delta") {
      pendingRuntimeDeltasRef.current.push({ payload, fallback });
      if (runtimeDeltaFrameRef.current !== null) return;
      runtimeDeltaUsesAnimationFrameRef.current = typeof window.requestAnimationFrame === "function";
      runtimeDeltaFrameRef.current = runtimeDeltaUsesAnimationFrameRef.current
        ? window.requestAnimationFrame(flushRuntimeDeltas)
        : window.setTimeout(flushRuntimeDeltas, 16);
      return;
    }
    const pending = pendingRuntimeDeltasRef.current.splice(0);
    cancelRuntimeDeltaFrame();
    setThread((current) => {
      const pendingPayloads = coalesceRuntimeDeltas(pending.map((entry) => entry.payload));
      const pendingFallback = pending.findLast((entry) => entry.fallback)?.fallback ?? fallback;
      const withPending = pendingPayloads.reduce((next, pendingPayload) => applyRuntimePayload(next ?? pendingFallback, pendingPayload), current);
      return applyRuntimePayload(withPending ?? fallback, payload);
    });
  }, [cancelRuntimeDeltaFrame, flushRuntimeDeltas]);

  useEffect(() => () => {
    pendingRuntimeDeltasRef.current = [];
    cancelRuntimeDeltaFrame();
  }, [cancelRuntimeDeltaFrame]);

  useEffect(() => {
    draftModeRef.current = draftMode;
  }, [draftMode]);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
    lastRuntimeActivityAtRef.current = Date.now();
    window.dispatchEvent(new CustomEvent("pixice:active-thread-changed", { detail: selectedThreadId }));
  }, [selectedThreadId]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  useEffect(() => {
    surfaceModeRef.current = surfaceMode;
    storage.setItem("pixice.surfaceMode", surfaceMode);
  }, [storage, surfaceMode]);

  useEffect(() => {
    preferencesRef.current = preferences;
    storage.setItem("pixice.preferences", JSON.stringify(preferences));
  }, [preferences, storage]);

  const changePreference = useCallback((key, value) => {
    setPreferences((current) => ({ ...current, [key]: value }));
    if (key === "showThirdProjectRow" && value === false && selectedProjectIdRef.current) {
      setProjects((current) => activateProject(current, selectedProjectIdRef.current, {}, 6));
    }
  }, []);

  const changeAgentBehavior = useCallback((id, value) => {
    setAgentBehaviors((current) => {
      const next = { ...current, [id]: value };
      savePersistentDefaults({ agentBehaviors: next });
      return next;
    });
  }, [savePersistentDefaults]);

  const changeView = useCallback((nextView) => {
    if (nextView !== "task") connect?.closeExecution?.();
    if (nextView !== "task") setPreviewOpen(false);
    setActiveView(nextView);
  }, [connect, setPreviewOpen]);

  const loadModels = useCallback(async () => {
    if (!api) return;
    const next = await api.models.list();
    setModels(next);
  }, [api]);

  const loadThreads = useCallback(async (projectId) => {
    if (!api || !projectId) return;
    const requestId = ++threadsLoadRequestRef.current;
    setLoading((state) => ({ ...state, threads: true }));
    try {
      const response = await api.threads.list({ projectId });
      if (requestId !== threadsLoadRequestRef.current || selectedProjectIdRef.current !== projectId) return;
      const next = response.data ?? [];
      next.filter(isBridgeThread).forEach((candidate) => bridgeThreadIdsRef.current.add(candidate.id));
      setThreads(next);
      refreshLinkedThreads(projectId);
      setProjectActivity((current) => ({
        ...current,
        [projectId]: summarizeProjectThreads(null, next, { seen: true })
      }));
      const sidebarCandidates = next.filter(isSidebarThread);
      setSelectedThreadId((current) => {
        const selected = surfaceModeRef.current === "focus" && focusThreadIdRef.current
          ? focusThreadIdRef.current
          : current && sidebarCandidates.some((candidate) => candidate.id === current)
          ? current
          : draftModeRef.current ? null : sidebarCandidates[0]?.id ?? null;
        selectedThreadIdRef.current = selected;
        return selected;
      });
    } catch (cause) {
      if (requestId !== threadsLoadRequestRef.current || selectedProjectIdRef.current !== projectId) return;
      setError(cause.message);
      // Keep the last list during a transient connection failure.
    } finally {
      if (requestId === threadsLoadRequestRef.current) setLoading((state) => ({ ...state, threads: false }));
    }
  }, [api, refreshLinkedThreads]);

  const loadThread = useCallback(async (projectId, threadId) => {
    if (!api || !projectId || !threadId) return;
    const requestId = ++threadLoadRequestRef.current;
    setLoading((state) => ({ ...state, thread: true }));
    try {
      const response = await api.threads.read({ projectId, threadId });
      if (requestId === threadLoadRequestRef.current && selectedProjectIdRef.current === projectId && selectedThreadIdRef.current === threadId) {
        markResponsesSeen(response.thread, seenResponseIdsRef.current);
        setThread(response.thread);
        if (response.thread?.name) {
          setThreads((current) => current.map((candidate) => candidate.id === threadId ? { ...candidate, name: response.thread.name } : candidate));
        }
        if (Array.isArray(response.plan)) setPlan(normalizePlan(response.plan));
        if (Array.isArray(response.plan)) {
          const planProgress = summarizePlanProgress(response.plan);
          setThreads((current) => current.map((candidate) => candidate.id === threadId ? { ...candidate, planProgress } : candidate));
        }
      }
    } catch (cause) {
      if (requestId === threadLoadRequestRef.current && selectedProjectIdRef.current === projectId && selectedThreadIdRef.current === threadId) {
        setError(cause.message);
        setThread(null);
      }
    } finally {
      if (requestId === threadLoadRequestRef.current) {
        setLoading((state) => ({ ...state, thread: false }));
      }
    }
  }, [api, normalizePlan]);

  const loadFocusSession = useCallback(async (projectId, { modelOverride = null, replaceEmpty = false } = {}) => {
    if (!api?.focus?.ensure || !projectId) return;
    const requestId = ++focusEnsureRequestRef.current;
    setFocusLoading(true);
    try {
      const requestedModel = modelOverride || defaultModel;
      const model = models.find((candidate) => candidate.model === requestedModel);
      const serviceTier = defaultFastMode ? fastServiceTier(model) : undefined;
      const response = await api.focus.ensure({
        projectId,
        model: requestedModel || undefined,
        ...(serviceTier !== undefined ? { serviceTier } : {}),
        ...(replaceEmpty ? { replaceEmpty: true } : {}),
        permissionMode: "full-access"
      });
      if (requestId !== focusEnsureRequestRef.current || selectedProjectIdRef.current !== projectId || surfaceModeRef.current !== "focus") return;
      const focusThread = response.thread;
      focusThreadIdRef.current = focusThread.id;
      setFocusThreadId(focusThread.id);
      markResponsesSeen(focusThread, seenResponseIdsRef.current);
      selectedThreadIdRef.current = focusThread.id;
      setSelectedThreadId(focusThread.id);
      setThread(focusThread);
      setPlan([]);
      setDraftMode(false);
      const saved = loadThreadConfiguration(focusThread.id, storage);
      const provider = response.configuration?.provider ?? focusThread.provider;
      const savedDefinition = saved?.model ? models.find((candidate) => candidate.model === saved.model) : null;
      const responseModel = response.configuration?.model;
      const responseDefinition = responseModel ? models.find((candidate) => candidate.model === responseModel || candidate.id === responseModel) : null;
      const responseModelName = responseDefinition?.model ?? responseModel;
      const configuredModel = (modelOverride && (!provider || responseDefinition?.provider === provider) ? responseModelName : null)
        ?? (saved && (!provider || (savedDefinition && savedDefinition.provider === provider)) ? saved.model : null)
        ?? (responseModel && (!provider || responseDefinition?.provider === provider) ? responseModelName : null)
        ?? models.find((candidate) => candidate.provider === provider)?.model
        ?? requestedModel;
      const configuredDefinition = models.find((candidate) => candidate.model === configuredModel);
      const configuredEffort = resolveReasoningEffort(saved?.effort, configuredDefinition, defaultEffort);
      const configuration = {
        model: configuredModel,
        effort: configuredEffort,
        fastMode: Boolean((saved ? saved.fastMode : defaultFastMode) && fastServiceTier(configuredDefinition)),
        permissionMode: "full-access"
      };
      saveThreadConfiguration(focusThread.id, configuration, storage);
      setSelectedModel(configuration.model);
      setEffort(configuration.effort);
      setFastMode(configuration.fastMode);
      setPermissionMode("full-access");
      setFocusMemory(response.memory ?? null);
      setFocusConnectionError(null);
      setError(null);
    } catch (cause) {
      if (requestId === focusEnsureRequestRef.current && selectedProjectIdRef.current === projectId) {
        setError(cause.message);
        setFocusConnectionError(cause.message);
      }
    } finally {
      if (requestId === focusEnsureRequestRef.current) setFocusLoading(false);
    }
  }, [api, defaultEffort, defaultFastMode, defaultModel, models, storage]);

  const refreshThread = useCallback(async (projectId, threadId) => {
    if (!api || !projectId || !threadId) return;
    try {
      const response = await api.threads.read({ projectId, threadId });
      if (selectedProjectIdRef.current === projectId && selectedThreadIdRef.current === threadId) {
        if (Array.isArray(response.plan)) {
          const nextPlan = normalizePlan(response.plan);
          setPlan((current) => samePlan(current, nextPlan) ? current : nextPlan);
          const planProgress = summarizePlanProgress(response.plan);
          setThreads((current) => current.map((candidate) => candidate.id === threadId ? { ...candidate, planProgress } : candidate));
        }
        if (response.thread?.name) {
          setThreads((current) => {
            const candidate = current.find((entry) => entry.id === threadId);
            if (!candidate || candidate.name === response.thread.name) return current;
            return current.map((entry) => entry.id === threadId ? { ...entry, name: response.thread.name } : entry);
          });
        }
        setThread((current) => {
          return mergeThreadSnapshot(current, response.thread);
        });
      }
    } catch {
      // Runtime events remain primary; a later refresh can recover a transient read.
    }
  }, [api, normalizePlan]);

  const loadAgents = useCallback(async (projectId, threadId) => {
    if (!api?.threads.children || !projectId || !threadId) return;
    try {
      const response = await api.threads.children({ projectId, threadId });
      if (selectedProjectIdRef.current !== projectId || selectedThreadIdRef.current !== threadId) return;
      const incoming = response.data ?? [];
      setThreads((current) => {
        const byId = new Map(current.map((candidate) => [candidate.id, candidate]));
        let changed = false;
        incoming.forEach((candidate) => {
          const existing = byId.get(candidate.id);
          const merged = {
            ...existing,
            ...candidate,
            preview: existing?.liveProjection && existing.preview ? existing.preview : candidate.preview,
            liveProjection: existing?.liveProjection ?? false
          };
          const unchanged = sameThreadSummary(existing, merged);
          if (!unchanged) changed = true;
          byId.set(candidate.id, unchanged ? existing : merged);
        });
        return changed ? [...byId.values()] : current;
      });
    } catch {
      // Live collaboration items still provide an immediate best-effort projection.
    }
  }, [api]);

  const loadReview = useCallback(async (projectId) => {
    if (!api || !projectId) return;
    const requestId = ++reviewLoadRequestRef.current;
    setLoading((state) => ({ ...state, review: true }));
    try {
      const result = await api.review.read({ projectId });
      if (requestId !== reviewLoadRequestRef.current || selectedProjectIdRef.current !== projectId) return;
      setReview({ ...result, projectId, fileDiffs: {} });
      if (result.repository?.git) setGitStatus(result.repository.git);
      setProjects((current) => current.map((project) => project.id === projectId ? { ...project, repository: result.repository } : project));
    } catch (cause) {
      if (requestId !== reviewLoadRequestRef.current || selectedProjectIdRef.current !== projectId) return;
      setError(cause.message);
      setReview({ projectId, repository: null, files: [], fileDiffs: {} });
    } finally {
      if (requestId === reviewLoadRequestRef.current) setLoading((state) => ({ ...state, review: false }));
    }
  }, [api]);

  const loadReviewFile = useCallback(async (projectId, filePath) => {
    if (!api?.review?.file || !projectId || !filePath) return;
    if (reviewFileRequestRef.current.has(filePath)) return;
    const requestId = Symbol(filePath);
    reviewFileRequestRef.current.set(filePath, requestId);
    setLoading((state) => ({ ...state, reviewFile: filePath }));
    try {
      const result = await api.review.file({ projectId, path: filePath });
      if (reviewFileRequestRef.current.get(filePath) !== requestId || selectedProjectIdRef.current !== projectId) return;
      setReview((current) => {
        if (current.projectId !== projectId || current.repository?.baseCommit !== result.baseCommit) return current;
        return { ...current, fileDiffs: { ...current.fileDiffs, [filePath]: result.diff } };
      });
    } catch (cause) {
      if (reviewFileRequestRef.current.get(filePath) === requestId) setError(cause.message);
    } finally {
      if (reviewFileRequestRef.current.get(filePath) === requestId) {
        reviewFileRequestRef.current.delete(filePath);
        setLoading((state) => ({ ...state, reviewFile: state.reviewFile === filePath ? null : state.reviewFile }));
      }
    }
  }, [api]);

  const loadBoard = useCallback(async (projectId) => {
    if (!api?.board || !projectId) {
      setBoardTasks([]);
      setBoardPhases([]);
      return;
    }
    const requestId = ++boardLoadRequestRef.current;
    setLoading((state) => ({ ...state, board: true }));
    try {
      const result = await api.board.list({ projectId });
      if (requestId !== boardLoadRequestRef.current || selectedProjectIdRef.current !== projectId) return;
      setBoardTasks(result.data ?? []);
      setBoardPhases(result.phases ?? []);
    } catch (cause) {
      if (requestId !== boardLoadRequestRef.current || selectedProjectIdRef.current !== projectId) return;
      setError(cause.message);
      setBoardTasks([]);
      setBoardPhases([]);
    } finally {
      if (requestId === boardLoadRequestRef.current) setLoading((state) => ({ ...state, board: false }));
    }
  }, [api]);

  const loadProactivity = useCallback(async (projectId, threadId) => {
    if (!api?.proactivity || !projectId || !threadId) {
      setProactiveSuggestions([]);
      return;
    }
    const requestId = ++proactivityLoadRequestRef.current;
    try {
      const result = await api.proactivity.list({ projectId, threadId });
      if (requestId !== proactivityLoadRequestRef.current || selectedProjectIdRef.current !== projectId || selectedThreadIdRef.current !== threadId) return;
      setProactiveSuggestions(result.data ?? []);
    } catch (cause) {
      if (requestId !== proactivityLoadRequestRef.current) return;
      setError(cause.message);
      setProactiveSuggestions([]);
    }
  }, [api]);

  const loadProjectTools = useCallback(async (projectId) => {
    if (!api?.instruments || !projectId) {
      setProjectTools([]);
      return;
    }
    const requestId = ++toolsLoadRequestRef.current;
    setLoading((state) => ({ ...state, tools: true }));
    try {
      const result = await api.instruments.tools({ projectId });
      if (requestId !== toolsLoadRequestRef.current || selectedProjectIdRef.current !== projectId) return;
      setProjectTools(result.data ?? []);
    } catch (cause) {
      if (requestId !== toolsLoadRequestRef.current || selectedProjectIdRef.current !== projectId) return;
      setError(cause.message);
      setProjectTools([]);
    } finally {
      if (requestId === toolsLoadRequestRef.current) setLoading((state) => ({ ...state, tools: false }));
    }
  }, [api]);

  const loadExtensions = useCallback(async () => {
    if (!api) return;
    const requestId = ++extensionsLoadRequestRef.current;
    const projectId = selectedProjectId;
    const threadId = selectedThreadId;
    setLoading((state) => ({ ...state, extensions: true }));
    try {
      const result = await api.extensions.list({ projectId: projectId ?? undefined, threadId: threadId ?? undefined });
      if (requestId !== extensionsLoadRequestRef.current || selectedProjectIdRef.current !== projectId || selectedThreadIdRef.current !== threadId) return;
      setExtensions({ ...EMPTY_EXTENSIONS, ...result });
    } catch (cause) {
      if (requestId !== extensionsLoadRequestRef.current) return;
      setError(cause.message);
    } finally {
      if (requestId === extensionsLoadRequestRef.current) setLoading((state) => ({ ...state, extensions: false }));
    }
  }, [api, selectedProjectId, selectedThreadId]);

  const loadProviders = useCallback(async () => {
    if (!api?.providers) return;
    setLoading((state) => ({ ...state, providers: true }));
    try {
      setProviders(await api.providers.list());
    } catch (cause) {
      setError(cause.message);
    } finally {
      setLoading((state) => ({ ...state, providers: false }));
    }
  }, [api]);

  const refreshProviders = useCallback(async () => {
    await loadProviders();
    await loadModels();
  }, [loadModels, loadProviders]);

  const loadGitHubStatus = useCallback(async () => {
    if (!api?.github) return;
    setLoading((state) => ({ ...state, github: true }));
    try {
      setGithubStatus(await api.github.status());
    } catch (cause) {
      setError(cause.message);
    } finally {
      setLoading((state) => ({ ...state, github: false }));
    }
  }, [api]);

  const loadGitStatus = useCallback(async () => {
    if (!api?.git) return;
    setLoading((state) => ({ ...state, git: true }));
    try {
      setGitStatus(await api.git.status());
    } catch (cause) {
      setError(cause.message);
    } finally {
      setLoading((state) => ({ ...state, git: false }));
    }
  }, [api]);

  const installCommandLineTools = useCallback(async () => {
    if (!api?.git) return;
    setLoading((state) => ({ ...state, git: true }));
    try {
      setGitStatus(await api.git.installCommandLineTools());
    } catch (cause) {
      setError(cause.message);
    } finally {
      setLoading((state) => ({ ...state, git: false }));
    }
  }, [api]);

  const loginGitHub = useCallback(async () => {
    if (!api?.github) return;
    setGithubProgress({ state: "starting", code: null, message: "Opening GitHub sign-in…" });
    try {
      setGithubStatus(await api.github.login());
      setGithubProgress(null);
    } catch (cause) {
      setGithubProgress(null);
      setError(cause.message);
      await loadGitHubStatus();
    }
  }, [api, loadGitHubStatus]);

  const logoutGitHub = useCallback(async () => {
    if (!api?.github) return;
    setLoading((state) => ({ ...state, github: true }));
    try {
      setGithubStatus(await api.github.logout());
      setGithubProgress(null);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setLoading((state) => ({ ...state, github: false }));
    }
  }, [api]);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    if (!api?.tasks?.receipts) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const results = await api.tasks.receipts({});
        const detail = selectedProjectId && selectedThreadId
          ? await api.tasks.receipt({ projectId: selectedProjectId, threadId: selectedThreadId }) : null;
        if (!cancelled) {
          setTaskReceipts((previous) => preserveReceiptEvidence(results.map((receipt) => receipt.threadId === detail?.threadId ? detail : receipt), previous));
        }
      } catch (cause) { if (!cancelled) setError(`Could not refresh task requests or results: ${cause.message}`); }
    }, 100);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [api, selectedProjectId, selectedThreadId, receiptRefreshKey]);

  useEffect(() => {
    if (!api?.tasks?.interventions) return undefined;
    let cancelled = false;
    const readToken = ++attentionSnapshotReadTokenRef.current;
    const readRevision = attentionRevisionRef.current;
    api.tasks.interventions().then((result) => {
      if (cancelled || readToken !== attentionSnapshotReadTokenRef.current || readRevision !== attentionRevisionRef.current) return;
      const requests = Array.isArray(result?.requests) ? result.requests : [];
      setAttention((current) => {
        if (cancelled || readToken !== attentionSnapshotReadTokenRef.current || readRevision !== attentionRevisionRef.current) return current;
        return requests;
      });
    }).catch((cause) => { if (!cancelled) setError(`Could not refresh task requests or results: ${cause.message}`); });
    return () => {
      cancelled = true;
      if (attentionSnapshotReadTokenRef.current === readToken) attentionSnapshotReadTokenRef.current += 1;
    };
  }, [api]);

  const loadUsage = useCallback(async (days = usageRangeDays) => {
    if (!api?.usage) return;
    const requestId = ++usageLoadRequestRef.current;
    setLoading((state) => ({ ...state, usage: true }));
    setUsageError(null);
    try {
      const result = await api.usage.summary({ days });
      if (requestId !== usageLoadRequestRef.current) return;
      setUsageSummary(result);
    } catch (cause) {
      if (requestId !== usageLoadRequestRef.current) return;
      setUsageError(cause.message);
    } finally {
      if (requestId === usageLoadRequestRef.current) setLoading((state) => ({ ...state, usage: false }));
    }
  }, [api, usageRangeDays]);

  const loadUsageLimits = useCallback(async () => {
    if (!api?.usage?.limits) return;
    const requestId = ++usageLimitsLoadRequestRef.current;
    setLoading((state) => ({ ...state, usageLimits: true }));
    setUsageLimitsError(null);
    try {
      const result = await api.usage.limits();
      if (requestId !== usageLimitsLoadRequestRef.current) return;
      setUsageLimits(result);
    } catch (cause) {
      if (requestId !== usageLimitsLoadRequestRef.current) return;
      setUsageLimitsError(cause.message);
    } finally {
      if (requestId === usageLimitsLoadRequestRef.current) setLoading((state) => ({ ...state, usageLimits: false }));
    }
  }, [api]);

  useEffect(() => {
    if (!api) {
      setRuntime({ state: "unavailable", connected: false });
      setError("Pixice’s desktop bridge is unavailable. Run the Electron app to connect projects and Codex.");
      setLoading((state) => ({ ...state, app: false }));
      return;
    }
    let cancelled = false;
    api.app.bootstrap().then((result) => {
      if (cancelled) return;
      // Recover server data in place. Navigation, composer drafts, settings forms,
      // preview tabs, and their scroll positions belong to the mounted interface.
      if (bootstrapLoaded.current) {
        setProjects(result.projects ?? []);
        setModels(result.models ?? []);
        setRuntime(result.runtime ?? { state: "unavailable", connected: false });
        return;
      }
      bootstrapLoaded.current = true;
      const nextModels = result.models ?? [];
      const persisted = result.settings ?? {};
      const durableSeenThreadCompletions = persistedSeenThreadCompletions(persisted.threadCompletionsSeen);
      setSeenThreadCompletions((current) => {
        if (!durableSeenThreadCompletions) return current;
        const next = { ...durableSeenThreadCompletions, ...current };
        if (Number.isFinite(durableSeenThreadCompletions[THREAD_COMPLETIONS_SEEN_BASELINE_KEY])) {
          next[THREAD_COMPLETIONS_SEEN_BASELINE_KEY] = durableSeenThreadCompletions[THREAD_COMPLETIONS_SEEN_BASELINE_KEY];
        }
        return next;
      });
      setSeenThreadCompletionsHydrated(true);
      const legacyModel = storage.getItem("pixice.model") || "";
      const legacyEffort = storage.getItem("pixice.effort") || "";
      const legacyPermission = storage.getItem("pixice.permissionMode") || "";
      const requestedModel = persisted.defaultModel || legacyModel;
      const resolvedModel = nextModels.find((model) => model.model === requestedModel)
        ?? nextModels.find((model) => model.isDefault)
        ?? nextModels[0];
      const resolvedEffort = resolvedModel
        ? resolveReasoningEffort(persisted.defaultEffort || legacyEffort, resolvedModel)
        : persisted.defaultEffort || legacyEffort;
      const requestedPermission = persisted.defaultPermissionMode || legacyPermission;
      const resolvedPermission = PERMISSION_OPTIONS.some((option) => option.value === requestedPermission)
        ? requestedPermission
        : "workspace-write";
      const resolvedDefaults = {
        ...(resolvedModel?.model ? { defaultModel: resolvedModel.model } : {}),
        ...(resolvedEffort ? { defaultEffort: resolvedEffort } : {}),
        defaultPermissionMode: resolvedPermission
      };
      const behaviorCatalog = result.agentBehaviors ?? EMPTY_AGENT_BEHAVIORS;
      const persistedBehaviors = persisted.agentBehaviors ?? {};
      const resolvedBehaviors = Object.fromEntries(behaviorCatalog.map((behavior) => [
        behavior.id,
        typeof persistedBehaviors[behavior.id] === "boolean" ? persistedBehaviors[behavior.id] : behavior.defaultEnabled
      ]));

      setProjects(result.projects ?? []);
      setModels(nextModels);
      setDefaultModel(resolvedModel?.model ?? requestedModel);
      setDefaultEffort(resolvedEffort);
      setDefaultFastMode(persisted.defaultFastMode === true);
      setThreadNamingModel(persisted.threadNamingModel ?? THREAD_NAMING_AUTO);
      setWorkflowGenerationModel(persisted.workflowGenerationModel ?? WORKFLOW_GENERATION_AUTO);
      setDefaultPermissionMode(resolvedPermission);
      setPermissionMode(resolvedPermission);
      setAgentBehaviorCatalog(behaviorCatalog);
      setAgentBehaviors(resolvedBehaviors);
      setAttentionNotifications(persisted.attentionNotifications !== false);
      setCompletionNotifications(persisted.completionNotifications === true);
      setNotificationSound(persisted.notificationSound !== false);
      setKeepSystemAwake(persisted.keepSystemAwake === true);
      setProviderUpdateChecksEnabled(persisted.checkProviderUpdates !== false);
      setDefaultsHydrated(true);
      setRuntime(result.runtime ?? { state: "unavailable", connected: false });
      if (Object.entries(resolvedDefaults).some(([key, value]) => persisted[key] !== value)) {
        savePersistentDefaults(resolvedDefaults);
      }
      const saved = storage.getItem("pixice.activeProjectId");
      const selected = result.projects?.find((project) => project.id === saved)?.id ?? result.projects?.[0]?.id ?? null;
      setSelectedProjectId(selected);
    }).catch((cause) => setError(cause.message)).finally(() => {
      if (!cancelled) setLoading((state) => ({ ...state, app: false }));
    });
    return () => { cancelled = true; };
  }, [api, savePersistentDefaults, serviceRevision, storage]);

  useEffect(() => {
    if (!api?.threads?.list || !projectActivityKey) {
      if (!projectActivityKey) setProjectActivity({});
      return undefined;
    }
    let cancelled = false;
    const projectIds = new Set(projects.map((project) => project.id));
    const projectSnapshot = projects
      .filter((project) => project.id !== selectedProjectId)
      .map((project) => ({ ...project }));
    Promise.all(projectSnapshot.map(async (project) => {
      try {
        const response = await api.threads.list({ projectId: project.id });
        const candidates = response.data ?? [];
        candidates.filter(isBridgeThread).forEach((candidate) => bridgeThreadIdsRef.current.add(candidate.id));
        return [project.id, summarizeProjectThreads(project, candidates, {
          seen: project.id === selectedProjectIdRef.current
        })];
      } catch {
        return [project.id, null];
      }
    })).then((entries) => {
      if (cancelled) return;
      setProjectActivity((current) => {
        const next = Object.fromEntries(Object.entries(current).filter(([projectId]) => projectIds.has(projectId)));
        for (const [projectId, activity] of entries) {
          next[projectId] = activity ?? current[projectId] ?? { runningThreadIds: [], unseenThreadIds: [] };
        }
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [api, projectActivityKey, runtime.connected, serviceRevision]);

  useEffect(() => {
    if (!api?.browser || !previewWorkspaceId) return;
    let cancelled = false;
    api.browser.state({ workspaceId: previewWorkspaceId }).then((state) => {
      if (!cancelled) {
        updatePreviewWorkspace(previewWorkspaceId, (workspace) => {
          const currentBrowserTabs = workspace.browserState?.tabs ?? [];
          const incomingBrowserIds = new Set((state.tabs ?? []).map((tab) => tab.id));
          const activeBrowserWasCreatedWhileLoading = currentBrowserTabs.some((tab) => tab.id === workspace.activeTabId)
            && !incomingBrowserIds.has(workspace.activeTabId);
          if (activeBrowserWasCreatedWhileLoading) return workspace;
          return {
            ...workspace,
            browserState: state,
            activeTabId: workspace.activeTabId ?? state.activeTabId ?? null
          };
        });
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [api, previewWorkspaceId, updatePreviewWorkspace, serviceRevision]);

  useEffect(() => {
    if (!api?.instruments || !selectedProjectId || !selectedThreadId) return;
    let cancelled = false;
    api.instruments.list({ projectId: selectedProjectId, threadId: selectedThreadId }).then((response) => {
      if (cancelled) return;
      updatePreviewWorkspace(selectedThreadId, (workspace) => ({
        ...workspace,
        instrumentTabs: response.data ?? []
      }));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [api, selectedProjectId, selectedThreadId, updatePreviewWorkspace, serviceRevision]);

  useEffect(() => {
    if (!api?.updates) return;
    let cancelled = false;
    api.updates.status().then((status) => {
      if (!cancelled) setUpdateStatus(status);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    if (!models.length || !defaultsHydrated) return;
    const model = models.find((candidate) => candidate.model === defaultModel) ?? models.find((candidate) => candidate.isDefault) ?? models[0];
    const nextDefaultEffort = resolveReasoningEffort(defaultEffort, model, model.defaultReasoningEffort);
    if (model.model !== defaultModel || nextDefaultEffort !== defaultEffort) {
      setDefaultModel(model.model);
      setDefaultEffort(nextDefaultEffort);
      savePersistentDefaults({ defaultModel: model.model, defaultEffort: nextDefaultEffort });
    }
    if (!models.some((candidate) => candidate.model === selectedModel)) {
      const savedThread = loadThreadConfiguration(selectedThreadIdRef.current, storage);
      const selectedThreadModel = models.find((candidate) => candidate.model === savedThread?.model) ?? model;
      setSelectedModel(selectedThreadModel.model);
      setEffort(resolveReasoningEffort(savedThread?.effort, selectedThreadModel, nextDefaultEffort));
      setFastMode(Boolean(savedThread?.fastMode));
      setPermissionMode(PERMISSION_OPTIONS.some((option) => option.value === savedThread?.permissionMode) ? savedThread.permissionMode : defaultPermissionMode);
    }
  }, [defaultEffort, defaultModel, defaultPermissionMode, defaultsHydrated, models, savePersistentDefaults, selectedModel, storage]);

  useEffect(() => {
    if (!models.length || !defaultModel || !defaultEffort || draftMode) return;
    const savedThread = loadThreadConfiguration(selectedThreadId, storage);
    const model = models.find((candidate) => candidate.model === savedThread?.model)
      ?? models.find((candidate) => candidate.model === defaultModel)
      ?? models[0];
    setSelectedModel(model.model);
    setEffort(resolveReasoningEffort(savedThread?.effort, model, defaultEffort));
    setFastMode(Boolean(savedThread?.fastMode));
    setPermissionMode(PERMISSION_OPTIONS.some((option) => option.value === savedThread?.permissionMode)
      ? savedThread.permissionMode
      : defaultPermissionMode);
  }, [defaultEffort, defaultModel, defaultPermissionMode, draftMode, models, selectedThreadId, storage]);

  useEffect(() => {
    if (!selectedProjectId) return undefined;
    const lastUsedAt = new Date().toISOString();
    const visibleProjectLimit = preferencesRef.current.showThirdProjectRow ? 9 : 6;
    setProjectActivity((current) => ({
      ...current,
      [selectedProjectId]: {
        ...(current[selectedProjectId] ?? { runningThreadIds: [] }),
        unseenThreadIds: []
      }
    }));
    setProjects((current) => activateProject(current, selectedProjectId, { lastUsedAt }, visibleProjectLimit));
    if (!api?.projects?.touch) return undefined;
    let cancelled = false;
    api.projects.touch({ projectId: selectedProjectId }).then((project) => {
      if (!cancelled && project) {
        setProjects((current) => activateProject(current, selectedProjectId, project, visibleProjectLimit));
      }
    }).catch(() => {
      // Project selection must stay responsive if persisting recency fails.
    });
    return () => { cancelled = true; };
  }, [api, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) return;
    setExecutionTarget((current) => current.hostId === "local" ? { ...current, projectId: selectedProjectId } : current);
  }, [selectedProjectId]);

  useEffect(() => {
    const targetStillExists = executionTarget.hostId === "local"
      ? Boolean(connect?.local)
      : Boolean(connect?.instances.some((instance) => instance.id === executionTarget.hostId));
    if (targetStillExists) return;
    const fallbackHostId = connect?.active ?? "local";
    setExecutionTarget({ hostId: fallbackHostId, projectId: fallbackHostId === "local" ? selectedProjectId : null });
    setExecutionTargetConfig(null);
  }, [connect?.active, connect?.instances, connect?.local, executionTarget.hostId, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setThreads([]);
      focusThreadIdRef.current = null;
      setFocusThreadId(null);
      setBoardTasks([]);
      setBoardPhases([]);
      setProactiveSuggestions([]);
      selectedThreadIdRef.current = null;
      setSelectedThreadId(null);
      setThread(null);
      setReview({ projectId: null, repository: null, files: [], fileDiffs: {} });
      return;
    }
    storage.setItem("pixice.activeProjectId", selectedProjectId);
    window.dispatchEvent(new CustomEvent("pixice:active-project-changed", { detail: selectedProjectId }));
    loadThreads(selectedProjectId);
    loadReview(selectedProjectId);
    loadBoard(selectedProjectId);
    loadProjectTools(selectedProjectId);
  }, [selectedProjectId, loadBoard, loadProjectTools, loadReview, loadThreads, runtime.connected, storage]);

  useEffect(() => {
    if (surfaceMode !== "focus" || !selectedProjectId || !api?.focus?.ensure) {
      focusEnsureRequestRef.current += 1;
      setFocusLoading(false);
      return;
    }
    void loadFocusSession(selectedProjectId);
  }, [api, loadFocusSession, selectedProjectId, serviceRevision, surfaceMode]);

  useEffect(() => {
    setSelectedProjectToolId(null);
  }, [selectedProjectId]);

  useEffect(() => {
    setPlan([]);
    if (!selectedProjectId || !selectedThreadId) {
      threadLoadRequestRef.current += 1;
      proactivityLoadRequestRef.current += 1;
      setThread(null);
      setProactiveSuggestions([]);
      setLoading((state) => ({ ...state, thread: false }));
      return;
    }
    if (optimisticThreadsRef.current.has(selectedThreadId)) {
      optimisticThreadsRef.current.delete(selectedThreadId);
      threadLoadRequestRef.current += 1;
      setLoading((state) => ({ ...state, thread: false }));
      setProactiveSuggestions([]);
      void loadProactivity(selectedProjectId, selectedThreadId);
      return;
    }
    loadThread(selectedProjectId, selectedThreadId);
    loadProactivity(selectedProjectId, selectedThreadId);
  }, [selectedProjectId, selectedThreadId, loadProactivity, loadThread]);

  useEffect(() => {
    if (!api || !selectedProjectId || !selectedThreadId || !activeTurn) return undefined;
    let cancelled = false;
    let timer;
    const scheduleForActivity = () => {
      const quietFor = Date.now() - lastRuntimeActivityAtRef.current;
      timer = window.setTimeout(refresh, Math.max(1_000, RUNTIME_RECOVERY_SILENCE_MS - quietFor));
    };
    const refresh = async () => {
      if (Date.now() - lastRuntimeActivityAtRef.current < RUNTIME_RECOVERY_SILENCE_MS) {
        scheduleForActivity();
        return;
      }
      try {
        await refreshThread(selectedProjectId, selectedThreadId);
      } catch {
        // Live notifications remain the primary path; polling is only a quiet fallback.
      }
      if (!cancelled) timer = window.setTimeout(refresh, RUNTIME_RECOVERY_SILENCE_MS);
    };
    scheduleForActivity();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, selectedProjectId, selectedThreadId, activeTurn?.id, refreshThread]);

  useEffect(() => {
    if (!api || !selectedProjectId || !selectedThreadId || activeView !== "task") return undefined;
    let cancelled = false;
    let timer;
    const refresh = async () => {
      await loadAgents(selectedProjectId, selectedThreadId);
      if (!cancelled) timer = window.setTimeout(refresh, 3000);
    };
    refresh();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, activeView, loadAgents, selectedProjectId, selectedThreadId]);

  useEffect(() => {
    if (activeView === "settings") loadExtensions();
    if (activeView === "settings" && settingsPage === "providers") loadProviders();
    if (activeView === "settings" && settingsPage === "capabilities") {
      loadGitStatus();
      loadGitHubStatus();
    }
    if (activeView === "settings" && settingsPage === "usage") loadUsage(usageRangeDays);
    if (activeView === "settings" && settingsPage === "usage") loadUsageLimits();
    if (activeView === "tools" && selectedProjectId) loadProjectTools(selectedProjectId);
  }, [activeView, loadExtensions, loadGitHubStatus, loadGitStatus, loadProjectTools, loadProviders, loadReview, loadUsage, loadUsageLimits, selectedProjectId, settingsPage, usageRangeDays, usageRefreshKey, usageLimitsRefreshKey, serviceRevision]);

  const refreshEventInstrumentSources = useCallback((capabilities, eventProjectId) => {
    if (!api?.instruments || !selectedProjectId || !previewApiWorkspaceId || eventProjectId && eventProjectId !== selectedProjectId) return;
    const requested = new Set(capabilities);
    const refreshes = previewInstrumentTabs.flatMap((instrument) => Object.entries(instrument.document.sources ?? {})
      .filter(([, source]) => source.refresh === "event" && requested.has(source.capability))
      .map(([source]) => ({ instrumentId: instrument.id, source })));
    if (!refreshes.length) return;
    void (async () => {
      for (const refresh of refreshes) {
        try {
          const instrument = await api.instruments.refresh({ projectId: selectedProjectId, threadId: previewApiWorkspaceId, ...refresh });
          setPreviewInstrumentTabs((current) => current.map((candidate) => candidate.id === instrument.id ? { ...instrument, launchValues: candidate.launchValues } : candidate));
        } catch {
          // The Instrument keeps its last good snapshot and exposes the source error.
        }
      }
    })();
  }, [api, previewApiWorkspaceId, previewInstrumentTabs, selectedProjectId, setPreviewInstrumentTabs]);

  useEffect(() => {
    if (!api) return;
    return api.events.subscribe((event) => {
      if (event.type === "FocusPolicyUpdated") {
        const projectId = event.payload?.projectId;
        const coordinatorModel = event.payload?.policy?.coordinatorModel;
        if (projectId !== selectedProjectIdRef.current || surfaceModeRef.current !== "focus" || !coordinatorModel) return;
        const model = models.find((candidate) => candidate.id === coordinatorModel || candidate.model === coordinatorModel);
        const focusThreadId = focusThreadIdRef.current;
        if (!model || !focusThreadId) return;
        const nextEffort = resolveReasoningEffort(effort, model, defaultEffort);
        setSelectedModel(model.model);
        setEffort(nextEffort);
        saveThreadConfiguration(focusThreadId, {
          model: model.model,
          effort: nextEffort,
          fastMode,
          permissionMode: "full-access"
        }, storage);
        return;
      }
      if (event.type === "ApplicationResync" || event.type === "ServiceReset") {
        setServiceRevision((value) => value + 1);
        const projectId = selectedProjectIdRef.current;
        const threadId = selectedThreadIdRef.current;
        if (projectId) {
          void loadThreads(projectId);
          void loadBoard(projectId);
          void loadReview(projectId);
          if (threadId) { void refreshThread(projectId, threadId); void loadAgents(projectId, threadId); }
          void loadProactivity(projectId, threadId);
        }
        return;
      }
      if (event.type === "RuntimeStatus") {
        setRuntime(event.payload);
        if (event.payload?.providers) {
          setProviders((current) => current.map((provider) => {
            const status = event.payload.providers[provider.id];
            if (!status) return provider;
            const connected = status.state === "ready"
              ? true
              : ["error", "stopped", "unavailable"].includes(status.state)
                ? false
                : provider.connected;
            return { ...provider, connected, status };
          }));
        }
        if (event.payload.connected) {
          loadModels().catch(() => null);
          if (selectedProjectId) {
            loadThreads(selectedProjectId);
            if (selectedThreadIdRef.current) refreshThread(selectedProjectId, selectedThreadIdRef.current);
          }
        }
        return;
      }
      if (event.type === "RuntimeError") {
        setError(event.payload.message);
        return;
      }
      if (event.type === "ProviderLifecycleState") {
        const providerId = event.payload?.provider ?? event.payload?.id;
        if (!providerId) return;
        const providerUpdate = event.payload?.updateState;
        if (providerUpdate?.state === "succeeded") {
          const providerLabel = event.payload?.runtimeLabel || event.payload?.label || providerId;
          publishOperation({
            id: `provider-update:${providerId}`,
            kind: "update",
            tone: "success",
            status: "Provider updated",
            title: providerLabel,
            label: `${providerLabel} updated`,
            detail: providerUpdate.message,
            progress: 100,
            autoDismiss: 4500
          });
        }
        setProviders((current) => {
          const lifecycle = { ...event.payload, id: providerId };
          const existing = current.find((provider) => provider.id === providerId);
          if (!existing) return [...current, lifecycle];
          return current.map((provider) => provider.id === providerId ? { ...provider, ...lifecycle } : provider);
        });
        return;
      }
      if (event.type === "TranscriptionModelProgress") {
        publishOperation(transcriptionDownloadOperation(event.payload, api));
        return;
      }
      if (event.type === "PreviewWorkspacePresentRequested") {
        const workspaceId = event.payload?.workspaceId ?? event.payload?.threadId;
        const sourceWorkspaceId = event.payload?.sourceWorkspaceId ?? event.payload?.sourceThreadId;
        if (!workspaceId || !sourceWorkspaceId || event.payload?.projectId !== selectedProjectIdRef.current) return;
        setPreviewWorkspaces((current) => {
          const source = current[sourceWorkspaceId] ?? EMPTY_PREVIEW_WORKSPACE;
          previewWorkspaceSequenceRef.current += 1;
          return {
            ...current,
            [workspaceId]: {
              ...source,
              open: true,
              presentedFromWorkspaceId: sourceWorkspaceId,
              presentationTitle: event.payload?.title ?? null,
              lastUsed: previewWorkspaceSequenceRef.current
            }
          };
        });
        if (workspaceId === selectedThreadIdRef.current) {
          setInspectorOpen(false);
          setActiveView("task");
        }
        return;
      }
      if (event.type === "GitHubAuthProgress") {
        setGithubProgress(event.payload);
        if (event.payload.state === "complete") loadGitHubStatus();
        return;
      }
      if (event.type === "AttentionRequired") {
        attentionRevisionRef.current += 1;
        setAttention((current) => mergeAttentionRequests(current, [event.payload]));
        const questionForCurrentThread = isQuestionRequest(event.payload) && event.payload.params?.threadId === selectedThreadIdRef.current;
        const attentionForCurrentThread = event.payload.params?.threadId === selectedThreadIdRef.current;
        const focusOpen = surfaceModeRef.current === "focus";
        if (!focusOpen && attentionForCurrentThread && !questionForCurrentThread) setInspectorOpen(true);
        if (!focusOpen && preferencesRef.current.bringApprovalsForward && isApprovalRequest(event.payload) && !questionForCurrentThread) setActiveView("attention");
        return;
      }
      if (event.type === "AttentionResolved") {
        attentionRevisionRef.current += 1;
        setAttention((current) => current.filter((request) => !attentionResolvedRequest(request, event.payload)));
        return;
      }
      if (event.type === "AttentionReset") {
        attentionRevisionRef.current += 1;
        setAttention([]);
        return;
      }
      if (event.type === "BrowserState") {
        const workspaceId = event.payload.workspaceId;
        updatePreviewWorkspace(workspaceId, (workspace) => {
          const fileTabs = workspace.fileTabs ?? [];
          const instrumentTabs = workspace.instrumentTabs ?? [];
          const customTabs = workspace.customTabs ?? [];
          const browserTabs = event.payload.tabs ?? [];
          const availableIds = new Set([
            ...browserTabs.map((tab) => tab.id),
            ...fileTabs.map((tab) => tab.id),
            ...instrumentTabs.map((tab) => `instrument:${tab.id}`),
            ...customTabs.map((tab) => tab.id)
          ]);
          const wasBrowserActive = (workspace.browserState?.tabs ?? []).some((tab) => tab.id === workspace.activeTabId);
          const activeTabId = wasBrowserActive && event.payload.activeTabId
            ? event.payload.activeTabId
            : availableIds.has(workspace.activeTabId) ? workspace.activeTabId
            : event.payload.activeTabId ?? customTabs.at(-1)?.id ?? fileTabs.at(-1)?.id ?? (instrumentTabs[0] ? `instrument:${instrumentTabs[0].id}` : null) ?? null;
          return {
            ...workspace,
            browserState: event.payload,
            activeTabId,
            open: availableIds.size ? workspace.open : false,
            presentedFromWorkspaceId: null,
            presentationTitle: null
          };
        });
        mirrorPreviewPresentations(workspaceId);
        return;
      }
      if (event.type === "BrowserOpenRequested") {
        const workspaceId = event.payload.workspaceId ?? event.payload.threadId;
        updatePreviewWorkspace(workspaceId, (workspace) => ({
          ...workspace,
          open: true,
          activeTabId: null,
          presentedFromWorkspaceId: null,
          presentationTitle: null
        }));
        mirrorPreviewPresentations(workspaceId);
        if (workspaceId === selectedThreadIdRef.current && document.querySelector(".pixice-app.view-task")) {
          setInspectorOpen(false);
        }
        return;
      }
      if (event.type === "FilePreviewOpenRequested") {
        const workspaceId = event.payload.workspaceId ?? event.payload.threadId;
        const file = event.payload.file;
        if (!workspaceId || !file) return;
        const tab = fileTabFromPayload(file);
        updatePreviewWorkspace(workspaceId, (workspace) => ({
          ...workspace,
          open: true,
          activeTabId: tab.id,
          presentedFromWorkspaceId: null,
          presentationTitle: null,
          fileTabs: (workspace.fileTabs ?? []).some((candidate) => candidate.id === tab.id)
            ? (workspace.fileTabs ?? []).map((candidate) => candidate.id === tab.id ? tab : candidate)
            : [...(workspace.fileTabs ?? []), tab]
        }));
        mirrorPreviewPresentations(workspaceId);
        if (workspaceId === selectedThreadIdRef.current && document.querySelector(".pixice-app.view-task")) setInspectorOpen(false);
        return;
      }
      if (event.type === "InstrumentUpdated") {
        const workspaceId = event.payload.workspaceId ?? event.payload.threadId;
        const instrument = event.payload.instrument;
        if (instrument?.projectId === selectedProjectIdRef.current) {
          setProjectTools((current) => {
            const without = current.filter((candidate) => candidate.id !== instrument.id);
            return instrument.lifecycle === "pinned" && event.payload.action !== "deleted" ? [instrument, ...without] : without;
          });
        }
        if (!workspaceId || !instrument) return;
        updatePreviewWorkspace(workspaceId, (workspace) => {
          const current = workspace.instrumentTabs ?? [];
          if (event.payload.action === "deleted") {
            const instrumentTabId = `instrument:${instrument.id}`;
            const nextTabs = current.filter((candidate) => candidate.id !== instrument.id);
            return {
              ...workspace,
              instrumentTabs: nextTabs,
              activeTabId: workspace.activeTabId === instrumentTabId
                ? nextTabs.length ? `instrument:${nextTabs[0].id}` : workspace.customTabs?.at(-1)?.id ?? workspace.browserState?.activeTabId ?? workspace.fileTabs?.at(-1)?.id ?? null
                : workspace.activeTabId
            };
          }
          const exists = current.some((candidate) => candidate.id === instrument.id);
          return {
            ...workspace,
            instrumentTabs: exists
              ? current.map((candidate) => candidate.id === instrument.id ? { ...instrument, launchValues: candidate.launchValues } : candidate)
              : [...current, instrument]
          };
        });
        mirrorPreviewPresentations(workspaceId);
        return;
      }
      if (event.type === "InstrumentOpenRequested") {
        const workspaceId = event.payload.workspaceId ?? event.payload.threadId;
        const instrument = event.payload.instrument;
        if (!workspaceId || !instrument) return;
        updatePreviewWorkspace(workspaceId, (workspace) => {
          const current = workspace.instrumentTabs ?? [];
          const exists = current.some((candidate) => candidate.id === instrument.id);
          return {
            ...workspace,
            open: true,
            activeTabId: `instrument:${instrument.id}`,
            instrumentTabs: exists
              ? current.map((candidate) => candidate.id === instrument.id ? { ...instrument, launchValues: instrument.launchValues ?? candidate.launchValues } : candidate)
              : [...current, instrument]
          };
        });
        mirrorPreviewPresentations(workspaceId);
        if (workspaceId === selectedThreadIdRef.current && document.querySelector(".pixice-app.view-task")) setInspectorOpen(false);
        return;
      }
      if (event.type === "IosPreviewOpenRequested") {
        const workspaceId = event.payload.workspaceId ?? event.payload.threadId;
        if (!workspaceId) return;
        const tabId = `simulator:${workspaceId}`;
        updatePreviewWorkspace(workspaceId, (workspace) => {
          const current = workspace.customTabs ?? [];
          const tab = {
            id: tabId,
            kind: "simulator",
            title: event.payload.session?.deviceName || "iOS Simulator",
            payload: { projectId: event.payload.projectId, session: event.payload.session ?? null }
          };
          return {
            ...workspace,
            open: true,
            activeTabId: tabId,
            customTabs: current.some((candidate) => candidate.id === tabId)
              ? current.map((candidate) => candidate.id === tabId ? { ...candidate, ...tab } : candidate)
              : [...current, tab]
          };
        });
        mirrorPreviewPresentations(workspaceId);
        if (workspaceId === selectedThreadIdRef.current && document.querySelector(".pixice-app.view-task")) setInspectorOpen(false);
        return;
      }
      if (event.type === "IosSessionUpdated") {
        const workspaceId = event.payload.workspaceId;
        const session = event.payload.session;
        if (!workspaceId || !session) return;
        const tabId = `simulator:${workspaceId}`;
        updatePreviewWorkspace(workspaceId, (workspace) => ({
          ...workspace,
          customTabs: (workspace.customTabs ?? []).map((candidate) => candidate.id === tabId
            ? {
              ...candidate,
              title: `${session.deviceName || "iOS Simulator"} · ${session.status}`,
              payload: { ...candidate.payload, projectId: session.projectId ?? candidate.payload?.projectId, session }
            }
            : candidate)
        }));
        mirrorPreviewPresentations(workspaceId);
        return;
      }
      if (event.type === "BoardUpdated") {
        if (!event.payload?.projectId || event.payload.projectId === selectedProjectId) loadBoard(selectedProjectId);
        refreshEventInstrumentSources(["board.list"], event.payload?.projectId);
        return;
      }
      if (event.type === "ProactivityUpdated") {
        const projectId = event.payload?.projectId;
        if (!projectId || projectId === selectedProjectIdRef.current) {
          loadProactivity(selectedProjectIdRef.current, selectedThreadIdRef.current);
        }
        return;
      }
      if (event.type === "WorkflowRunUpdated" || event.type === "WorkflowUpdated") {
        refreshEventInstrumentSources(["workflows.list", "workflow.output"], event.payload?.projectId);
        const workflow = event.payload?.workflow;
        if (event.type === "WorkflowUpdated" && event.payload?.action === "created" && workflow?.createdByThreadId) {
          publishOperation({
            id: `workflow-created:${workflow.id}`,
            kind: "workflow",
            tone: "success",
            status: "Workflow created",
            title: workflow.name || "Untitled workflow",
            label: `${workflow.name || "Workflow"} created`,
            detail: "A thread added a new Workflow to this project.",
            progress: 100,
            actionLabel: "Open",
            autoDismiss: 8000,
            onAction: () => window.dispatchEvent(new CustomEvent("pixice:open-workflow-workspace", {
              detail: { workflowId: workflow.id, projectId: workflow.projectId, hostId: api?.remote?.hostId ?? "local" }
            }))
          });
        }
      }
      if (event.type === "UpdateState") {
        setUpdateStatus(event.payload);
        return;
      }
      if (event.type === "TrayNavigate") {
        surfaceModeRef.current = "workspace";
        setSurfaceMode("workspace");
        focusEnsureRequestRef.current += 1;
        setFocusLoading(false);
        if (event.payload?.settingsPage) setSettingsPage(event.payload.settingsPage);
        if (event.payload?.projectId) {
          storage.setItem("pixice.activeProjectId", event.payload.projectId);
          selectedProjectIdRef.current = event.payload.projectId;
          setSelectedProjectId(event.payload.projectId);
        }
        if (event.payload?.threadId) {
          selectedThreadIdRef.current = event.payload.threadId;
          setSelectedThreadId(event.payload.threadId);
          setDraftMode(false);
        }
        setActiveView(event.payload?.view ?? "task");
        return;
      }
      if (event.type === "TraySettingsUpdated") {
        if (typeof event.payload?.keepSystemAwake === "boolean") setKeepSystemAwake(event.payload.keepSystemAwake);
        return;
      }
      if (event.type === "TaskReceiptUpdated") {
        setReceiptRefreshKey((value) => value + 1);
        return;
      }
      if (event.type === "UsageUpdated") {
        setUsageRefreshKey((value) => value + 1);
        return;
      }
      if (event.type === "CodexLimitsUpdated") {
        setUsageLimitsRefreshKey((value) => value + 1);
        return;
      }

      const payload = event.payload ?? {};
      const activityProjectId = payload.projectId;
      const activityThreadId = payload.threadId ?? payload.thread?.id;
      if (isBridgeThread(payload.thread)) bridgeThreadIdsRef.current.add(payload.thread.id);
      if (payload.item?.bridge) {
        [...(payload.item.receiverThreadIds ?? []), ...Object.keys(payload.item.agentsStates ?? {})]
          .forEach((threadId) => bridgeThreadIdsRef.current.add(threadId));
      }
      if (activityThreadId && activityThreadId === selectedThreadIdRef.current) lastRuntimeActivityAtRef.current = Date.now();
      if (activityProjectId && activityThreadId && ["thread/started", "thread/status/changed", "turn/started", "turn/completed"].includes(payload.method)) {
        setProjectActivity((current) => {
          const existing = current[activityProjectId] ?? { runningThreadIds: [], unseenThreadIds: [] };
          const runningThreadIds = new Set(existing.runningThreadIds ?? []);
          const unseenThreadIds = new Set(existing.unseenThreadIds ?? []);
          const wasRunning = runningThreadIds.has(activityThreadId);
          const nowRunning = payload.method === "turn/started"
            || (payload.method === "thread/started" && threadIsRunning(payload.thread))
            || (payload.method === "thread/status/changed" && threadIsRunning({ status: payload.status }));

          if (nowRunning) {
            runningThreadIds.add(activityThreadId);
            unseenThreadIds.delete(activityThreadId);
          } else if (payload.method === "turn/completed" || payload.method === "thread/status/changed") {
            runningThreadIds.delete(activityThreadId);
            const bridgeCompletionPending = bridgeThreadIdsRef.current.has(activityThreadId) && payload.method !== "turn/completed";
            if (!bridgeCompletionPending && activityProjectId !== selectedProjectId && (payload.method === "turn/completed" || wasRunning)) {
              unseenThreadIds.add(activityThreadId);
            }
          }

          return {
            ...current,
            [activityProjectId]: {
              runningThreadIds: [...runningThreadIds],
              unseenThreadIds: [...unseenThreadIds]
            }
          };
        });
      }
      if (payload.projectId && payload.projectId !== selectedProjectId) return;
      if (payload.method === "turn/started" && payload.threadId) {
        setThreads((current) => current.map((candidate) => candidate.id === payload.threadId
          ? { ...candidate, status: { type: "active", activeFlags: [] }, planProgress: null }
          : candidate));
        setPreviewWorkspaces((current) => updateThreadPreviewTabs(current, payload.threadId, { payload: { status: "running" } }));
      }
      if (payload.method === "turn/completed" && payload.threadId) {
        setThreads((current) => current.map((candidate) => candidate.id === payload.threadId
          ? {
              ...candidate,
              status: "completed",
              completionRevision: payload.turn?.id || payload.turnId
                ? `turn:${payload.turn?.id ?? payload.turnId}`
                : candidate.completionRevision ?? `completed:${Date.now()}`,
              updatedAt: Date.now()
            }
          : candidate));
        setPreviewWorkspaces((current) => updateThreadPreviewTabs(current, payload.threadId, { payload: { status: "completed" } }));
      }
      if (payload.method === "thread/status/changed") {
        setThreads((current) => current.map((candidate) => candidate.id === payload.threadId ? { ...candidate, status: payload.status } : candidate));
        setPreviewWorkspaces((current) => updateThreadPreviewTabs(current, payload.threadId, { payload: { status: threadStatus({ status: payload.status }) } }));
      }
      if (payload.method === "thread/name/updated") {
        setThreads((current) => current.map((candidate) => candidate.id === payload.threadId ? { ...candidate, name: payload.name } : candidate));
        setPreviewWorkspaces((current) => updateThreadPreviewTabs(current, payload.threadId, { title: payload.name }));
        if (payload.threadId === selectedThreadIdRef.current) {
          setThread((current) => current?.id === payload.threadId ? { ...current, name: payload.name } : current);
        }
      }
      if (payload.method === "thread/slash-commands/updated") {
        setThreads((current) => current.map((candidate) => candidate.id === payload.threadId ? { ...candidate, slashCommands: payload.slashCommands } : candidate));
        if (payload.threadId === selectedThreadIdRef.current) {
          setThread((current) => current?.id === payload.threadId ? { ...current, slashCommands: payload.slashCommands } : current);
        }
      }
      if (payload.method === "turn/plan/updated") {
        refreshEventInstrumentSources(["tasks.plan"], payload.projectId);
        setThreads((current) => current.map((candidate) => candidate.id === payload.threadId
          ? { ...candidate, planProgress: summarizePlanProgress(payload.plan) }
          : candidate));
      }
      if (payload.method === "thread/started" && payload.thread && (!payload.projectId || payload.projectId === selectedProjectId)) {
        setThreads((current) => {
          const existing = current.find((candidate) => candidate.id === payload.thread.id);
          return existing
            ? current.map((candidate) => candidate.id === payload.thread.id ? { ...candidate, ...payload.thread } : candidate)
            : [payload.thread, ...current];
        });
      }
      if (payload.item?.type === "collabAgentToolCall" || payload.item?.type === "collabToolCall") {
        setThreads((current) => projectCollabAgents(current, payload.item));
        if (preferencesRef.current.autoOpenTaskMap) setInspectorOpen(true);
        if (selectedProjectId && selectedThreadIdRef.current) {
          window.setTimeout(() => loadAgents(selectedProjectId, selectedThreadIdRef.current), 80);
        }
      }
      if (payload.threadId === selectedThreadIdRef.current) {
        commitRuntimePayload(payload, optimisticThreadsRef.current.get(payload.threadId));
        if (payload.method === "turn/started") setPlan([]);
        if (payload.method === "turn/plan/updated") setPlan(normalizePlan(payload.plan));
        if (payload.method === "turn/completed" && selectedProjectId) {
          loadReview(selectedProjectId);
          window.setTimeout(() => refreshThread(selectedProjectId, payload.threadId), 100);
          window.setTimeout(() => refreshThread(selectedProjectId, payload.threadId), 600);
        }
      }
    });
  }, [api, commitRuntimePayload, defaultEffort, effort, fastMode, loadAgents, loadBoard, loadGitHubStatus, loadModels, loadProactivity, loadReview, loadThreads, mirrorPreviewPresentations, models, normalizePlan, refreshEventInstrumentSources, refreshThread, selectedProjectId, storage, updatePreviewWorkspace]);

  const openProject = () => {
    if (!api?.projects) return;
    setProjectDialogOpen(true);
  };

  const pickProjectFolders = async () => {
    if (!api?.projects?.pickFolders) return [];
    try {
      return await api.projects.pickFolders();
    } catch (cause) {
      setError(cause.message);
      return [];
    }
  };

  const createProject = async (draft) => {
    if (!api?.projects?.create || projectCreateBusy) return;
    setProjectCreateBusy(true);
    try {
      const project = await api.projects.create(draft);
      if (!project) return;
      const visibleProjectLimit = preferencesRef.current.showThirdProjectRow ? 9 : 6;
      setProjects((current) => {
        const withoutProject = current.filter((candidate) => candidate.id !== project.id);
        return activateProject([...withoutProject, project], project.id, project, visibleProjectLimit);
      });
      setDraftMode(false);
      selectedProjectIdRef.current = project.id;
      setSelectedProjectId(project.id);
      setActiveView("task");
      setProjectDialogOpen(false);
    } catch (cause) {
      setError(cause.message);
      throw cause;
    } finally {
      setProjectCreateBusy(false);
    }
  };

  const selectProject = (projectId) => {
    connect?.closeExecution?.();
    setSelectedLinkedThread(null);
    setExecutionTarget({ hostId: connect?.active ?? "local", projectId });
    setExecutionTargetConfig(null);
    surfaceModeRef.current = "workspace";
    setSurfaceMode("workspace");
    setDraftMode(false);
    selectedProjectIdRef.current = projectId;
    selectedThreadIdRef.current = null;
    setSelectedThreadId(null);
    setSelectedProjectId(projectId);
    setActiveView("task");
  };

  const enterFocus = () => {
    if (!api?.focus?.ensure || !selectedProjectId) return;
    connect?.closeExecution?.();
    setSelectedLinkedThread(null);
    setExecutionTarget({ hostId: connect?.active ?? "local", projectId: selectedProjectId });
    setExecutionTargetConfig(null);
    if (selectedThreadIdRef.current && selectedThreadIdRef.current !== focusThreadIdRef.current) {
      workspaceThreadByProjectRef.current.set(selectedProjectId, selectedThreadIdRef.current);
    }
    surfaceModeRef.current = "focus";
    setSurfaceMode("focus");
    focusThreadIdRef.current = null;
    setFocusThreadId(null);
    setFocusLoading(true);
    setFocusConnectionError(null);
    setFocusMemory(null);
    selectedThreadIdRef.current = null;
    setSelectedThreadId(null);
    setThread(null);
    setPlan([]);
    setInspectorOpen(false);
    setPreviewOpen(false);
    setActiveView("task");
  };

  const exitFocus = () => {
    focusEnsureRequestRef.current += 1;
    surfaceModeRef.current = "workspace";
    setSurfaceMode("workspace");
    setFocusLoading(false);
    setFocusConnectionError(null);
    const preferredId = workspaceThreadByProjectRef.current.get(selectedProjectId);
    const candidates = threads.filter((candidate) => candidate.id !== focusThreadIdRef.current && isSidebarThread(candidate));
    const nextId = candidates.some((candidate) => candidate.id === preferredId) ? preferredId : candidates[0]?.id ?? null;
    selectedThreadIdRef.current = nextId;
    setSelectedThreadId(nextId);
    setThread(null);
    setPlan([]);
    setDraftMode(!nextId);
    setActiveView("task");
  };

  const selectFocusProject = (projectId) => {
    if (!projectId || projectId === selectedProjectIdRef.current) return;
    focusEnsureRequestRef.current += 1;
    focusThreadIdRef.current = null;
    setFocusThreadId(null);
    setFocusLoading(true);
    setFocusConnectionError(null);
    setFocusMemory(null);
    selectedProjectIdRef.current = projectId;
    selectedThreadIdRef.current = null;
    setSelectedProjectId(projectId);
    setSelectedThreadId(null);
    setThread(null);
    setPlan([]);
    setDraftMode(false);
    setActiveView("task");
  };

  const deleteProject = async (projectId) => {
    if (!api?.projects?.delete) return false;
    const target = projects.find((candidate) => candidate.id === projectId);
    if (!target) return false;
    if (preferences.confirmBeforeDelete && !window.confirm(`Delete “${target.displayName}”?\n\nThis removes the project and its Pixice data. Your folders and files stay on disk.`)) return false;
    try {
      await api.projects.delete({ projectId });
      const remaining = projects.filter((candidate) => candidate.id !== projectId);
      setProjects((current) => current.filter((candidate) => candidate.id !== projectId));
      if (selectedProjectIdRef.current === projectId) {
        const removedIndex = projects.findIndex((candidate) => candidate.id === projectId);
        const nextProject = remaining[Math.min(Math.max(removedIndex, 0), remaining.length - 1)] ?? null;
        setDraftMode(false);
        selectedProjectIdRef.current = nextProject?.id ?? null;
        selectedThreadIdRef.current = null;
        setSelectedProjectId(nextProject?.id ?? null);
        setSelectedThreadId(null);
        setThread(null);
        setPlan([]);
        setActiveView("task");
      }
      return true;
    } catch (cause) {
      setError(cause.message);
      return false;
    }
  };

  const selectThread = (threadId) => {
    connect?.closeExecution?.();
    setSelectedLinkedThread(null);
    setDraftMode(false);
    setExecutionTarget({ hostId: connect?.active ?? "local", projectId: selectedProjectIdRef.current ?? selectedProjectId });
    setExecutionTargetConfig(null);
    selectedThreadIdRef.current = threadId;
    setSelectedThreadId(threadId);
    setActiveView("task");
  };

  const changeExecutionTarget = async (next) => {
    const requestId = ++executionTargetRequestRef.current;
    if (next.hostId !== executionTarget.hostId) setExecutionTargetConfig(null);
    setExecutionTarget(next);
    if (!connect) return;
    const currentHostId = connect.active ?? "local";
    if (next.hostId === currentHostId) {
      if (requestId === executionTargetRequestRef.current) setExecutionTargetConfig(null);
      return;
    }
    try {
      const catalog = await connect.loadHostCatalog(next.hostId);
      if (!catalog || requestId !== executionTargetRequestRef.current) return;
      const targetStorage = createWorkspaceStorage(next.hostId);
      const configKey = `pixice.executionConfiguration.${next.projectId || "new"}`;
      let saved = null;
      try { saved = JSON.parse(targetStorage.getItem(configKey) || "null"); } catch { /* A damaged target draft must not block choosing a host. */ }
      const model = catalog.models?.find((candidate) => candidate.model === saved?.model)
        ?? catalog.models?.find((candidate) => candidate.model === selectedModel)
        ?? catalog.models?.find((candidate) => candidate.isDefault)
        ?? catalog.models?.[0];
      if (model) {
        const nextConfig = {
          model: model.model,
          effort: resolveReasoningEffort(saved?.effort, model, effort),
          fastMode: Boolean(saved?.fastMode ?? fastMode) && Boolean(fastServiceTier(model)),
          permissionMode: PERMISSION_OPTIONS.some((option) => option.value === saved?.permissionMode)
            ? saved.permissionMode
            : permissionMode
        };
        if (requestId !== executionTargetRequestRef.current) return;
        setExecutionTargetConfig(nextConfig);
        targetStorage.setItem(configKey, JSON.stringify(nextConfig));
      }
    } catch (cause) {
      setError(`Could not read ${next.hostId}: ${cause.message}`);
    }
  };

  const newTask = () => {
    if (!selectedProjectId) return;
    connect?.closeExecution?.();
    setSelectedLinkedThread(null);
    surfaceModeRef.current = "workspace";
    setSurfaceMode("workspace");
    const model = models.find((candidate) => candidate.model === defaultModel);
    setDraftMode(true);
    setSelectedModel(defaultModel);
    setEffort(defaultEffort);
    setFastMode(Boolean(defaultFastMode && fastServiceTier(model)));
    setPermissionMode(defaultPermissionMode);
    setExecutionTarget({ hostId: connect?.active ?? "local", projectId: selectedProjectId });
    setExecutionTargetConfig(null);
    selectedThreadIdRef.current = null;
    setSelectedThreadId(null);
    setThread(null);
    setPlan([]);
    setActiveView("task");
  };

  const deleteThread = async (threadId, { skipConfirm = false } = {}) => {
    if (!api || !selectedProjectId) return;
    const projectId = selectedProjectId;
    const target = threads.find((candidate) => candidate.id === threadId);
    const title = threadTitle(target);
    const owningPreview = previewWorkspaces[threadId];
    const dirtyFileCount = (owningPreview?.fileTabs ?? []).filter((file) => file.dirty).length;
    if (skipConfirm && dirtyFileCount) return false;
    const previewHasContent = Boolean(
      owningPreview
      && ((owningPreview.browserState?.tabs ?? []).length
        || (owningPreview.fileTabs ?? []).length
        || (owningPreview.instrumentTabs ?? []).length
        || (owningPreview.customTabs ?? []).length)
    );
    if (!skipConfirm && (preferences.confirmBeforeDelete || dirtyFileCount)) {
      const previewWarning = previewHasContent ? " It also closes this chat's Preview workspace." : "";
      const dirtyWarning = dirtyFileCount
        ? `\n\n${dirtyFileCount === 1 ? "One file has" : `${dirtyFileCount} files have`} unsaved edits.`
        : "";
      if (!window.confirm(`Delete "${title}"?\n\nThis removes the conversation from Pixice's task list.${previewWarning}${dirtyWarning}`)) return false;
    }
    try {
      await api.threads.archive({ projectId, threadId });
      if (owningPreview) {
        try {
          await api.browser?.destroy?.({ workspaceId: threadId });
        } catch {
          // The conversation is already archived, so Preview teardown remains best effort.
        }
      }
      storage.removeItem(threadConfigurationKey(threadId));
      setSeenThreadCompletions((current) => {
        if (!(threadId in current)) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      setPreviewWorkspaces((current) => removeThreadPreviewTabs(current, threadId));
      if (selectedProjectIdRef.current !== projectId) return;
      const remaining = threads.filter((candidate) => candidate.id !== threadId);
      setThreads((current) => current.filter((candidate) => candidate.id !== threadId));
      setBoardTasks((current) => current.map((task) => task.threadId === threadId ? { ...task, threadId: null } : task));
      if (selectedThreadIdRef.current === threadId) {
        const next = remaining.find((candidate) => !candidate.parentThreadId) ?? null;
        selectedThreadIdRef.current = next?.id ?? null;
        setSelectedThreadId(next?.id ?? null);
        setThread(null);
        setPlan([]);
        setDraftMode(!next);
      }
      setError(null);
      return true;
    } catch (cause) {
      if (selectedProjectIdRef.current === projectId) setError(cause.message);
      return false;
    }
  };

  const cleanupThreads = async (threadIds) => {
    const removable = [...new Set(threadIds)].filter((threadId) => (
      threads.some((candidate) => candidate.id === threadId)
      && !(previewWorkspaces[threadId]?.fileTabs ?? []).some((file) => file.dirty)
    ));
    if (!removable.length) return 0;
    const label = removable.length === 1 ? "this old chat" : `these ${removable.length} old chats`;
    if (!window.confirm(`Clean up ${label}?\n\nThis removes the conversations from Pixice’s task list.`)) return 0;
    const results = await Promise.all(removable.map((threadId) => deleteThread(threadId, { skipConfirm: true })));
    return results.filter(Boolean).length;
  };

  const createBoardTask = async ({ title, description, column, ...details }) => {
    if (!api?.board || !selectedProjectId) return;
    const projectId = selectedProjectId;
    try {
      const task = await api.board.create({ projectId, title, description, column, ...details });
      if (selectedProjectIdRef.current !== projectId) return;
      setBoardTasks((current) => current.some((candidate) => candidate.id === task.id) ? current : [...current, task]);
      setError(null);
      return task;
    } catch (cause) {
      setError(cause.message);
      throw cause;
    }
  };

  const createBoardPhase = async ({ title, taskIds }) => {
    if (!api?.board?.createPhase || !selectedProjectId) return;
    const projectId = selectedProjectId;
    try {
      const phase = await api.board.createPhase({ projectId, title, taskIds });
      if (selectedProjectIdRef.current === projectId) await loadBoard(projectId);
      setError(null);
      return phase;
    } catch (cause) {
      setError(cause.message);
      throw cause;
    }
  };

  const openBoardTaskPreview = useCallback((task) => {
    if (!task || !selectedProjectId || !previewWorkspaceId) return;
    window.dispatchEvent(new CustomEvent("pixice:task-preview-requested", {
      detail: {
        hostId: api?.remote?.hostId ?? "local",
        projectId: selectedProjectId,
        taskId: task.id,
        threadId: selectedThreadId,
        workspaceId: previewWorkspaceId,
        reason: "edit",
        actorKind: "user"
      }
    }));
  }, [previewWorkspaceId, selectedProjectId, selectedThreadId]);

  const rescheduleBoardTask = useCallback(async (task, schedule) => {
    if (!api?.board || !selectedProjectId || !previewWorkspaceId) return;
    const downstreamIds = new Set();
    const queue = [...(task.dependents ?? [])];
    while (queue.length) {
      const candidateId = queue.shift();
      if (!candidateId || downstreamIds.has(candidateId)) continue;
      downstreamIds.add(candidateId);
      const candidate = boardTasks.find((entry) => entry.id === candidateId);
      queue.push(...(candidate?.dependents ?? []));
    }
    window.dispatchEvent(new CustomEvent("pixice:task-preview-requested", {
      detail: {
        hostId: api?.remote?.hostId ?? "local",
        projectId: selectedProjectId,
        taskId: task.id,
        threadId: selectedThreadId,
        workspaceId: previewWorkspaceId,
        reason: "reschedule",
        actorKind: "user",
        scheduleProposal: schedule,
        scheduleImpact: {
          dependents: boardTasks.filter((candidate) => downstreamIds.has(candidate.id)).map((candidate) => ({ id: candidate.id, title: candidate.title })),
          enabledBindings: task.workflowBindings?.filter((binding) => binding.enabled).length ?? 0,
          lockedFields: task.schedule?.lockedFields ?? []
        }
      }
    }));
  }, [api, boardTasks, previewWorkspaceId, selectedProjectId, selectedThreadId]);

  const moveBoardTask = async (taskId, column, beforeTaskId) => {
    if (!api?.board || !selectedProjectId) return;
    const projectId = selectedProjectId;
    try {
      await api.board.move({ projectId, taskId, column, ...(beforeTaskId ? { beforeTaskId } : {}) });
      if (selectedProjectIdRef.current === projectId) await loadBoard(projectId);
      setError(null);
    } catch (cause) {
      setError(cause.message);
      throw cause;
    }
  };

  const resolveProactiveSuggestion = async (suggestion, decision) => {
    if (!api?.proactivity || !selectedProjectId) return;
    const projectId = selectedProjectId;
    try {
      await api.proactivity.resolve({ projectId, suggestionId: suggestion.id, decision });
      if (selectedProjectIdRef.current !== projectId) return;
      setProactiveSuggestions((current) => current.filter((candidate) => candidate.id !== suggestion.id));
      if (suggestion.type === "task-status" && decision === "accept") await loadBoard(projectId);
      setError(null);
    } catch (cause) {
      setError(cause.message);
      throw cause;
    }
  };

  const startBoardTask = async (task) => {
    if (!api?.board || !api?.threads || !selectedProjectId || !runtime.connected) return;
    const projectId = selectedProjectId;
    try {
      const created = await api.threads.create({
        projectId,
        model: defaultModel || undefined,
        permissionMode: defaultPermissionMode
      });
      const threadId = created.thread.id;
      const model = models.find((candidate) => candidate.model === defaultModel);
      const defaultFastTier = defaultFastMode ? fastServiceTier(model) : null;
      saveThreadConfiguration(threadId, { model: defaultModel, effort: defaultEffort, fastMode: Boolean(defaultFastTier), permissionMode: defaultPermissionMode }, storage);
      await api.board.attach({ projectId, taskId: task.id, threadId });
      await api.board.move({ projectId, taskId: task.id, column: "active" });
      const prompt = task.description ? `${task.title}\n\n${task.description}` : task.title;
      const response = await api.turns.start({
        projectId,
        threadId,
        text: prompt,
        images: [],
        model: defaultModel || undefined,
        effort: defaultEffort,
        ...(defaultFastTier ? { serviceTier: defaultFastTier } : {}),
        permissionMode: defaultPermissionMode
      });
      markThreadMessaged(threadId);
      if (selectedProjectIdRef.current !== projectId) return;
      optimisticThreadsRef.current.set(threadId, created.thread);
      setThreads((current) => current.some((candidate) => candidate.id === threadId) ? current : [created.thread, ...current]);
      setBoardTasks((current) => current.map((candidate) => candidate.id === task.id ? { ...candidate, column: "active", threadId } : candidate));
      selectedThreadIdRef.current = threadId;
      setSelectedThreadId(threadId);
      setDraftMode(false);
      setThread(applyRuntimePayload(created.thread, { method: "turn/started", threadId, turn: response.turn }));
      setActiveView("task");
      setError(null);
    } catch (cause) {
      setError(cause.message);
      throw cause;
    }
  };

  const changeDefaultModel = (modelName) => {
    setDefaultModel(modelName);
    const model = models.find((candidate) => candidate.model === modelName);
    const nextEffort = resolveReasoningEffort(defaultEffort, model, model?.defaultReasoningEffort);
    setDefaultEffort(nextEffort);
    savePersistentDefaults({ defaultModel: modelName, defaultEffort: nextEffort });
  };

  const changeThreadModel = (modelName) => {
    setSelectedModel(modelName);
    const model = models.find((candidate) => candidate.model === modelName);
    const nextEffort = resolveReasoningEffort(effort, model, defaultEffort);
    setEffort(nextEffort);
    saveThreadConfiguration(selectedThreadId, { model: modelName, effort: nextEffort, fastMode, permissionMode }, storage);
    const currentProvider = models.find((candidate) => candidate.model === selectedModel)?.provider;
    if (focusActive && models.find((candidate) => candidate.model === modelName)?.provider !== currentProvider) {
      void loadFocusSession(selectedProjectId, { modelOverride: modelName, replaceEmpty: true });
    }
  };

  const changeDefaultEffort = (nextEffort) => {
    setDefaultEffort(nextEffort);
    savePersistentDefaults({ defaultEffort: nextEffort });
  };

  const changeDefaultFastMode = (enabled) => {
    setDefaultFastMode(enabled);
    savePersistentDefaults({ defaultFastMode: enabled });
  };

  const changeThreadNamingModel = (modelName) => {
    setThreadNamingModel(modelName);
    savePersistentDefaults({ threadNamingModel: modelName });
  };

  const changeWorkflowGenerationModel = (modelName) => {
    setWorkflowGenerationModel(modelName);
    savePersistentDefaults({ workflowGenerationModel: modelName });
  };

  const changeThreadEffort = (nextEffort) => {
    setEffort(nextEffort);
    saveThreadConfiguration(selectedThreadId, { model: selectedModel, effort: nextEffort, fastMode, permissionMode }, storage);
  };

  const changeThreadFastMode = (enabled) => {
    setFastMode(enabled);
    saveThreadConfiguration(selectedThreadId, { model: selectedModel, effort, fastMode: enabled, permissionMode }, storage);
  };

  const changeDefaultPermissionMode = (mode) => {
    setDefaultPermissionMode(mode);
    savePersistentDefaults({ defaultPermissionMode: mode });
  };

  const changeThreadPermissionMode = (mode) => {
    setPermissionMode(mode);
    saveThreadConfiguration(selectedThreadId, { model: selectedModel, effort, fastMode, permissionMode: mode }, storage);
  };

  const changeAttentionNotifications = (enabled) => {
    setAttentionNotifications(enabled);
    savePersistentDefaults({ attentionNotifications: enabled });
  };

  const changeCompletionNotifications = (enabled) => {
    setCompletionNotifications(enabled);
    savePersistentDefaults({ completionNotifications: enabled });
  };

  const changeNotificationSound = (enabled) => {
    setNotificationSound(enabled);
    savePersistentDefaults({ notificationSound: enabled });
  };

  const changeKeepSystemAwake = (enabled) => {
    setKeepSystemAwake(enabled);
    savePersistentDefaults({ keepSystemAwake: enabled });
  };

  const changeProviderUpdateChecksEnabled = (enabled) => {
    setProviderUpdateChecksEnabled(enabled);
    savePersistentDefaults({ checkProviderUpdates: enabled });
  };

  const togglePreview = useCallback(async () => {
    if (!previewWorkspaceId) return;
    if (previewOpen) {
      setPreviewOpen(false);
      return;
    }
    setInspectorOpen(false);
    setPreviewOpen(true);
    if (previewActiveTabId) return;
    if (previewCustomTabs.length) {
      setPreviewActiveTabId(previewCustomTabs.at(-1).id);
      return;
    }
    if (previewInstrumentTabs.length) {
      setPreviewActiveTabId(`instrument:${previewInstrumentTabs[0].id}`);
      return;
    }
    if (browserState.tabs?.length) {
      setPreviewActiveTabId(browserState.activeTabId ?? browserState.tabs[0].id);
      return;
    }
    const chooser = newPreviewChooserTab();
    setPreviewCustomTabs([chooser]);
    setPreviewActiveTabId(chooser.id);
  }, [browserState, previewActiveTabId, previewCustomTabs, previewInstrumentTabs, previewOpen, previewWorkspaceId, setPreviewActiveTabId, setPreviewCustomTabs, setPreviewOpen]);

  const openPreviewCustomTabInWorkspace = useCallback((workspaceId, tab) => {
    if (!workspaceId || !tab?.id) return;
    updatePreviewWorkspace(workspaceId, (workspace) => {
      const customTabs = workspace.customTabs ?? [];
      return {
        ...workspace,
        open: true,
        activeTabId: tab.id,
        customTabs: customTabs.some((candidate) => candidate.id === tab.id)
          ? customTabs.map((candidate) => candidate.id === tab.id ? { ...candidate, ...tab } : candidate)
          : [...customTabs, tab]
      };
    });
  }, [updatePreviewWorkspace]);

  const openPreviewCustomTab = useCallback((tab) => {
    openPreviewCustomTabInWorkspace(previewWorkspaceId, tab);
  }, [openPreviewCustomTabInWorkspace, previewWorkspaceId]);

  const updatePreviewCustomTab = useCallback((tabId, patch) => {
    setPreviewCustomTabs((current) => current.map((tab) => tab.id === tabId ? { ...tab, ...patch } : tab));
  }, [setPreviewCustomTabs]);

  const registerSideThread = useCallback((tabId, createdThread, payload) => {
    const workspaceId = payload?.hostThreadId ?? (payload?.projectId ? `draft:${payload.projectId}` : null);
    markThreadMessaged(createdThread.id);
    openPreviewCustomTabInWorkspace(workspaceId, {
      id: tabId,
      kind: "thread",
      title: threadTitle(createdThread),
      payload: {
        ...payload,
        threadId: createdThread.id,
        forkedFromId: createdThread.forkedFromId ?? payload?.forkedFromId ?? null,
        status: threadStatus(createdThread)
      }
    });
    if (selectedProjectIdRef.current !== payload?.projectId) return;
    setThreads((current) => current.some((candidate) => candidate.id === createdThread.id)
      ? current.map((candidate) => candidate.id === createdThread.id ? { ...candidate, ...createdThread } : candidate)
      : [createdThread, ...current]);
  }, [markThreadMessaged, openPreviewCustomTabInWorkspace]);

  const forkConversation = useCallback(async ({ threadId, turnId, itemId, configuration }) => {
    const projectId = selectedProjectIdRef.current;
    if (!api?.threads?.fork || !projectId || !threadId || !turnId || !itemId) return false;
    const selectedThreadAtStart = selectedThreadIdRef.current;
    const sourceConfiguration = loadThreadConfiguration(threadId, storage)
      ?? configuration
      ?? (threadId === selectedThreadAtStart
        ? { model: selectedModel, effort, fastMode, permissionMode }
        : null);
    try {
      const response = await api.threads.fork({
        projectId,
        threadId,
        lastTurnId: turnId,
        lastItemId: itemId
      });
      const forkedThread = response.thread;
      if (sourceConfiguration) saveThreadConfiguration(forkedThread.id, sourceConfiguration, storage);
      if (selectedProjectIdRef.current !== projectId) return true;
      setThreads((current) => current.some((candidate) => candidate.id === forkedThread.id)
        ? current.map((candidate) => candidate.id === forkedThread.id ? { ...candidate, ...forkedThread } : candidate)
        : [forkedThread, ...current]);
      if (selectedThreadIdRef.current === selectedThreadAtStart) {
        markResponsesSeen(forkedThread, seenResponseIdsRef.current);
        optimisticThreadsRef.current.set(forkedThread.id, forkedThread);
        selectedThreadIdRef.current = forkedThread.id;
        setSelectedThreadId(forkedThread.id);
        setThread(forkedThread);
        setPlan([]);
        setProactiveSuggestions([]);
        setDraftMode(false);
        setActiveView("task");
      }
      setError(null);
      return true;
    } catch (cause) {
      if (selectedProjectIdRef.current === projectId) setError(cause.message);
      return false;
    }
  }, [api, effort, fastMode, permissionMode, selectedModel]);

  const openNewPreviewTab = useCallback(() => {
    openPreviewCustomTab(newPreviewChooserTab());
  }, [openPreviewCustomTab]);

  const replacePreviewChooserWithBrowser = useCallback((chooserId, nextBrowserState) => {
    updatePreviewWorkspace(previewWorkspaceId, (workspace) => {
      const customTabs = (workspace.customTabs ?? []).filter((tab) => tab.id !== chooserId);
      return {
        ...workspace,
        browserState: nextBrowserState,
        customTabs,
        activeTabId: nextBrowserState.activeTabId
          ?? customTabs.at(-1)?.id
          ?? workspace.fileTabs?.at(-1)?.id
          ?? (workspace.instrumentTabs?.[0] ? `instrument:${workspace.instrumentTabs[0].id}` : null)
          ?? null,
        open: true
      };
    });
  }, [previewWorkspaceId, updatePreviewWorkspace]);

  const updatePreviewFile = useCallback((tabId, patch) => {
    setPreviewFileTabs((current) => current.map((tab) => tab.id === tabId ? { ...tab, ...patch } : tab));
  }, [setPreviewFileTabs]);

  const closePreviewBrowser = useCallback(async (tabId) => {
    if (!api?.browser || !previewWorkspaceId || !previewApiWorkspaceId) return;
    try {
      const nextBrowserState = await api.browser.close({ workspaceId: previewApiWorkspaceId, tabId });
      updatePreviewWorkspace(previewWorkspaceId, (workspace) => {
        const fileTabs = workspace.fileTabs ?? [];
        const instrumentTabs = workspace.instrumentTabs ?? [];
        const customTabs = workspace.customTabs ?? [];
        const browserTabs = nextBrowserState.tabs ?? [];
        const availableIds = new Set([
          ...browserTabs.map((tab) => tab.id),
          ...fileTabs.map((tab) => tab.id),
          ...instrumentTabs.map((tab) => `instrument:${tab.id}`),
          ...customTabs.map((tab) => tab.id)
        ]);
        const activeTabId = availableIds.has(workspace.activeTabId)
          ? workspace.activeTabId
          : nextBrowserState.activeTabId ?? customTabs.at(-1)?.id ?? fileTabs.at(-1)?.id ?? (instrumentTabs[0] ? `instrument:${instrumentTabs[0].id}` : null) ?? null;
        if (!availableIds.size) {
          const chooser = newPreviewChooserTab();
          return { ...workspace, browserState: nextBrowserState, customTabs: [chooser], activeTabId: chooser.id };
        }
        return {
          ...workspace,
          browserState: nextBrowserState,
          activeTabId,
          open: workspace.open
        };
      });
    } catch (cause) {
      setError(cause.message);
    }
  }, [api, previewApiWorkspaceId, previewWorkspaceId, updatePreviewWorkspace]);

  const closePreviewFile = useCallback((tabId) => {
    const target = previewFileTabs.find((tab) => tab.id === tabId);
    if (target?.dirty && !window.confirm(`Close “${target.name}” without saving your changes?`)) return;
    updatePreviewWorkspace(previewWorkspaceId, (workspace) => {
      const fileTabs = (workspace.fileTabs ?? []).filter((tab) => tab.id !== tabId);
      const instrumentTabs = workspace.instrumentTabs ?? [];
      const customTabs = workspace.customTabs ?? [];
      const browserTabs = workspace.browserState?.tabs ?? [];
      const availableIds = new Set([
        ...browserTabs.map((tab) => tab.id),
        ...fileTabs.map((tab) => tab.id),
        ...instrumentTabs.map((tab) => `instrument:${tab.id}`),
        ...customTabs.map((tab) => tab.id)
      ]);
      const activeTabId = workspace.activeTabId === tabId
        ? fileTabs.at(-1)?.id ?? customTabs.at(-1)?.id ?? (instrumentTabs[0] ? `instrument:${instrumentTabs[0].id}` : null) ?? workspace.browserState?.activeTabId ?? browserTabs[0]?.id ?? null
        : workspace.activeTabId;
      if (!availableIds.size) {
        const chooser = newPreviewChooserTab();
        return { ...workspace, fileTabs, customTabs: [chooser], activeTabId: chooser.id };
      }
      return { ...workspace, fileTabs, activeTabId, open: workspace.open };
    });
  }, [previewFileTabs, previewWorkspaceId, updatePreviewWorkspace]);

  const closePreviewInstrument = useCallback((instrumentId) => {
    const tabId = `instrument:${instrumentId}`;
    updatePreviewWorkspace(previewWorkspaceId, (workspace) => {
      const instrumentTabs = (workspace.instrumentTabs ?? []).filter((instrument) => instrument.id !== instrumentId);
      const fileTabs = workspace.fileTabs ?? [];
      const customTabs = workspace.customTabs ?? [];
      const browserTabs = workspace.browserState?.tabs ?? [];
      const availableIds = new Set([
        ...browserTabs.map((tab) => tab.id),
        ...fileTabs.map((tab) => tab.id),
        ...instrumentTabs.map((tab) => `instrument:${tab.id}`),
        ...customTabs.map((tab) => tab.id)
      ]);
      const activeTabId = workspace.activeTabId === tabId
        ? (instrumentTabs[0] ? `instrument:${instrumentTabs[0].id}` : null) ?? customTabs.at(-1)?.id ?? fileTabs.at(-1)?.id ?? workspace.browserState?.activeTabId ?? browserTabs[0]?.id ?? null
        : workspace.activeTabId;
      if (!availableIds.size) {
        const chooser = newPreviewChooserTab();
        return { ...workspace, instrumentTabs, customTabs: [chooser], activeTabId: chooser.id };
      }
      return { ...workspace, instrumentTabs, activeTabId, open: workspace.open };
    });
  }, [previewWorkspaceId, updatePreviewWorkspace]);

  const closePreviewCustomTab = useCallback((tabId, { ensureTab = true } = {}) => {
    const target = previewCustomTabs.find((tab) => tab.id === tabId);
    const draftAttachmentCount = Number(target?.payload?.draftAttachmentCount ?? 0);
    const unrecoverableText = Boolean(target?.payload?.draftHasText)
      && (!preferences.preserveDrafts || !target?.payload?.threadId);
    if (target?.kind === "thread" && (draftAttachmentCount > 0 || unrecoverableText)) {
      const description = draftAttachmentCount > 0 && unrecoverableText
        ? "The unsent message and attachments will be discarded."
        : draftAttachmentCount > 0
          ? "Unsent attachments will be discarded."
          : "The unsent message will be discarded.";
      if (!window.confirm(`Close "${target.title || "side thread"}"?\n\n${description}`)) return;
    }
    if (target?.kind === "thread" && !target.payload?.threadId) {
      const draftKey = `${target.payload?.projectId}:side:${target.payload?.draftId ?? target.id}`;
      storage.removeItem(`pixice.draft.${draftKey}`);
    }
    if (target?.kind === "simulator") {
      void api?.ios?.stop?.({ workspaceId: previewApiWorkspaceId }).catch(() => {});
    }
    updatePreviewWorkspace(previewWorkspaceId, (workspace) => {
      let customTabs = (workspace.customTabs ?? []).filter((tab) => tab.id !== tabId);
      const browserTabs = workspace.browserState?.tabs ?? [];
      const fileTabs = workspace.fileTabs ?? [];
      const instrumentTabs = workspace.instrumentTabs ?? [];
      let fallback = customTabs.at(-1)?.id
        ?? fileTabs.at(-1)?.id
        ?? (instrumentTabs[0] ? `instrument:${instrumentTabs[0].id}` : null)
        ?? workspace.browserState?.activeTabId
        ?? browserTabs[0]?.id
        ?? null;
      if (!fallback && ensureTab) {
        const chooser = newPreviewChooserTab();
        customTabs = [chooser];
        fallback = chooser.id;
      }
      return {
        ...workspace,
        customTabs,
        activeTabId: workspace.activeTabId === tabId ? fallback : workspace.activeTabId,
        open: workspace.open
      };
    });
  }, [api, preferences.preserveDrafts, previewApiWorkspaceId, previewCustomTabs, previewWorkspaceId, updatePreviewWorkspace]);

  const refreshPreviewInstrument = useCallback(async (instrumentId, source) => {
    if (!api?.instruments || !selectedProjectId || !previewApiWorkspaceId) throw new Error("Instrument data refresh is unavailable");
    const instrument = await api.instruments.refresh({ projectId: selectedProjectId, threadId: previewApiWorkspaceId, instrumentId, source });
    setPreviewInstrumentTabs((current) => current.map((candidate) => candidate.id === instrument.id ? { ...instrument, launchValues: candidate.launchValues } : candidate));
    return instrument;
  }, [api, previewApiWorkspaceId, selectedProjectId, setPreviewInstrumentTabs]);

  const sendPreviewInstrumentEvent = useCallback(async (instrumentId, actionId, payload) => {
    if (!api?.instruments || !selectedProjectId || !previewApiWorkspaceId) throw new Error("Instrument agent events are unavailable");
    const model = models.find((candidate) => candidate.model === selectedModel);
    return api.instruments.event({
      projectId: selectedProjectId,
      threadId: previewApiWorkspaceId,
      instrumentId,
      actionId,
      payload,
      model: selectedModel || undefined,
      serviceTier: fastMode ? fastServiceTier(model) : null,
      effort: effort || undefined,
      permissionMode
    });
  }, [api, effort, fastMode, models, permissionMode, previewApiWorkspaceId, selectedModel, selectedProjectId]);

  const invokePreviewInstrumentCapability = useCallback(async (instrumentId, actionId, argumentsValue) => {
    if (!api?.instruments || !selectedProjectId || !previewApiWorkspaceId) throw new Error("Trusted Instrument actions are unavailable");
    return api.instruments.invoke({ projectId: selectedProjectId, threadId: previewApiWorkspaceId, instrumentId, actionId, arguments: argumentsValue, requestId: window.crypto.randomUUID() });
  }, [api, previewApiWorkspaceId, selectedProjectId]);

  const pinPreviewInstrument = useCallback(async (instrumentId, pinned) => {
    if (!api?.instruments || !selectedProjectId || !previewApiWorkspaceId) throw new Error("Instrument pinning is unavailable");
    const instrument = await api.instruments.pin({ projectId: selectedProjectId, threadId: previewApiWorkspaceId, instrumentId, pinned });
    setPreviewInstrumentTabs((current) => current.map((candidate) => candidate.id === instrument.id ? { ...instrument, launchValues: candidate.launchValues } : candidate));
    return instrument;
  }, [api, previewApiWorkspaceId, selectedProjectId, setPreviewInstrumentTabs]);

  const launchProjectTool = useCallback(async (instrumentId, values) => {
    if (!api?.instruments || !selectedProjectId || !selectedThreadId) throw new Error("Select or create a task before launching a project tool");
    const instrument = await api.instruments.launch({ projectId: selectedProjectId, threadId: selectedThreadId, instrumentId, values });
    updatePreviewWorkspace(selectedThreadId, (workspace) => {
      const current = workspace.instrumentTabs ?? [];
      return {
        ...workspace,
        open: true,
        activeTabId: `instrument:${instrument.id}`,
        instrumentTabs: current.some((candidate) => candidate.id === instrument.id)
          ? current.map((candidate) => candidate.id === instrument.id ? instrument : candidate)
          : [...current, instrument]
      };
    });
    await changeView("task");
    setInspectorOpen(false);
    await loadProjectTools(selectedProjectId);
    return instrument;
  }, [api, changeView, loadProjectTools, selectedProjectId, selectedThreadId, updatePreviewWorkspace]);

  const renameProjectTool = useCallback(async (instrumentId, name) => {
    if (!api?.instruments || !selectedProjectId || !selectedThreadId) throw new Error("Select a task before editing a project tool");
    const instrument = await api.instruments.rename({ projectId: selectedProjectId, threadId: selectedThreadId, instrumentId, name });
    await loadProjectTools(selectedProjectId);
    return instrument;
  }, [api, loadProjectTools, selectedProjectId, selectedThreadId]);

  const changeProjectToolGrants = useCallback(async (instrumentId, grants) => {
    if (!api?.instruments || !selectedProjectId || !selectedThreadId) throw new Error("Select a task before editing tool capabilities");
    const instrument = await api.instruments.grants({ projectId: selectedProjectId, threadId: selectedThreadId, instrumentId, grants });
    await loadProjectTools(selectedProjectId);
    return instrument;
  }, [api, loadProjectTools, selectedProjectId, selectedThreadId]);

  const duplicateProjectTool = useCallback(async (instrumentId) => {
    if (!api?.instruments || !selectedProjectId || !selectedThreadId) throw new Error("Select a task before duplicating a project tool");
    const instrument = await api.instruments.duplicate({ projectId: selectedProjectId, threadId: selectedThreadId, instrumentId });
    await loadProjectTools(selectedProjectId);
    return instrument;
  }, [api, loadProjectTools, selectedProjectId, selectedThreadId]);

  const deleteProjectTool = useCallback(async (instrumentId) => {
    if (!api?.instruments || !selectedProjectId || !selectedThreadId) throw new Error("Select a task before deleting a project tool");
    const instrument = await api.instruments.deleteTool({ projectId: selectedProjectId, threadId: selectedThreadId, instrumentId });
    await loadProjectTools(selectedProjectId);
    return instrument;
  }, [api, loadProjectTools, selectedProjectId, selectedThreadId]);

  const loadProjectToolRevisions = useCallback(async (instrumentId) => {
    if (!api?.instruments || !selectedProjectId) return [];
    const result = await api.instruments.revisions({ projectId: selectedProjectId, instrumentId });
    return result.data ?? [];
  }, [api, selectedProjectId]);

  const loadProjectToolReceipts = useCallback(async (instrumentId) => {
    if (!api?.instruments || !selectedProjectId) return [];
    const result = await api.instruments.receipts({ projectId: selectedProjectId, instrumentId });
    return result.data ?? [];
  }, [api, selectedProjectId]);

  const restoreProjectTool = useCallback(async (instrumentId, version) => {
    if (!api?.instruments || !selectedProjectId || !selectedThreadId) throw new Error("Select a task before restoring a project tool");
    const instrument = await api.instruments.restore({ projectId: selectedProjectId, threadId: selectedThreadId, instrumentId, version });
    await loadProjectTools(selectedProjectId);
    return instrument;
  }, [api, loadProjectTools, selectedProjectId, selectedThreadId]);

  const openWorkspaceReference = useCallback(async (target) => {
    if (!api || !selectedProjectId || !previewWorkspaceId) return;
    setInspectorOpen(false);
    setActiveView("task");
    setPreviewOpen(true);
    updatePreviewWorkspace(previewWorkspaceId, (workspace) => ({
      ...workspace,
      presentedFromWorkspaceId: null,
      presentationTitle: null
    }));
    try {
      if (/^https?:\/\//i.test(target)) {
        const next = await api.browser.create({ workspaceId: previewWorkspaceId, url: target });
        setBrowserState(next);
        setPreviewActiveTabId(next.activeTabId ?? null);
        return;
      }
      const file = await (api.files.preview ?? api.files.read)({ projectId: selectedProjectId, path: target });
      const tab = fileTabFromPayload(file);
      setPreviewFileTabs((current) => current.some((candidate) => candidate.id === tab.id) ? current : [...current, tab]);
      setPreviewActiveTabId(tab.id);
    } catch (cause) {
      setError(cause.message);
    }
  }, [api, previewWorkspaceId, selectedProjectId, setBrowserState, setPreviewActiveTabId, setPreviewFileTabs, setPreviewOpen, updatePreviewWorkspace]);

  const runUpdateAction = useCallback(async (action) => {
    if (!api?.updates) return;
    try {
      const status = await api.updates[action]();
      if (status?.state) setUpdateStatus(status);
    } catch (cause) {
      setUpdateStatus((current) => ({ ...current, state: "error", message: cause.message }));
    }
  }, [api]);

  const submit = async (text, attachments = [], preparedAttachments = null, sourceAttachments = attachments, signal = null, draftLifecycle = null) => {
    if (!api || !selectedProjectId || submittingRef.current) return false;
    assertSubmissionActive(signal);
    const currentHostId = connect?.active ?? "local";
    const targetIsOrigin = executionTarget.hostId === currentHostId;
    const targetProjectId = targetIsOrigin ? selectedProjectId : executionTarget.projectId;
    const targetApi = targetIsOrigin
      ? api
      : connect?.getApi?.(executionTarget.hostId) ?? connect?.ensureClient?.(executionTarget.hostId)?.api;
    if (!targetIsOrigin && !targetProjectId) {
      setError("Choose a project on the target environment before starting.");
      return false;
    }
    let prepared = preparedAttachments;
    try {
      prepared ??= await prepareSubmissionAttachments({ api: targetApi, projectId: targetProjectId, hostId: targetApi?.remote?.hostId ?? executionTarget.hostId, deviceId: targetApi?.remote?.deviceId, attachments, signal });
      assertSubmissionActive(signal);
    } catch (cause) {
      if (!signal?.aborted) setError(cause.message);
      return false;
    }
    if (connect && executionTarget.hostId !== currentHostId) {
      const initialPayload = requestPayloadWithAttachments({
        projectId: executionTarget.projectId,
        threadId: PROSPECTIVE_THREAD_ID,
        text,
        previewContext: currentPreviewContext,
        model: targetModelName || undefined,
        effort: targetEffort,
        permissionMode: targetPermissionMode
      }, prepared);
      assertSubmissionRequestBudget({ api: targetApi, operation: "turns.start", payload: initialPayload });
      submittingRef.current = true;
      setSubmitting(true);
      try {
        assertSubmissionActive(signal);
        const accepted = await connect.openExecution({
          hostId: executionTarget.hostId,
          projectId: executionTarget.projectId,
          originHostId: currentHostId,
          originHostLabel: currentHostId === "local" ? "This device" : connect.instances.find((instance) => instance.id === currentHostId)?.name ?? currentHostId,
          originProjectId: selectedProjectId,
          initialPrompt: text,
          initialAttachments: attachments,
          initialPreparedAttachments: { attachments: initialPayload.attachments, attachmentIds: initialPayload.attachmentIds ?? [] },
          initialModel: targetModelName,
          initialEffort: targetEffort,
          initialPermissionMode: targetPermissionMode,
          initialFastMode: targetFastMode,
          submissionSignal: signal,
          onThreadLinked: rememberLinkedThread
        });
        assertSubmissionActive(signal);
        return accepted !== false;
      } catch (cause) {
        if (!signal?.aborted) setError(cause.message);
        return false;
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
    if (!runtime.connected) return false;
    const projectId = selectedProjectId;
    const startingThreadId = selectedThreadId;
    submittingRef.current = true;
    setSubmitting(true);
    let optimisticThreadId = null;
    let optimisticTurnId = null;
    let optimisticMessageId = null;
    let removeOptimisticTurnOnFailure = false;
    const selectedModelInfo = targetModels.find((model) => model.model === targetModelName);
    const selectedFastTier = fastServiceTier(selectedModelInfo);
    const serviceTier = selectedFastTier ? (targetFastMode ? selectedFastTier : null) : undefined;
    try {
      let targetThreadId = startingThreadId;
      if (!targetThreadId) {
        const prospectivePayload = requestPayloadWithAttachments({
          projectId,
          threadId: PROSPECTIVE_THREAD_ID,
          text,
          previewContext: currentPreviewContext,
          model: targetModelName || undefined,
          ...(serviceTier !== undefined ? { serviceTier } : {}),
          effort: targetEffort,
          permissionMode: targetPermissionMode
        }, prepared);
        assertSubmissionRequestBudget({ api, operation: "turns.start", payload: prospectivePayload });
      }
      if (!targetThreadId) {
        const created = await api.threads.create({
          projectId,
          model: targetModelName || undefined,
          ...(serviceTier !== undefined ? { serviceTier } : {}),
          permissionMode: targetPermissionMode
        });
        assertSubmissionActive(signal);
        targetThreadId = created.thread.id;
        markThreadMessaged(targetThreadId);
        draftLifecycle?.adoptDraftKey(`${projectId}:${targetThreadId}`);
        const draftWorkspaceId = `draft:${projectId}`;
        await api.browser?.adopt({ fromWorkspaceId: draftWorkspaceId, toWorkspaceId: targetThreadId });
        assertSubmissionActive(signal);
        setPreviewWorkspaces((current) => {
          const draftWorkspace = current[draftWorkspaceId];
          if (!draftWorkspace) return current;
          const next = { ...current, [targetThreadId]: draftWorkspace };
          delete next[draftWorkspaceId];
          return next;
        });
        saveThreadConfiguration(targetThreadId, { model: targetModelName, effort: targetEffort, fastMode: targetFastMode, permissionMode: targetPermissionMode }, storage);
        optimisticThreadId = targetThreadId;
        if (selectedProjectIdRef.current === projectId) {
          optimisticThreadsRef.current.set(targetThreadId, created.thread);
          selectedThreadIdRef.current = targetThreadId;
          setDraftMode(false);
          setThreads((current) => current.some((candidate) => candidate.id === targetThreadId)
            ? current.map((candidate) => candidate.id === targetThreadId ? { ...candidate, ...created.thread } : candidate)
            : [created.thread, ...current]);
          setSelectedThreadId(targetThreadId);
          setThread(created.thread);
        }
      }
      if (activeTurn && targetThreadId === startingThreadId) {
        optimisticTurnId = activeTurn.id;
        optimisticMessageId = `local-user:${activeTurn.id}:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
        if (selectedProjectIdRef.current === projectId && selectedThreadIdRef.current === targetThreadId) {
          setThread((current) => appendLocalUserMessage(current, {
            turnId: activeTurn.id,
            text,
            attachments,
            messageId: optimisticMessageId
          }));
        }
        const steerPayload = requestPayloadWithAttachments({ projectId, threadId: targetThreadId, turnId: activeTurn.id, text, previewContext: currentPreviewContext }, prepared);
        assertSubmissionRequestBudget({ api, operation: "turns.steer", payload: steerPayload });
        await api.turns.steer(steerPayload);
        assertSubmissionActive(signal);
        if (selectedProjectIdRef.current === projectId && selectedThreadIdRef.current === targetThreadId) {
          window.setTimeout(() => refreshThread(projectId, targetThreadId), 250);
        }
        optimisticTurnId = null;
        optimisticMessageId = null;
      } else {
        optimisticTurnId = `local-turn:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
        optimisticMessageId = `local-user:${optimisticTurnId}`;
        removeOptimisticTurnOnFailure = true;
        if (selectedProjectIdRef.current === projectId && selectedThreadIdRef.current === targetThreadId) {
          setThread((current) => appendLocalUserMessage(current, {
            turnId: optimisticTurnId,
            text,
            attachments,
            messageId: optimisticMessageId
          }));
        }
        const startPayload = requestPayloadWithAttachments({
          projectId,
          threadId: targetThreadId,
          text,
          previewContext: currentPreviewContext,
          model: targetModelName || undefined,
          ...(serviceTier !== undefined ? { serviceTier } : {}),
          effort: targetEffort,
          permissionMode: targetPermissionMode
        }, prepared);
        assertSubmissionRequestBudget({ api, operation: "turns.start", payload: startPayload });
        const response = await api.turns.start(startPayload);
        assertSubmissionActive(signal);
        if (selectedProjectIdRef.current === projectId && selectedThreadIdRef.current === targetThreadId) {
          const temporaryTurnId = optimisticTurnId;
          const localMessageId = optimisticMessageId;
          setThread((current) => {
            if (!current) return current;
            const createdAt = response.turn.startedAt ?? response.turn.createdAt;
            const responseAlreadyArrived = (current.turns ?? []).some((turn) => turn.id === response.turn.id);
            if (!responseAlreadyArrived) {
              const withoutTemporaryTurn = removeLocalUserMessage(current, {
                turnId: temporaryTurnId,
                messageId: localMessageId,
                removeEmptyTurn: true
              });
              const incoming = appendLocalUserMessage({
                id: current.id,
                turns: [{ ...response.turn, renderId: temporaryTurnId }]
              }, {
                turnId: response.turn.id,
                text,
                attachments,
                createdAt,
                messageId: localMessageId,
                skipIfMatching: true
              });
              return mergeThreadSnapshot(withoutTemporaryTurn, incoming);
            }
            const withoutTemporaryTurn = removeLocalUserMessage(current, {
              turnId: temporaryTurnId,
              messageId: localMessageId,
              removeEmptyTurn: true
            });
            const keyedThread = {
              ...withoutTemporaryTurn,
              turns: (withoutTemporaryTurn.turns ?? []).map((turn) => turn.id === response.turn.id
                ? { ...turn, renderId: turn.renderId ?? temporaryTurnId }
                : turn)
            };
            const started = applyRuntimePayload(keyedThread, { method: "turn/started", threadId: targetThreadId, turn: response.turn });
            return appendLocalUserMessage(started, {
              turnId: response.turn.id,
              text,
              attachments,
              createdAt,
              messageId: localMessageId,
              skipIfMatching: true
            });
          });
          window.setTimeout(() => refreshThread(projectId, targetThreadId), 250);
          window.setTimeout(() => refreshThread(projectId, targetThreadId), 900);
        }
        optimisticTurnId = null;
        optimisticMessageId = null;
      }
      markThreadMessaged(targetThreadId);
      assertSubmissionActive(signal);
      if (surfaceModeRef.current === "focus") setFocusConnectionError(null);
      setError(null);
      return true;
    } catch (cause) {
      if (optimisticThreadId) optimisticThreadsRef.current.delete(optimisticThreadId);
      if (optimisticTurnId && optimisticMessageId) {
        setThread((current) => removeLocalUserMessage(current, {
          turnId: optimisticTurnId,
          messageId: optimisticMessageId,
          removeEmptyTurn: removeOptimisticTurnOnFailure
        }));
      }
      if (!signal?.aborted) {
        setError(cause.message);
        if (surfaceModeRef.current === "focus" && FOCUS_CONNECTION_ERROR.test(String(cause.message ?? ""))) {
          setFocusConnectionError(cause.message);
        }
      }
      return false;
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const interrupt = async () => {
    if (!api || !selectedProjectId || !selectedThreadId || !activeTurn) return;
    try {
      await api.turns.interrupt({ projectId: selectedProjectId, threadId: selectedThreadId, turnId: activeTurn.id });
    } catch (cause) {
      setError(cause.message);
    }
  };

  const resolveAttention = async (request, decision) => {
    try {
      const generation = requestGenerationPayload(request);
      if (request.method === "workflow/taskEvent/requestApproval") await api.workflows.resolveMissedTrigger({ projectId: request.projectId, requestId: request.id, ...generation, decision: decision === "accept" ? "accept" : "decline" });
      else if (request.method?.includes("requestUserInput")) await api.requests.respond({ requestId: request.id, ...generation, answers: decision });
      else if (request.method?.toLowerCase().includes("elicitation")) await api.elicitations.respond({ requestId: request.id, ...generation, ...decision });
      else await api.approvals.resolve({ requestId: request.id, ...generation, decision });
      attentionRevisionRef.current += 1;
      setAttention((current) => current.filter((candidate) => !sameAttentionRequest(candidate, request)));
    } catch (cause) {
      setError(cause.message);
    }
  };

  const resolveQuestion = async (request, response) => {
    try {
      await api.questions.respond({ requestId: request.id, ...response, ...requestGenerationPayload(request) });
      attentionRevisionRef.current += 1;
      setAttention((current) => current.filter((candidate) => !sameAttentionRequest(candidate, request)));
      return true;
    } catch (cause) {
      if (!request.focusCoordinatorQuestion) setError(cause.message);
      return false;
    }
  };

  const loginProvider = async (provider) => {
    if (!api?.providers) return false;
    try {
      const result = await api.providers.login({ provider });
      return result.opened;
    } catch (cause) {
      setError(cause.message);
      return false;
    }
  };

  const runProviderAction = async (provider, action) => {
    const operation = api?.providers?.[action];
    if (typeof operation !== "function") throw new Error(`${action.replace(/^./, (letter) => letter.toUpperCase())} is not available for this provider.`);
    const result = await operation({ provider });
    await refreshProviders();
    return result;
  };

  const operationItems = [];
  const updateVersion = updateStatus.availableVersion ? ` ${updateStatus.availableVersion}` : "";
  if (["checking", "downloading", "protecting-data", "available", "downloaded", "install-error", "error"].includes(updateStatus.state)) {
    const appUpdateOperation = {
      id: "pixice-update",
      kind: "update",
      title: updateStatus.state === "downloading" ? `Downloading Pixice${updateVersion}` : `Pixice${updateVersion}`,
      detail: updateStatus.message,
      dismissible: !["checking", "downloading", "protecting-data"].includes(updateStatus.state)
    };
    if (updateStatus.state === "checking") Object.assign(appUpdateOperation, { tone: "working", status: "Checking for updates", label: "Checking Pixice updates", indeterminate: true });
    if (updateStatus.state === "downloading") Object.assign(appUpdateOperation, { tone: "working", status: `${Math.round(updateStatus.percent)}% downloaded`, label: `Downloading Pixice · ${Math.round(updateStatus.percent)}%`, progress: updateStatus.percent });
    if (updateStatus.state === "protecting-data") Object.assign(appUpdateOperation, { tone: "working", status: "Protecting your data", label: "Preparing Pixice update", indeterminate: true });
    if (updateStatus.state === "available") Object.assign(appUpdateOperation, { tone: "working", status: "Update available", label: `Pixice${updateVersion} available`, actionLabel: "Download", onAction: () => runUpdateAction("download") });
    if (updateStatus.state === "downloaded") Object.assign(appUpdateOperation, { tone: "success", status: "Ready to install", label: `Pixice${updateVersion} downloaded`, progress: 100, actionLabel: "Restart", onAction: () => runUpdateAction("install") });
    if (updateStatus.state === "install-error") Object.assign(appUpdateOperation, { tone: "error", status: "Install failed", actionLabel: "Retry", onAction: () => runUpdateAction("install") });
    if (updateStatus.state === "error") Object.assign(appUpdateOperation, { tone: "error", status: "Update failed", actionLabel: "Try again", onAction: () => runUpdateAction("check") });
    operationItems.push(appUpdateOperation);
  }
  providers.forEach((provider) => {
    const state = provider.updateState?.state;
    if (!["checking", "updating", "available", "failed", "error"].includes(state)) return;
    const label = provider.runtimeLabel || provider.label || provider.id;
    const providerOperation = {
      id: `provider-update:${provider.id}`,
      kind: "update",
      title: label,
      detail: provider.updateState?.error || provider.updateState?.message,
      dismissible: !["checking", "updating"].includes(state)
    };
    if (state === "checking") Object.assign(providerOperation, { tone: "working", status: "Checking for updates", label: `Checking ${label} updates`, indeterminate: true });
    if (state === "updating") Object.assign(providerOperation, { tone: "working", status: "Updating provider", label: `Updating ${label}`, indeterminate: true });
    if (state === "available") Object.assign(providerOperation, { tone: "working", status: `Version ${provider.updateState.availableVersion} available`, label: `${label} update available`, actionLabel: "Update", onAction: () => runProviderAction(provider.id, "update") });
    if (state === "failed" || state === "error") Object.assign(providerOperation, { tone: "error", status: "Provider update failed", actionLabel: "Retry", onAction: () => runProviderAction(provider.id, "update") });
    operationItems.push(providerOperation);
  });
  if (error) {
    operationItems.push({
      id: "runtime-error",
      tone: "error",
      status: "Needs attention",
      title: "Pixice",
      detail: error,
      onDismiss: () => setError(null)
    });
  }

  const openExternal = async (kind, path) => {
    if (!api || !selectedProjectId) return;
    try {
      if (kind === "terminal") await api.external.openTerminal({ projectId: selectedProjectId });
      if (kind === "editor") await api.external.openEditor({ projectId: selectedProjectId, ...(path ? { path } : {}) });
      if (kind === "reveal") await api.external.reveal({ projectId: selectedProjectId });
    } catch (cause) {
      setError(cause.message);
    }
  };

  const loadReceiptEvidence = async (receipt) => {
    const updated = await api.tasks.receipt({ projectId: receipt.projectId, threadId: receipt.threadId });
    if (updated) setTaskReceipts((current) => current.map((candidate) => candidate.threadId === updated.threadId ? updated : candidate));
  };
  const compareReceipt = (receipt) => {
    setComparisonThreadId(receipt.threadId);
    changeView("compare");
  };
  const openReceiptTask = (receipt) => {
    setDraftMode(false);
    selectedProjectIdRef.current = receipt.projectId;
    selectedThreadIdRef.current = receipt.threadId;
    setSelectedProjectId(receipt.projectId);
    setSelectedThreadId(receipt.threadId);
    setActiveView("task");
  };
  const replayReceipt = async (receipt, options) => {
    const result = await api.tasks.replay({ projectId: receipt.projectId, threadId: receipt.threadId, revision: receipt.revision, ...options });
    setProjects((current) => current.some((project) => project.id === result.project.id) ? current : [...current, result.project]);
    setReceiptRefreshKey((value) => value + 1);
  };
  const comparisonSource = taskReceipts.find((receipt) => receipt.threadId === comparisonThreadId);
  const comparisonReceipts = comparisonSource ? taskReceipts.filter((receipt) => receipt.groupId === comparisonSource.groupId).sort((left, right) => left.startedAt.localeCompare(right.startedAt)) : [];
  const focusActive = surfaceMode === "focus" && Boolean(selectedProject) && !readOnly && Boolean(api?.focus?.ensure);
  const interventionCount = attention.filter(isApprovalRequest).length;

  const questionRequest = attention.find((request) => isQuestionRequest(request) && request.params?.threadId === selectedThreadId) ?? null;
  const currentHostId = connect?.active ?? "local";
  useEffect(() => {
    connect?.registerOrigin?.({
      hostId: currentHostId,
      projectId: selectedProjectId,
      hostLabel: currentHostId === "local" ? "This device" : connect.instances?.find((instance) => instance.id === currentHostId)?.name ?? currentHostId
    });
  }, [connect, currentHostId, selectedProjectId]);
  const targetIsOrigin = executionTarget.hostId === currentHostId;
  const targetCatalog = targetIsOrigin ? { models, providers } : (connect?.hostCatalogs?.[executionTarget.hostId] ?? {});
  const targetModels = targetCatalog.models ?? [];
  const targetModel = targetModels.find((candidate) => candidate.model === (targetIsOrigin ? selectedModel : executionTargetConfig?.model))
    ?? targetModels.find((candidate) => candidate.isDefault)
    ?? targetModels[0];
  const targetModelName = targetModel?.model ?? (targetIsOrigin ? selectedModel : executionTargetConfig?.model ?? "");
  const targetEffort = resolveReasoningEffort(targetIsOrigin ? effort : executionTargetConfig?.effort, targetModel, targetModel?.defaultReasoningEffort);
  const targetFastMode = targetIsOrigin ? fastMode : Boolean(executionTargetConfig?.fastMode && fastServiceTier(targetModel));
  const targetPermissionMode = focusActive
    ? "full-access"
    : targetIsOrigin ? permissionMode : executionTargetConfig?.permissionMode ?? defaultPermissionMode;
  const targetProvider = targetModel?.provider
    ? (targetCatalog.providers ?? []).find((provider) => provider.id === targetModel.provider)
    : null;
  const targetProviderReady = !targetProvider
    || (targetProvider.connected !== false && !["error", "stopped", "unavailable"].includes(targetProvider.status?.state));
  const targetHostState = targetIsOrigin
    ? runtime
    : connect?.clientStates?.[executionTarget.hostId] ?? targetCatalog.runtime ?? { state: "connecting", connected: false };
  const targetConnected = targetIsOrigin
    ? Boolean(runtime.connected)
    : Boolean(targetHostState.connected || targetHostState.state === "connected");
  const targetProjectReady = targetIsOrigin
    ? Boolean(selectedProject)
    : Boolean(executionTarget.projectId && (targetCatalog.projects ?? []).some((candidate) => candidate.id === executionTarget.projectId));
  const targetAttachmentApi = targetIsOrigin ? api : connect?.getApi?.(executionTarget.hostId);
  const targetAttachmentContext = {
    api: targetAttachmentApi,
    hostId: targetAttachmentApi?.remote?.hostId ?? executionTarget.hostId,
    deviceId: targetAttachmentApi?.remote?.deviceId,
    projectId: targetIsOrigin ? selectedProjectId : executionTarget.projectId
  };
  const updateExecutionTargetConfig = (patch) => {
    if (targetIsOrigin) return;
    setExecutionTargetConfig((current) => {
      const next = { model: targetModelName, effort: targetEffort, fastMode: targetFastMode, permissionMode: targetPermissionMode, ...current, ...patch };
      try { createWorkspaceStorage(executionTarget.hostId).setItem(`pixice.executionConfiguration.${executionTarget.projectId || "new"}`, JSON.stringify(next)); } catch { /* The target remains usable if storage is unavailable. */ }
      return next;
    });
  };
  const composerProps = {
    disabled: !targetConnected || !targetProjectReady || !targetProviderReady,
    busy: submitting,
    draftKey: `${selectedProjectId ?? "none"}:${selectedThreadId ?? "new"}`,
    preserveDrafts: preferences.preserveDrafts,
    sendShortcut: preferences.sendShortcut,
    spellCheckComposer: preferences.spellCheckComposer,
    autoFocusComposer: preferences.autoFocusComposer,
    showSlashCommands: preferences.showSlashCommands,
    slashCommands: targetIsOrigin ? thread?.slashCommands : undefined,
    showPermissionPicker: !focusActive,
    running: Boolean(activeTurn),
    questionRequest,
    onQuestionResolve: resolveQuestion,
    models: targetModels,
    selectedModel: targetModelName,
    onModelChange: (modelName) => {
      if (targetIsOrigin) { changeThreadModel(modelName); return; }
      const model = targetModels.find((candidate) => candidate.model === modelName);
      updateExecutionTargetConfig({ model: modelName, effort: resolveReasoningEffort(targetEffort, model, model?.defaultReasoningEffort), fastMode: Boolean(targetFastMode && fastServiceTier(model)) });
    },
    storage,
    attachmentContext: targetAttachmentContext,
    effort: targetEffort,
    onEffortChange: (value) => targetIsOrigin ? changeThreadEffort(value) : updateExecutionTargetConfig({ effort: value }),
    fastMode: targetFastMode,
    onFastModeChange: (value) => targetIsOrigin ? changeThreadFastMode(value) : updateExecutionTargetConfig({ fastMode: value }),
    permissionMode: targetPermissionMode,
    onPermissionModeChange: (value) => targetIsOrigin ? changeThreadPermissionMode(value) : updateExecutionTargetConfig({ permissionMode: value }),
    providers: targetCatalog.providers ?? [],
    onProviderLogin: loginProvider,
    onProvidersRefresh: refreshProviders,
    onSubmit: submit,
    onImageRevision: ({ comment, source, prompt }) => {
      const attachments = generatedImageAttachment(source);
      return submit(generatedImageRevisionPrompt(comment, prompt, attachments.length > 0), attachments);
    },
    onForkResponse: forkConversation,
    onInterrupt: interrupt,
    dictationApi: api,
    transcription: transcription.state,
    micDeviceId: preferences.micDeviceId || null,
    accentColor: preferences.accentColor
  };
  const activeProjectToolId = projectTools.some((tool) => tool.id === selectedProjectToolId)
    ? selectedProjectToolId
    : projectTools[0]?.id ?? null;
  const linkedHostStates = useMemo(() => {
    const states = { ...(connect?.clientStates ?? {}), local: connect?.localState };
    const known = new Set((connect?.instances ?? []).map((instance) => instance.id));
    linkedThreads.forEach((link) => {
      if (link.executionHostId !== "local" && !known.has(link.executionHostId) && !states[link.executionHostId]) states[link.executionHostId] = { state: "forgotten", connected: false };
    });
    return states;
  }, [connect?.clientStates, connect?.instances, connect?.localState, linkedThreads]);

  const executionActive = Boolean(connect?.execution);
  const originPreviewOpen = !focusActive && previewOpen && !executionActive;
  let content;
  if (activeView === "board") {
    content = (
      <BoardWorkspace
        project={selectedProject}
        threads={threads}
        tasks={boardTasks}
        phases={boardPhases}
        attention={attention}
        loading={loading.threads || loading.board}
        onCreate={createBoardTask}
        onCreatePhase={createBoardPhase}
        onMove={moveBoardTask}
        onOpenThread={selectThread}
        onOpenTask={openBoardTaskPreview}
        onScheduleMove={rescheduleBoardTask}
        onStartTask={startBoardTask}
        storage={storage}
      />
    );
  } else if (activeView === "tools") {
    content = (
      <ProjectToolsWorkspace
        project={selectedProject}
        threadId={selectedThreadId}
        tools={projectTools}
        selectedId={activeProjectToolId}
        loading={loading.tools}
        onReload={() => loadProjectTools(selectedProjectId)}
        onLaunch={launchProjectTool}
        onRename={renameProjectTool}
        onGrants={changeProjectToolGrants}
        onDuplicate={duplicateProjectTool}
        onDelete={deleteProjectTool}
        onRevisions={loadProjectToolRevisions}
        onReceipts={loadProjectToolReceipts}
        onRestore={restoreProjectTool}
      />
    );
  } else if (activeView === "review") {
    content = <ReviewWorkspace project={selectedProject} review={review} loading={loading.review} fileLoadingPath={loading.reviewFile} gitStatus={gitStatus} gitBusy={loading.git} onLoadFile={(filePath) => loadReviewFile(selectedProjectId, filePath)} onRefresh={async () => { await loadGitStatus(); await loadReview(selectedProjectId); }} onInstallGit={installCommandLineTools} onExternal={openExternal} />;
  } else if (activeView === "settings") {
    content = (
      <SettingsWorkspace
        page={settingsPage}
        transcription={transcription}
        models={models}
        selectedModel={defaultModel}
        onModelChange={changeDefaultModel}
        effort={defaultEffort}
        onEffortChange={changeDefaultEffort}
        permissionMode={defaultPermissionMode}
        onPermissionModeChange={changeDefaultPermissionMode}
        defaultFastMode={defaultFastMode}
        onDefaultFastModeChange={changeDefaultFastMode}
        threadNamingModel={threadNamingModel}
        onThreadNamingModelChange={changeThreadNamingModel}
        workflowGenerationModel={workflowGenerationModel}
        onWorkflowGenerationModelChange={changeWorkflowGenerationModel}
        preferences={preferences}
        onPreferenceChange={changePreference}
        attentionNotifications={attentionNotifications}
        onAttentionNotificationsChange={changeAttentionNotifications}
        completionNotifications={completionNotifications}
        onCompletionNotificationsChange={changeCompletionNotifications}
        notificationSound={notificationSound}
        onNotificationSoundChange={changeNotificationSound}
        keepSystemAwake={keepSystemAwake}
        onKeepSystemAwakeChange={changeKeepSystemAwake}
        agentBehaviorCatalog={agentBehaviorCatalog}
        agentBehaviors={agentBehaviors}
        onAgentBehaviorChange={changeAgentBehavior}
        extensions={extensions}
        extensionsLoading={loading.extensions}
        providers={providers}
        providersLoading={loading.providers}
        onRefreshProviders={refreshProviders}
        onProviderLogin={loginProvider}
        onProviderAction={runProviderAction}
        providerUpdateChecksEnabled={providerUpdateChecksEnabled}
        onProviderUpdateChecksEnabledChange={changeProviderUpdateChecksEnabled}
        widgetCredentials={api?.widgets}
        githubStatus={githubStatus}
        githubLoading={loading.github}
        githubProgress={githubProgress}
        onRefreshGitHub={loadGitHubStatus}
        onGitHubLogin={loginGitHub}
        onGitHubLogout={logoutGitHub}
        gitStatus={gitStatus}
        gitLoading={loading.git}
        onRefreshGit={loadGitStatus}
        onInstallGit={installCommandLineTools}
        usageSummary={usageSummary}
        usageLoading={loading.usage}
        usageError={usageError}
        usageLimits={usageLimits}
        usageLimitsLoading={loading.usageLimits}
        usageLimitsError={usageLimitsError}
        usageRangeDays={usageRangeDays}
        onUsageRangeChange={setUsageRangeDays}
        onRefreshUsage={() => { loadUsage(usageRangeDays); loadUsageLimits(); }}
        onRefreshCapabilities={loadExtensions}
        updateStatus={updateStatus}
        onCheckForUpdates={() => runUpdateAction("check")}
        onDownloadUpdate={() => runUpdateAction("download")}
        onInstallUpdate={() => runUpdateAction("install")}
      />
    );
  } else if (activeView === "attention") {
    content = <AttentionWorkspace attention={attention} projects={projects} onResolve={resolveAttention} />;
  } else if (activeView === "compare") {
    content = <main className="main-canvas workspace"><AppToolbar icon={GitBranch} title="Compare models" subtitle={comparisonSource?.projectName} />{comparisonSource ? <ModelReplay key={comparisonSource.threadId} source={comparisonSource} comparisons={comparisonReceipts} models={models} onReplay={replayReceipt} onClose={() => openReceiptTask(comparisonSource)} Picker={ComposerPicker} renderDiff={renderCapturedChanges} onOpen={openReceiptTask} onLoadEvidence={loadReceiptEvidence} /> : <div className="empty-state compact"><h2>No task selected</h2><p>Open a completed task receipt to compare models.</p></div>}</main>;
  } else {
    content = (
      <>
        <div
          className="origin-task-workspace"
          data-execution-active={executionActive}
          aria-hidden={executionActive ? "true" : undefined}
          inert={executionActive ? true : undefined}
        >
          <ConversationWorkspace
            api={api}
            storage={storage}
            project={selectedProject}
            thread={thread}
            threads={threads}
            loading={loading.app || loading.thread}
            runtime={runtime}
            plan={plan}
            changedCount={changedCount}
            seenResponseIds={seenResponseIdsRef.current}
            inspectorOpen={inspectorOpen}
            onInspectorToggle={() => setInspectorOpen((open) => !open)}
            onOpenProject={openProject}
            showTaskProgress={preferences.showTaskProgress}
            expandTaskProgress={preferences.expandTaskProgress}
            showMessageTimestamps={preferences.showMessageTimestamps}
            completedWorkDetails={preferences.completedWorkDetails}
            previewOpen={originPreviewOpen}
            previewVisible={!executionActive}
            onPreviewToggle={togglePreview}
            previewWorkspaceId={previewWorkspaceId}
            previewApiWorkspaceId={previewApiWorkspaceId}
            browserState={browserState}
            onBrowserState={setBrowserState}
            onPreviewBrowserCreated={replacePreviewChooserWithBrowser}
            previewFileTabs={previewFileTabs}
            previewInstrumentTabs={previewInstrumentTabs}
            previewCustomTabs={previewCustomTabs}
            previewActiveTabId={previewActiveTabId}
            onPreviewActiveTabChange={setPreviewActiveTabId}
            onPreviewBrowserClose={closePreviewBrowser}
            onPreviewFileUpdate={updatePreviewFile}
            onPreviewFileClose={closePreviewFile}
            onPreviewInstrumentClose={closePreviewInstrument}
            onPreviewCustomTabOpen={openPreviewCustomTab}
            onPreviewCustomTabUpdate={updatePreviewCustomTab}
            onPreviewCustomTabClose={closePreviewCustomTab}
            onPreviewNewTab={openNewPreviewTab}
            onPreviewInstrumentRefresh={refreshPreviewInstrument}
            onPreviewInstrumentEvent={sendPreviewInstrumentEvent}
            onPreviewInstrumentInvoke={invokePreviewInstrumentCapability}
            onPreviewInstrumentPin={pinPreviewInstrument}
            onOpenWorkspaceReference={openWorkspaceReference}
            readOnly={readOnly}
            proactiveSuggestions={proactiveSuggestions}
            onProactiveSuggestionResolve={resolveProactiveSuggestion}
            sideThreadProps={{
              runtime,
              storage,
              models,
              defaultModel,
              defaultEffort,
              defaultFastMode,
              defaultPermissionMode,
              providers,
              threads,
              attention,
              preferences,
              seenResponseIds: seenResponseIdsRef.current,
              onQuestionResolve: resolveQuestion,
              onProviderLogin: loginProvider,
              onProvidersRefresh: refreshProviders,
              onThreadCreated: registerSideThread,
              onThreadActivity: markThreadMessaged,
              onThreadViewed: markThreadCompletionSeen,
              onOpenMain: selectThread,
              onForkResponse: forkConversation,
              onError: setError
            }}
            taskMapProps={{ thread, threads, plan, attention, onResolve: resolveAttention }}
            receipt={taskReceipts.find((receipt) => receipt.threadId === selectedThreadId)}
            onReceiptCompare={compareReceipt}
            composerProps={{
              ...composerProps,
              disabled: executionActive || composerProps.disabled,
              globalFileDrop: executionActive ? false : composerProps.globalFileDrop,
              autoFocusComposer: executionActive ? false : composerProps.autoFocusComposer
            }}
            executionTargetControl={connect && !selectedThreadId ? <ExecutionTargetControl
              connect={connect}
              value={executionTarget}
              projects={projects}
              currentHostId={connect?.active ?? "local"}
              currentProjectId={selectedProjectId}
              onChange={changeExecutionTarget}
              onProjectChange={(projectId) => {
                const next = { ...executionTarget, projectId };
                setExecutionTarget(next);
                if (next.hostId !== (connect?.active ?? "local")) void changeExecutionTarget(next);
              }}
              disabled={Boolean(selectedThreadId) || submitting}
            /> : null}
          />
        </div>
        {executionActive && connect?.executionView}
      </>
    );
  }

  useEffect(() => { setMobileNavigationOpen(false); }, [activeView, settingsPage, selectedProjectId, selectedThreadId]);

  return (
    <div className="pixice-stage">
      <div
        className={`pixice-app ${focusActive ? "view-focus" : `view-${activeView}`}`}
        data-surface-mode={focusActive ? "focus" : "workspace"}
        data-sidebar-expanded={sidebarExpanded}
        data-mobile-navigation={mobileNavigationOpen}
        data-inspector-open={!focusActive && activeView === "task" && inspectorOpen && Boolean(thread) && !originPreviewOpen && !executionActive}
        data-density={preferences.density}
        data-conversation-width={preferences.conversationWidth}
        data-conversation-text-size={preferences.conversationTextSize}
        data-accent-color={preferences.accentColor}
        data-reduce-transparency={preferences.reduceTransparency}
        data-reduce-motion={preferences.reduceMotion}
        data-show-shortcuts={preferences.showShortcutHints}
        data-preview-open={activeView === "task" && originPreviewOpen}
        data-active-thread-id={selectedThreadId ?? ""}
        style={{ "--sidebar-width": `${sidebarWidth}px` }}
      >
        <div className="window-drag-region" aria-hidden="true" />
        {focusActive ? (
          <FocusWorkspace
            api={api}
            storage={storage}
            project={selectedProject}
            projects={projects}
            thread={thread?.id === focusThreadId ? thread : null}
            threads={threads}
            loading={focusLoading || loading.app || (Boolean(focusThreadId) && loading.thread)}
            runtime={runtime}
            models={models}
            defaultModel={defaultModel}
            defaultEffort={defaultEffort}
            defaultFastMode={defaultFastMode}
            providers={providers}
            attention={[]}
            focusQuestions={attention.filter((request) => isQuestionRequest(request) && request.params?.threadId === focusThreadId)}
            preferences={preferences}
            plan={plan}
            seenResponseIds={seenResponseIdsRef.current}
            showMessageTimestamps={preferences.showMessageTimestamps}
            completedWorkDetails={preferences.completedWorkDetails}
            composerProps={{ ...composerProps, globalFileDrop: true }}
            connectionError={focusConnectionError}
            onRetry={() => loadFocusSession(selectedProjectId)}
            memory={focusMemory}
            onMemoryChange={(next) => {
              if (next?.projectId === selectedProjectIdRef.current) setFocusMemory(next);
            }}
            onExit={exitFocus}
            onOpenSettings={() => {
              exitFocus();
              changeView("settings");
            }}
            onSelectProject={selectFocusProject}
            previewOpen={previewOpen}
            onPreviewToggle={togglePreview}
            previewWorkspaceId={previewWorkspaceId}
            previewApiWorkspaceId={previewApiWorkspaceId}
            browserState={browserState}
            onBrowserState={setBrowserState}
            onPreviewBrowserCreated={replacePreviewChooserWithBrowser}
            previewFileTabs={previewFileTabs}
            previewInstrumentTabs={previewInstrumentTabs}
            previewCustomTabs={previewCustomTabs}
            previewActiveTabId={previewActiveTabId}
            onPreviewActiveTabChange={setPreviewActiveTabId}
            onPreviewBrowserClose={closePreviewBrowser}
            onPreviewFileUpdate={updatePreviewFile}
            onPreviewFileClose={closePreviewFile}
            onPreviewInstrumentClose={closePreviewInstrument}
            onPreviewCustomTabOpen={openPreviewCustomTab}
            onPreviewCustomTabUpdate={updatePreviewCustomTab}
            onPreviewCustomTabClose={closePreviewCustomTab}
            onPreviewNewTab={openNewPreviewTab}
            onPreviewInstrumentRefresh={refreshPreviewInstrument}
            onPreviewInstrumentEvent={sendPreviewInstrumentEvent}
            onPreviewInstrumentInvoke={invokePreviewInstrumentCapability}
            onPreviewInstrumentPin={pinPreviewInstrument}
            onOpenWorkspaceReference={openWorkspaceReference}
            onQuestionResolve={resolveQuestion}
            onProviderLogin={loginProvider}
            onProvidersRefresh={refreshProviders}
            onThreadCreated={registerSideThread}
            onThreadActivity={markThreadMessaged}
            onThreadViewed={markThreadCompletionSeen}
            onOpenMain={selectThread}
            onForkResponse={forkConversation}
            onError={setError}
            onResolveAttention={resolveAttention}
          />
        ) : <>
        {api?.remote && <>
          <button className="connect-mobile-menu" aria-label={mobileNavigationOpen ? "Close navigation" : "Open navigation"} aria-expanded={mobileNavigationOpen} onClick={() => { setMobileNavigationOpen((value) => !value); setSidebarExpanded(true); }}><Stack size={18} /></button>
          {mobileNavigationOpen && <button className="connect-mobile-scrim" aria-label="Close navigation drawer" onClick={() => setMobileNavigationOpen(false)} />}
        </>}
        {activeView === "settings" ? (
          <SettingsSidebar page={settingsPage} onPageChange={setSettingsPage} onBack={() => changeView("task")} />
        ) : activeView === "tools" ? (
          <ProjectToolsSidebar
            tools={projectTools}
            loading={loading.tools}
            selectedId={activeProjectToolId}
            onSelect={setSelectedProjectToolId}
            onBack={() => changeView("task")}
          />
        ) : (
          <Sidebar
            projects={projects}
            projectActivity={projectActivity}
            seenThreadCompletions={seenThreadCompletions}
            selectedProjectId={selectedProjectId}
            onSelectProject={selectProject}
            onDeleteProject={deleteProject}
            tasks={sidebarThreads}
            selectedThreadId={selectedThreadId}
            onSelectThread={selectThread}
            onDeleteThread={deleteThread}
            onCleanupThreads={cleanupThreads}
            protectedThreadIds={boardTasks.map((task) => task.threadId).filter(Boolean)}
            threadCleanupAgeDays={preferences.threadCleanupAgeDays}
            onNewTask={newTask}
            onEnterFocus={!readOnly && api?.focus?.ensure ? enterFocus : null}
            onOpenProject={openProject}
            activeView={activeView}
            onView={changeView}
            attentionCount={interventionCount}
            changedCount={changedCount}
            toolCount={projectTools.length}
            runtime={runtime}
            legacySidebar={preferences.legacySidebar}
            recentProjectLimit={preferences.showThirdProjectRow ? 9 : 6}
            reduceMotion={preferences.reduceMotion}
            collapseForPreview={activeView === "task" && originPreviewOpen}
            onExpandedChange={setSidebarExpanded}
            width={sidebarWidth}
            onWidthChange={setSidebarWidth}
            storage={storage}
            linkedThreads={linkedThreads}
            linkedThreadHostStates={linkedHostStates}
            onOpenLinkedThread={openLinkedThread}
            selectedLinkedThread={selectedLinkedThread}
          />
        )}
        {content}
        <div className="workflow-workspace-slot" data-workflow-workspace-slot />
        {activeView === "task" && !originPreviewOpen && !executionActive && <Inspector open={inspectorOpen} thread={thread} threads={threads} plan={plan} attention={attention} onResolve={resolveAttention} />}
        </>}
      </div>
      <OperationCapsuleStack operations={operationItems} taskOffset={!focusActive && activeView === "task"} />
      <ProjectCreationDialog
        open={projectDialogOpen}
        busy={projectCreateBusy}
        onClose={() => setProjectDialogOpen(false)}
        onAddFolders={pickProjectFolders}
        onCreate={createProject}
      />
    </div>
  );
}

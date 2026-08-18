import { Children, cloneElement, createContext, useCallback, useEffect, useId, useMemo, useRef, useState, useContext } from "react";
import {
  ArrowClockwise, Bell, Brain, CaretDown, CaretLeft, CaretRight, Check, CheckCircle,
  Circle, Code, Desktop, Eye, File, Files, Folder, FolderOpen, Gauge, Gear, GitBranch,
  GitDiff, Globe, Info, Lightning, List, LockKey, MagnifyingGlass, PaperPlaneTilt, Pause,
  ImageSquare, PlugsConnected, Plus, ShieldCheck, Sparkle, SpinnerGap, Stack,
  TerminalWindow, Trash, TreeStructure, Warning, X
} from "@phosphor-icons/react";
import loomIcon from "./assets/loom-icon.png";
import { ReasoningOrb } from "./components/ReasoningOrb.jsx";
import { StreamingText } from "./components/StreamingText.jsx";
import { ModelBrandIcon, modelBrand } from "./components/ModelBrandIcon.jsx";
import {
  applyRuntimePayload,
  descendantsOf,
  flattenItems,
  mergeThreadSnapshot,
  parseDiff,
  projectCollabAgents,
  threadStatus,
  threadTitle
} from "./state/runtime.js";

const EMPTY_EXTENSIONS = { skills: [], apps: [], mcp: [], errors: [] };
const EMPTY_BROWSER_STATE = { native: false, activeTabId: null, tabs: [] };
const EMPTY_PREVIEW_WORKSPACE = { open: false, browserState: EMPTY_BROWSER_STATE, fileTabs: [], activeTabId: null };
const EMPTY_UPDATE_STATUS = { supported: false, state: "development", currentVersion: "0.0.0", availableVersion: null, percent: 0, message: "Updates are available in packaged Loom builds." };
const WorkspaceOpenContext = createContext(null);
const MIN_SIDEBAR_WIDTH = 224;
const MAX_SIDEBAR_WIDTH = 360;
const DEFAULT_SIDEBAR_WIDTH = 264;
const MAX_COMPOSER_IMAGES = 10;
const MAX_COMPOSER_IMAGE_BYTES = 20 * 1024 * 1024;
const COMPOSER_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
const DEFAULT_PREFERENCES = {
  confirmBeforeDelete: true,
  preserveDrafts: true,
  showTaskProgress: true,
  autoOpenTaskMap: false,
  bringApprovalsForward: false,
  density: "compact",
  showShortcutHints: true,
  reduceMotion: false
};

// Mirrors the slash-command discovery surface in the installed Codex runtime.
// Loom only presents and autocompletes these commands; Codex remains responsible
// for interpreting them when the user submits the composer.
const SLASH_COMMANDS = [
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

function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem("loom.preferences") ?? "{}");
    return { ...DEFAULT_PREFERENCES, ...saved };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function supportedReasoningEfforts(model) {
  return model?.supportedReasoningEfforts?.map((option) => option.reasoningEffort ?? option.effort ?? option) ?? [];
}

function storedReasoningEffort(model) {
  const saved = localStorage.getItem("loom.effort");
  const supported = supportedReasoningEfforts(model);
  return saved && (!supported.length || supported.includes(saved))
    ? saved
    : model?.defaultReasoningEffort || supported[0] || "high";
}

function threadConfigurationKey(threadId) {
  return `loom.threadConfiguration.${threadId}`;
}

function loadThreadConfiguration(threadId) {
  if (!threadId) return null;
  try {
    return JSON.parse(localStorage.getItem(threadConfigurationKey(threadId)) ?? "null");
  } catch {
    return null;
  }
}

function saveThreadConfiguration(threadId, configuration) {
  if (!threadId) return;
  localStorage.setItem(threadConfigurationKey(threadId), JSON.stringify(configuration));
}

function resolveReasoningEffort(candidate, model, fallback) {
  const supported = supportedReasoningEfforts(model);
  if (candidate && (!supported.length || supported.includes(candidate))) return candidate;
  if (fallback && (!supported.length || supported.includes(fallback))) return fallback;
  return model?.defaultReasoningEffort || supported[0] || "high";
}

function clampSidebarWidth(width) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function IconButton({ label, children, className = "", ...props }) {
  return <button className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}

function readComposerImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve({
      id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      name: file.name || "Pasted image",
      type: file.type,
      size: file.size,
      url: reader.result
    }));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read image")));
    reader.readAsDataURL(file);
  });
}

function imageFilesFromTransfer(transfer) {
  return Array.from(transfer?.files ?? []).filter((file) => COMPOSER_IMAGE_TYPES.has(file.type));
}

function transferHasImages(transfer) {
  const items = Array.from(transfer?.items ?? []);
  if (items.some((item) => item.kind === "file" && COMPOSER_IMAGE_TYPES.has(item.type))) return true;
  return imageFilesFromTransfer(transfer).length > 0;
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

function SidebarNavItem({ icon: Icon, label, active, badge, badgeTone = "neutral", shortcut, tone = "", disabled, onClick }) {
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
      {badge > 0 && <span className={`rail-badge ${badgeTone}`}>{badge > 99 ? "99+" : badge}</span>}
    </button>
  );
}

function Sidebar({
  projects,
  selectedProjectId,
  onSelectProject,
  tasks,
  selectedThreadId,
  onSelectThread,
  onDeleteThread,
  onNewTask,
  onOpenProject,
  activeView,
  onView,
  attentionCount,
  changedCount,
  runtime,
  forcedCollapsed = false,
  onExpandedChange,
  width,
  onWidthChange
}) {
  const [pinnedExpanded, setPinnedExpanded] = useState(() => localStorage.getItem("loom.sidebarPinned") !== "false");
  const resizeCleanup = useRef(null);
  const expanded = forcedCollapsed ? false : pinnedExpanded;

  useEffect(() => onExpandedChange(expanded), [expanded, onExpandedChange]);
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
    if (forcedCollapsed) return;
    const next = !expanded;
    setPinnedExpanded(next);
    localStorage.setItem("loom.sidebarPinned", String(next));
  };

  const keepExpanded = () => {
    setPinnedExpanded(true);
    localStorage.setItem("loom.sidebarPinned", "true");
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
      localStorage.setItem("loom.sidebarWidth", String(nextWidth));
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
    localStorage.setItem("loom.sidebarWidth", String(nextWidth));
  };

  return (
    <aside
      className="sidebar"
      aria-label="Primary navigation"
      data-expanded={expanded}
      data-forced-collapsed={forcedCollapsed}
    >
      <div className="rail-header">
        <div className="brand-mark"><img src={loomIcon} alt="" /></div>
        <div className="brand-copy">
          <strong>Loom</strong>
          <small>{runtime.connected ? "Codex connected" : "Codex offline"}</small>
        </div>
        <IconButton
          label={expanded ? "Collapse navigation labels" : "Expand navigation labels"}
          aria-expanded={expanded}
          onClick={togglePinned}
          className="rail-toggle"
          disabled={forcedCollapsed}
        >
          {expanded ? <CaretLeft size={18} /> : <List size={18} />}
        </IconButton>
      </div>

      <nav className="rail-scroll">
        <div className="rail-group">
          <div className="rail-group-label"><i />Workspace</div>
          <SidebarNavItem icon={Plus} label="New task" tone="new-task" shortcut={newTaskShortcut} active={Boolean(selectedProjectId) && activeView === "task" && !selectedThreadId} disabled={!selectedProjectId} onClick={onNewTask} />
          <SidebarNavItem icon={Bell} label="Attention" active={activeView === "attention"} badge={attentionCount} badgeTone="attention" onClick={() => onView("attention")} />
          <SidebarNavItem icon={GitDiff} label="Review" active={activeView === "review"} badge={changedCount} disabled={!selectedProjectId} onClick={() => onView("review")} />
        </div>

        <div className="rail-divider" />
        <div className="rail-section-heading">
          <span className="rail-group-label"><i />Projects</span>
          <IconButton label="Open project" onClick={onOpenProject}><Plus size={15} /></IconButton>
        </div>

        <div className="project-list">
          {projects.length === 0 && <p className="rail-empty">Open a local folder to begin.</p>}
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
                {selected && (
                  <div className="task-tree" aria-label={`${project.displayName} tasks`}>
                    {tasks.length === 0 && <p>No Codex tasks yet</p>}
                    {tasks.map((task) => {
                      const title = threadTitle(task);
                      const active = task.id === selectedThreadId && activeView === "task";
                      const status = threadStatus(task);
                      const running = ["running", "inProgress", "active"].includes(status);
                      return (
                        <div className={`task-row ${active ? "active" : ""} ${running ? "running" : ""}`} key={task.id}>
                          <button className="task-select" onClick={() => onSelectThread(task.id)} title={title} aria-current={active ? "page" : undefined}>
                            <span className="task-title">{title}</span>
                            {running && (
                              <ReasoningOrb
                                className="task-state task-reasoning-orb"
                                size={16}
                                label="Task is reasoning"
                                decorative
                              />
                            )}
                          </button>
                          <IconButton className="task-delete" label={`Delete ${title}`} onClick={() => onDeleteThread(task.id)}>
                            <Trash size={13} />
                          </IconButton>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </nav>

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

function AppToolbar({ title, subtitle, inspectorOpen, onInspectorToggle, showInspector = false, previewOpen, onPreviewToggle, showPreview = false }) {
  return (
    <header className="app-toolbar">
      <div className="toolbar-title">
        <Folder size={16} />
        <span><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</span>
      </div>
      <div className="toolbar-actions">
        {showPreview && (
          <IconButton label={previewOpen ? "Close preview workspace" : "Open preview workspace"} className={previewOpen ? "active" : ""} onClick={onPreviewToggle}>
            <Stack size={18} />
          </IconButton>
        )}
        {showInspector && (
          <IconButton label="Toggle task inspector" className={inspectorOpen ? "active" : ""} onClick={onInspectorToggle}>
            <TreeStructure size={18} />
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

function FileSurface({ file, onUpdate, onSave }) {
  const source = file.draft ?? file.content ?? "";

  useEffect(() => {
    if (!file.editing) return undefined;
    const saveShortcut = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void onSave(file);
    };
    window.addEventListener("keydown", saveShortcut);
    return () => window.removeEventListener("keydown", saveShortcut);
  }, [file, onSave]);

  if (file.editing) {
    return (
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
  }
  if (file.previewKind === "markdown") return <div className="file-document markdown-document"><MarkdownMessage text={source} /></div>;
  if (file.previewKind === "html") return <iframe className="html-preview" title={`Preview ${file.name}`} srcDoc={source} sandbox="allow-scripts allow-forms allow-modals" />;
  if (file.previewKind === "image") return <div className="file-media-preview"><img src={file.dataUrl} alt={file.name} /></div>;
  if (file.previewKind === "pdf") return <iframe className="pdf-preview" title={file.name} src={file.dataUrl} />;
  if (file.previewKind === "unsupported") return <div className="file-empty"><File size={28} /><strong>Preview unavailable</strong><small>This binary format cannot be displayed or edited in Loom yet.</small></div>;
  return <pre className="text-file-preview"><code>{source}</code></pre>;
}

function BrowserPanel({ api, workspaceId, state, onState, onClose, projectId, fileTabs, activeTabId, onActiveTabChange, onFileUpdate, onFileClose }) {
  const viewportRef = useRef(null);
  const activeFile = fileTabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeTab = activeFile ? null : state.tabs.find((tab) => tab.id === activeTabId) ?? state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
  const [address, setAddress] = useState(activeTab?.url ?? "");

  useEffect(() => setAddress(activeTab?.url ?? ""), [activeTab?.id, activeTab?.url]);
  useEffect(() => {
    if (!api?.browser || !activeTab || !viewportRef.current) {
      if (workspaceId) void api?.browser?.setViewport({ workspaceId, visible: false }).catch(() => {});
      return undefined;
    }
    const updateBounds = () => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      void api.browser.setViewport({
        workspaceId,
        visible: true,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }).then(onState).catch(() => {});
    };
    updateBounds();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(updateBounds) : null;
    observer?.observe(viewportRef.current);
    window.addEventListener("resize", updateBounds);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateBounds);
      void api.browser.setViewport({ workspaceId, visible: false }).catch(() => {});
    };
  }, [activeTab?.id, api, onState, workspaceId]);

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
    void run(() => api.browser.navigate({ workspaceId, tabId: activeTab?.id, url: address }));
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

  return (
    <section className="browser-panel" aria-label="Preview workspace">
      <div className="browser-tabbar">
        <div className="browser-tabs" role="tablist" aria-label="Workspace tabs">
          {state.tabs.map((tab) => (
            <div className={`browser-tab${tab.id === activeTabId ? " active" : ""}`} role="presentation" key={tab.id}>
              <button role="tab" aria-selected={tab.id === activeTabId} onClick={() => void run(() => api.browser.activate({ workspaceId, tabId: tab.id }), true)}>
                {tab.loading ? <SpinnerGap className="spin-icon" size={12} /> : <Globe size={12} />}
                <span>{tab.title || "New tab"}</span>
              </button>
              <IconButton label={`Close ${tab.title || "tab"}`} onClick={() => void run(() => api.browser.close({ workspaceId, tabId: tab.id }), tab.id === activeTabId)}><X size={11} /></IconButton>
            </div>
          ))}
          {fileTabs.map((file) => (
            <div className={`browser-tab file-tab${file.id === activeTabId ? " active" : ""}${file.dirty ? " dirty" : ""}`} role="presentation" key={file.id}>
              <button role="tab" aria-selected={file.id === activeTabId} onClick={() => onActiveTabChange(file.id)}>
                {file.previewKind === "html" ? <Code size={12} /> : <File size={12} />}
                <span>{file.name}</span>
              </button>
              <IconButton label={`Close ${file.name}`} onClick={() => onFileClose(file.id)}>{file.dirty ? <Circle size={8} weight="fill" /> : <X size={11} />}</IconButton>
            </div>
          ))}
          <IconButton label="New browser tab" className="browser-new-tab" onClick={() => void run(() => api.browser.create({ workspaceId }), true)}><Plus size={15} /></IconButton>
        </div>
        <IconButton label="Close preview workspace" className="browser-close" onClick={onClose}><X size={15} /></IconButton>
      </div>
      {activeFile ? (
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
          <IconButton label="Back" disabled={!activeTab?.canGoBack} onClick={() => void run(() => api.browser.history({ workspaceId, action: "back" }))}><CaretLeft size={16} /></IconButton>
          <IconButton label="Forward" disabled={!activeTab?.canGoForward} onClick={() => void run(() => api.browser.history({ workspaceId, action: "forward" }))}><CaretRight size={16} /></IconButton>
          <IconButton label={activeTab?.loading ? "Stop loading" : "Reload"} onClick={() => void run(() => api.browser.history({ workspaceId, action: activeTab?.loading ? "stop" : "reload" }))}>{activeTab?.loading ? <X size={14} /> : <ArrowClockwise size={15} />}</IconButton>
          <form className="browser-address" onSubmit={submitAddress}>
            <LockKey size={13} />
            <input aria-label="Browser address" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Search or enter address" spellCheck="false" />
          </form>
        </div>
      )}
      {activeTab?.error && <div className="browser-error"><Warning size={13} />{activeTab.error}</div>}
      {activeFile ? (
        <FileSurface file={activeFile} onUpdate={onFileUpdate} onSave={saveFile} />
      ) : activeTab ? (
        <div className="browser-viewport" ref={viewportRef}>
          {!state.native && (
            <div className="browser-mock-page">
              <span><Globe size={23} /></span>
              <strong>{activeTab.title || "Browse with Loom"}</strong>
              <small>{activeTab.url || "Enter an address above or ask Codex to investigate a page."}</small>
            </div>
          )}
        </div>
      ) : <div className="file-empty"><Stack size={28} /><strong>Open something</strong><small>Use + for a browser tab or select a file link in the conversation.</small></div>}
    </section>
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

function PlanPanel({ plan, fallbackText, thread, agents = [], fileCount = 0, running, inspectorOpen, onInspectorToggle }) {
  const [expanded, setExpanded] = useState(true);
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
        <span className="progress-glyph"><Stack size={17} weight="fill" /></span>
        <span className="progress-title"><strong>Task progress</strong><small>{thread ? threadTitle(thread) : "Codex plan"}</small></span>
        {total > 0 && <span className="progress-count"><strong>{complete} / {total}</strong><small>complete</small></span>}
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
                <span><Circle size={10} weight="fill" /><strong>{phase}</strong></span>
                <small>{workingCopy}</small>
              </div>
              <div className="progress-steps">
                {plan.map((step, index) => (
                  <div className={`progress-step ${step.status}${step.status === "inProgress" && !running ? " inactive" : ""}`} key={step.step}>
                    {step.status === "completed" ? <CheckCircle size={15} weight="fill" /> : step.status === "inProgress" && running ? <SpinnerGap className="spin-icon" size={15} /> : step.status === "inProgress" ? <Pause size={15} weight="fill" /> : <Circle size={15} />}
                    <span className="progress-step-copy"><strong>{step.step}</strong><small>{planStepDetail(step, index, workingAgents, running)}</small></span>
                  </div>
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
        {item.aggregatedOutput && (
          <details className="trace-command-output">
            <summary><span>View output</span><CaretRight className="activity-caret" size={12} /></summary>
            <pre>{item.aggregatedOutput}</pre>
          </details>
        )}
      </div>
    );
  }
  if (item.type === "fileChange") {
    const count = item.changes?.length ?? 0;
    return <div className="trace-entry"><Files size={14} /><span className="trace-entry-copy"><strong>Updated files</strong><small>{count} file{count === 1 ? "" : "s"}</small></span><StatusDot status={item.status === "completed" ? "complete" : "running"} /></div>;
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

function MarkdownMessage({ text, trailing }) {
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
      blocks.push(<pre className="message-code" key={`code-${index}`}><code data-language={language || undefined}>{code.join("\n")}</code></pre>);
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

function threadRevision(thread) {
  return JSON.stringify([
    thread?.id,
    thread?.updatedAt,
    thread?.status,
    (thread?.turns ?? []).map((turn) => [
      turn.id,
      turn.status,
      (turn.items ?? []).map((item) => [
        item.id,
        item.type,
        item.status,
        item.phase,
        item.text,
        item.aggregatedOutput,
        item.content?.map((part) => part.text ?? part.url ?? part.path).join("\n"),
        item.summary,
        item.changes
      ])
    ])
  ]);
}

function AssistantResponse({ item, forceFinal, responseKey, seenResponseIds }) {
  const [animate] = useState(() => !seenResponseIds.has(responseKey));
  useEffect(() => {
    seenResponseIds.add(responseKey);
  }, [responseKey, seenResponseIds]);

  return (
    <article className={`message assistant-message ${forceFinal ? "final_answer" : item.phase ?? ""}`}>
      {animate ? (
        <StreamingText text={item.text}>
          {(shown, caret) => <MarkdownMessage text={shown} trailing={caret} />}
        </StreamingText>
      ) : <MarkdownMessage text={item.text} />}
    </article>
  );
}

function ConversationItem({ item, forceFinal = false, responseKey, seenResponseIds }) {
  if (item.type === "userMessage") {
    const text = item.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const images = item.content?.filter((part) => part.type === "image" && part.url) ?? [];
    if (!text && images.length === 0) return null;
    return (
      <div className="message user-message">
        {images.length > 0 && (
          <div className="user-message-images" aria-label={`${images.length} attached image${images.length === 1 ? "" : "s"}`}>
            {images.map((image, index) => <img src={image.url} alt={`Attached image ${index + 1}`} key={`${image.url.slice(0, 48)}-${index}`} />)}
          </div>
        )}
        {text && <span>{text}</span>}
      </div>
    );
  }
  if (item.type === "agentMessage") {
    if (!item.text) return null;
    return <AssistantResponse item={item} forceFinal={forceFinal} responseKey={responseKey} seenResponseIds={seenResponseIds} />;
  }
  if (item.type === "plan") return null;
  return <ActivityItem item={item} />;
}

const TRACE_ITEM_TYPES = new Set(["reasoning", "commandExecution", "fileChange", "collabAgentToolCall", "mcpToolCall", "dynamicToolCall"]);

function turnIsRunning(status) {
  return status === "inProgress" || status === "running" || status === "active";
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
    icon: Lightning
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
  none: { label: "None", description: "Answer directly without deliberate reasoning.", icon: Lightning },
  minimal: { label: "Minimal", description: "Fast responses for straightforward work.", icon: Lightning },
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

function ComposerPicker({ label, hint, value, options, onChange, kind, align = "right", disabled = false }) {
  const [open, setOpen] = useState(false);
  const [activeProvider, setActiveProvider] = useState("codex");
  const rootRef = useRef(null);
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
  const visibleSelectedIndex = Math.max(0, visibleOptions.findIndex((option) => option.value === value));

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

  const choose = (next) => {
    onChange(next.value);
    setOpen(false);
    window.setTimeout(() => rootRef.current?.querySelector(".picker-trigger")?.focus(), 0);
  };

  const moveFocus = (event) => {
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
    <div className={`composer-picker ${kind}`} data-open={open} ref={rootRef}>
      <button
        type="button"
        className="picker-trigger"
        aria-label={`${label}: ${selected?.label ?? "Unavailable"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled || !selected}
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
        <span className="picker-trigger-label">{selected?.label ?? "Unavailable"}</span>
        <CaretDown className="picker-chevron" size={12} weight="bold" />
      </button>
      {open && (
        <div className="picker-popover" data-align={align}>
          <div className="picker-head">
            <span>{label}</span>
            <small>{hint}</small>
          </div>
          {providerOptions.length > 0 && (
            <div className="model-provider-tabs" role="tablist" aria-label="Model provider">
              {providerOptions.map((provider) => {
                const available = options.some((option) => option.provider === provider.value);
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
                    <ModelBrandIcon model={provider.value === "codex" ? "gpt" : "claude"} provider={provider.value} />
                    <span>{provider.label}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="picker-options" id={listboxId} role="listbox" aria-label={label} onKeyDown={moveFocus}>
            {visibleOptions.map((option, index) => (
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
        </div>
      )}
    </div>
  );
}

function WorkingTrace({ items, running, settled }) {
  const disclosureId = useId();
  const [manualExpanded, setManualExpanded] = useState(null);
  const wasSettled = useRef(settled);
  const toolCount = items.filter((item) => item.type !== "agentMessage" && item.type !== "reasoning").length;
  const activeItem = [...items].reverse().find((item) => item.status === "inProgress" || item.status === "running");
  const activeLabel = activeItem?.type === "commandExecution"
    ? "Running command"
    : activeItem?.type === "mcpToolCall" || activeItem?.type === "dynamicToolCall"
      ? "Using tools"
      : toolCount ? "Working" : "Thinking";
  const doneLabel = toolCount
    ? `Ran ${toolCount} action${toolCount === 1 ? "" : "s"}`
    : "Thought through the task";
  const label = running ? activeLabel : settled ? doneLabel : "Work details";
  const expanded = manualExpanded ?? !settled;

  useEffect(() => {
    if (!wasSettled.current && settled) setManualExpanded(null);
    wasSettled.current = settled;
  }, [settled]);

  return (
    <section className="working-trace" data-expanded={expanded} data-working={running}>
      <button
        type="button"
        className="trace-toggle"
        aria-expanded={expanded}
        aria-controls={disclosureId}
        onClick={() => setManualExpanded((current) => !(current ?? !settled))}
      >
        {running
          ? <ReasoningOrb className="trace-status-orb" label={label} decorative />
          : <Sparkle className="trace-status-icon" size={15} weight="regular" />}
        <span className={`trace-toggle-label ${running ? "shimmer" : ""}`} role="status">{label}</span>
        <CaretRight className="trace-caret" size={13} />
      </button>
      <div
        id={disclosureId}
        className="trace-disclosure"
        aria-hidden={!expanded}
        inert={!expanded}
      >
        <div className="trace-disclosure-inner">
          <div className="trace-list">
            {items.map((item, index) => item.type === "agentMessage" ? (
              item.text ? <div className="trace-commentary" key={item.renderId ?? item.id ?? `commentary-${index}`}><MarkdownMessage text={item.text} /></div> : null
            ) : (
              <ActivityItem item={item} key={item.renderId ?? item.id ?? `${item.type}-${index}`} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function TurnConversation({ threadId, turn, seenResponseIds }) {
  const items = turn.items ?? [];
  const running = turnIsRunning(turn.status);
  const explicitFinalIndex = items.findLastIndex((item) => item.type === "agentMessage" && item.phase === "final_answer");
  const fallbackFinalIndex = explicitFinalIndex === -1 && turn.status === "completed"
    ? items.findLastIndex((item) => item.type === "agentMessage" && item.text)
    : -1;
  const finalIndex = explicitFinalIndex === -1 ? fallbackFinalIndex : explicitFinalIndex;
  const settled = !running && finalIndex !== -1;
  const rendered = [];
  let traceItems = [];
  let renderedWorkingTrace = false;

  const flushTrace = () => {
    if (!traceItems.length) return;
    const key = traceItems[0].renderId ?? traceItems[0].id ?? `trace-${rendered.length}`;
    rendered.push(<WorkingTrace items={traceItems} running={running} settled={settled} key={key} />);
    renderedWorkingTrace = true;
    traceItems = [];
  };

  items.forEach((item, index) => {
    if (item.type === "plan") return;
    const isFinal = index === finalIndex;
    const isTrace = !isFinal && (item.type === "agentMessage" || TRACE_ITEM_TYPES.has(item.type));
    if (isTrace) {
      traceItems.push(item);
      return;
    }
    flushTrace();
    rendered.push(
      <ConversationItem
        item={item}
        forceFinal={isFinal}
        responseKey={responseDisplayKey(threadId, turn.renderId ?? turn.id, item, index)}
        seenResponseIds={seenResponseIds}
        key={item.renderId ?? item.id ?? `${item.type}-${index}`}
      />
    );
  });
  flushTrace();
  if (running && !renderedWorkingTrace && finalIndex === -1) {
    rendered.push(<WorkingTrace items={[]} running settled={false} key={`pending-${turn.renderId ?? turn.id}`} />);
  }

  return rendered;
}

function Composer({ disabled, busy, draftKey, preserveDrafts, running, models, selectedModel, onModelChange, effort, onEffortChange, permissionMode, onPermissionModeChange, onSubmit, onInterrupt }) {
  const [text, setText] = useState("");
  const [images, setImages] = useState([]);
  const [draggingImages, setDraggingImages] = useState(false);
  const [imageNotice, setImageNotice] = useState("");
  const [commandSelection, setCommandSelection] = useState(0);
  const [commandsDismissed, setCommandsDismissed] = useState(false);
  const storageKey = `loom.draft.${draftKey}`;
  const commandListId = useId();
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const selected = models.find((model) => model.model === selectedModel);
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
  useEffect(() => {
    setText(preserveDrafts ? localStorage.getItem(storageKey) ?? "" : "");
    setImages([]);
    setImageNotice("");
    setCommandsDismissed(false);
    setCommandSelection(0);
    if (!preserveDrafts) localStorage.removeItem(storageKey);
  }, [preserveDrafts, storageKey]);

  const addImageFiles = useCallback(async (files) => {
    if (disabled) return;
    const candidates = Array.from(files ?? []);
    const supported = candidates.filter((file) => COMPOSER_IMAGE_TYPES.has(file.type));
    const withinLimit = supported.filter((file) => file.size <= MAX_COMPOSER_IMAGE_BYTES);
    if (supported.length !== candidates.length) setImageNotice("Use PNG, JPEG, WebP, GIF, or AVIF images.");
    else if (withinLimit.length !== supported.length) setImageNotice("Images must be 20 MB or smaller.");
    else setImageNotice("");
    const available = Math.max(0, MAX_COMPOSER_IMAGES - images.length);
    if (available === 0) {
      setImageNotice(`You can attach up to ${MAX_COMPOSER_IMAGES} images.`);
      return;
    }
    try {
      const additions = await Promise.all(withinLimit.slice(0, available).map(readComposerImage));
      setImages((current) => [...current, ...additions].slice(0, MAX_COMPOSER_IMAGES));
      if (withinLimit.length > available) setImageNotice(`You can attach up to ${MAX_COMPOSER_IMAGES} images.`);
      textareaRef.current?.focus();
    } catch {
      setImageNotice("One of the images could not be read.");
    }
  }, [disabled, images.length]);

  useEffect(() => {
    const onDragEnter = (event) => {
      if (disabled || !transferHasImages(event.dataTransfer)) return;
      event.preventDefault();
      setDraggingImages(true);
    };
    const onDragOver = (event) => {
      if (disabled || !transferHasImages(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setDraggingImages(true);
    };
    const onDragLeave = (event) => {
      if (!event.relatedTarget) setDraggingImages(false);
    };
    const onDrop = (event) => {
      if (disabled || !transferHasImages(event.dataTransfer)) return;
      event.preventDefault();
      setDraggingImages(false);
      addImageFiles(imageFilesFromTransfer(event.dataTransfer));
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [addImageFiles, disabled]);
  const slashMatch = text.match(/^\/([^\s]*)$/);
  const slashQuery = slashMatch?.[1].toLowerCase() ?? null;
  const matchingCommands = slashQuery === null ? [] : SLASH_COMMANDS.filter((command) => {
    return command.name.includes(slashQuery) || command.description.toLowerCase().includes(slashQuery);
  });
  const commandMenuOpen = !disabled && !commandsDismissed && matchingCommands.length > 0;
  const activeCommandIndex = Math.min(commandSelection, Math.max(0, matchingCommands.length - 1));
  const activeCommand = matchingCommands[activeCommandIndex];

  const completeCommand = (command) => {
    if (!command || disabled) return;
    const value = `/${command.name} `;
    setText(value);
    setCommandsDismissed(true);
    if (preserveDrafts) localStorage.setItem(storageKey, value);
    window.setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(value.length, value.length);
    }, 0);
  };
  const submit = async () => {
    const value = text.trim();
    if ((!value && images.length === 0) || disabled || busy) return;
    const submittedImages = images;
    setText("");
    setImages([]);
    setImageNotice("");
    localStorage.removeItem(storageKey);
    const accepted = await onSubmit(value, submittedImages.map((image) => image.url));
    if (accepted === false) {
      setText((current) => current || value);
      setImages((current) => current.length ? current : submittedImages);
      if (preserveDrafts) localStorage.setItem(storageKey, value);
    }
  };
  return (
    <div className="composer" data-dragging-images={draggingImages}>
      {draggingImages && (
        <div className="composer-drop-target" role="status">
          <ImageSquare size={22} />
          <span>Drop images to attach</span>
        </div>
      )}
      {commandMenuOpen && (
        <div className="slash-command-menu" id={commandListId} role="listbox" aria-label="Slash commands">
          <div className="slash-command-head">
            <span>Codex commands</span>
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
      {images.length > 0 && (
        <div className="composer-attachments" aria-label="Attached images">
          {images.map((image) => (
            <figure className="composer-attachment" key={image.id}>
              <img src={image.url} alt={image.name} />
              <button type="button" aria-label={`Remove ${image.name}`} onClick={() => setImages((current) => current.filter((candidate) => candidate.id !== image.id))}>
                <X size={10} weight="bold" />
              </button>
            </figure>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        aria-label="Message Codex"
        aria-autocomplete="list"
        aria-expanded={commandMenuOpen}
        aria-controls={commandMenuOpen ? commandListId : undefined}
        aria-activedescendant={commandMenuOpen && activeCommand ? `${commandListId}-${activeCommand.name}` : undefined}
        placeholder={disabled ? "Connect Codex and select a project to begin" : running ? "Steer the active task" : "Ask Codex to work on this project"}
        value={text}
        disabled={disabled}
        onPaste={(event) => {
          const files = imageFilesFromTransfer(event.clipboardData);
          if (files.length > 0) addImageFiles(files);
        }}
        onFocus={() => setCommandsDismissed(false)}
        onBlur={() => setCommandsDismissed(true)}
        onChange={(event) => {
          const value = event.target.value;
          setText(value);
          setCommandsDismissed(false);
          setCommandSelection(0);
          if (preserveDrafts) localStorage.setItem(storageKey, value);
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
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {imageNotice && <div className="composer-image-notice" role="status">{imageNotice}</div>}
      <div className="composer-controls">
        <div className="composer-primary-actions">
          <input
            ref={fileInputRef}
            className="composer-file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
            multiple
            tabIndex={-1}
            onChange={(event) => {
              addImageFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <IconButton label="Attach images" className="composer-attach" onClick={() => fileInputRef.current?.click()} disabled={disabled || images.length >= MAX_COMPOSER_IMAGES}>
            <Plus size={18} />
          </IconButton>
          <ComposerPicker
            label="Permissions"
            hint="Applied to this task"
            value={permissionMode}
            options={PERMISSION_OPTIONS}
            onChange={onPermissionModeChange}
            kind="permission"
            align="left"
            disabled={disabled || running}
          />
        </div>
        <div className="composer-actions">
          <ComposerPicker
            label="Model"
            hint="Choose the right engine"
            value={selectedModel}
            options={modelOptions}
            onChange={onModelChange}
            kind="model"
            disabled={disabled || models.length === 0 || running}
          />
          <ComposerPicker
            label="Reasoning"
            hint="Control depth and speed"
            value={effort}
            options={effortOptions}
            onChange={onEffortChange}
            kind="reasoning"
            disabled={disabled || running}
          />
          {running && <IconButton label="Interrupt task" className="turn-button" onClick={onInterrupt}><Pause size={16} weight="fill" /></IconButton>}
          <IconButton label={running ? "Steer task" : "Send message"} className="send" onClick={submit} disabled={disabled || busy || (!text.trim() && images.length === 0)}>
            <PaperPlaneTilt size={17} weight="fill" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function EmptyConversation({ project, runtime, onOpenProject }) {
  if (!project) {
    return (
      <div className="empty-state">
        <span className="empty-mark"><FolderOpen size={25} /></span>
        <h1>Open a project</h1>
        <p>Loom groups real Codex tasks by their local working folder.</p>
        <button className="primary-button" onClick={onOpenProject}><FolderOpen size={16} />Open project</button>
      </div>
    );
  }
  return (
    <div className="empty-state">
      <span className="empty-mark"><Sparkle size={25} /></span>
      <h1>What should Codex work on?</h1>
      <p>{runtime.connected ? `Start a task in ${project.displayName}. Its conversation, plan, agents, and changes will appear here.` : "The project is ready, but the local Codex runtime is not connected yet."}</p>
    </div>
  );
}

function ConversationWorkspace({
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
  previewOpen,
  onPreviewToggle,
  previewWorkspaceId,
  browserState,
  onBrowserState,
  previewFileTabs,
  previewActiveTabId,
  onPreviewActiveTabChange,
  onPreviewFileUpdate,
  onPreviewFileClose,
  onOpenWorkspaceReference,
  composerProps
}) {
  const items = flattenItems(thread);
  const latestPlanText = [...items].reverse().find((item) => item.type === "plan")?.text;
  const agents = thread ? descendantsOf(threads, thread.id) : [];
  const touchedFiles = new Set(items.flatMap((item) => {
    if (item.type !== "fileChange") return [];
    const paths = (item.changes ?? []).map((change) => change.path || change.filePath).filter(Boolean);
    return paths.length ? paths : [item.path || item.filePath].filter(Boolean);
  })).size || changedCount;
  const scrollRef = useRef(null);
  const followLatestRef = useRef(true);
  const followedThreadRef = useRef(thread?.id);
  const liveLength = items.map((item) => (item.text?.length ?? 0) + (item.aggregatedOutput?.length ?? 0) + (Array.isArray(item.summary) ? item.summary.join("").length : 0)).join(":");
  useEffect(() => {
    if (followedThreadRef.current !== thread?.id) {
      followedThreadRef.current = thread?.id;
      followLatestRef.current = true;
    }
    const node = scrollRef.current;
    if (node && followLatestRef.current) node.scrollTop = node.scrollHeight;
  }, [thread?.id, items.length, liveLength]);

  const handleConversationScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    followLatestRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 96;
  };

  return (
    <WorkspaceOpenContext.Provider value={onOpenWorkspaceReference}>
    <div className={`task-workspace${previewOpen ? " preview-mode" : ""}`}>
      <main className="main-canvas">
        <AppToolbar
          title={thread ? threadTitle(thread) : project?.displayName ?? "Loom"}
          subtitle={thread ? project?.displayName : project?.canonicalPath}
          inspectorOpen={inspectorOpen}
          onInspectorToggle={onInspectorToggle}
          showInspector={Boolean(thread) && !previewOpen}
          previewOpen={previewOpen}
          onPreviewToggle={onPreviewToggle}
          showPreview={Boolean(project)}
        />
        <div className="conversation-scroll" ref={scrollRef} onScroll={handleConversationScroll}>
          {loading ? (
            <div className="loading-state"><SpinnerGap className="spin-icon" size={20} />Loading conversation…</div>
          ) : !thread ? (
            <EmptyConversation project={project} runtime={runtime} onOpenProject={onOpenProject} />
          ) : (
            <div className="conversation-column">
              <div className="message-stream">
                {items.length === 0 && <p className="quiet-empty">This task has no messages yet.</p>}
                {(thread.turns ?? []).map((turn) => <TurnConversation threadId={thread.id} turn={turn} seenResponseIds={seenResponseIds} key={turn.renderId ?? turn.id} />)}
              </div>
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
                />
              )}
            </div>
          )}
        </div>
        {project && <Composer {...composerProps} />}
      </main>
      {previewOpen && (
        <BrowserPanel
          api={window.loom}
          workspaceId={previewWorkspaceId}
          state={browserState}
          onState={onBrowserState}
          onClose={onPreviewToggle}
          projectId={project?.id}
          fileTabs={previewFileTabs}
          activeTabId={previewActiveTabId}
          onActiveTabChange={onPreviewActiveTabChange}
          onFileUpdate={onPreviewFileUpdate}
          onFileClose={onPreviewFileClose}
        />
      )}
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

function ApprovalCard({ request, onResolve }) {
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
          <button onClick={() => onResolve(request, "acceptForSession")}>Allow for session</button>
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
      ) : <small>This request type is not supported by this Loom version.</small>}
    </section>
  );
}

function Inspector({ open, thread, threads, plan, attention, onResolve }) {
  if (!thread) return null;
  const agents = descendantsOf(threads, thread.id);
  const agentStatusCopy = (agent) => {
    const status = threadStatus(agent);
    if (status === "running" || status === "inProgress") return "Working";
    if (status === "completed" || status === "idle") return "Completed";
    if (status === "failed" || status === "systemError") return "Failed";
    if (status === "interrupted") return "Interrupted";
    return "Waiting";
  };
  const agentDetail = (agent) => {
    if (agent.agentStatusMessage) return agent.agentStatusMessage;
    const title = threadTitle(agent);
    return title !== threadTitle(thread) ? title : "";
  };
  return (
    <aside className={`inspector ${open ? "open" : ""}`} aria-label="Task inspector">
      <div className="inspector-head"><span>Task</span><StatusDot status={threadStatus(thread)} /></div>
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
          <div className="agent-row lead"><StatusDot status={threadStatus(thread)} /><span><strong>Lead</strong><small>{threadTitle(thread)}</small></span></div>
          {agents.map((agent) => (
            <div className="agent-row child" key={agent.id}>
              <span className="branch-line" /><StatusDot status={threadStatus(agent)} />
              <span><strong>{agent.agentNickname || agent.agentRole || "Delegated agent"}</strong><small>{agentStatusCopy(agent)}{agentDetail(agent) ? ` · ${agentDetail(agent)}` : ""}</small></span>
            </div>
          ))}
          {agents.length === 0 && <p className="inspector-empty">No delegated agents yet.</p>}
        </div>
      </section>
      {attention.filter((request) => request.params?.threadId === thread.id).map((request) => <ApprovalCard request={request} onResolve={onResolve} key={request.id} />)}
    </aside>
  );
}

function FileDiff({ file }) {
  if (!file) return null;
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
        {file.rows.length ? file.rows.map((row, index) => (
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

function ReviewWorkspace({ project, review, loading, onRefresh, onExternal }) {
  const files = useMemo(() => parseDiff(review?.diff), [review?.diff]);
  const [selectedPath, setSelectedPath] = useState(null);
  useEffect(() => setSelectedPath(files[0]?.path ?? null), [review?.diff]);
  const selected = files.find((file) => file.path === selectedPath) ?? files[0];
  const dirtyCount = review?.repository?.dirtyPaths?.length ?? 0;

  return (
    <main className="main-canvas workspace">
      <AppToolbar title="Review changes" subtitle={project?.displayName} />
      <div className="workspace-header">
        <div>
          <span>Working tree</span>
          <h1>{project?.displayName ?? "Review"}</h1>
          <p>{loading ? "Refreshing Git state…" : `${dirtyCount} changed file${dirtyCount === 1 ? "" : "s"}`}</p>
        </div>
        <div>
          <button onClick={() => onExternal("terminal")}><TerminalWindow size={16} />Terminal</button>
          <button onClick={() => onExternal("editor")}><Desktop size={16} />Editor</button>
          <button onClick={() => onExternal("reveal")}><FolderOpen size={16} />Reveal</button>
          <IconButton label="Refresh review" onClick={onRefresh}><ArrowClockwise size={17} /></IconButton>
        </div>
      </div>
      {loading ? <div className="loading-state"><SpinnerGap className="spin-icon" size={20} />Reading Git changes…</div> : files.length === 0 ? (
        <div className="empty-state compact"><CheckCircle size={28} weight="fill" /><h2>Working tree is clean</h2><p>Changes made by Codex will appear here.</p></div>
      ) : (
        <div className="review-layout">
          <aside className="file-browser">
            <div className="list-label">Changed files</div>
            {files.map((file) => (
              <button key={file.path} className={file.path === selected?.path ? "selected" : ""} onClick={() => setSelectedPath(file.path)}>
                <File size={16} /><span><strong>{file.path.split("/").pop()}</strong><small>{file.path.split("/").slice(0, -1).join("/")}</small></span><b>+{file.plus}</b><em>−{file.minus}</em>
              </button>
            ))}
          </aside>
          <section className="diff-panel">
            <FileDiff file={selected} />
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

function SettingsRow({ title, description, children }) {
  return (
    <div className="preference-row">
      <span><strong>{title}</strong><small>{description}</small></span>
      <div className="preference-control">{children}</div>
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
        <div className="segmented">{Object.keys(groups).map((name) => <button key={name} className={tab === name ? "selected" : ""} onClick={() => setTab(name)}>{name === "mcp" ? "MCP servers" : name[0].toUpperCase() + name.slice(1)}</button>)}</div>
        <IconButton label="Refresh capabilities" onClick={onRefresh}><ArrowClockwise size={17} /></IconButton>
      </div>
      <label className="search-field"><MagnifyingGlass size={17} /><input aria-label="Search capabilities" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${tab === "mcp" ? "MCP servers" : tab}`} /></label>
      {loading ? <div className="loading-state inline"><SpinnerGap className="spin-icon" size={18} />Loading capabilities…</div> : (
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

const SETTINGS_PAGES = [
  { id: "general", label: "General", description: "Task defaults and safety", icon: Gear, keywords: "permissions model reasoning delete drafts" },
  { id: "orchestration", label: "Orchestration", description: "How delegated work surfaces", icon: TreeStructure, keywords: "agents progress task map approvals" },
  { id: "appearance", label: "Appearance", description: "Density, hints, and motion", icon: Eye, keywords: "compact comfortable shortcuts animation" },
  { id: "updates", label: "Updates", description: "Version and GitHub releases", icon: ArrowClockwise, keywords: "version release download install github update" },
  { id: "runtime", label: "Runtime", description: "Codex connection and context", icon: Gauge, keywords: "status models project connected" },
  { id: "capabilities", label: "Capabilities", description: "Skills, apps, and MCP", icon: PlugsConnected, keywords: "extensions plugins tools servers" },
  { id: "shortcuts", label: "Shortcuts", description: "Fast paths through Loom", icon: Code, keywords: "keyboard new task settings" }
];

function SettingsSidebar({ page, onPageChange, onBack }) {
  const [query, setQuery] = useState("");
  const visiblePages = SETTINGS_PAGES.filter((candidate) => `${candidate.label} ${candidate.description} ${candidate.keywords}`.toLowerCase().includes(query.trim().toLowerCase()));

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
      {visiblePages.length === 0 && <p className="settings-nav-empty">No matching settings.</p>}
    </aside>
  );
}

function SettingsWorkspace({
  page,
  runtime,
  project,
  models,
  selectedModel,
  onModelChange,
  effort,
  onEffortChange,
  permissionMode,
  onPermissionModeChange,
  preferences,
  onPreferenceChange,
  extensions,
  extensionsLoading,
  onRefreshCapabilities,
  onRefreshModels,
  updateStatus,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate
}) {
  const selectedPage = SETTINGS_PAGES.find((candidate) => candidate.id === page) ?? SETTINGS_PAGES[0];
  const selectedModelInfo = models.find((model) => model.model === selectedModel);
  const effortOptions = selectedModelInfo?.supportedReasoningEfforts?.map((option) => option.reasoningEffort ?? option.effort ?? option) ?? ["medium", "high"];
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const capabilityCount = extensions.apps.length + extensions.mcp.length + extensions.skills.reduce((count, entry) => count + (entry.skills?.length ?? 0), 0);

  let pageContent;
  if (page === "general") {
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
        </SettingsGroup>
        <SettingsGroup title="Safety and continuity">
          <SettingsRow title="Confirm before deleting tasks" description="Ask before removing a conversation from the task list.">
            <SettingsToggle label="Confirm before deleting tasks" checked={preferences.confirmBeforeDelete} onChange={(value) => onPreferenceChange("confirmBeforeDelete", value)} />
          </SettingsRow>
          <SettingsRow title="Keep message drafts" description="Restore unsent text when you move between tasks.">
            <SettingsToggle label="Keep message drafts" checked={preferences.preserveDrafts} onChange={(value) => onPreferenceChange("preserveDrafts", value)} />
          </SettingsRow>
        </SettingsGroup>
      </>
    );
  } else if (page === "orchestration") {
    pageContent = (
      <SettingsGroup title="Live orchestration" description="Decide how Loom reveals parallel work and decisions.">
        <SettingsRow title="Show task progress" description="Keep live plans, completion, agents, and touched files in the conversation.">
          <SettingsToggle label="Show task progress" checked={preferences.showTaskProgress} onChange={(value) => onPreferenceChange("showTaskProgress", value)} />
        </SettingsRow>
        <SettingsRow title="Open task map when agents join" description="Reveal the inspector when a task delegates work to another agent.">
          <SettingsToggle label="Open task map when agents join" checked={preferences.autoOpenTaskMap} onChange={(value) => onPreferenceChange("autoOpenTaskMap", value)} />
        </SettingsRow>
        <SettingsRow title="Bring approvals forward" description="Open Attention automatically when an active task needs your decision.">
          <SettingsToggle label="Bring approvals forward" checked={preferences.bringApprovalsForward} onChange={(value) => onPreferenceChange("bringApprovalsForward", value)} />
        </SettingsRow>
      </SettingsGroup>
    );
  } else if (page === "appearance") {
    pageContent = (
      <SettingsGroup title="Interface" description="Tune the shell without changing Loom's native character.">
        <SettingsRow title="Interface density" description="Choose tighter or roomier navigation and setting rows.">
          <select className="settings-select" aria-label="Interface density" value={preferences.density} onChange={(event) => onPreferenceChange("density", event.target.value)}>
            <option value="compact">Compact</option>
            <option value="comfortable">Comfortable</option>
          </select>
        </SettingsRow>
        <SettingsRow title="Show shortcut hints" description="Display available keyboard shortcuts beside navigation actions.">
          <SettingsToggle label="Show shortcut hints" checked={preferences.showShortcutHints} onChange={(value) => onPreferenceChange("showShortcutHints", value)} />
        </SettingsRow>
        <SettingsRow title="Reduce motion" description="Minimize panel, progress, and loading animations.">
          <SettingsToggle label="Reduce motion" checked={preferences.reduceMotion} onChange={(value) => onPreferenceChange("reduceMotion", value)} />
        </SettingsRow>
      </SettingsGroup>
    );
  } else if (page === "updates") {
    const updateBusy = updateStatus.state === "checking" || updateStatus.state === "downloading";
    const action = updateStatus.state === "available"
      ? { label: `Download ${updateStatus.availableVersion}`, run: onDownloadUpdate }
      : updateStatus.state === "downloaded"
        ? { label: "Restart and install", run: onInstallUpdate, primary: true }
        : { label: updateStatus.state === "error" ? "Try again" : updateStatus.state === "not-available" ? "Check again" : "Check for updates", run: onCheckForUpdates };
    pageContent = (
      <>
        <SettingsGroup title="Loom updates" description="Packaged releases are downloaded directly from the official GitHub repository.">
          <SettingsRow title="Current version" description={`Loom ${updateStatus.currentVersion}`}>
            <span className="settings-value">{updateStatus.supported ? "Release build" : "Development build"}</span>
          </SettingsRow>
          <SettingsRow title={updateStatus.state === "downloaded" ? "Ready to install" : "Update status"} description={updateStatus.message}>
            <button className={`settings-action${action.primary ? " primary" : ""}`} disabled={!updateStatus.supported || updateBusy} onClick={action.run}>
              {updateBusy && <SpinnerGap className="spin-icon" size={14} />}{updateStatus.state === "downloading" ? `${Math.round(updateStatus.percent)}%` : action.label}
            </button>
          </SettingsRow>
          {updateStatus.state === "downloading" && (
            <div className="update-progress" role="progressbar" aria-label="Update download" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(updateStatus.percent)}>
              <span style={{ width: `${Math.max(0, Math.min(100, updateStatus.percent))}%` }} />
            </div>
          )}
        </SettingsGroup>
        <p className="settings-footnote">Loom checks for updates in the background. Downloads and restarts remain under your control.</p>
      </>
    );
  } else if (page === "runtime") {
    pageContent = (
      <>
        <SettingsGroup title="Codex runtime" description="Live status from the desktop bridge.">
          <SettingsRow title="Connection" description={runtime.connected ? runtime.userAgent || "Local Codex runtime" : "The runtime is not currently available."}>
            <span className={`settings-status ${runtime.connected ? "ready" : "offline"}`}><i />{runtime.connected ? "Connected" : "Offline"}</span>
          </SettingsRow>
          <SettingsRow title="Available models" description={`${models.length} model${models.length === 1 ? "" : "s"} reported by Codex.`}>
            <button className="settings-action" onClick={onRefreshModels}><ArrowClockwise size={15} />Refresh</button>
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup title="Current context">
          <SettingsRow title="Project" description={project?.canonicalPath ?? "Open a project to provide working context."}><span className="settings-value">{project?.displayName ?? "None"}</span></SettingsRow>
          <SettingsRow title="Capabilities" description="Skills, apps, and MCP servers currently loaded."><span className="settings-value">{capabilityCount}</span></SettingsRow>
        </SettingsGroup>
      </>
    );
  } else if (page === "capabilities") {
    pageContent = <CapabilitiesSettings extensions={extensions} loading={extensionsLoading} onRefresh={onRefreshCapabilities} />;
  } else {
    pageContent = (
      <SettingsGroup title="App shortcuts" description="These shortcuts are available anywhere in Loom.">
        <SettingsRow title="New task" description="Start a blank task in the selected project."><kbd className="settings-shortcut">{isMac ? "⌘ N" : "Ctrl N"}</kbd></SettingsRow>
        <SettingsRow title="Open settings" description="Jump directly to this settings workspace."><kbd className="settings-shortcut">{isMac ? "⌘ ," : "Ctrl ,"}</kbd></SettingsRow>
      </SettingsGroup>
    );
  }

  return (
    <main className="main-canvas workspace settings-workspace">
      <div className="settings-content-scroll">
        <div className="settings-content">
          <header className="settings-page-title"><span>Settings</span><h1>{selectedPage.label}</h1><p>{selectedPage.description}</p></header>
          {pageContent}
        </div>
      </div>
    </main>
  );
}

function AttentionWorkspace({ attention, onResolve }) {
  return (
    <main className="main-canvas workspace">
      <AppToolbar title="Attention" subtitle={`${attention.length} pending`} />
      <div className="attention-column">
        <div className="settings-title"><span>Attention</span><h1>Decisions waiting on you</h1><p>Approval requests from every active Loom task appear here.</p></div>
        {attention.length === 0 ? <div className="empty-state compact"><CheckCircle size={28} weight="fill" /><h2>Nothing needs attention</h2><p>Active tasks can continue without input.</p></div> : attention.map((request) => <ApprovalCard request={request} onResolve={onResolve} key={request.id} />)}
      </div>
    </main>
  );
}

export function App() {
  const api = window.loom;
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const selectedProjectIdRef = useRef(null);
  const [threads, setThreads] = useState([]);
  const [selectedThreadId, setSelectedThreadId] = useState(null);
  const selectedThreadIdRef = useRef(null);
  const optimisticThreadsRef = useRef(new Map());
  const threadLoadRequestRef = useRef(0);
  const threadsLoadRequestRef = useRef(0);
  const reviewLoadRequestRef = useRef(0);
  const extensionsLoadRequestRef = useRef(0);
  const submittingRef = useRef(false);
  const seenResponseIdsRef = useRef(new Set());
  const [thread, setThread] = useState(null);
  const [plan, setPlan] = useState([]);
  const [attention, setAttention] = useState([]);
  const [review, setReview] = useState({ repository: null, diff: "" });
  const [extensions, setExtensions] = useState(EMPTY_EXTENSIONS);
  const [models, setModels] = useState([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [defaultEffort, setDefaultEffort] = useState("");
  const [effort, setEffort] = useState("");
  const [defaultPermissionMode, setDefaultPermissionMode] = useState(() => {
    const saved = localStorage.getItem("loom.permissionMode");
    return PERMISSION_OPTIONS.some((option) => option.value === saved) ? saved : "workspace-write";
  });
  const [permissionMode, setPermissionMode] = useState(defaultPermissionMode);
  const [preferences, setPreferences] = useState(loadPreferences);
  const preferencesRef = useRef(preferences);
  const [runtime, setRuntime] = useState({ state: "starting", connected: false });
  const [activeView, setActiveView] = useState("task");
  const [settingsPage, setSettingsPage] = useState("general");
  const [viewTransitionPending, setViewTransitionPending] = useState(false);
  const viewTransitionPendingRef = useRef(false);
  const viewCurtainRef = useRef(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [previewWorkspaces, setPreviewWorkspaces] = useState({});
  const [updateStatus, setUpdateStatus] = useState(EMPTY_UPDATE_STATUS);
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number.parseInt(localStorage.getItem("loom.sidebarWidth") ?? "", 10);
    return Number.isFinite(saved) && saved !== 296 ? clampSidebarWidth(saved) : DEFAULT_SIDEBAR_WIDTH;
  });
  const [draftMode, setDraftMode] = useState(false);
  const draftModeRef = useRef(false);
  const [loading, setLoading] = useState({ app: true, threads: false, thread: false, review: false, extensions: false });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const previewWorkspaceId = selectedThreadId ?? (selectedProjectId ? `draft:${selectedProjectId}` : null);
  const previewWorkspace = previewWorkspaces[previewWorkspaceId] ?? EMPTY_PREVIEW_WORKSPACE;
  const previewOpen = previewWorkspace.open;
  const browserState = previewWorkspace.browserState;
  const previewFileTabs = previewWorkspace.fileTabs;
  const previewActiveTabId = previewWorkspace.activeTabId;
  const updatePreviewWorkspace = useCallback((workspaceId, updater) => {
    if (!workspaceId) return;
    setPreviewWorkspaces((current) => {
      const workspace = current[workspaceId] ?? EMPTY_PREVIEW_WORKSPACE;
      const next = typeof updater === "function" ? updater(workspace) : updater;
      return { ...current, [workspaceId]: next };
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
  const setPreviewActiveTabId = useCallback((value) => {
    updatePreviewWorkspace(previewWorkspaceId, (workspace) => ({
      ...workspace,
      activeTabId: typeof value === "function" ? value(workspace.activeTabId) : value
    }));
  }, [previewWorkspaceId, updatePreviewWorkspace]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const activeTurn = [...(thread?.turns ?? [])].reverse().find((turn) => turnIsRunning(turn.status));
  const rootThreads = threads
    .filter((candidate) => !candidate.parentThreadId)
    .map((candidate) => candidate.id === thread?.id
      ? { ...candidate, status: { type: activeTurn ? "active" : "idle", activeFlags: [] } }
      : candidate);
  const changedCount = review.repository?.dirtyPaths?.length ?? 0;

  const normalizePlan = useCallback((steps) => (steps ?? []).map((step) => ({
    ...step,
    status: step.status === "in_progress" ? "inProgress" : step.status
  })), []);

  useEffect(() => {
    draftModeRef.current = draftMode;
  }, [draftMode]);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  useEffect(() => {
    preferencesRef.current = preferences;
    localStorage.setItem("loom.preferences", JSON.stringify(preferences));
  }, [preferences]);

  const changePreference = useCallback((key, value) => {
    setPreferences((current) => ({ ...current, [key]: value }));
  }, []);

  const changeView = useCallback(async (nextView) => {
    if (nextView === activeView || viewTransitionPendingRef.current) return;
    if (nextView !== "task") setPreviewOpen(false);
    const crossesSettingsBoundary = activeView === "settings" || nextView === "settings";
    const curtain = viewCurtainRef.current;
    const reduceMotion = preferencesRef.current.reduceMotion || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!crossesSettingsBoundary || !curtain?.animate || reduceMotion) {
      setActiveView(nextView);
      return;
    }

    const enteringSettings = nextView === "settings";
    const start = enteringSettings ? "translate3d(110%, 0, 0)" : "translate3d(-110%, 0, 0)";
    const end = enteringSettings ? "translate3d(-110%, 0, 0)" : "translate3d(110%, 0, 0)";
    viewTransitionPendingRef.current = true;
    setViewTransitionPending(true);
    curtain.hidden = false;
    try {
      await curtain.animate(
        [{ transform: start }, { transform: "translate3d(0, 0, 0)" }],
        { duration: 180, easing: "cubic-bezier(.55, 0, .25, 1)", fill: "forwards" }
      ).finished;
      setActiveView(nextView);
      await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
      await curtain.animate(
        [{ transform: "translate3d(0, 0, 0)" }, { transform: end }],
        { duration: 240, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "forwards" }
      ).finished;
    } finally {
      curtain.getAnimations().forEach((animation) => animation.cancel());
      curtain.hidden = true;
      viewTransitionPendingRef.current = false;
      setViewTransitionPending(false);
    }
  }, [activeView, setPreviewOpen]);

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
      setThreads(next);
      const roots = next.filter((candidate) => !candidate.parentThreadId);
      setSelectedThreadId((current) => {
        const selected = current && roots.some((candidate) => candidate.id === current)
          ? current
          : draftModeRef.current ? null : roots[0]?.id ?? null;
        selectedThreadIdRef.current = selected;
        return selected;
      });
    } catch (cause) {
      if (requestId !== threadsLoadRequestRef.current || selectedProjectIdRef.current !== projectId) return;
      setError(cause.message);
      setThreads([]);
    } finally {
      if (requestId === threadsLoadRequestRef.current) setLoading((state) => ({ ...state, threads: false }));
    }
  }, [api]);

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

  const refreshThread = useCallback(async (projectId, threadId) => {
    if (!api || !projectId || !threadId) return;
    try {
      const response = await api.threads.read({ projectId, threadId });
      if (selectedProjectIdRef.current === projectId && selectedThreadIdRef.current === threadId) {
        if (Array.isArray(response.plan)) setPlan(normalizePlan(response.plan));
        if (response.thread?.name) {
          setThreads((current) => current.map((candidate) => candidate.id === threadId ? { ...candidate, name: response.thread.name } : candidate));
        }
        setThread((current) => {
          const merged = mergeThreadSnapshot(current, response.thread);
          return threadRevision(merged) === threadRevision(current) ? current : merged;
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
        incoming.forEach((candidate) => {
          const existing = byId.get(candidate.id);
          byId.set(candidate.id, {
            ...existing,
            ...candidate,
            preview: existing?.liveProjection && existing.preview ? existing.preview : candidate.preview,
            liveProjection: existing?.liveProjection ?? false
          });
        });
        return [...byId.values()];
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
      setReview(result);
      setProjects((current) => current.map((project) => project.id === projectId ? { ...project, repository: result.repository } : project));
    } catch (cause) {
      if (requestId !== reviewLoadRequestRef.current || selectedProjectIdRef.current !== projectId) return;
      setError(cause.message);
      setReview({ repository: null, diff: "" });
    } finally {
      if (requestId === reviewLoadRequestRef.current) setLoading((state) => ({ ...state, review: false }));
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

  useEffect(() => {
    if (!api) {
      setRuntime({ state: "unavailable", connected: false });
      setError("Loom’s desktop bridge is unavailable. Run the Electron app to connect projects and Codex.");
      setLoading((state) => ({ ...state, app: false }));
      return;
    }
    let cancelled = false;
    api.app.bootstrap().then((result) => {
      if (cancelled) return;
      setProjects(result.projects ?? []);
      setModels(result.models ?? []);
      setRuntime(result.runtime ?? { state: "unavailable", connected: false });
      const saved = localStorage.getItem("loom.activeProjectId");
      const selected = result.projects?.find((project) => project.id === saved)?.id ?? result.projects?.[0]?.id ?? null;
      setSelectedProjectId(selected);
    }).catch((cause) => setError(cause.message)).finally(() => {
      if (!cancelled) setLoading((state) => ({ ...state, app: false }));
    });
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    if (!api?.browser || !previewWorkspaceId) return;
    let cancelled = false;
    api.browser.state({ workspaceId: previewWorkspaceId }).then((state) => {
      if (!cancelled) {
        updatePreviewWorkspace(previewWorkspaceId, (workspace) => ({
          ...workspace,
          browserState: state,
          activeTabId: workspace.activeTabId ?? state.activeTabId ?? null
        }));
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [api, previewWorkspaceId, updatePreviewWorkspace]);

  useEffect(() => {
    if (!api?.updates) return;
    let cancelled = false;
    api.updates.status().then((status) => {
      if (!cancelled) setUpdateStatus(status);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    if (!models.length) return;
    const saved = localStorage.getItem("loom.model");
    const model = models.find((candidate) => candidate.model === saved) ?? models.find((candidate) => candidate.isDefault) ?? models[0];
    const nextDefaultEffort = storedReasoningEffort(model);
    setDefaultModel((current) => current || model.model);
    setDefaultEffort((current) => current || nextDefaultEffort);
    if (!selectedModel) {
      const savedThread = loadThreadConfiguration(selectedThreadIdRef.current);
      const selectedThreadModel = models.find((candidate) => candidate.model === savedThread?.model) ?? model;
      setSelectedModel(selectedThreadModel.model);
      setEffort(resolveReasoningEffort(savedThread?.effort, selectedThreadModel, nextDefaultEffort));
      setPermissionMode(PERMISSION_OPTIONS.some((option) => option.value === savedThread?.permissionMode) ? savedThread.permissionMode : defaultPermissionMode);
    }
  }, [defaultPermissionMode, models, selectedModel]);

  useEffect(() => {
    if (!models.length || !defaultModel || !defaultEffort || draftMode) return;
    const savedThread = loadThreadConfiguration(selectedThreadId);
    const model = models.find((candidate) => candidate.model === savedThread?.model)
      ?? models.find((candidate) => candidate.model === defaultModel)
      ?? models[0];
    setSelectedModel(model.model);
    setEffort(resolveReasoningEffort(savedThread?.effort, model, defaultEffort));
    setPermissionMode(PERMISSION_OPTIONS.some((option) => option.value === savedThread?.permissionMode)
      ? savedThread.permissionMode
      : defaultPermissionMode);
  }, [defaultEffort, defaultModel, defaultPermissionMode, draftMode, models, selectedThreadId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setThreads([]);
      selectedThreadIdRef.current = null;
      setSelectedThreadId(null);
      setThread(null);
      setReview({ repository: null, diff: "" });
      return;
    }
    localStorage.setItem("loom.activeProjectId", selectedProjectId);
    loadThreads(selectedProjectId);
    loadReview(selectedProjectId);
  }, [selectedProjectId, loadReview, loadThreads]);

  useEffect(() => {
    setPlan([]);
    if (!selectedProjectId || !selectedThreadId) {
      threadLoadRequestRef.current += 1;
      setThread(null);
      setLoading((state) => ({ ...state, thread: false }));
      return;
    }
    if (optimisticThreadsRef.current.has(selectedThreadId)) {
      optimisticThreadsRef.current.delete(selectedThreadId);
      threadLoadRequestRef.current += 1;
      setLoading((state) => ({ ...state, thread: false }));
      return;
    }
    loadThread(selectedProjectId, selectedThreadId);
  }, [selectedProjectId, selectedThreadId, loadThread]);

  useEffect(() => {
    if (!api || !selectedProjectId || !selectedThreadId || !activeTurn) return undefined;
    let cancelled = false;
    let timer;
    const refresh = async () => {
      try {
        await refreshThread(selectedProjectId, selectedThreadId);
      } catch {
        // Live notifications remain the primary path; polling is only a quiet fallback.
      }
      if (!cancelled) timer = window.setTimeout(refresh, 1500);
    };
    timer = window.setTimeout(refresh, 1500);
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
      if (!cancelled) timer = window.setTimeout(refresh, 1200);
    };
    refresh();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, activeView, loadAgents, selectedProjectId, selectedThreadId]);

  useEffect(() => {
    if (activeView === "settings") loadExtensions();
    if (activeView === "review" && selectedProjectId) loadReview(selectedProjectId);
  }, [activeView, loadExtensions, loadReview, selectedProjectId]);

  useEffect(() => {
    if (!api) return;
    return api.events.subscribe((event) => {
      if (event.type === "RuntimeStatus") {
        setRuntime(event.payload);
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
      if (event.type === "AttentionRequired") {
        setAttention((current) => current.some((request) => request.id === event.payload.id) ? current : [...current, event.payload]);
        if (preferencesRef.current.bringApprovalsForward) setActiveView("attention");
        return;
      }
      if (event.type === "AttentionReset") {
        setAttention([]);
        return;
      }
      if (event.type === "BrowserState") {
        const workspaceId = event.payload.workspaceId;
        updatePreviewWorkspace(workspaceId, (workspace) => ({
          ...workspace,
          browserState: event.payload,
          activeTabId: workspace.activeTabId?.startsWith("file:") ? workspace.activeTabId : event.payload.activeTabId ?? workspace.activeTabId
        }));
        return;
      }
      if (event.type === "BrowserOpenRequested") {
        const workspaceId = event.payload.workspaceId ?? event.payload.threadId;
        updatePreviewWorkspace(workspaceId, (workspace) => ({ ...workspace, open: true, activeTabId: null }));
        if (workspaceId === selectedThreadIdRef.current) {
          setInspectorOpen(false);
          setActiveView("task");
        }
        return;
      }
      if (event.type === "UpdateState") {
        setUpdateStatus(event.payload);
        return;
      }

      const payload = event.payload ?? {};
      if (payload.projectId && payload.projectId !== selectedProjectId) return;
      if (payload.method === "thread/status/changed") {
        setThreads((current) => current.map((candidate) => candidate.id === payload.threadId ? { ...candidate, status: payload.status } : candidate));
      }
      if (payload.method === "thread/name/updated") {
        setThreads((current) => current.map((candidate) => candidate.id === payload.threadId ? { ...candidate, name: payload.name } : candidate));
        if (payload.threadId === selectedThreadIdRef.current) {
          setThread((current) => current?.id === payload.threadId ? { ...current, name: payload.name } : current);
        }
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
        const optimisticThread = optimisticThreadsRef.current.get(payload.threadId);
        setThread((current) => applyRuntimePayload(current ?? optimisticThread, payload));
        if (payload.method === "turn/started") setPlan([]);
        if (payload.method === "turn/plan/updated") setPlan(normalizePlan(payload.plan));
        if (payload.method === "turn/completed" && selectedProjectId) {
          loadReview(selectedProjectId);
          window.setTimeout(() => refreshThread(selectedProjectId, payload.threadId), 100);
          window.setTimeout(() => refreshThread(selectedProjectId, payload.threadId), 600);
        }
      }
    });
  }, [api, loadAgents, loadModels, loadReview, loadThreads, normalizePlan, refreshThread, selectedProjectId, updatePreviewWorkspace]);

  const openProject = async () => {
    if (!api) return;
    try {
      const project = await api.projects.open();
      if (!project) return;
      setProjects((current) => [project, ...current.filter((candidate) => candidate.id !== project.id)]);
      setDraftMode(false);
      selectedProjectIdRef.current = project.id;
      setSelectedProjectId(project.id);
      setActiveView("task");
    } catch (cause) {
      setError(cause.message);
    }
  };

  const selectProject = (projectId) => {
    setDraftMode(false);
    selectedProjectIdRef.current = projectId;
    selectedThreadIdRef.current = null;
    setSelectedThreadId(null);
    setSelectedProjectId(projectId);
    setActiveView("task");
  };

  const selectThread = (threadId) => {
    setDraftMode(false);
    selectedThreadIdRef.current = threadId;
    setSelectedThreadId(threadId);
    setActiveView("task");
  };

  const newTask = () => {
    if (!selectedProjectId) return;
    setDraftMode(true);
    setSelectedModel(defaultModel);
    setEffort(defaultEffort);
    setPermissionMode(defaultPermissionMode);
    selectedThreadIdRef.current = null;
    setSelectedThreadId(null);
    setThread(null);
    setPlan([]);
    setActiveView("task");
  };

  const deleteThread = async (threadId) => {
    if (!api || !selectedProjectId) return;
    const projectId = selectedProjectId;
    const target = threads.find((candidate) => candidate.id === threadId);
    const title = threadTitle(target);
    if (preferences.confirmBeforeDelete && !window.confirm(`Delete “${title}”?\n\nThis removes the conversation from Loom’s task list.`)) return;
    try {
      await api.threads.archive({ projectId, threadId });
      localStorage.removeItem(threadConfigurationKey(threadId));
      setPreviewWorkspaces((current) => {
        if (!current[threadId]) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      if (selectedProjectIdRef.current !== projectId) return;
      const remaining = threads.filter((candidate) => candidate.id !== threadId);
      setThreads((current) => current.filter((candidate) => candidate.id !== threadId));
      if (selectedThreadIdRef.current === threadId) {
        const next = remaining.find((candidate) => !candidate.parentThreadId) ?? null;
        selectedThreadIdRef.current = next?.id ?? null;
        setSelectedThreadId(next?.id ?? null);
        setThread(null);
        setPlan([]);
        setDraftMode(!next);
      }
      setError(null);
    } catch (cause) {
      setError(cause.message);
    }
  };

  const changeDefaultModel = (modelName) => {
    setDefaultModel(modelName);
    localStorage.setItem("loom.model", modelName);
    const model = models.find((candidate) => candidate.model === modelName);
    const nextEffort = resolveReasoningEffort(defaultEffort, model, storedReasoningEffort(model));
    setDefaultEffort(nextEffort);
    localStorage.setItem("loom.effort", nextEffort);
  };

  const changeThreadModel = (modelName) => {
    setSelectedModel(modelName);
    const model = models.find((candidate) => candidate.model === modelName);
    const nextEffort = resolveReasoningEffort(effort, model, defaultEffort);
    setEffort(nextEffort);
    saveThreadConfiguration(selectedThreadId, { model: modelName, effort: nextEffort, permissionMode });
  };

  const changeDefaultEffort = (nextEffort) => {
    setDefaultEffort(nextEffort);
    localStorage.setItem("loom.effort", nextEffort);
  };

  const changeThreadEffort = (nextEffort) => {
    setEffort(nextEffort);
    saveThreadConfiguration(selectedThreadId, { model: selectedModel, effort: nextEffort, permissionMode });
  };

  const changeDefaultPermissionMode = (mode) => {
    setDefaultPermissionMode(mode);
    localStorage.setItem("loom.permissionMode", mode);
  };

  const changeThreadPermissionMode = (mode) => {
    setPermissionMode(mode);
    saveThreadConfiguration(selectedThreadId, { model: selectedModel, effort, permissionMode: mode });
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
    if (!api?.browser) return;
    try {
      const current = await api.browser.state({ workspaceId: previewWorkspaceId });
      const next = current.tabs?.length ? current : await api.browser.create({ workspaceId: previewWorkspaceId });
      setBrowserState(next);
      setPreviewActiveTabId(next.activeTabId ?? null);
    } catch (cause) {
      setError(cause.message);
    }
  }, [api, previewActiveTabId, previewOpen, previewWorkspaceId, setBrowserState, setPreviewActiveTabId, setPreviewOpen]);

  const updatePreviewFile = useCallback((tabId, patch) => {
    setPreviewFileTabs((current) => current.map((tab) => tab.id === tabId ? { ...tab, ...patch } : tab));
  }, [setPreviewFileTabs]);

  const closePreviewFile = useCallback((tabId) => {
    const target = previewFileTabs.find((tab) => tab.id === tabId);
    if (target?.dirty && !window.confirm(`Close “${target.name}” without saving your changes?`)) return;
    const remaining = previewFileTabs.filter((tab) => tab.id !== tabId);
    setPreviewFileTabs(remaining);
    if (previewActiveTabId === tabId) setPreviewActiveTabId(remaining.at(-1)?.id ?? browserState.activeTabId ?? null);
  }, [browserState.activeTabId, previewActiveTabId, previewFileTabs, setPreviewActiveTabId, setPreviewFileTabs]);

  const openWorkspaceReference = useCallback(async (target) => {
    if (!api || !selectedProjectId || !previewWorkspaceId) return;
    setInspectorOpen(false);
    setActiveView("task");
    setPreviewOpen(true);
    try {
      if (/^https?:\/\//i.test(target)) {
        const next = await api.browser.create({ workspaceId: previewWorkspaceId, url: target });
        setBrowserState(next);
        setPreviewActiveTabId(next.activeTabId ?? null);
        return;
      }
      const file = await api.files.read({ projectId: selectedProjectId, path: target });
      const tab = fileTabFromPayload(file);
      setPreviewFileTabs((current) => current.some((candidate) => candidate.id === tab.id) ? current : [...current, tab]);
      setPreviewActiveTabId(tab.id);
    } catch (cause) {
      setError(cause.message);
    }
  }, [api, previewWorkspaceId, selectedProjectId, setBrowserState, setPreviewActiveTabId, setPreviewFileTabs, setPreviewOpen]);

  const runUpdateAction = useCallback(async (action) => {
    if (!api?.updates) return;
    try {
      const status = await api.updates[action]();
      if (status?.state) setUpdateStatus(status);
    } catch (cause) {
      setUpdateStatus((current) => ({ ...current, state: "error", message: cause.message }));
    }
  }, [api]);

  const submit = async (text, images = []) => {
    if (!api || !selectedProjectId || !runtime.connected || submittingRef.current) return false;
    const projectId = selectedProjectId;
    const startingThreadId = selectedThreadId;
    submittingRef.current = true;
    setSubmitting(true);
    let optimisticThreadId = null;
    try {
      let targetThreadId = startingThreadId;
      if (!targetThreadId) {
        const created = await api.threads.create({ projectId, model: selectedModel || undefined, permissionMode });
        targetThreadId = created.thread.id;
        const draftWorkspaceId = `draft:${projectId}`;
        await api.browser?.adopt({ fromWorkspaceId: draftWorkspaceId, toWorkspaceId: targetThreadId });
        setPreviewWorkspaces((current) => {
          const draftWorkspace = current[draftWorkspaceId];
          if (!draftWorkspace) return current;
          const next = { ...current, [targetThreadId]: draftWorkspace };
          delete next[draftWorkspaceId];
          return next;
        });
        saveThreadConfiguration(targetThreadId, { model: selectedModel, effort, permissionMode });
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
        await api.turns.steer({ projectId, threadId: targetThreadId, turnId: activeTurn.id, text, images });
        if (selectedProjectIdRef.current === projectId && selectedThreadIdRef.current === targetThreadId) {
          window.setTimeout(() => refreshThread(projectId, targetThreadId), 250);
        }
      } else {
        const response = await api.turns.start({
          projectId,
          threadId: targetThreadId,
          text,
          images,
          model: selectedModel || undefined,
          effort,
          permissionMode
        });
        if (selectedProjectIdRef.current === projectId && selectedThreadIdRef.current === targetThreadId) {
          setThread((current) => current
            ? applyRuntimePayload(current, { method: "turn/started", threadId: targetThreadId, turn: response.turn })
            : current);
          window.setTimeout(() => refreshThread(projectId, targetThreadId), 250);
          window.setTimeout(() => refreshThread(projectId, targetThreadId), 900);
        }
      }
      setError(null);
      return true;
    } catch (cause) {
      if (optimisticThreadId) optimisticThreadsRef.current.delete(optimisticThreadId);
      setError(cause.message);
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
      if (request.method?.includes("requestUserInput")) await api.requests.respond({ requestId: request.id, answers: decision });
      else if (request.method?.toLowerCase().includes("elicitation")) await api.elicitations.respond({ requestId: request.id, ...decision });
      else await api.approvals.resolve({ requestId: request.id, decision });
      setAttention((current) => current.filter((candidate) => candidate.id !== request.id));
    } catch (cause) {
      setError(cause.message);
    }
  };

  const openExternal = async (kind) => {
    if (!api || !selectedProjectId) return;
    try {
      if (kind === "terminal") await api.external.openTerminal({ projectId: selectedProjectId });
      if (kind === "editor") await api.external.openEditor({ projectId: selectedProjectId });
      if (kind === "reveal") await api.external.reveal({ projectId: selectedProjectId });
    } catch (cause) {
      setError(cause.message);
    }
  };

  const composerProps = {
    disabled: !runtime.connected || !selectedProject,
    busy: submitting,
    draftKey: `${selectedProjectId ?? "none"}:${selectedThreadId ?? "new"}`,
    preserveDrafts: preferences.preserveDrafts,
    running: Boolean(activeTurn),
    models,
    selectedModel,
    onModelChange: changeThreadModel,
    effort,
    onEffortChange: changeThreadEffort,
    permissionMode,
    onPermissionModeChange: changeThreadPermissionMode,
    onSubmit: submit,
    onInterrupt: interrupt
  };

  let content;
  if (activeView === "review") {
    content = <ReviewWorkspace project={selectedProject} review={review} loading={loading.review} onRefresh={() => loadReview(selectedProjectId)} onExternal={openExternal} />;
  } else if (activeView === "settings") {
    content = (
      <SettingsWorkspace
        page={settingsPage}
        runtime={runtime}
        project={selectedProject}
        models={models}
        selectedModel={defaultModel}
        onModelChange={changeDefaultModel}
        effort={defaultEffort}
        onEffortChange={changeDefaultEffort}
        permissionMode={defaultPermissionMode}
        onPermissionModeChange={changeDefaultPermissionMode}
        preferences={preferences}
        onPreferenceChange={changePreference}
        extensions={extensions}
        extensionsLoading={loading.extensions}
        onRefreshCapabilities={loadExtensions}
        onRefreshModels={() => loadModels().catch((cause) => setError(cause.message))}
        updateStatus={updateStatus}
        onCheckForUpdates={() => runUpdateAction("check")}
        onDownloadUpdate={() => runUpdateAction("download")}
        onInstallUpdate={() => runUpdateAction("install")}
      />
    );
  } else if (activeView === "attention") {
    content = <AttentionWorkspace attention={attention} onResolve={resolveAttention} />;
  } else {
    content = (
      <ConversationWorkspace
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
        previewOpen={previewOpen}
        onPreviewToggle={togglePreview}
        previewWorkspaceId={previewWorkspaceId}
        browserState={browserState}
        onBrowserState={setBrowserState}
        previewFileTabs={previewFileTabs}
        previewActiveTabId={previewActiveTabId}
        onPreviewActiveTabChange={setPreviewActiveTabId}
        onPreviewFileUpdate={updatePreviewFile}
        onPreviewFileClose={closePreviewFile}
        onOpenWorkspaceReference={openWorkspaceReference}
        composerProps={composerProps}
      />
    );
  }

  return (
    <div className="loom-stage">
      <div
        className={`loom-app view-${activeView}`}
        data-sidebar-expanded={sidebarExpanded}
        data-inspector-open={activeView === "task" && inspectorOpen && Boolean(thread)}
        data-density={preferences.density}
        data-reduce-motion={preferences.reduceMotion}
        data-show-shortcuts={preferences.showShortcutHints}
        data-view-transitioning={viewTransitionPending}
        data-preview-open={activeView === "task" && previewOpen}
        style={{ "--sidebar-width": `${sidebarWidth}px` }}
      >
        <div className="window-drag-region" aria-hidden="true" />
        {activeView === "settings" ? (
          <SettingsSidebar page={settingsPage} onPageChange={setSettingsPage} onBack={() => changeView("task")} />
        ) : (
          <Sidebar
            projects={projects}
            selectedProjectId={selectedProjectId}
            onSelectProject={selectProject}
            tasks={rootThreads}
            selectedThreadId={selectedThreadId}
            onSelectThread={selectThread}
            onDeleteThread={deleteThread}
            onNewTask={newTask}
            onOpenProject={openProject}
            activeView={activeView}
            onView={changeView}
            attentionCount={attention.length}
            changedCount={changedCount}
            runtime={runtime}
            forcedCollapsed={previewOpen}
            onExpandedChange={setSidebarExpanded}
            width={sidebarWidth}
            onWidthChange={setSidebarWidth}
          />
        )}
        {content}
        {activeView === "task" && !previewOpen && <Inspector open={inspectorOpen} thread={thread} threads={threads} plan={plan} attention={attention} onResolve={resolveAttention} />}
      </div>
      <div ref={viewCurtainRef} className="view-curtain" hidden aria-hidden="true" />
      {error && (
        <div className="runtime-toast" role="alert">
          <Warning size={17} />
          <span><strong>Loom needs attention</strong><small>{error}</small></span>
          <IconButton label="Dismiss error" onClick={() => setError(null)}><X size={15} /></IconButton>
        </div>
      )}
    </div>
  );
}

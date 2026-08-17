import { Children, cloneElement, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise, Bell, Brain, CaretDown, CaretLeft, CaretRight, Check, CheckCircle,
  Circle, Code, Desktop, Eye, File, Files, Folder, FolderOpen, Gauge, Gear, GitBranch,
  GitDiff, Globe, Info, Lightning, List, LockKey, MagnifyingGlass, PaperPlaneTilt, Pause,
  PlugsConnected, Plus, ShieldCheck, Sparkle, SpinnerGap, Stack,
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
const MIN_SIDEBAR_WIDTH = 224;
const MAX_SIDEBAR_WIDTH = 360;
const DEFAULT_SIDEBAR_WIDTH = 264;

function clampSidebarWidth(width) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function IconButton({ label, children, className = "", ...props }) {
  return <button className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
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

function SidebarNavItem({ icon: Icon, label, active, badge, disabled, onClick }) {
  return (
    <button
      className={`rail-nav-item ${active ? "active" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      title={label}
    >
      {active && <span className="thread-indicator"><i /></span>}
      <span className="rail-icon"><Icon size={19} weight={active ? "fill" : "regular"} /></span>
      <span className="rail-label">{label}</span>
      {badge > 0 && <span className="rail-badge">{badge}</span>}
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
  onExpandedChange,
  width,
  onWidthChange
}) {
  const [pinnedExpanded, setPinnedExpanded] = useState(() => localStorage.getItem("loom.sidebarPinned") !== "false");
  const resizeCleanup = useRef(null);
  const expanded = pinnedExpanded;

  useEffect(() => onExpandedChange(expanded), [expanded, onExpandedChange]);
  useEffect(() => () => resizeCleanup.current?.(), []);

  const togglePinned = () => {
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
        >
          {expanded ? <CaretLeft size={18} /> : <List size={18} />}
        </IconButton>
      </div>

      <nav className="rail-scroll">
        <div className="rail-group">
          <div className="rail-group-label"><i />Workspace</div>
          <SidebarNavItem icon={Plus} label="New task" active={Boolean(selectedProjectId) && activeView === "task" && !selectedThreadId} disabled={!selectedProjectId} onClick={onNewTask} />
          <SidebarNavItem icon={Bell} label="Attention" active={activeView === "attention"} badge={attentionCount} onClick={() => onView("attention")} />
          <SidebarNavItem icon={GitDiff} label="Review" active={activeView === "review"} badge={changedCount} disabled={!selectedProjectId} onClick={() => onView("review")} />
          <SidebarNavItem icon={PlugsConnected} label="Extensions" active={activeView === "extensions"} onClick={() => onView("extensions")} />
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
            const dirty = project.repository?.dirtyPaths?.length ?? 0;
            return (
              <div className={`project-node ${selected ? "selected" : ""}`} key={project.id}>
                <button
                  className="project-row"
                  onClick={() => onSelectProject(project.id)}
                  aria-current={selected ? "true" : undefined}
                  title={project.displayName}
                >
                  <span className="rail-icon project-icon"><Folder size={18} weight={selected ? "fill" : "regular"} /></span>
                  <span className="project-copy">
                    <strong>{project.displayName}</strong>
                    <small>{project.repository?.kind === "git" ? `${dirty ? `${dirty} changed` : "Clean"} · Git` : "Folder"}</small>
                  </span>
                  {dirty > 0 && <span className="dirty-dot" title={`${dirty} changed files`} />}
                </button>
                {selected && (
                  <div className="task-tree">
                    {tasks.length === 0 && <p>No Codex tasks yet</p>}
                    {tasks.map((task) => {
                      const title = threadTitle(task);
                      const active = task.id === selectedThreadId && activeView === "task";
                      return (
                        <div className={`task-row ${active ? "active" : ""}`} key={task.id}>
                          <button className="task-select" onClick={() => onSelectThread(task.id)} title={title}>
                            <span className="task-branch" />
                            <StatusDot status={threadStatus(task)} />
                            <span>{title}</span>
                            <time>{relativeTime(task.recencyAt ?? task.updatedAt)}</time>
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

      <button className="rail-footer" onClick={() => onView("extensions")} aria-label="Open runtime extensions">
        <span className="runtime-slot"><span className={`runtime-orb ${runtime.connected ? "ready" : runtime.state}`} /></span>
        <span className="rail-label">
          <strong>{runtime.connected ? "Runtime ready" : "Runtime unavailable"}</strong>
          <small>{runtime.connected ? runtime.userAgent || "Local Codex" : "Check the runtime notice"}</small>
        </span>
        <Gear size={17} />
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

function AppToolbar({ title, subtitle, inspectorOpen, onInspectorToggle, showInspector = false }) {
  return (
    <header className="app-toolbar">
      <div className="toolbar-title">
        <Folder size={16} />
        <span><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</span>
      </div>
      <div className="toolbar-actions">
        {showInspector && (
          <IconButton label="Toggle task inspector" className={inspectorOpen ? "active" : ""} onClick={onInspectorToggle}>
            <TreeStructure size={18} />
          </IconButton>
        )}
      </div>
    </header>
  );
}

function PlanPanel({ plan, fallbackText }) {
  if (!plan?.length && !fallbackText) return null;
  const complete = plan?.filter((step) => step.status === "completed").length ?? 0;
  return (
    <section className="task-progress">
      <div className="progress-head">
        <span className="progress-glyph"><Stack size={17} weight="fill" /></span>
        <span><strong>Plan</strong><small>{plan?.length ? `${complete} of ${plan.length} complete` : "Codex plan"}</small></span>
      </div>
      {plan?.length ? (
        <div className="progress-steps">
          {plan.map((step) => (
            <div className={`progress-step ${step.status}`} key={step.step}>
              {step.status === "completed" ? <CheckCircle size={17} weight="fill" /> : step.status === "inProgress" ? <SpinnerGap className="spin-icon" size={17} /> : <Circle size={16} />}
              <span>{step.step}</span>
            </div>
          ))}
        </div>
      ) : <p className="plan-text">{fallbackText}</p>}
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

function inlineMarkdown(text, keyPrefix) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g).filter(Boolean).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={`${keyPrefix}-${index}`}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={`${keyPrefix}-${index}`}>{part.slice(2, -2)}</strong>;
    const reference = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (reference) return <span className="message-reference" title={reference[2]} key={`${keyPrefix}-${index}`}>{reference[1]}</span>;
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
        item.content?.map((part) => part.text).join("\n"),
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
    if (!text) return null;
    return <div className="message user-message">{text}</div>;
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
    const branded = modelBrand(option.value);
    return (
      <span className="picker-glyph model-picker-glyph">
        {branded ? <ModelBrandIcon model={option.value} /> : <Sparkle size={14} weight="fill" />}
      </span>
    );
  }
  const Glyph = option.icon ?? Sparkle;
  return <span className={`picker-glyph${option.danger ? " danger" : ""}`}><Glyph size={15} weight="regular" /></span>;
}

function ComposerPicker({ label, hint, value, options, onChange, kind, align = "right", disabled = false }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const optionRefs = useRef([]);
  const listboxId = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex] ?? options[0];

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
    window.setTimeout(() => optionRefs.current[selectedIndex]?.focus(), 0);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, selectedIndex]);

  const choose = (next) => {
    onChange(next.value);
    setOpen(false);
    window.setTimeout(() => rootRef.current?.querySelector(".picker-trigger")?.focus(), 0);
  };

  const moveFocus = (event) => {
    const currentIndex = optionRefs.current.indexOf(document.activeElement);
    let nextIndex = currentIndex;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1 + options.length) % options.length;
    else if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + options.length) % options.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = options.length - 1;
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
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
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
          <div className="picker-options" id={listboxId} role="listbox" aria-label={label} onKeyDown={moveFocus}>
            {options.map((option, index) => (
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

function Composer({ disabled, busy, draftKey, running, models, selectedModel, onModelChange, effort, onEffortChange, permissionMode, onPermissionModeChange, onSubmit, onInterrupt }) {
  const [text, setText] = useState("");
  const selected = models.find((model) => model.model === selectedModel);
  const efforts = selected?.supportedReasoningEfforts ?? [];
  const modelOptions = models.map((model) => ({
    value: model.model,
    label: model.displayName ?? model.model,
    description: model.isDefault ? `${model.model} · Default` : model.model
  }));
  const effortOptions = (efforts.length ? efforts : [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }]).map((option) => {
    const value = option.reasoningEffort ?? option.effort ?? option;
    return { value, ...(EFFORT_META[value] ?? { label: String(value).replace(/^./, (letter) => letter.toUpperCase()), description: "Adjust how deeply Codex reasons.", icon: Brain }) };
  });
  useEffect(() => setText(""), [draftKey]);
  const submit = async () => {
    const value = text.trim();
    if (!value || disabled || busy) return;
    setText("");
    const accepted = await onSubmit(value);
    if (accepted === false) setText((current) => current || value);
  };
  return (
    <div className="composer">
      <textarea
        aria-label="Message Codex"
        placeholder={disabled ? "Connect Codex and select a project to begin" : running ? "Steer the active task" : "Ask Codex to work on this project"}
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-controls">
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
          <IconButton label={running ? "Steer task" : "Send message"} className="send" onClick={submit} disabled={disabled || busy || !text.trim()}>
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
  loading,
  runtime,
  plan,
  seenResponseIds,
  inspectorOpen,
  onInspectorToggle,
  onOpenProject,
  composerProps
}) {
  const items = flattenItems(thread);
  const latestPlanText = [...items].reverse().find((item) => item.type === "plan")?.text;
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
    <main className="main-canvas">
      <AppToolbar
        title={thread ? threadTitle(thread) : project?.displayName ?? "Loom"}
        subtitle={thread ? project?.displayName : project?.canonicalPath}
        inspectorOpen={inspectorOpen}
        onInspectorToggle={onInspectorToggle}
        showInspector={Boolean(thread)}
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
            <PlanPanel plan={plan} fallbackText={latestPlanText} />
          </div>
        )}
      </div>
      {project && <Composer {...composerProps} />}
    </main>
  );
}

function ApprovalCard({ request, onResolve }) {
  const method = request.method ?? "Approval";
  const params = request.params ?? {};
  const isApproval = method.includes("requestApproval") || method === "applyPatchApproval" || method === "execCommandApproval";
  const isUserInput = method.includes("requestUserInput");
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const [answers, setAnswers] = useState({});
  const summary = params.command || params.reason || params.cwd || method.replaceAll("/", " · ");
  const submitAnswers = () => onResolve(request, Object.fromEntries(questions.map((question, index) => {
    const id = question.id ?? `question-${index + 1}`;
    return [id, { answers: [answers[id]?.trim()].filter(Boolean) }];
  })));
  return (
    <section className="approval-card">
      <div className="approval-title"><Warning size={17} weight="fill" /><strong>{isApproval ? "Approval required" : "Attention required"}</strong></div>
      <p>{summary}</p>
      {(params.cwd || request.projectId) && <small className="approval-context">{params.cwd ?? `Project ${request.projectId}`}</small>}
      {isApproval ? (
        <div className="approval-actions">
          <button className="approve" onClick={() => onResolve(request, "accept")}><Check size={15} />Approve</button>
          <button onClick={() => onResolve(request, "decline")}><X size={15} />Decline</button>
          <button onClick={() => onResolve(request, "acceptForSession")}>Allow for session</button>
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

function ExtensionsWorkspace({ extensions, loading, onRefresh }) {
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
    <main className="main-canvas workspace settings-workspace">
      <AppToolbar title="Extensions" subtitle="Runtime capabilities" />
      <div className="settings-column">
        <div className="settings-title"><span>Extensions</span><h1>Capabilities</h1><p>Live skills, apps, and MCP servers exposed by the connected Codex runtime.</p></div>
        <div className="settings-controls">
          <div className="segmented">{Object.keys(groups).map((name) => <button key={name} className={tab === name ? "selected" : ""} onClick={() => setTab(name)}>{name === "mcp" ? "MCP servers" : name[0].toUpperCase() + name.slice(1)}</button>)}</div>
          <IconButton label="Refresh extensions" onClick={onRefresh}><ArrowClockwise size={17} /></IconButton>
        </div>
        <label className="search-field"><MagnifyingGlass size={17} /><input aria-label="Search extensions" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${tab === "mcp" ? "MCP servers" : tab}`} /></label>
        {loading ? <div className="loading-state inline"><SpinnerGap className="spin-icon" size={18} />Loading capabilities…</div> : (
          <div className="settings-list">
            {visible.map((item, index) => {
              const name = item.name || item.displayName || item.id || `Capability ${index + 1}`;
              const detail = item.description || item.shortDescription || item.serverInfo?.description || (tab === "mcp" ? `${Object.keys(item.tools ?? {}).length} tools · ${item.authStatus ?? "available"}` : "Available");
              return <div className="settings-row" key={item.id ?? item.path ?? name}><span className="extension-icon"><Icon size={19} /></span><span><strong>{name}</strong><small>{detail}</small></span><span className="availability"><CheckCircle size={15} weight="fill" />Available</span></div>;
            })}
            {visible.length === 0 && <p className="settings-empty">No matching {tab === "mcp" ? "MCP servers" : tab} reported by Codex.</p>}
          </div>
        )}
        {extensions.errors.length > 0 && <div className="policy-row"><Info size={17} /><span><strong>Some capability sources did not load</strong><small>{extensions.errors.join(" · ")}</small></span></div>}
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
  const [selectedModel, setSelectedModel] = useState("");
  const [effort, setEffort] = useState("");
  const [permissionMode, setPermissionMode] = useState(() => {
    const saved = localStorage.getItem("loom.permissionMode");
    return PERMISSION_OPTIONS.some((option) => option.value === saved) ? saved : "workspace-write";
  });
  const [runtime, setRuntime] = useState({ state: "starting", connected: false });
  const [activeView, setActiveView] = useState("task");
  const [inspectorOpen, setInspectorOpen] = useState(true);
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

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const rootThreads = threads.filter((candidate) => !candidate.parentThreadId);
  const activeTurn = [...(thread?.turns ?? [])].reverse().find((turn) => turn.status === "inProgress");
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
    if (!models.length) return;
    const saved = localStorage.getItem("loom.model");
    const model = models.find((candidate) => candidate.model === saved) ?? models.find((candidate) => candidate.isDefault) ?? models[0];
    setSelectedModel((current) => current || model.model);
    setEffort((current) => current || model.defaultReasoningEffort || "high");
  }, [models]);

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
    if (activeView === "extensions") loadExtensions();
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
        return;
      }
      if (event.type === "AttentionReset") {
        setAttention([]);
        return;
      }

      const payload = event.payload ?? {};
      if (payload.projectId && payload.projectId !== selectedProjectId) return;
      if (payload.method === "thread/status/changed") {
        setThreads((current) => current.map((candidate) => candidate.id === payload.threadId ? { ...candidate, status: payload.status } : candidate));
      }
      if (payload.method === "thread/name/updated") {
        setThreads((current) => current.map((candidate) => candidate.id === payload.threadId ? { ...candidate, name: payload.name } : candidate));
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
  }, [api, loadAgents, loadModels, loadReview, loadThreads, normalizePlan, refreshThread, selectedProjectId]);

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
    if (!window.confirm(`Delete “${title}”?\n\nThis removes the conversation from Loom’s task list.`)) return;
    try {
      await api.threads.archive({ projectId, threadId });
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

  const changeModel = (modelName) => {
    setSelectedModel(modelName);
    localStorage.setItem("loom.model", modelName);
    const model = models.find((candidate) => candidate.model === modelName);
    if (model?.defaultReasoningEffort) setEffort(model.defaultReasoningEffort);
  };

  const changePermissionMode = (mode) => {
    setPermissionMode(mode);
    localStorage.setItem("loom.permissionMode", mode);
  };

  const submit = async (text) => {
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
        await api.turns.steer({ projectId, threadId: targetThreadId, turnId: activeTurn.id, text });
        if (selectedProjectIdRef.current === projectId && selectedThreadIdRef.current === targetThreadId) {
          window.setTimeout(() => refreshThread(projectId, targetThreadId), 250);
        }
      } else {
        const response = await api.turns.start({
          projectId,
          threadId: targetThreadId,
          text,
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
    running: Boolean(activeTurn),
    models,
    selectedModel,
    onModelChange: changeModel,
    effort,
    onEffortChange: setEffort,
    permissionMode,
    onPermissionModeChange: changePermissionMode,
    onSubmit: submit,
    onInterrupt: interrupt
  };

  let content;
  if (activeView === "review") {
    content = <ReviewWorkspace project={selectedProject} review={review} loading={loading.review} onRefresh={() => loadReview(selectedProjectId)} onExternal={openExternal} />;
  } else if (activeView === "extensions") {
    content = <ExtensionsWorkspace extensions={extensions} loading={loading.extensions} onRefresh={loadExtensions} />;
  } else if (activeView === "attention") {
    content = <AttentionWorkspace attention={attention} onResolve={resolveAttention} />;
  } else {
    content = (
      <ConversationWorkspace
        project={selectedProject}
        thread={thread}
        loading={loading.app || loading.thread}
        runtime={runtime}
        plan={plan}
        seenResponseIds={seenResponseIdsRef.current}
        inspectorOpen={inspectorOpen}
        onInspectorToggle={() => setInspectorOpen((open) => !open)}
        onOpenProject={openProject}
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
        style={{ "--sidebar-width": `${sidebarWidth}px` }}
      >
        <div className="window-drag-region" aria-hidden="true" />
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
          onView={setActiveView}
          attentionCount={attention.length}
          changedCount={changedCount}
          runtime={runtime}
          onExpandedChange={setSidebarExpanded}
          width={sidebarWidth}
          onWidthChange={setSidebarWidth}
        />
        {content}
        {activeView === "task" && <Inspector open={inspectorOpen} thread={thread} threads={threads} plan={plan} attention={attention} onResolve={resolveAttention} />}
      </div>
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

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise, Bell, CaretLeft, CaretRight, Check, CheckCircle,
  Circle, Desktop, File, Files, Folder, FolderOpen, Gear, GitBranch,
  GitDiff, Globe, Info, List, MagnifyingGlass, PaperPlaneTilt, Pause,
  PlugsConnected, Plus, ShieldCheck, Sparkle, SpinnerGap, Stack,
  TerminalWindow, TreeStructure, Warning, X
} from "@phosphor-icons/react";
import loomIcon from "./assets/loom-icon.png";
import {
  applyRuntimePayload,
  descendantsOf,
  flattenItems,
  parseDiff,
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
                    {tasks.slice(0, 12).map((task) => (
                      <button
                        key={task.id}
                        className={task.id === selectedThreadId && activeView === "task" ? "active" : ""}
                        onClick={() => onSelectThread(task.id)}
                        title={threadTitle(task)}
                      >
                        <span className="task-branch" />
                        <StatusDot status={threadStatus(task)} />
                        <span>{threadTitle(task)}</span>
                        <time>{relativeTime(task.recencyAt ?? task.updatedAt)}</time>
                      </button>
                    ))}
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
              {step.status === "completed" ? <CheckCircle size={17} weight="fill" /> : step.status === "in_progress" ? <SpinnerGap className="spin-icon" size={17} /> : <Circle size={16} />}
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

function MarkdownMessage({ text }) {
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
      blocks.push(
        <div className="message-table-wrap" key={`table-${index}`}>
          <table>
            <thead><tr>{headers.map((cell, cellIndex) => <th key={`head-${cellIndex}`}>{inlineMarkdown(cell, `head-${cellIndex}`)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={`row-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`cell-${rowIndex}-${cellIndex}`}>{inlineMarkdown(cell, `cell-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
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

  return <div className="markdown-body">{blocks}</div>;
}

function ConversationItem({ item, forceFinal = false }) {
  if (item.type === "userMessage") {
    const text = item.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (!text) return null;
    return <div className="message user-message">{text}</div>;
  }
  if (item.type === "agentMessage") {
    if (!item.text) return null;
    return <article className={`message assistant-message ${forceFinal ? "final_answer" : item.phase ?? ""}`}><MarkdownMessage text={item.text} /></article>;
  }
  if (item.type === "plan") return null;
  return <ActivityItem item={item} />;
}

const TRACE_ITEM_TYPES = new Set(["reasoning", "commandExecution", "fileChange", "collabAgentToolCall", "mcpToolCall", "dynamicToolCall"]);

function turnIsRunning(status) {
  return status === "inProgress" || status === "running" || status === "active";
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
        <Sparkle className="trace-status-icon" size={15} weight={running ? "fill" : "regular"} />
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
              item.text ? <div className="trace-commentary" key={item.id ?? `commentary-${index}`}><MarkdownMessage text={item.text} /></div> : null
            ) : (
              <ActivityItem item={item} key={item.id ?? `${item.type}-${index}`} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function TurnConversation({ turn }) {
  const items = turn.items ?? [];
  const running = turnIsRunning(turn.status);
  const explicitFinalIndex = items.findLastIndex((item) => item.type === "agentMessage" && item.phase === "final_answer");
  const fallbackFinalIndex = explicitFinalIndex === -1 && !running
    ? items.findLastIndex((item) => item.type === "agentMessage" && item.text)
    : -1;
  const finalIndex = explicitFinalIndex === -1 ? fallbackFinalIndex : explicitFinalIndex;
  const settled = !running && finalIndex !== -1;
  const rendered = [];
  let traceItems = [];

  const flushTrace = () => {
    if (!traceItems.length) return;
    const key = traceItems[0].id ?? `trace-${rendered.length}`;
    rendered.push(<WorkingTrace items={traceItems} running={running} settled={settled} key={key} />);
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
    rendered.push(<ConversationItem item={item} forceFinal={isFinal} key={item.id ?? `${item.type}-${index}`} />);
  });
  flushTrace();

  return rendered;
}

function Composer({ disabled, running, models, selectedModel, onModelChange, effort, onEffortChange, onSubmit, onInterrupt }) {
  const [text, setText] = useState("");
  const selected = models.find((model) => model.model === selectedModel);
  const efforts = selected?.supportedReasoningEfforts ?? [];
  const submit = async () => {
    const value = text.trim();
    if (!value || disabled) return;
    setText("");
    const accepted = await onSubmit(value);
    if (accepted === false) setText(value);
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
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-controls">
        <div className="permission-label"><ShieldCheck size={15} />Workspace access</div>
        <div>
          <select aria-label="Model" value={selectedModel} onChange={(event) => onModelChange(event.target.value)} disabled={disabled || models.length === 0}>
            {models.length === 0 && <option value="">Default model</option>}
            {models.map((model) => <option value={model.model} key={model.id ?? model.model}>{model.displayName ?? model.model}</option>)}
          </select>
          <select aria-label="Reasoning effort" value={effort} onChange={(event) => onEffortChange(event.target.value)} disabled={disabled}>
            {(efforts.length ? efforts : [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }]).map((option) => {
              const value = option.reasoningEffort ?? option.effort ?? option;
              return <option value={value} key={value}>{String(value).replace(/^./, (letter) => letter.toUpperCase())}</option>;
            })}
          </select>
          {running && <IconButton label="Interrupt task" className="turn-button" onClick={onInterrupt}><Pause size={16} weight="fill" /></IconButton>}
          <IconButton label={running ? "Steer task" : "Send message"} className="send" onClick={submit} disabled={disabled || !text.trim()}>
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
  inspectorOpen,
  onInspectorToggle,
  onOpenProject,
  composerProps
}) {
  const items = flattenItems(thread);
  const latestPlanText = [...items].reverse().find((item) => item.type === "plan")?.text;
  const scrollRef = useRef(null);
  const liveLength = items.map((item) => (item.text?.length ?? 0) + (item.aggregatedOutput?.length ?? 0) + (Array.isArray(item.summary) ? item.summary.join("").length : 0)).join(":");
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [items.length, liveLength]);

  return (
    <main className="main-canvas">
      <AppToolbar
        title={thread ? threadTitle(thread) : project?.displayName ?? "Loom"}
        subtitle={thread ? project?.displayName : project?.canonicalPath}
        inspectorOpen={inspectorOpen}
        onInspectorToggle={onInspectorToggle}
        showInspector={Boolean(thread)}
      />
      <div className="conversation-scroll" ref={scrollRef}>
        {loading ? (
          <div className="loading-state"><SpinnerGap className="spin-icon" size={20} />Loading conversation…</div>
        ) : !thread ? (
          <EmptyConversation project={project} runtime={runtime} onOpenProject={onOpenProject} />
        ) : (
          <div className="conversation-column">
            <PlanPanel plan={plan} fallbackText={latestPlanText} />
            <div className="message-stream">
              {items.length === 0 && <p className="quiet-empty">This task has no messages yet.</p>}
              {(thread.turns ?? []).map((turn) => <TurnConversation turn={turn} key={turn.id} />)}
            </div>
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
  const summary = params.command || params.reason || params.cwd || method.replaceAll("/", " · ");
  return (
    <section className="approval-card">
      <div className="approval-title"><Warning size={17} weight="fill" /><strong>{isApproval ? "Approval required" : "Attention required"}</strong></div>
      <p>{summary}</p>
      {isApproval ? (
        <div className="approval-actions">
          <button className="approve" onClick={() => onResolve(request, "accept")}><Check size={15} />Approve</button>
          <button onClick={() => onResolve(request, "decline")}><X size={15} />Decline</button>
          <button onClick={() => onResolve(request, "acceptForSession")}>Allow for session</button>
        </div>
      ) : <small>Open the active task to respond to this request.</small>}
    </section>
  );
}

function Inspector({ open, thread, threads, plan, attention, onResolve }) {
  if (!thread) return null;
  const agents = descendantsOf(threads, thread.id);
  return (
    <aside className={`inspector ${open ? "open" : ""}`} aria-label="Task inspector">
      <div className="inspector-head"><span>Task</span><StatusDot status={threadStatus(thread)} /></div>
      <section className="inspector-section">
        <span className="section-label">Plan</span>
        {plan?.length ? (
          <div className="inspector-plan">
            {plan.map((step) => <div key={step.step} className={step.status}>{step.status === "completed" ? <CheckCircle size={14} weight="fill" /> : <Circle size={14} />}<span>{step.step}</span></div>)}
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
              <span><strong>{agent.agentNickname || agent.agentRole || "Delegated agent"}</strong><small>{threadTitle(agent)}</small></span>
            </div>
          ))}
          {agents.length === 0 && <p className="inspector-empty">No delegated agents yet.</p>}
        </div>
      </section>
      {attention.filter((request) => request.params?.threadId === thread.id).map((request) => <ApprovalCard request={request} onResolve={onResolve} key={request.id} />)}
    </aside>
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
            <div className="diff-head"><span>{selected?.path}</span><small>Unified diff</small></div>
            <div className="diff-code">
              {selected?.lines.map((line, index) => {
                const kind = line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : line.startsWith("@@") ? "hunk" : "";
                return <div className={`diff-line ${kind}`} key={`${index}-${line}`}><span>{index + 1}</span><code>{line || " "}</code></div>;
              })}
            </div>
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
  const [threads, setThreads] = useState([]);
  const [selectedThreadId, setSelectedThreadId] = useState(null);
  const [thread, setThread] = useState(null);
  const [plan, setPlan] = useState([]);
  const [attention, setAttention] = useState([]);
  const [review, setReview] = useState({ repository: null, diff: "" });
  const [extensions, setExtensions] = useState(EMPTY_EXTENSIONS);
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [effort, setEffort] = useState("high");
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
  const [error, setError] = useState(null);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const rootThreads = threads.filter((candidate) => !candidate.parentThreadId);
  const activeTurn = [...(thread?.turns ?? [])].reverse().find((turn) => turn.status === "inProgress");
  const changedCount = review.repository?.dirtyPaths?.length ?? 0;

  useEffect(() => {
    draftModeRef.current = draftMode;
  }, [draftMode]);

  const loadModels = useCallback(async () => {
    if (!api) return;
    const next = await api.models.list();
    setModels(next);
  }, [api]);

  const loadThreads = useCallback(async (projectId) => {
    if (!api || !projectId) return;
    setLoading((state) => ({ ...state, threads: true }));
    try {
      const response = await api.threads.list({ projectId });
      const next = response.data ?? [];
      setThreads(next);
      const roots = next.filter((candidate) => !candidate.parentThreadId);
      setSelectedThreadId((current) => {
        if (current && roots.some((candidate) => candidate.id === current)) return current;
        return draftModeRef.current ? null : roots[0]?.id ?? null;
      });
    } catch (cause) {
      setError(cause.message);
      setThreads([]);
    } finally {
      setLoading((state) => ({ ...state, threads: false }));
    }
  }, [api]);

  const loadThread = useCallback(async (projectId, threadId) => {
    if (!api || !projectId || !threadId) return;
    setLoading((state) => ({ ...state, thread: true }));
    try {
      const response = await api.threads.read({ projectId, threadId });
      setThread(response.thread);
    } catch (cause) {
      setError(cause.message);
      setThread(null);
    } finally {
      setLoading((state) => ({ ...state, thread: false }));
    }
  }, [api]);

  const loadReview = useCallback(async (projectId) => {
    if (!api || !projectId) return;
    setLoading((state) => ({ ...state, review: true }));
    try {
      const result = await api.review.read({ projectId });
      setReview(result);
      setProjects((current) => current.map((project) => project.id === projectId ? { ...project, repository: result.repository } : project));
    } catch (cause) {
      setError(cause.message);
      setReview({ repository: null, diff: "" });
    } finally {
      setLoading((state) => ({ ...state, review: false }));
    }
  }, [api]);

  const loadExtensions = useCallback(async () => {
    if (!api) return;
    setLoading((state) => ({ ...state, extensions: true }));
    try {
      const result = await api.extensions.list({ cwd: selectedProject?.canonicalPath, threadId: selectedThreadId ?? undefined });
      setExtensions({ ...EMPTY_EXTENSIONS, ...result });
    } catch (cause) {
      setError(cause.message);
    } finally {
      setLoading((state) => ({ ...state, extensions: false }));
    }
  }, [api, selectedProject?.canonicalPath, selectedThreadId]);

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
      setThread(null);
      return;
    }
    loadThread(selectedProjectId, selectedThreadId);
  }, [selectedProjectId, selectedThreadId, loadThread]);

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
          if (selectedProjectId) loadThreads(selectedProjectId);
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

      const payload = event.payload ?? {};
      if (payload.method === "thread/status/changed") {
        setThreads((current) => current.map((candidate) => candidate.id === payload.threadId ? { ...candidate, status: payload.status } : candidate));
      }
      if (payload.method === "thread/name/updated") {
        setThreads((current) => current.map((candidate) => candidate.id === payload.threadId ? { ...candidate, name: payload.name } : candidate));
      }
      if (payload.method === "thread/started" && payload.thread) {
        setThreads((current) => current.some((candidate) => candidate.id === payload.thread.id) ? current : [payload.thread, ...current]);
      }
      if (payload.threadId === selectedThreadId) {
        setThread((current) => applyRuntimePayload(current, payload));
        if (payload.method === "turn/plan/updated") setPlan(payload.plan ?? []);
        if (payload.method === "turn/completed" && selectedProjectId) loadReview(selectedProjectId);
      }
    });
  }, [api, loadModels, loadReview, loadThreads, selectedProjectId, selectedThreadId]);

  const openProject = async () => {
    if (!api) return;
    try {
      const project = await api.projects.open();
      if (!project) return;
      setProjects((current) => [project, ...current.filter((candidate) => candidate.id !== project.id)]);
      setDraftMode(false);
      setSelectedProjectId(project.id);
      setActiveView("task");
    } catch (cause) {
      setError(cause.message);
    }
  };

  const selectProject = (projectId) => {
    setDraftMode(false);
    setSelectedThreadId(null);
    setSelectedProjectId(projectId);
    setActiveView("task");
  };

  const selectThread = (threadId) => {
    setDraftMode(false);
    setSelectedThreadId(threadId);
    setActiveView("task");
  };

  const newTask = () => {
    if (!selectedProjectId) return;
    setDraftMode(true);
    setSelectedThreadId(null);
    setThread(null);
    setPlan([]);
    setActiveView("task");
  };

  const changeModel = (modelName) => {
    setSelectedModel(modelName);
    localStorage.setItem("loom.model", modelName);
    const model = models.find((candidate) => candidate.model === modelName);
    if (model?.defaultReasoningEffort) setEffort(model.defaultReasoningEffort);
  };

  const submit = async (text) => {
    if (!api || !selectedProjectId || !runtime.connected) return false;
    try {
      let targetThreadId = selectedThreadId;
      if (!targetThreadId) {
        const created = await api.threads.create({ projectId: selectedProjectId, model: selectedModel || undefined });
        targetThreadId = created.thread.id;
        setDraftMode(false);
        setThreads((current) => [created.thread, ...current]);
        setSelectedThreadId(targetThreadId);
        setThread(created.thread);
      }
      if (activeTurn && targetThreadId === selectedThreadId) {
        await api.turns.steer({ projectId: selectedProjectId, threadId: targetThreadId, turnId: activeTurn.id, text });
      } else {
        const response = await api.turns.start({
          projectId: selectedProjectId,
          threadId: targetThreadId,
          text,
          model: selectedModel || undefined,
          effort
        });
        setThread((current) => current ? applyRuntimePayload(current, { method: "turn/started", threadId: targetThreadId, turn: response.turn }) : current);
      }
      return true;
    } catch (cause) {
      setError(cause.message);
      return false;
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
      await api.approvals.resolve({ requestId: request.id, decision });
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
    running: Boolean(activeTurn),
    models,
    selectedModel,
    onModelChange: changeModel,
    effort,
    onEffortChange: setEffort,
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

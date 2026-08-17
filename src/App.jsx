import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwise, Bell, CaretDown, CaretRight, Check, CheckCircle, Circle,
  CirclesFour, Desktop, DotsThree, File, Files, Flask, Folder, FolderOpen,
  Gear, GitBranch, GitDiff, Globe, Info, MagnifyingGlass, PaperPlaneTilt,
  Pause, PlugsConnected, Plus, ShieldCheck, SidebarSimple, Sparkle, SpinnerGap, Stack,
  TerminalWindow, TreeStructure, Warning, X, XCircle
} from "@phosphor-icons/react";
import loomIcon from "./assets/loom-icon.png";

const tasks = [
  ["auth", "Refactor authentication flow", "running"],
  ["rate", "Add rate limiting middleware", "complete"],
  ["memory", "Investigate memory leak", "attention"],
  ["database", "Upgrade database driver", "complete"],
  ["errors", "Audit API error handling", "error"]
];
const agents = [
  { id: "lead", name: "Lead", role: "Coordinating the task", status: "running", files: 3 },
  { id: "api", name: "API migration", role: "Backend changes complete", status: "complete", files: 22 },
  { id: "tests", name: "Session tests", role: "Running integration tests", status: "running", files: 8 },
  { id: "docs", name: "Docs audit", role: "Waiting for direction", status: "attention", files: 4 }
];
const files = [
  { path: "src/middleware/auth.ts", plus: 32, minus: 4 },
  { path: "src/routes/session.ts", plus: 26, minus: 0 },
  { path: "tests/session.test.ts", plus: 45, minus: 2 },
  { path: "tests/helpers/auth.ts", plus: 18, minus: 1 },
  { path: "docs/authentication.md", plus: 14, minus: 6, preexisting: true }
];
const extensionGroups = {
  Skills: [
    { name: "React performance", detail: "Built in · 3 dependencies", enabled: true, icon: Sparkle },
    { name: "Security scan", detail: "Plugin · managed approvals", enabled: true, icon: ShieldCheck },
    { name: "Document tools", detail: "Built in · 4 dependencies", enabled: false, icon: Files }
  ],
  Apps: [
    { name: "GitHub", detail: "Connected", enabled: true, icon: GitBranch },
    { name: "Figma", detail: "Authentication required", enabled: false, icon: CirclesFour },
    { name: "PostHog", detail: "Available", enabled: false, icon: Globe }
  ],
  "MCP servers": [
    { name: "filesystem", detail: "Healthy · 8 tools", enabled: true, icon: FolderOpen },
    { name: "browser", detail: "Healthy · 12 tools", enabled: true, icon: Globe },
    { name: "design-system", detail: "Needs authentication", enabled: false, icon: PlugsConnected }
  ]
};

function IconButton({ label, children, className = "", ...props }) {
  return <button className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}
function StatusDot({ status }) { return <span className={`status-dot ${status}`} aria-hidden="true" />; }
function Toggle({ item, onChange }) {
  return <button className={`toggle ${item.enabled ? "on" : ""}`} role="switch" aria-checked={item.enabled} aria-label={`${item.enabled ? "Disable" : "Enable"} ${item.name}`} onClick={() => onChange(!item.enabled)}><span /></button>;
}

function Sidebar({ activeView, setActiveView, taskStatus }) {
  return <aside className="sidebar">
    <div className="sidebar-drag" />
    <div className="sidebar-toolbar">
      <button className="brand-button"><img src={loomIcon} alt="" /><strong>Loom</strong><CaretDown size={13} /></button>
      <span><IconButton label="Search"><MagnifyingGlass size={17} /></IconButton><IconButton label="Notifications"><Bell size={17} /></IconButton></span>
    </div>
    <nav className="source-list" aria-label="Loom navigation">
      <button className="source-row" onClick={() => setActiveView("task")}><Plus size={17} />New task</button>
      <button className="source-row" onClick={() => setActiveView("task")}><Warning size={17} />Attention<span className="badge">1</span></button>
      <button className={`source-row ${activeView === "review" ? "selected" : ""}`} onClick={() => setActiveView("review")}><GitDiff size={17} />Review<span className="subtle-count">5</span></button>
      <button className={`source-row ${activeView === "extensions" ? "selected" : ""}`} onClick={() => setActiveView("extensions")}><PlugsConnected size={17} />Extensions</button>
    </nav>
    <div className="sidebar-section-title">Projects</div>
    <div className="project-block">
      <button className="project-title"><Folder size={16} /><span>Aurora</span><CaretDown size={13} /></button>
      {tasks.slice(0, 3).map(([id, title, status]) => <button key={id} className={`task-link ${id === "auth" && activeView === "task" ? "selected" : ""}`} onClick={() => setActiveView("task")}><span>{title}</span><StatusDot status={id === "auth" ? taskStatus : status} /></button>)}
    </div>
    <div className="project-block"><button className="project-title"><Folder size={16} /><span>Nebula</span><CaretRight size={13} /></button></div>
    <div className="sidebar-section-title history-title">Recent</div>
    <div className="recent-list">{tasks.slice(3).map(([id, title, status]) => <button key={id} className="task-link"><span>{title}</span><StatusDot status={status} /></button>)}</div>
    <button className="account-row"><span className="avatar">TS</span><span><strong>Tobias</strong><small>ChatGPT</small></span><Gear size={17} /></button>
  </aside>;
}

function AppToolbar({ inspectorOpen, setInspectorOpen, title = "Refactor authentication flow" }) {
  return <header className="app-toolbar">
    <div className="toolbar-title"><Folder size={16} /><span>{title}</span><DotsThree size={18} /></div>
    <div className="toolbar-actions"><IconButton label="Toggle sidebar"><SidebarSimple size={18} /></IconButton><IconButton label="Toggle agent inspector" className={inspectorOpen ? "active" : ""} onClick={() => setInspectorOpen(!inspectorOpen)}><TreeStructure size={18} /></IconButton></div>
  </header>;
}

function TaskProgress({ taskStatus }) {
  const [expanded, setExpanded] = useState(true);
  const paused = taskStatus === "interrupted";
  const steps = [
    ["Analyze current flow", "Lead", "done"],
    ["Design cookie model", "Lead", "done"],
    ["Migrate backend", "API migration", "done"],
    ["Update client sessions", "API migration", paused ? "paused" : "active"],
    ["Add fingerprinting", "Session tests", paused ? "paused" : "active"],
    ["Verify and review", "Lead", "pending"]
  ];
  const StepIcon = ({ state }) => state === "done" ? <CheckCircle size={17} weight="fill" /> : state === "active" ? <SpinnerGap className="spin-icon" size={17} /> : state === "paused" ? <Pause size={15} weight="fill" /> : <Circle size={16} />;
  return <section className={`task-progress ${expanded ? "expanded" : "collapsed"}`}>
    <button className="progress-head" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
      <span className="progress-title"><span className="progress-glyph"><Stack size={17} weight="fill" /></span><span><strong>Task progress</strong><small>Refactor authentication flow</small></span></span>
      <span className="progress-count"><strong>3 / 6</strong><small>complete</small></span>
      <CaretDown className="progress-caret" size={15} />
    </button>
    <div className="progress-track"><span style={{ width: paused ? "50%" : "58%" }} /></div>
    {expanded && <div className="progress-body">
      <div className="phase-row"><span><i />Implementation</span><small>{paused ? "Work paused" : "2 agents working in parallel"}</small></div>
      <div className="progress-steps">{steps.map(([label, owner, state]) => <div className={`progress-step ${state}`} key={label}><StepIcon state={state} /><span><strong>{label}</strong><small>{owner}</small></span></div>)}</div>
      <div className="progress-foot"><span className="agent-stack"><span className="lead-agent"><img src={loomIcon} alt="" /></span><span className="api-agent"><GitBranch size={11} weight="bold" /></span><span className="test-agent"><Flask size={11} weight="bold" /></span></span><span><strong>4 agents</strong><small>31 files touched</small></span><button onClick={(event) => event.stopPropagation()}>Open task map <CaretRight size={13} /></button></div>
    </div>}
  </section>;
}
function Composer({ taskStatus, setTaskStatus }) {
  const [text, setText] = useState("");
  const [messages, setMessages] = useState([]);
  const input = useRef(null);
  const submit = async () => {
    const value = text.trim();
    if (!value) return;
    setMessages((current) => [...current, value]); setText(""); setTaskStatus("running");
    await window.loom?.turns.start({ threadId: "thread-auth", text: value }).catch(() => null);
  };
  return <>
    <div className="sent-messages">{messages.map((message, index) => <div className="sent-bubble" key={`${message}-${index}`}>{message}</div>)}</div>
    <div className="composer">
      <textarea ref={input} aria-label="Message Loom" placeholder="Do anything" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} />
      <div className="composer-controls">
        <div><IconButton label="Attach files"><Plus size={18} /></IconButton><button className="access-button"><ShieldCheck size={15} />Full access</button></div>
        <div><select aria-label="Model"><option>GPT-5.6 Codex</option><option>GPT-5.4</option></select><select aria-label="Reasoning effort"><option>High</option><option>Medium</option><option>Low</option></select><IconButton label={taskStatus === "interrupted" ? "Resume task" : "Interrupt task"} className="turn-button" onClick={async () => { if (taskStatus === "interrupted") setTaskStatus("running"); else { setTaskStatus("interrupted"); await window.loom?.tasks.interrupt({ threadId: "thread-auth" }).catch(() => null); } }}>{taskStatus === "interrupted" ? <ArrowCounterClockwise size={18} /> : <Pause size={17} weight="fill" />}</IconButton><IconButton label="Send message" className="send" onClick={submit}><PaperPlaneTilt size={17} weight="fill" /></IconButton></div>
      </div>
    </div>
  </>;
}

function Conversation({ taskStatus, setTaskStatus, setSelectedAgent, inspectorOpen, setInspectorOpen }) {
  const showAgent = (id) => { setSelectedAgent(id); setInspectorOpen(true); };
  return <main className="main-canvas">
    <AppToolbar inspectorOpen={inspectorOpen} setInspectorOpen={setInspectorOpen} />
    <div className="conversation-scroll"><div className="conversation-column">
      <h1 className="sr-only">Refactor authentication flow</h1>
      <div className="user-bubble">Refactor the authentication flow to use httpOnly cookies, rotate refresh tokens, and add device fingerprinting. Keep changes minimal and add tests.</div>
      <article className="assistant-message">
        <div className="working-label">Working for 4m 18s</div>
        <p>I’ll trace the current authentication flow, split the backend and verification work, then bring the combined changes back here for review.</p>
        <TaskProgress taskStatus={taskStatus} />
        <button className="delegation-summary" onClick={() => showAgent("tests")}><span className="delegation-icons"><span><GitBranch size={13} /></span><span><Flask size={13} /></span><span><File size={13} /></span></span><span><strong>Delegated to 3 agents</strong><small>1 complete · 1 running · 1 needs approval</small></span><CaretRight size={15} /></button>
        <p className="progress-update">The backend migration is complete. Session tests are running while the docs agent waits for your approval.</p>
      </article>
      <Composer taskStatus={taskStatus} setTaskStatus={setTaskStatus} />
    </div></div>
  </main>;
}

function Inspector({ open, setOpen, selectedAgent, setSelectedAgent, taskStatus }) {
  const [approval, setApproval] = useState("pending");
  const selected = agents.find((agent) => agent.id === selectedAgent) ?? agents[2];
  return <aside className={`inspector ${open ? "open" : ""}`} aria-label="Agent inspector">
    <div className="inspector-head"><span>Task</span><IconButton label="Close agent inspector" onClick={() => setOpen(false)}><X size={16} /></IconButton></div>
    <section className="inspector-section plan-summary"><span className="section-label">Plan</span><p><Sparkle size={16} />Refactor authentication flow</p><div className="thin-progress"><span /></div><small>2 of 3 steps complete</small></section>
    <section className="inspector-section">
      <div className="section-heading"><span className="section-label">Agents</span><small>4</small></div>
      <div className="agent-list">{agents.map((agent, index) => { const state = agent.id === "lead" && taskStatus === "interrupted" ? "interrupted" : agent.status; return <button key={agent.id} className={`${agent.id === selectedAgent ? "selected" : ""} ${index ? "child" : ""}`} onClick={() => setSelectedAgent(agent.id)}>{index > 0 && <span className="branch-line" />}<StatusDot status={state} /><span className="agent-copy"><strong>{agent.name}</strong><small>{agent.role}</small></span><small>{agent.files}</small></button>; })}</div>
    </section>
    <section className="inspector-section selected-detail"><div className="section-heading"><span className="section-label">{selected.name}</span><small>{selected.files} files</small></div><code><TerminalWindow size={15} />{selected.id === "tests" ? "pnpm test session" : selected.id === "api" ? "git diff -- src/auth" : "rg authentication"}</code><p>{selected.id === "tests" ? "12 tests passed so far" : "Latest activity completed successfully"}</p></section>
    <section className={`approval ${approval}`}>{approval === "pending" ? <><div><Warning size={16} weight="fill" /><strong>Approval required</strong></div><p>Allow Docs audit to edit <code>docs/authentication.md</code>?</p><div className="approval-actions"><button className="approve" onClick={async () => { setApproval("accepted"); await window.loom?.approvals.resolve({ requestId: "approval-docs", decision: "accept" }).catch(() => null); }}><Check size={15} />Approve</button><button onClick={() => setApproval("declined")}><X size={15} />Decline</button></div></> : <div className="resolved">{approval === "accepted" ? <CheckCircle size={18} weight="fill" /> : <XCircle size={18} weight="fill" />}<span><strong>{approval === "accepted" ? "Approved" : "Declined"}</strong><small>Decision sent to Docs audit</small></span><button onClick={() => setApproval("pending")}>Undo</button></div>}</section>
  </aside>;
}

function ReviewWorkspace({ inspectorOpen, setInspectorOpen }) {
  const [selected, setSelected] = useState(files[0]);
  const [split, setSplit] = useState(false);
  const lines = [["", "41", "41", "export function createSession(user: User) {"], ["removed", "42", "", "  const token = sign({ id: user.id });"], ["removed", "43", "", "  return { token };"], ["added", "", "42", "  const refreshToken = rotateRefreshToken(user.id);"], ["added", "", "43", "  cookies.set('session', refreshToken, cookieOptions);"], ["added", "", "44", "  return { authenticated: true };"], ["", "44", "45", "}"]];
  return <main className="main-canvas workspace">
    <AppToolbar inspectorOpen={inspectorOpen} setInspectorOpen={setInspectorOpen} title="Review changes" />
    <div className="workspace-header"><div><span>Review workspace</span><h1>Refactor authentication flow</h1><p>5 changed files · <b>+135</b> <em>−13</em> · isolated worktree</p></div><div><button><TerminalWindow size={16} />Terminal</button><button><Desktop size={16} />Editor</button><button><FolderOpen size={16} />Reveal</button></div></div>
    <div className="review-layout"><aside className="file-browser"><div className="list-label">Changed files</div>{files.map((file) => <button key={file.path} className={file.path === selected.path ? "selected" : ""} onClick={() => setSelected(file)}><File size={16} /><span><strong>{file.path.split("/").pop()}</strong><small>{file.path.split("/").slice(0, -1).join("/")}</small></span>{file.preexisting && <Warning size={14} />}<b>+{file.plus}</b><em>−{file.minus}</em></button>)}</aside>
      <section className="diff-panel"><div className="diff-head"><span>{selected.path}</span><div><button className={!split ? "selected" : ""} onClick={() => setSplit(false)}>Unified</button><button className={split ? "selected" : ""} onClick={() => setSplit(true)}>Split</button><IconButton label="Diff menu"><DotsThree size={17} /></IconButton></div></div>{selected.preexisting && <div className="file-warning"><Warning size={16} />This file had changes before Loom started.</div>}<div className={`diff-code ${split ? "split" : ""}`}>{lines.map(([kind, oldLine, newLine, code], index) => <div className={`diff-line ${kind}`} key={`${code}-${index}`}><span>{oldLine}</span><span>{newLine}</span><code>{kind === "added" ? "+" : kind === "removed" ? "−" : " "} {code}</code></div>)}</div><div className="codex-review"><Sparkle size={17} /><span><strong>Codex review is ready</strong><small>No critical issues found. One compatibility note remains.</small></span><button>Open review</button></div></section>
    </div>
  </main>;
}

function ExtensionsWorkspace({ inspectorOpen, setInspectorOpen }) {
  const [tab, setTab] = useState("Skills");
  const [groups, setGroups] = useState(extensionGroups);
  const [query, setQuery] = useState("");
  const visible = groups[tab].filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
  const update = (name, enabled) => setGroups((current) => ({ ...current, [tab]: current[tab].map((item) => item.name === name ? { ...item, enabled } : item) }));
  return <main className="main-canvas workspace settings-workspace">
    <AppToolbar inspectorOpen={inspectorOpen} setInspectorOpen={setInspectorOpen} title="Extensions" />
    <div className="settings-column"><div className="settings-title"><span>Extensions</span><h1>Capabilities</h1><p>Control the tools and context Codex can use in Loom.</p></div>
      <div className="segmented">{Object.keys(groups).map((name) => <button key={name} className={tab === name ? "selected" : ""} onClick={() => setTab(name)}>{name}</button>)}</div>
      <label className="search-field"><MagnifyingGlass size={17} /><input aria-label="Search extensions" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${tab.toLowerCase()}`} /></label>
      <div className="settings-list">{visible.map((item) => { const Icon = item.icon; return <div className="settings-row" key={item.name}><span className="extension-icon"><Icon size={19} /></span><span><strong>{item.name}</strong><small>{item.detail}</small></span><button className="inspect-button">Inspect <CaretRight size={14} /></button><Toggle item={item} onChange={(enabled) => update(item.name, enabled)} /></div>; })}</div>
      <div className="policy-row"><Info size={17} /><span><strong>Managed policy is active</strong><small>Some capabilities may be controlled by your organization.</small></span><button>View policy</button></div>
      {tab === "MCP servers" && <button className="add-server"><Plus size={16} />Add MCP server</button>}
    </div>
  </main>;
}

export function App() {
  const [activeView, setActiveView] = useState("task");
  const [selectedAgent, setSelectedAgent] = useState("tests");
  const [taskStatus, setTaskStatus] = useState("running");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [runtimeNotice, setRuntimeNotice] = useState(null);
  useEffect(() => window.loom?.events.subscribe((event) => { if (event.type === "RuntimeError") setRuntimeNotice(event.payload); }), []);
  const content = useMemo(() => activeView === "review"
    ? <ReviewWorkspace inspectorOpen={inspectorOpen} setInspectorOpen={setInspectorOpen} />
    : activeView === "extensions"
      ? <ExtensionsWorkspace inspectorOpen={inspectorOpen} setInspectorOpen={setInspectorOpen} />
      : <Conversation taskStatus={taskStatus} setTaskStatus={setTaskStatus} setSelectedAgent={setSelectedAgent} inspectorOpen={inspectorOpen} setInspectorOpen={setInspectorOpen} />,
  [activeView, taskStatus, inspectorOpen]);
  return <div className={`loom-app view-${activeView} ${inspectorOpen ? "inspector-open" : ""}`}><Sidebar activeView={activeView} setActiveView={setActiveView} taskStatus={taskStatus} />{content}{activeView === "task" && <Inspector open={inspectorOpen} setOpen={setInspectorOpen} selectedAgent={selectedAgent} setSelectedAgent={setSelectedAgent} taskStatus={taskStatus} />}{runtimeNotice && <div className="runtime-toast"><Warning size={17} /><span><strong>Codex runtime needs attention</strong><small>{runtimeNotice.message}</small></span><IconButton label="Dismiss runtime error" onClick={() => setRuntimeNotice(null)}><X size={15} /></IconButton></div>}</div>;
}

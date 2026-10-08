import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createContextRecord, normalizeContextRecords } from "./context.js";
import "./ContextPicker.css";

const CATEGORIES = [
  ["all", "All"], ["file", "Files"], ["thread", "Threads"], ["skill", "Skills"], ["pull-request", "Pull requests"],
  ["terminal", "Terminal"], ["review", "Review"], ["preview", "Preview"], ["citation", "Quote"]
];
const KIND_LABEL = { file: "File", thread: "Thread", skill: "Skill", "pull-request": "Pull request", image: "Image", terminal: "Terminal excerpt", review: "Review selection", preview: "Preview annotation", citation: "Quotation" };
const EXCERPT_KINDS = ["terminal", "review", "preview", "citation"];
const EMPTY = Object.freeze([]);

function flattenSkills(value) {
  const entries = Array.isArray(value) ? value : Array.isArray(value?.skills) ? value.skills : [];
  return entries.flatMap(group => Array.isArray(group?.skills) ? group.skills : [group]).filter(Boolean).map(skill => ({
    name: skill.name || skill.displayName || skill.id || "Skill",
    path: skill.path || skill.filePath || skill.skillPath || skill.location?.path || skill.metadata?.path || skill.id || skill.name,
    description: skill.description || skill.shortDescription || ""
  })).filter(skill => skill.path);
}

function fileCandidates(result, scope) {
  const files = Array.isArray(result) ? result : result?.files ?? [];
  return files.map(file => createContextRecord("file", { label: file.relativePath || file.name || file.path, source: { ...scope, path: file.path, relativePath: file.relativePath, name: file.name } })).filter(Boolean);
}
function threadCandidates(result, scope) {
  const threads = Array.isArray(result) ? result : result?.data ?? [];
  return threads.filter(thread => thread?.id && thread.id !== scope.threadId).map(thread => createContextRecord("thread", {
    label: thread.name || thread.title || thread.preview || "Untitled thread",
    source: { ...scope, threadId: thread.id, title: thread.name || thread.title || thread.preview || "Untitled thread" }
  })).filter(Boolean);
}
function skillCandidates(result, scope) {
  return flattenSkills(result).map(skill => createContextRecord("skill", { label: skill.name, source: { ...scope, path: skill.path, name: skill.name }, ...(skill.description ? { text: skill.description } : {}) })).filter(Boolean);
}
function pullRequestCandidates(result, scope) {
  const requests = Array.isArray(result) ? result : result?.data || result?.pullRequests || (result?.number ? [result] : []);
  return requests.map(pr => createContextRecord("pull-request", {
    label: `#${pr.number} ${pr.title || "Pull request"}`,
    source: { ...scope, number: pr.number, url: pr.url || pr.html_url, title: pr.title, state: pr.isDraft ? "draft" : String(pr.state || "open").toLowerCase(), baseBranch: pr.baseRefName || pr.baseBranch || pr.base?.ref, headBranch: pr.headRefName || pr.headBranch || pr.head?.ref },
    ...(pr.body ? { text: pr.body } : {})
  })).filter(Boolean);
}

// The editor keeps focus when an @/# menu is open. The imperative keyboard
// adapter allows its Arrow/Enter/Escape handler to drive this same list.
export const ContextPicker = forwardRef(function ContextPicker({ api, projectId, threadId = null, hostId, threads = EMPTY, skills = EMPTY, contexts = EMPTY, currentPreview, query = "", marker = "@", kind: requestedKind = "all", listboxId, onSelect, onClose, onAttachFiles, autofocus = false }, ref) {
  const [kind, setKind] = useState(marker === "#" ? "pull-request" : requestedKind);
  const [search, setSearch] = useState(query);
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState([]);
  const [selection, setSelection] = useState(0);
  const [excerpt, setExcerpt] = useState("");
  const [label, setLabel] = useState("");
  const [sourceValue, setSourceValue] = useState("");
  const [comment, setComment] = useState("");
  const generation = useRef(0);
  const scope = useMemo(() => ({ projectId, ...(threadId ? { threadId } : {}), ...(hostId ? { hostId } : {}) }), [projectId, threadId, hostId]);
  const knownThreads = useMemo(() => threadCandidates(threads, scope), [threads, scope]);
  const knownSkills = useMemo(() => skillCandidates(skills, scope), [skills, scope]);
  useEffect(() => { setSearch(query); setSelection(0); }, [query]);
  useEffect(() => { setKind(marker === "#" ? "pull-request" : requestedKind); }, [marker, requestedKind]);
  useEffect(() => {
    if (kind !== "preview") return;
    const active = currentPreview?.active || currentPreview;
    if (active?.url || active?.path) setSourceValue(active.url || active.path);
    if (active?.title) setLabel(active.title);
  }, [kind, currentPreview]);
  useEffect(() => {
    const attempt = ++generation.current;
    setSelection(0);
    if (EXCERPT_KINDS.includes(kind)) { setLoading(false); setErrors([]); return; }
    setLoading(true);
    const timer = window.setTimeout(async () => {
      const tasks = [];
      const local = [];
      const notices = [];
      if (["all", "file"].includes(kind)) {
        if (api?.files?.list && projectId) tasks.push({ label: "Files", run: () => api.files.list({ projectId, ...(threadId ? { threadId } : {}), query: search, limit: 60 }), convert: fileCandidates });
        else if (kind === "file") notices.push("Project files are unavailable in this session.");
      }
      if (["all", "thread"].includes(kind)) {
        if (knownThreads.length) local.push(...knownThreads);
        else if (api?.threads?.list && projectId) tasks.push({ label: "Threads", run: () => api.threads.list({ projectId }), convert: threadCandidates });
        else if (kind === "thread") notices.push("Project threads are unavailable in this session.");
      }
      if (["all", "skill"].includes(kind)) {
        if (knownSkills.length) local.push(...knownSkills);
        else if (api?.extensions?.list && projectId) tasks.push({ label: "Skills", run: () => api.extensions.list({ projectId, ...(threadId ? { threadId } : {}) }), convert: skillCandidates });
        else if (kind === "skill") notices.push("Installed Skills are unavailable in this session.");
      }
      if (kind === "pull-request") {
        if (!api?.pullRequests?.list || !projectId || !threadId) notices.push("Pull requests require a saved task in a GitHub project.");
        else {
          tasks.push({ label: "Pull requests", run: async () => {
            const reference = search.trim().replace(/^#/, "");
            if (/^\d+$/.test(reference) && api.pullRequests.read) return api.pullRequests.read({ projectId, threadId, reference: `#${reference}` });
            return api.pullRequests.list({ projectId, threadId, state: "all" });
          }, convert: pullRequestCandidates });
        }
      }
      const results = await Promise.allSettled(tasks.map(task => task.run()));
      if (attempt !== generation.current) return;
      results.forEach((result, index) => {
        if (result.status === "fulfilled") local.push(...tasks[index].convert(result.value, scope));
        else notices.push(`${tasks[index].label}: ${result.reason?.message || "Could not load context. Try again."}`);
      });
      local.push(...normalizeContextRecords(contexts));
      // Apply the query before the record cap. Otherwise a large thread list
      // can evict a matching Skill or file before the visible list filters it.
      const needle = search.trim().toLowerCase();
      setCandidates(normalizeContextRecords(local.filter(record => !needle || `${record.label} ${record.source.path || ""} ${record.source.title || ""}`.toLowerCase().includes(needle))));
      setErrors(notices);
      setLoading(false);
    }, 120);
    return () => { window.clearTimeout(timer); generation.current++; };
  }, [api, scope, projectId, threadId, hostId, search, kind, knownThreads, knownSkills, contexts]);

  const filtered = useMemo(() => candidates.filter(record => (kind === "all" || record.kind === kind) && (!search.trim() || `${record.label} ${record.source.path || ""} ${record.source.title || ""}`.toLowerCase().includes(search.trim().toLowerCase()))).slice(0, 80), [candidates, kind, search]);
  useEffect(() => { setSelection(index => Math.min(index, Math.max(0, filtered.length - 1))); }, [filtered.length]);
  const choose = (record) => { if (record) onSelect?.(record); };
  const handleKeyDown = (event) => {
    if (EXCERPT_KINDS.includes(kind)) return false;
    if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setSelection(index => (index + (event.key === "ArrowDown" ? 1 : -1) + Math.max(1, filtered.length)) % Math.max(1, filtered.length)); return true; }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.metaKey && !event.ctrlKey) { event.preventDefault(); choose(filtered[selection]); return true; }
    if (event.key === "Escape") { event.preventDefault(); onClose?.(); return true; }
    return false;
  };
  useImperativeHandle(ref, () => ({ handleKeyDown, selectHighlighted: () => choose(filtered[selection]), moveSelection: delta => setSelection(index => (index + delta + Math.max(1, filtered.length)) % Math.max(1, filtered.length)) }));
  const addExcerpt = (event) => {
    event.preventDefault();
    if (!excerpt.trim()) return;
    const active = currentPreview?.active || currentPreview;
    const source = { ...scope, title: label.trim() || KIND_LABEL[kind] };
    if (kind === "review" && sourceValue.trim()) source.path = sourceValue.trim();
    else if (kind === "terminal" && sourceValue.trim()) source.terminalId = sourceValue.trim();
    else if (kind === "preview") { if (sourceValue.trim()) source.url = sourceValue.trim(); if (active?.id) source.tabId = active.id; }
    else if (kind === "citation" && sourceValue.trim()) source.url = sourceValue.trim();
    choose(createContextRecord(kind, { label: label.trim() || KIND_LABEL[kind], source, text: excerpt, ...(comment.trim() ? { comment } : {}) }));
  };

  return <section className="composer-context-picker" aria-label="Add context" onKeyDown={handleKeyDown}>
    <div className="composer-context-picker-heading"><span>Add context</span><button type="button" aria-label="Close context picker" onClick={onClose}>×</button></div>
    <div className="composer-context-categories" role="tablist" aria-label="Context kind">
      {CATEGORIES.map(([value, name]) => <button type="button" role="tab" aria-selected={kind === value} key={value} onClick={() => { setKind(value); setSelection(0); }}>{name}</button>)}
    </div>
    {EXCERPT_KINDS.includes(kind) ? <form className="composer-context-excerpt" onSubmit={addExcerpt}>
      <label>Label<input aria-label="Context label" value={label} onChange={event => setLabel(event.target.value)} maxLength={160} placeholder={KIND_LABEL[kind]} /></label>
      <label>{kind === "review" ? "File path" : kind === "terminal" ? "Terminal / session" : "Source URL"}<input aria-label="Context source" value={sourceValue} onChange={event => setSourceValue(event.target.value)} maxLength={4096} placeholder={kind === "review" ? "src/example.js" : kind === "terminal" ? "Build output" : "Optional source"} /></label>
      <label>{kind === "preview" ? "Selected page text or annotation" : "Selected source text"}<textarea aria-label="Selected source text" autoFocus={autofocus} value={excerpt} onChange={event => setExcerpt(event.target.value)} maxLength={32768} rows={5} placeholder="Paste the exact excerpt to include with your request" /></label>
      <label>Comment<input aria-label="Context comment" value={comment} onChange={event => setComment(event.target.value)} maxLength={4000} placeholder="Optional direction about this context" /></label>
      <button type="submit" className="composer-context-add" disabled={!excerpt.trim()}>Insert context</button>
    </form> : <>
      <input className="composer-context-search" aria-label="Search context" autoFocus={autofocus} value={search} onChange={event => setSearch(event.target.value)} placeholder={kind === "pull-request" ? "PR number or title…" : "Search files, threads, or Skills…"} />
      <div id={listboxId} className="composer-context-results" role="listbox" aria-label="Context results">
        {filtered.map((record, index) => <button type="button" role="option" aria-selected={selection === index} key={`${record.kind}:${record.id}`} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setSelection(index)} onClick={() => choose(record)}>
          <span className="composer-context-kind">{KIND_LABEL[record.kind] || record.kind}</span><span className="composer-context-result-name">{record.label}</span>
          {record.kind === "pull-request" && <span className="composer-context-result-detail">{record.source.state}</span>}
        </button>)}
        {loading && <p role="status">Loading context…</p>}
        {!loading && !filtered.length && <p>No matching context.</p>}
      </div>
      {errors.length > 0 && <div className="composer-context-errors" role="status">{errors.map(error => <p key={error}>{error}</p>)}</div>}
    </>}
    {onAttachFiles && <button type="button" className="composer-context-attach" onClick={onAttachFiles}>Attach images or files…</button>}
    <div className="composer-context-picker-footnote">Context is inserted at the cursor. Thread history is read only when needed.</div>
  </section>;
});

export function ContextInspector({ record, onChange, onClose, onSourceOpen, onRemove }) {
  if (!record) return null;
  const source = record.source || {};
  const sourceLabel = source.path || source.url || source.title || source.threadId || source.terminalId || "Source captured with this excerpt";
  return <section className="composer-context-inspector" role="dialog" aria-label={`Context: ${record.label}`}>
    <div className="composer-context-picker-heading"><span>{record.label}</span><button type="button" aria-label="Close context details" onClick={onClose}>×</button></div>
    <div className="composer-context-source"><span>{KIND_LABEL[record.kind || record.type]}</span><span>{sourceLabel}</span>{source.rangeLabel && <span>{source.rangeLabel}</span>}</div>
    {record.text && <pre className="composer-context-source-text">{record.text}</pre>}
    {record.diff && <pre className="composer-context-source-text">{record.diff}</pre>}
    <label className="composer-context-comment">Comment<textarea aria-label="Comment on context" value={record.comment || ""} maxLength={4000} rows={2} onChange={event => onChange?.({ ...record, comment: event.target.value })} placeholder="Add direction without changing the quoted source" /></label>
    <div className="composer-context-inspector-actions">
      {onSourceOpen && <button type="button" onClick={() => onSourceOpen(record)}>Open source</button>}
      {onRemove && <button type="button" onClick={() => onRemove(record)}>Remove context</button>}
    </div>
  </section>;
}

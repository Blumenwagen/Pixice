import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, GitBranch, Warning, Check, X, Eye, Plus } from "./icons/index.jsx";
import "./PullRequestWorkspace.css";

function when(value) { return value ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""; }
function prState(pr) { return pr?.state === "merged" ? "Merged" : pr?.state === "closed" ? "Closed" : pr?.isDraft ? "Draft" : "Open"; }
function DiffBody({ value }) {
  const lines = value.split("\n");
  return <pre className="pr-diff" aria-label="Pull request diff">{value.length > 256_000 || lines.length > 10_000 ? value : lines.map((line, index) => <span key={index} className={line.startsWith("+") && !line.startsWith("+++") ? "is-added" : line.startsWith("-") && !line.startsWith("---") ? "is-removed" : line.startsWith("@@") ? "is-hunk" : ""}>{line || " "}{"\n"}</span>)}</pre>;
}
function splitDiff(diff) {
  return diff.split(/(?=^diff --git )/m).filter(Boolean).map((body, index) => {
    const file = body.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? body.match(/^--- a\/(.+)$/m)?.[1] ?? `Change ${index + 1}`;
    return { path: file, body };
  });
}

/** A thread-owned Preview tab, with T3's native delivery and linked review workflow. */
export function PullRequestWorkspace({ api, projectId, threadId, initialUrl = null, onOpenUrl, onError }) {
  const client = api?.pullRequests;
  const scope = { projectId, threadId };
  const [workspace, setWorkspace] = useState(null), [prs, setPrs] = useState([]), [view, setView] = useState("changes");
  const [detail, setDetail] = useState(null), [selectedUrl, setSelectedUrl] = useState(initialUrl), [detailTab, setDetailTab] = useState("overview");
  const [listState, setListState] = useState("open"), [selectedPaths, setSelectedPaths] = useState([]);
  const [message, setMessage] = useState(""), [linkReference, setLinkReference] = useState("");
  const [title, setTitle] = useState(""), [body, setBody] = useState(""), [base, setBase] = useState(""), [draft, setDraft] = useState(true), [creating, setCreating] = useState(false);
  const [writing, setWriting] = useState(null), [comment, setComment] = useState(""), [verdict, setVerdict] = useState("comment"), [mergeMethod, setMergeMethod] = useState("squash");
  const [diff, setDiff] = useState(null), [diffPath, setDiffPath] = useState(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(null), [notice, setNotice] = useState(null);
  const mounted = useRef(true), generation = useRef(0), detailRequest = useRef(0);
  const onErrorRef = useRef(onError); onErrorRef.current = onError;
  const fail = useCallback((cause) => { setError(cause?.message || "This pull request action could not finish."); onErrorRef.current?.(cause); }, []);
  const refresh = useCallback(async () => {
    if (!client || !projectId || !threadId) { setLoading(false); return; }
    const current = generation.current;
    const results = await Promise.allSettled([client.workspace({ projectId, threadId }), client.list({ projectId, threadId, state: listState })]);
    if (!mounted.current || current !== generation.current) return;
    if (results[0].status === "fulfilled") {
      const next = results[0].value; setWorkspace(next); setBase((value) => value || next.repository?.defaultBranchRef?.name || "main");
      setSelectedPaths((paths) => paths.filter((path) => next.files.some((file) => file.path === path)));
    } else fail(results[0].reason);
    if (results[1].status === "fulfilled") { setPrs(results[1].value); setNotice(null); }
    else setNotice(results[1].reason?.message || "GitHub pull requests are unavailable.");
    setLoading(false);
  }, [client, projectId, threadId, listState, fail]);
  useEffect(() => {
    mounted.current = true; generation.current++; setWorkspace(null); setPrs([]); setDetail(null); setSelectedUrl(initialUrl);
    setSelectedPaths([]); setBusy(false); setError(null); setNotice(null); setMessage(""); setTitle(""); setBody(""); setBase(""); setCreating(false); setWriting(null); setLoading(true);
    setView(initialUrl ? "requests" : "changes");
    return () => { mounted.current = false; generation.current++; detailRequest.current++; };
  }, [projectId, threadId, initialUrl]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const subscribe = api?.events?.subscribe ?? api?.onEvent;
    let timer;
    const off = subscribe?.((event) => {
      if (event.type !== "PullRequestsUpdated" || event.payload?.projectId !== projectId || event.payload?.threadId !== threadId) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void refresh();
        if (selectedUrl && client) {
          const request = ++detailRequest.current;
          client.read({ projectId, threadId, reference: selectedUrl }).then((value) => { if (mounted.current && request === detailRequest.current) setDetail(value); }).catch((cause) => { if (mounted.current && request === detailRequest.current) fail(cause); });
        }
      }, 100);
    });
    return () => { off?.(); clearTimeout(timer); };
  }, [api, client, projectId, threadId, selectedUrl, refresh, fail]);
  useEffect(() => {
    setDetail(null); setDiff(null); setDiffPath(null); setWriting(null); setComment("");
    if (!selectedUrl || !client) return;
    const request = ++detailRequest.current;
    client.read({ projectId, threadId, reference: selectedUrl }).then((value) => {
      if (mounted.current && request === detailRequest.current) setDetail(value);
    }).catch((cause) => { if (mounted.current && request === detailRequest.current) fail(cause); });
  }, [client, projectId, threadId, selectedUrl, fail]);
  useEffect(() => {
    if (detailTab !== "code" || !selectedUrl || !client) return;
    let current = true; setDiff(null);
    client.diff({ projectId, threadId, url: selectedUrl }).then((value) => { if (current) setDiff(value); }).catch((cause) => { if (current) fail(cause); });
    return () => { current = false; };
  }, [client, projectId, threadId, selectedUrl, detailTab, detail?.headSha, fail]);
  const perform = async (action, success, refreshAfter = true) => {
    if (busy) return; const current = generation.current;
    setBusy(true); setError(null);
    try {
      const result = await action();
      if (mounted.current && current === generation.current) { success?.(result); if (refreshAfter) await refresh(); }
    } catch (cause) { if (mounted.current && current === generation.current) fail(cause); }
    finally { if (mounted.current && current === generation.current) setBusy(false); }
  };
  const open = (pr) => { setSelectedUrl(pr.url); setDetailTab("overview"); setView("requests"); setError(null); };
  const linked = workspace?.links?.find((link) => link.url === selectedUrl), watch = linked?.watch;
  const mutate = (action, extra = {}) => perform(() => client.update({ ...scope, url: detail.url, action, ...extra }), (result) => { setDetail(result); setWriting(null); setComment(""); if (result.warning) setError(result.warning); });
  const code = diff ? splitDiff(diff.diff) : [], activeDiff = code.find((part) => part.path === diffPath) ?? code[0];
  const visiblePrs = view === "linked" ? workspace?.links?.map((link) => ({ ...link, ...link.snapshot })) ?? [] : prs;
  const canWrite = workspace?.canWrite !== false, disabled = busy || !canWrite;
  if (!client) return <div className="pr-workspace pr-unavailable"><h2>Pull requests</h2><p>This host does not support the native pull request workspace yet.</p></div>;
  return <section className="pr-workspace" aria-label="Pull request workspace">
    <header className="pr-workspace-header"><div><GitBranch size={18} /><strong>Pull requests</strong><span>{workspace?.repository?.nameWithOwner ?? workspace?.branch ?? ""}</span></div><button type="button" className="pr-icon-button" aria-label="Refresh pull requests" disabled={busy} onClick={() => void perform(async () => {
      await refresh();
      if (selectedUrl) { const request = ++detailRequest.current; const value = await client.read({ ...scope, reference: selectedUrl }); if (mounted.current && request === detailRequest.current) setDetail(value); }
    }, null, false)}><ArrowClockwise size={16} /></button></header>
    <nav className="pr-workspace-tabs" aria-label="Pull request views">{[["changes", "Deliver changes"], ["requests", "Pull requests"], ["linked", `Linked${workspace?.links?.length ? ` · ${workspace.links.length}` : ""}`]].map(([id, label]) => <button type="button" key={id} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}</nav>
    {error && <div className="pr-banner is-error" role="alert"><Warning size={15} /><span>{error}</span><button type="button" aria-label="Dismiss pull request error" onClick={() => setError(null)}><X size={13} /></button></div>}
    {loading && <p className="pr-empty" role="status">Loading repository…</p>}
    {!loading && view === "changes" && <div className="pr-delivery-scroll">
      <div className="pr-delivery-heading"><h2>{workspace?.branch || "Detached checkout"}</h2><p>{workspace?.ahead ?? 0} commits ahead{workspace?.behind ? ` · ${workspace.behind} behind` : ""}{!canWrite ? " · Read-only access" : ""}</p></div>
      <section className="pr-delivery-section"><div className="pr-section-heading"><h3>Changes <span>{workspace?.files?.length ?? 0}</span></h3>{workspace?.files?.length > 0 && <label><input type="checkbox" aria-label="Select all changed files" disabled={disabled} checked={selectedPaths.length === workspace.files.length} onChange={(event) => setSelectedPaths(event.target.checked ? workspace.files.map((file) => file.path) : [])} />Select all</label>}</div>
        {!workspace?.files?.length && <p className="pr-muted">The working tree is clean.</p>}
        <div className="pr-local-files">{workspace?.files?.map((file) => <label key={file.path}><input type="checkbox" aria-label={`Select ${file.path}`} disabled={disabled} checked={selectedPaths.includes(file.path)} onChange={(event) => setSelectedPaths((paths) => event.target.checked ? [...paths, file.path] : paths.filter((path) => path !== file.path))} /><code>{file.path}</code><span>{file.status.trim()}</span></label>)}</div>
        <form className="pr-commit-form" onSubmit={(event) => { event.preventDefault(); void perform(() => client.commit({ ...scope, message, paths: selectedPaths }), () => { setMessage(""); setSelectedPaths([]); }); }}>
          <label htmlFor={`pr-commit-${threadId}`}>Commit message</label><textarea id={`pr-commit-${threadId}`} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Describe the change" rows={2} disabled={disabled} />
          <button type="submit" disabled={disabled || !message.trim() || !selectedPaths.length}>Commit {selectedPaths.length ? `${selectedPaths.length} selected file${selectedPaths.length === 1 ? "" : "s"}` : "selected files"}</button>
        </form>
      </section>
      <section className="pr-delivery-section pr-push"><div><h3>Push branch</h3><p className="pr-muted">{workspace?.branch ? `${workspace.branch} → origin/${workspace.branch}` : "Choose a branch before publishing changes."}</p></div><button type="button" disabled={disabled || !workspace?.branch} onClick={() => void perform(() => client.push(scope))}>Push to origin</button></section>
      <section className="pr-delivery-section"><div className="pr-section-heading"><h3>Create pull request</h3><button type="button" disabled={disabled || !workspace?.branch} onClick={() => setCreating(!creating)}>{creating ? "Cancel" : "Prepare pull request"}</button></div>
        {workspace?.githubError && <p className="pr-muted">{workspace.githubError}</p>}
        {creating && <form className="pr-create-form" onSubmit={(event) => { event.preventDefault(); void perform(() => client.create({ ...scope, title, body, base, draft }), (result) => { setCreating(false); setTitle(""); setBody(""); open(result.detail); if (result.warning) setError(result.warning); }); }}>
          <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={1000} /></label><label>Description<textarea value={body} onChange={(event) => setBody(event.target.value)} rows={7} /></label>
          <div className="pr-form-row"><label>Base branch<input value={base} onChange={(event) => setBase(event.target.value)} required /></label><label className="pr-checkbox"><input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} />Draft pull request</label></div>
          <button type="submit" disabled={disabled || !title.trim() || !base.trim()}>Create {draft ? "draft " : ""}pull request</button>
        </form>}
      </section>
    </div>}
    {!loading && view !== "changes" && <div className="pr-review-layout">
      <aside className="pr-list" aria-label={view === "linked" ? "Linked pull requests" : "Repository pull requests"}>
        <form className="pr-link-form" onSubmit={(event) => { event.preventDefault(); void perform(() => client.link({ ...scope, reference: linkReference.trim() }), (result) => { setLinkReference(""); open(result.detail); }); }}><input aria-label="Pull request URL or number" value={linkReference} onChange={(event) => setLinkReference(event.target.value)} placeholder="PR URL or number" /><button type="submit" aria-label="Link pull request" disabled={busy || !linkReference.trim()}><Plus size={14} /></button></form>
        {view === "requests" && <select aria-label="Pull request state" value={listState} onChange={(event) => setListState(event.target.value)}><option value="open">Open</option><option value="merged">Merged</option><option value="closed">Closed</option><option value="all">All pull requests</option></select>}
        {notice && <p className="pr-muted pr-list-notice">{notice}</p>}
        {!visiblePrs.length && <p className="pr-empty">{view === "linked" ? "Link a pull request to keep it with this chat." : "No pull requests found."}</p>}
        {visiblePrs.map((pr) => <button type="button" className="pr-list-row" key={pr.url} aria-label={`#${pr.number} ${pr.title || "Pull request"}`} aria-pressed={selectedUrl === pr.url} onClick={() => open(pr)}><strong>{pr.title || `Pull request #${pr.number}`}</strong><div className="pr-list-meta">#{pr.number} · {prState(pr)}{pr.watch?.active && <Eye size={12} aria-label="Watching" />}</div></button>)}
      </aside>
      <div className="pr-review-main">
        {!selectedUrl ? <p className="pr-empty">Select a pull request to see its checks, conversation, and changes.</p> : !detail ? <p className="pr-empty" role="status">Loading pull request…</p> : <>
          <header className="pr-detail-header"><div><span className={`pr-state is-${detail.state}`}>{prState(detail)}</span><h2>{detail.title}</h2><p>#{detail.number} · {detail.headBranch} → {detail.baseBranch}{detail.reviewDecision ? ` · ${detail.reviewDecision.toLowerCase().replace(/_/g, " ")}` : ""}</p></div>
            <div className="pr-detail-actions"><button type="button" onClick={() => onOpenUrl ? onOpenUrl(detail.url) : window.open(detail.url, "_blank", "noopener,noreferrer")}>Open on GitHub</button>
              <button type="button" disabled={busy} onClick={() => void perform(() => linked ? client.unlink({ ...scope, url: detail.url }) : client.link({ ...scope, reference: detail.url }))}>{linked ? "Unlink" : "Link to chat"}</button>
              {linked && detail.state === "open" && <button type="button" aria-pressed={Boolean(watch?.active)} disabled={busy || (!watch?.active && !workspace?.canWatch)} onClick={() => void perform(() => watch?.active ? client.stopWatch({ ...scope, url: detail.url }) : client.watch({ ...scope, reference: detail.url }))}><Eye size={14} />{watch?.active ? "Stop watching" : "Watch"}</button>}
            </div>
          </header>
          {watch?.active && <div className="pr-watch-status" role="status"><Eye size={13} />Watching for check results, reviews, comments, and conflicts.{watch.pauseUntil > Date.now() ? " GitHub rate limit; resuming automatically." : ""}</div>}
          {watch && !watch.active && watch.stoppedReason && watch.stoppedReason !== "stopped" && <p className="pr-watch-status">Watch ended: {watch.stoppedReason.replace(/-/g, " ")}.</p>}
          <nav className="pr-detail-tabs" aria-label="Pull request details">{[["overview", "Overview"], ["checks", `Checks · ${detail.checks.length}`], ["discussion", `Conversation · ${detail.comments.length + detail.reviews.length + detail.inlineComments.length}`], ["code", `Code · ${detail.files.length}`]].map(([id, label]) => <button type="button" key={id} aria-pressed={detailTab === id} onClick={() => setDetailTab(id)}>{label}</button>)}</nav>
          {detailTab === "overview" && <div className="pr-detail-scroll"><div className="pr-description">{detail.body || "No description provided."}</div><dl className="pr-facts"><div><dt>Author</dt><dd>{detail.author?.login ?? "Unknown"}</dd></div><div><dt>Branch</dt><dd>{detail.mergeability === "conflicting" ? "Conflicts with base branch" : detail.mergeability === "clean" ? "No merge conflicts" : "Checking mergeability"}</dd></div><div><dt>Updated</dt><dd>{when(detail.updatedAt)}</dd></div></dl>
            <div className="pr-action-row">{detail.state === "open" && <><button type="button" disabled={disabled} onClick={() => void mutate(detail.isDraft ? "ready" : "draft")}>{detail.isDraft ? "Mark ready for review" : "Convert to draft"}</button><button type="button" disabled={disabled} onClick={() => { setWriting(writing === "edit" ? null : "edit"); setTitle(detail.title); setBody(detail.body); }}>Edit title and description</button><button type="button" disabled={disabled} onClick={() => void mutate("close")}>Close pull request</button><button type="button" disabled={disabled || detail.isDraft || detail.mergeability === "conflicting" || !detail.headSha} onClick={() => setWriting(writing === "merge" ? null : "merge")}>Merge…</button></>}{detail.state === "closed" && <button type="button" disabled={disabled} onClick={() => void mutate("reopen")}>Reopen pull request</button>}</div>
            {writing === "edit" && <form className="pr-create-form" onSubmit={(event) => { event.preventDefault(); void mutate("edit", { title, body }); }}><label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>Description<textarea rows={8} value={body} onChange={(event) => setBody(event.target.value)} /></label><button type="submit" disabled={disabled || !title.trim()}>Save pull request</button></form>}
            {writing === "merge" && <form className="pr-merge-confirm" onSubmit={(event) => { event.preventDefault(); void mutate("merge", { method: mergeMethod, expectedHeadSha: detail.headSha }); }}><p>Merge #{detail.number} into <strong>{detail.baseBranch}</strong> at commit <code>{detail.headSha.slice(0, 7)}</code>.</p><select aria-label="Merge method" value={mergeMethod} onChange={(event) => setMergeMethod(event.target.value)}><option value="squash">Squash and merge</option><option value="merge">Create a merge commit</option><option value="rebase">Rebase and merge</option></select><button type="submit" disabled={disabled}>Confirm merge</button><button type="button" onClick={() => setWriting(null)}>Cancel</button></form>}
          </div>}
          {detailTab === "checks" && <div className="pr-detail-scroll"><h3 className="pr-section-title">{detail.checks.length ? "Checks on the current commit" : "No checks reported"}</h3>{detail.checks.map((check, index) => <div className="pr-check-row" key={`${check.name}:${index}`}><span className={`pr-check-state is-${check.status}`}>{check.status === "success" ? <Check size={15} /> : check.status === "pending" ? <span className="pr-check-pending" /> : <Warning size={15} />}</span><div><strong>{check.name}</strong><small>{check.required ? "Required · " : ""}{check.status.replace(/-/g, " ")}</small></div>{check.url && <button type="button" onClick={() => onOpenUrl ? onOpenUrl(check.url) : window.open(check.url, "_blank", "noopener,noreferrer")}>Details</button>}</div>)}</div>}
          {detailTab === "discussion" && <div className="pr-detail-scroll"><div className="pr-remarks">{[...detail.comments, ...detail.reviews, ...detail.inlineComments].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map((remark) => <article key={remark.id}><header><strong>{remark.author?.login ?? "Someone"}</strong><span>{remark.reviewState?.toLowerCase().replace(/_/g, " ") || remark.kind} · {when(remark.createdAt)}</span></header>{remark.path && <code className="pr-remark-path">{remark.path}</code>}<p>{remark.body || remark.reviewState?.toLowerCase().replace(/_/g, " ") || "Reviewed"}</p></article>)}</div>{!detail.activityComplete && <p className="pr-muted">Some inline conversation may be unavailable. Open GitHub to see the full history.</p>}
            {detail.state === "open" && <form className="pr-comment-form" onSubmit={(event) => { event.preventDefault(); void mutate(verdict === "comment" ? "comment" : "review", { body: comment, verdict }); }}><label htmlFor={`pr-comment-${threadId}`}>Comment or review</label><textarea id={`pr-comment-${threadId}`} value={comment} onChange={(event) => setComment(event.target.value)} rows={4} disabled={disabled} placeholder="Write a comment" /><div className="pr-form-row"><select aria-label="Review verdict" value={verdict} onChange={(event) => setVerdict(event.target.value)} disabled={disabled}><option value="comment">Comment</option><option value="approve" disabled={detail.author?.login === detail.viewer}>Approve</option><option value="request-changes" disabled={detail.author?.login === detail.viewer}>Request changes</option></select><button type="submit" disabled={disabled || (verdict !== "approve" && !comment.trim())}>{verdict === "comment" ? "Post comment" : "Submit review"}</button></div></form>}
          </div>}
          {detailTab === "code" && <div className="pr-code-layout">{!diff ? <p className="pr-empty" role="status">Loading changes…</p> : <><aside className="pr-changed-files" aria-label="Pull request changed files">{code.map((part) => <button type="button" key={part.path} aria-pressed={activeDiff?.path === part.path} onClick={() => setDiffPath(part.path)}>{part.path}</button>)}</aside><div className="pr-code-body"><header><code>{activeDiff?.path ?? "No file changes"}</code>{diff.truncated && <span>Diff truncated · open GitHub for all changes</span>}</header>{activeDiff && <DiffBody value={activeDiff.body} />}</div></>}</div>}
        </>}
      </div>
    </div>}
    {busy && <div className="pr-working" role="status">Working…</div>}
  </section>;
}

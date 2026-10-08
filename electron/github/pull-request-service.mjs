import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { detectGitRuntime } from "../git/git-runtime.mjs";

const execFile = promisify(execFileCallback);
const DETAIL_FIELDS = "number,url,title,body,state,isDraft,author,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,comments,reviews,files,commits,updatedAt,createdAt";
const LIST_FIELDS = "number,url,title,state,isDraft,author,baseRefName,headRefName,headRefOid,mergeable,reviewDecision,updatedAt";
const MAX_LINKS = 2_000;
const MAX_WATCHES = 500;

function text(value, limit = 100_000) { return typeof value === "string" ? value.slice(0, limit) : ""; }
function nonempty(value, name, limit = 10_000) {
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0")) throw new Error(`${name} is invalid`);
  return value.trim();
}
export function parsePullRequestUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Use a GitHub pull request URL"); }
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || !match) {
    throw new Error("Use an https://github.com/owner/repository/pull/number URL");
  }
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) throw new Error("Pull request number is invalid");
  return { owner: match[1], repository: match[2], repo: `${match[1]}/${match[2]}`, number, url: `https://github.com/${match[1]}/${match[2]}/pull/${number}`, key: `${match[1]}/${match[2]}#${number}`.toLowerCase() };
}
function json(output) {
  try { return JSON.parse(output.stdout); } catch { throw new Error("GitHub returned an unreadable response"); }
}
function actor(value) { return value?.login ? { login: text(value.login, 100), url: text(value.url, 2_000) || null } : null; }
export function normalizePullRequestCheck(check, requiredNames = []) {
  const name = text(check.name ?? check.context, 500) || "Unnamed check";
  const status = String(check.conclusion || check.state || check.status || "PENDING").toUpperCase();
  const normalized = ["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE", "STALE"].includes(status) ? "failure"
    : status === "CANCELLED" ? "cancelled"
      : status === "ACTION_REQUIRED" ? "action-required"
        : ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(status) ? "success" : "pending";
  return { name, status: normalized, required: requiredNames.includes(name), url: text(check.detailsUrl ?? check.targetUrl, 2_000) || null };
}
function remark(value, kind = "comment") {
  return { id: String(value.id ?? `${kind}:${value.url ?? value.databaseId}`), kind, body: text(value.body, 30_000), author: actor(value.author ?? value.user),
    createdAt: value.createdAt ?? value.created_at ?? value.submittedAt ?? value.submitted_at,
    editedAt: value.updatedAt ?? value.updated_at ?? value.lastEditedAt ?? null, url: value.url ?? value.html_url ?? null,
    path: value.path ?? null, reviewState: value.state ?? null };
}
export function normalizePullRequest(raw, { viewer = null, requiredNames = [], inlineComments = [] } = {}) {
  const ref = parsePullRequestUrl(raw.url);
  return { ...ref, title: text(raw.title, 1_000), body: text(raw.body), state: String(raw.state ?? "OPEN").toLowerCase(), isDraft: Boolean(raw.isDraft),
    author: actor(raw.author), viewer, baseBranch: text(raw.baseRefName, 1_000), headBranch: text(raw.headRefName, 1_000), headSha: raw.headRefOid ?? null,
    mergeability: String(raw.mergeable).toUpperCase() === "CONFLICTING" || raw.mergeStateStatus === "DIRTY" ? "conflicting" : String(raw.mergeable).toUpperCase() === "MERGEABLE" ? "clean" : "unknown",
    reviewDecision: raw.reviewDecision ?? null, updatedAt: raw.updatedAt ?? null, createdAt: raw.createdAt ?? null,
    checks: (raw.statusCheckRollup ?? []).slice(0, 500).map((check) => normalizePullRequestCheck(check, requiredNames)),
    comments: (raw.comments ?? []).slice(-200).map((value) => remark(value)),
    reviews: (raw.reviews ?? []).slice(-200).map((value) => remark(value, "review")),
    inlineComments: inlineComments.slice(-200).map((value) => remark(value, "inline")),
    files: (raw.files ?? []).slice(0, 1_000).map((file) => ({ path: text(file.path, 10_000), additions: file.additions ?? 0, deletions: file.deletions ?? 0 })),
    commits: (raw.commits ?? []).slice(-200).map((commit) => ({ sha: commit.oid, message: text(commit.messageHeadline, 1_000), committedAt: commit.committedDate })),
    truncated: { comments: (raw.comments?.length ?? 0) > 200, files: (raw.files?.length ?? 0) > 1_000, inlineComments: inlineComments.length >= 200 },
    activityComplete: inlineComments.length < 200 };
}
export function emptyPullRequestState() { return { version: 1, links: [], watches: [] }; }
function persistedState(value) {
  if (value?.version !== 1) return emptyPullRequestState();
  const identity = (entry) => typeof entry?.threadId === "string" && typeof entry.projectId === "string" && entry.threadId.length <= 1_000 && entry.projectId.length <= 1_000;
  const links = [], watches = [], linkKeys = new Set(), watchKeys = new Set();
  for (const link of (Array.isArray(value.links) ? value.links : []).slice(-MAX_LINKS)) {
    if (!identity(link)) continue;
    try {
      const ref = parsePullRequestUrl(link.url), key = `${link.threadId}:${ref.key}`;
      if (linkKeys.has(key)) continue;
      linkKeys.add(key); links.push({ projectId: link.projectId, threadId: link.threadId, ...ref, linkedAt: link.linkedAt, snapshot: link.snapshot ?? null });
    } catch { /* A malformed attachment must not affect other saved chats. */ }
  }
  for (const watch of (Array.isArray(value.watches) ? value.watches : []).slice(-MAX_WATCHES)) {
    if (!identity(watch) || !watch.cursor || !Number.isFinite(Date.parse(watch.startedAt))) continue;
    try {
      const ref = parsePullRequestUrl(watch.url), id = `${watch.threadId}:${ref.key}`;
      if (watchKeys.has(id)) continue;
      watchKeys.add(id);
      const cursor = watch.cursor, names = (array) => (Array.isArray(array) ? array : []).filter((entry) => typeof entry === "string").slice(-500).map((entry) => entry.slice(0, 1_000));
      const pending = watch.pending?.eventId?.startsWith?.("pr-watch:") && typeof watch.pending.message === "string"
        ? { eventId: text(watch.pending.eventId, 100), message: text(watch.pending.message, 20_000), summary: text(watch.pending.summary, 1_000), kinds: names(watch.pending.kinds), createdAt: watch.pending.createdAt } : null;
      watches.push({ ...watch, id, ...ref, active: watch.active === true, permissionMode: ["read-only", "workspace-write", "auto-approve", "full-access"].includes(watch.permissionMode) ? watch.permissionMode : "read-only", failures: Math.max(0, Math.min(8, Number(watch.failures) || 0)),
        pauseUntil: Number.isFinite(watch.pauseUntil) ? watch.pauseUntil : null, pending,
        cursor: { startedAt: watch.startedAt, headSha: text(cursor.headSha, 100) || null, failedChecks: names(cursor.failedChecks), passed: cursor.passed === true, passedChecks: names(cursor.passedChecks),
          remarksThrough: Number.isFinite(Date.parse(cursor.remarksThrough)) ? cursor.remarksThrough : watch.startedAt, remarkIds: names(cursor.remarkIds).slice(-200), conflicting: cursor.conflicting === true, wakes: Math.max(0, Math.min(10, Number(cursor.wakes) || 0)) } });
    } catch { /* Skip invalid watches instead of sending their contents to a provider. */ }
  }
  return { version: 1, links, watches };
}

/** Native delivery/reference model: T3 source-control workspace and linked PR ownership. */
export class PullRequestService {
  constructor({ githubCli, resolveContext, loadState = () => null, saveState = () => {}, emit = () => {}, runGit = execFile, gitExecutablePath = null, now = () => Date.now() } = {}) {
    if (!githubCli || typeof resolveContext !== "function") throw new Error("Pull request service needs GitHub and project context");
    this.github = githubCli; this.resolveContext = resolveContext; this.saveState = saveState; this.emit = emit;
    this.runGit = runGit; this.gitExecutablePath = gitExecutablePath; this.now = now;
    this.state = persistedState(loadState()); this.locks = new Map(); this.account = null; this.accountReadAt = 0;
  }
  async context(input, { write = false } = {}) {
    nonempty(input?.projectId, "Project identity"); nonempty(input?.threadId, "Chat identity");
    const context = await this.resolveContext({ projectId: input.projectId, threadId: input.threadId });
    if (!context || context.projectId !== input.projectId || context.threadId !== input.threadId || !path.isAbsolute(context.cwd ?? "")) throw new Error("This chat does not belong to the selected project");
    if (write && !["workspace-write", "auto-approve", "full-access"].includes(context.permissionMode)) throw new Error("This chat has read-only access");
    return context;
  }
  async git(context, args, options = {}) {
    if (!this.gitExecutablePath) {
      const runtime = await detectGitRuntime();
      if (!runtime.available) throw new Error(runtime.message);
      this.gitExecutablePath = runtime.executablePath;
    }
    return this.runGit(this.gitExecutablePath, args, { cwd: context.cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, ...options });
  }
  async gh(context, args, options) { return this.github.execute(args, { cwd: context.cwd, ...options }); }
  async viewer(context) {
    if (!this.accountReadAt || this.now() - this.accountReadAt > 5 * 60_000) {
      try { this.account = json(await this.gh(context, ["api", "user"]))?.login ?? null; this.accountReadAt = this.now(); }
      catch { this.account = null; }
    }
    return this.account;
  }
  persist() { this.saveState(structuredClone(this.state)); }
  changed(input) { this.emit({ projectId: input.projectId, threadId: input.threadId }); }
  links(input) { return this.state.links.filter((link) => link.projectId === input.projectId && link.threadId === input.threadId).map((link) => ({ ...link, watch: this.state.watches.find((watch) => watch.threadId === link.threadId && watch.key === link.key) ?? null })); }
  watchRecords() { return structuredClone(this.state.watches.filter((watch) => watch.active)); }
  setWatch(watch) {
    const index = this.state.watches.findIndex((existing) => existing.id === watch.id);
    if (index >= 0) this.state.watches[index] = watch;
    else this.state.watches.push(watch);
    while (this.state.watches.length > MAX_WATCHES) {
      const inactive = this.state.watches.findIndex((entry) => !entry.active);
      if (inactive < 0) throw new Error("The server has reached its active watch limit");
      this.state.watches.splice(inactive, 1);
    }
    this.persist(); this.changed(watch);
  }
  async read(input) {
    const context = await this.context(input);
    const reference = nonempty(input.reference ?? input.url, "Pull request reference", 2_000);
    if (reference.startsWith("http")) parsePullRequestUrl(reference);
    else if (!/^[1-9]\d*$/.test(reference)) throw new Error("Choose a pull request number or GitHub URL");
    const raw = json(await this.gh(context, ["pr", "view", reference, "--json", DETAIL_FIELDS]));
    const ref = parsePullRequestUrl(raw.url);
    const [viewer, inline, checkContexts] = await Promise.allSettled([
      this.viewer(context),
      this.gh(context, ["api", `repos/${ref.repo}/pulls/${ref.number}/comments?per_page=100`, "--paginate", "--slurp"]),
      this.readCheckContexts(context, ref)
    ]);
    const inlineComments = inline.status === "fulfilled" ? json(inline.value).flat().slice(-200) : [];
    const checks = checkContexts.status === "fulfilled" && checkContexts.value.headSha === raw.headRefOid ? checkContexts.value : null;
    const detail = normalizePullRequest(raw, { viewer: viewer.status === "fulfilled" ? viewer.value : null, inlineComments });
    detail.checksComplete = Boolean(checks?.complete);
    if (checks) detail.checks = checks.nodes.map((check) => ({ ...normalizePullRequestCheck(check), required: check.isRequired === true }));
    // Failed/incomplete metadata must never announce that all required checks passed.
    if (!detail.checksComplete) detail.checks.push({ name: "Check status could not be fully verified", status: "pending", required: true, url: null });
    detail.activityComplete = inline.status === "fulfilled" && !detail.truncated.inlineComments;
    const link = this.state.links.find((entry) => entry.projectId === input.projectId && entry.threadId === input.threadId && entry.key === detail.key);
    if (link) { link.snapshot = this.snapshot(detail); this.persist(); }
    return detail;
  }
  async readCheckContexts(context, ref) {
    // T3's github.com selection asks the host about required checks, including rulesets.
    const query = `query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100,after:$after){nodes{__typename ... on StatusContext{context state targetUrl isRequired(pullRequestNumber:$number)} ... on CheckRun{name status conclusion detailsUrl isRequired(pullRequestNumber:$number)}} pageInfo{hasNextPage endCursor}}}}}}}}}`;
    let after = null, headSha = null; const nodes = [];
    for (let page = 0; page < 5; page++) {
      const result = json(await this.gh(context, ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${ref.owner}`, "-f", `repo=${ref.repository}`, "-F", `number=${ref.number}`, ...(after ? ["-f", `after=${after}`] : [])]));
      if (result.errors?.length) throw new Error(text(result.errors[0].message, 1_000));
      const pr = result.data?.repository?.pullRequest;
      if (!pr) throw new Error("GitHub could not verify checks for this pull request");
      if (headSha && headSha !== pr.headRefOid) throw new Error("The pull request head changed while its checks were being read");
      headSha = pr.headRefOid;
      const connection = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
      nodes.push(...(connection?.nodes ?? []).filter(Boolean));
      if (!connection?.pageInfo?.hasNextPage) return { nodes, headSha, complete: true };
      after = connection.pageInfo.endCursor;
      if (!after) break;
    }
    return { nodes: nodes.slice(0, 500), headSha, complete: false };
  }
  snapshot(detail) { return { title: detail.title, state: detail.state, isDraft: detail.isDraft, headSha: detail.headSha, updatedAt: detail.updatedAt, reviewDecision: detail.reviewDecision, mergeability: detail.mergeability, checks: detail.checks }; }
  async workspace(input) {
    const context = await this.context(input);
    const [git, prefixRead] = await Promise.all([
      this.git(context, ["status", "--porcelain=v1", "-z", "--", "."]),
      this.git(context, ["rev-parse", "--show-prefix"])
    ]);
    const prefix = prefixRead.stdout.trim();
    const files = []; const entries = git.stdout.split("\0");
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]; if (!entry) continue;
      const file = entry.slice(3);
      if (!prefix || file.startsWith(prefix)) files.push({ path: prefix ? file.slice(prefix.length) : file, status: entry.slice(0, 2) });
      if (/[RC]/.test(entry.slice(0, 2))) index++;
    }
    const branch = (await this.git(context, ["branch", "--show-current"])).stdout.trim();
    const [repo, aheadBehind] = await Promise.allSettled([
      this.gh(context, ["repo", "view", "--json", "nameWithOwner,url,defaultBranchRef"]),
      this.git(context, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])
    ]);
    const repository = repo.status === "fulfilled" ? json(repo.value) : null;
    const [ahead = 0, behind = 0] = aheadBehind.status === "fulfilled" ? aheadBehind.value.stdout.trim().split(/\s+/).map(Number) : [];
    return { projectId: context.projectId, threadId: context.threadId, cwd: context.cwd, branch, files, ahead, behind, hasUpstream: aheadBehind.status === "fulfilled", repository,
      githubError: repo.status === "rejected" ? text(repo.reason?.stderr ?? repo.reason?.message, 1_000) : null,
      canWrite: ["workspace-write", "auto-approve", "full-access"].includes(context.permissionMode), canWatch: !context.parentThreadId && !context.archived && !context.settled, links: this.links(input) };
  }
  async list(input) {
    const context = await this.context(input);
    const state = ["open", "closed", "merged", "all"].includes(input.state) ? input.state : "open";
    return json(await this.gh(context, ["pr", "list", "--state", state, "--limit", "100", "--json", LIST_FIELDS])).map((raw) => normalizePullRequest(raw));
  }
  async link(input) {
    await this.context(input); const detail = await this.read(input);
    this.recordLink(input, parsePullRequestUrl(detail.url), this.snapshot(detail));
    return { detail, links: this.links(input) };
  }
  recordLink(input, ref, snapshot = null) {
    if (!this.state.links.some((link) => link.threadId === input.threadId && link.key === ref.key)) {
      if (this.state.links.filter((link) => link.threadId === input.threadId).length >= 50 || this.state.links.length >= MAX_LINKS) throw new Error("This chat has reached its linked pull request limit");
      this.state.links.push({ projectId: input.projectId, threadId: input.threadId, ...ref, linkedAt: new Date(this.now()).toISOString(), snapshot });
      this.persist(); this.changed(input);
    }
  }
  async unlink(input) {
    await this.context(input); const ref = parsePullRequestUrl(input.url);
    this.state.links = this.state.links.filter((link) => !(link.threadId === input.threadId && link.projectId === input.projectId && link.key === ref.key));
    await this.stopWatch(input); this.persist(); this.changed(input); return { links: this.links(input) };
  }
  async exclusive(context, work) {
    const key = context.cwd; const previous = this.locks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work); this.locks.set(key, current);
    try { return await current; } finally { if (this.locks.get(key) === current) this.locks.delete(key); }
  }
  async commit(input) {
    const context = await this.context(input, { write: true });
    const message = nonempty(input.message, "Commit message", 20_000);
    if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > 1_000) throw new Error("Select the files to commit");
    const paths = [...new Set(input.paths.map((file) => {
      nonempty(file, "File path"); const relative = path.normalize(file);
      if (path.isAbsolute(file) || relative === ".." || relative.startsWith(`..${path.sep}`) || relative === ".") throw new Error("A commit file is outside this chat's workspace");
      return file;
    }))];
    return this.exclusive(context, async () => {
      await this.git(context, ["--literal-pathspecs", "add", "--", ...paths]);
      const result = await this.git(context, ["--literal-pathspecs", "commit", "--only", "-m", message, "--", ...paths], { timeout: 120_000 });
      this.changed(input); return { output: text(result.stdout, 20_000), workspace: await this.workspace(input) };
    });
  }
  async push(input) {
    const context = await this.context(input, { write: true });
    return this.exclusive(context, async () => {
      const branch = (await this.git(context, ["branch", "--show-current"])).stdout.trim();
      if (!branch) throw new Error("Create or check out a branch before pushing");
      // No force push, prompt, or automatic remote guessing. The user sees origin and branch.
      const result = await this.git(context, ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`], { timeout: 120_000 });
      this.changed(input); return { output: text(`${result.stdout}\n${result.stderr}`, 20_000), workspace: await this.workspace(input) };
    });
  }
  async withBody(body, work) {
    if (typeof body !== "string" || body.length > 100_000 || body.includes("\0")) throw new Error("Pull request text is invalid");
    const directory = await mkdtemp(path.join(tmpdir(), "pixice-pr-"));
    const file = path.join(directory, "body.md");
    try { await writeFile(file, body, { encoding: "utf8", mode: 0o600 }); return await work(file); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  async create(input) {
    const context = await this.context(input, { write: true });
    const title = nonempty(input.title, "Pull request title", 1_000), base = nonempty(input.base, "Base branch", 1_000);
    if (this.state.links.filter((link) => link.threadId === input.threadId).length >= 50 || this.state.links.length >= MAX_LINKS) throw new Error("This chat has reached its linked pull request limit");
    return this.exclusive(context, async () => {
      const branch = (await this.git(context, ["branch", "--show-current"])).stdout.trim();
      if (!branch) throw new Error("Create or check out a branch before opening a pull request");
      const output = await this.withBody(input.body ?? "", (file) => this.gh(context, ["pr", "create", "--title", title, "--body-file", file, "--base", base, "--head", branch, ...(input.draft === false ? [] : ["--draft"])], { timeout: 120_000 }));
      const url = output.stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
      if (!url) throw new Error("GitHub created the pull request but its URL could not be read. Refresh the list before retrying.");
      const ref = parsePullRequestUrl(url);
      // Save successful creation before an optional follow-up read can fail. Never retry a write.
      const fallback = normalizePullRequest({ url, title, body: input.body ?? "", state: "OPEN", isDraft: input.draft !== false, baseRefName: base, headRefName: branch });
      this.recordLink(input, ref, this.snapshot(fallback));
      try { return { detail: await this.read({ ...input, reference: url }), links: this.links(input) }; }
      catch { return { detail: fallback, links: this.links(input), warning: "The pull request was created and linked. Its latest details could not be read; refresh to try again." }; }
    });
  }
  async update(input) {
    const context = await this.context(input, { write: true }); const ref = parsePullRequestUrl(input.url);
    if (!["ready", "draft", "close", "reopen", "edit", "comment", "review", "merge"].includes(input.action)) throw new Error("Unsupported pull request action");
    if (input.action === "merge" && (!['squash', 'merge', 'rebase'].includes(input.method) || !/^[a-f0-9]{40}$/i.test(input.expectedHeadSha ?? ""))) throw new Error("Refresh and confirm the current pull request before merging");
    const previous = await this.read({ ...input, reference: ref.url });
    const commands = { ready: ["pr", "ready", ref.url], draft: ["pr", "ready", ref.url, "--undo"], close: ["pr", "close", ref.url], reopen: ["pr", "reopen", ref.url] };
    if (commands[input.action]) await this.gh(context, commands[input.action], { timeout: 120_000 });
    else if (input.action === "edit") {
      const title = nonempty(input.title, "Pull request title", 1_000);
      await this.withBody(input.body ?? "", (file) => this.gh(context, ["pr", "edit", ref.url, "--title", title, "--body-file", file]));
    } else if (input.action === "comment") {
      nonempty(input.body, "Comment", 100_000);
      await this.withBody(input.body, (file) => this.gh(context, ["pr", "comment", ref.url, "--body-file", file]));
    } else if (input.action === "review") {
      const flag = { comment: "--comment", approve: "--approve", "request-changes": "--request-changes" }[input.verdict];
      if (!flag) throw new Error("Choose a review verdict");
      if (input.verdict !== "approve") nonempty(input.body, "Review", 100_000);
      await this.withBody(input.body ?? "", (file) => this.gh(context, ["pr", "review", ref.url, flag, "--body-file", file]));
    } else if (input.action === "merge") {
      const method = { squash: "--squash", merge: "--merge", rebase: "--rebase" }[input.method];
      if (!method || !/^[a-f0-9]{40}$/i.test(input.expectedHeadSha ?? "")) throw new Error("Refresh and confirm the current pull request before merging");
      await this.gh(context, ["pr", "merge", ref.url, method, "--match-head-commit", input.expectedHeadSha], { timeout: 120_000 });
    } else throw new Error("Unsupported pull request action");
    this.changed(input);
    try { return await this.read({ ...input, reference: ref.url }); }
    catch {
      const patch = { ready: { isDraft: false }, draft: { isDraft: true }, close: { state: "closed" }, reopen: { state: "open" }, edit: { title: input.title?.trim(), body: input.body ?? "" }, merge: { state: "merged" } }[input.action] ?? {};
      const detail = { ...previous, ...patch, warning: "The GitHub action completed. Its latest details could not be refreshed; refresh the pull request before posting again." };
      const link = this.state.links.find((entry) => entry.projectId === input.projectId && entry.threadId === input.threadId && entry.key === ref.key);
      if (link) { link.snapshot = this.snapshot(detail); this.persist(); }
      return detail;
    }
  }
  async diff(input) {
    const context = await this.context(input); const ref = parsePullRequestUrl(input.url);
    const output = await this.gh(context, ["pr", "diff", ref.url, "--color", "never"], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
    return { url: ref.url, diff: text(output.stdout, 4 * 1024 * 1024), truncated: output.stdout.length > 4 * 1024 * 1024 };
  }
  async watch(input) {
    const context = await this.context(input);
    if (context.parentThreadId) throw new Error("The parent chat owns pull request watches");
    if (context.archived || context.settled) throw new Error("Resume this chat before watching a pull request");
    const { detail } = await this.link(input);
    if (detail.state !== "open") throw new Error("Only open pull requests can be watched");
    const existing = this.state.watches.find((watch) => watch.threadId === input.threadId && watch.key === detail.key);
    if (existing?.active) return existing;
    if (this.state.watches.filter((watch) => watch.active).length >= MAX_WATCHES) throw new Error("The server has reached its active watch limit");
    const startedAt = new Date(this.now()).toISOString();
    const watch = { id: `${input.threadId}:${detail.key}`, projectId: input.projectId, threadId: input.threadId, key: detail.key, url: detail.url, active: true, startedAt,
      permissionMode: ["read-only", "workspace-write", "auto-approve", "full-access"].includes(context.permissionMode) ? context.permissionMode : "read-only",
      failures: 0, pauseUntil: null, stoppedReason: null, lastCheckedAt: startedAt, pending: null,
      cursor: { startedAt, headSha: detail.headSha, failedChecks: [], passed: false, passedChecks: [], remarksThrough: startedAt, remarkIds: [], conflicting: false, wakes: 0 } };
    // Start with the current checks/conflict, so only changes after the user's request wake it.
    watch.cursor.failedChecks = detail.checks.filter((check) => ["failure", "cancelled", "action-required"].includes(check.status)).map((check) => check.name);
    const required = detail.checks.filter((check) => check.required), gate = required.length ? required : detail.checks;
    watch.cursor.passed = gate.length > 0 && gate.every((check) => check.status === "success");
    watch.cursor.passedChecks = watch.cursor.passed ? gate.map((check) => check.name) : [];
    watch.cursor.conflicting = detail.mergeability === "conflicting";
    this.setWatch(watch); return watch;
  }
  async stopWatch(input) {
    await this.context(input); const ref = parsePullRequestUrl(input.url);
    const watch = this.state.watches.find((entry) => entry.projectId === input.projectId && entry.threadId === input.threadId && entry.key === ref.key);
    if (watch) this.setWatch({ ...watch, active: false, pending: null, stoppedReason: input.reason ?? "stopped" });
    return { ok: true, links: this.links(input) };
  }
  stopThread(threadId, reason = "stopped") {
    for (const watch of this.state.watches.filter((entry) => entry.threadId === threadId && entry.active)) this.setWatch({ ...watch, active: false, pending: null, stoppedReason: reason });
  }
  removeProject(projectId) {
    this.state.links = this.state.links.filter((link) => link.projectId !== projectId);
    this.state.watches = this.state.watches.filter((watch) => watch.projectId !== projectId); this.persist();
  }
  async fingerprint(input) {
    const context = await this.context(input); const ref = parsePullRequestUrl(input.url);
    const query = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){state mergeable headRefOid comments(first:100,orderBy:{field:UPDATED_AT,direction:DESC}){totalCount nodes{lastEditedAt}} reviews(last:100){totalCount nodes{lastEditedAt}} reviewThreads{totalCount} commits(last:1){nodes{commit{statusCheckRollup{contexts{checkRunCountsByState{state count} statusContextCountsByState{state count}}}}}}}}}`;
    const result = json(await this.gh(context, ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${ref.owner}`, "-f", `repo=${ref.repository}`, "-F", `number=${ref.number}`]));
    if (result.errors?.length) throw new Error(text(result.errors[0].message, 1_000));
    const pr = result.data?.repository?.pullRequest;
    if (!pr) throw new Error("The watched pull request is unavailable");
    return JSON.stringify(pr);
  }
}

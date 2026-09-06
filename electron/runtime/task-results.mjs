import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { captureTaskSnapshot, createReplayWorkspace, taskWorkspaceChanges } from "../git/task-snapshots.mjs";

const terminal = new Set(["completed", "failed", "interrupted"]);
const now = () => new Date().toISOString();
const bounded = (value, length = 24_000) => String(value ?? "").slice(0, length);
const timestamp = (value) => {
  const date = new Date(typeof value === "number" && value < 1e12 ? value * 1_000 : value ?? Date.now());
  return Number.isNaN(date.getTime()) ? now() : date.toISOString();
};
async function freezeAttachments(input, root, directory) {
  if (!root) return [];
  const strings = [];
  const collect = (value) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(input);
  if (!strings.some((value) => value.includes(root))) return [];
  const frozen = [];
  const visit = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const source = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(source);
      else if (strings.some((value) => value.includes(source))) {
        if (!entry.isFile()) throw new Error("Attached input is no longer a regular file.");
        const destination = path.join(directory, randomUUID(), entry.name);
        await mkdir(path.dirname(destination), { recursive: true });
        await cp(source, destination, { errorOnExist: true, force: false });
        frozen.push({ path: source, frozenPath: destination });
      }
    }
  };
  await visit(root);
  return frozen;
}

export function verificationEvidence(turns) {
  const checks = [];
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      if (item.type !== "commandExecution") continue;
      const command = bounded(item.command, 2_000);
      const invokesCheck = command.split(/&&|\|\||[;\n]/).some((part) => /^(?:\s*(?:[\w_]+=[^\s]+\s+)*)?(?:(?:npm|pnpm|yarn|bun)(?:\s+(?:run|exec))?\s+(?:test[\w:-]*|check[\w:-]*|lint[\w:-]*|typecheck[\w:-]*|build[\w:-]*|verify[\w:-]*|vitest|jest|tsc)\b|(?:npx|uv run)\s+(?:vitest|jest|pytest|tsc)\b|(?:cargo|go|swift|dotnet)\s+(?:test|check|build)\b|(?:pytest|vitest|jest|tsc|xcodebuild)\b|python[\d.]*\s+-m\s+(?:pytest|unittest)\b|node\s+(?:--test|[^\s]*(?:vitest|verify|test|check|lint)[^\s]*))/i.test(part.trim()));
      if (!invokesCheck) continue;
      const code = item.exitCode;
      const compound = /[|;&\n]/.test(command);
      checks.push({
        id: `${turn.id}:${item.id}`, command,
        status: compound ? "unknown" : typeof code === "number" ? code === 0 ? "passed" : "failed" : item.status === "failed" ? "failed" : "unknown",
        exitCode: typeof code === "number" ? code : null,
        output: bounded(item.aggregatedOutput ?? item.output, 8_000)
      });
    }
  }
  return checks.slice(-100);
}

function tokenTotals(rows) {
  return rows.reduce((total, row) => {
    total.tokens += row.input_tokens + row.cached_input_tokens + row.cache_write_input_tokens + row.output_tokens;
    total.events += 1;
    if (row.cost_usd == null) total.unpricedEvents += 1;
    else total.costUsd += row.cost_usd;
    return total;
  }, { tokens: 0, costUsd: 0, events: 0, unpricedEvents: 0 });
}

export class TaskResults {
  constructor({ database, directory, onChange = () => {}, startThread, startTurn, readThread,
    captureSnapshot = captureTaskSnapshot, createWorkspace = createReplayWorkspace, readChanges = taskWorkspaceChanges }) {
    this.database = database;
    this.directory = directory;
    this.onChange = onChange;
    this.startThread = startThread;
    this.startTurn = startTurn;
    this.readThread = readThread;
    this.captureSnapshot = captureSnapshot;
    this.createWorkspace = createWorkspace;
    this.readChanges = readChanges;
    this.finishing = new Map();
    database.db.exec(`CREATE TABLE IF NOT EXISTS task_results (
      thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, group_id TEXT NOT NULL,
      updated_at TEXT NOT NULL, data TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS task_results_project ON task_results(project_id);`);
    // A replay never resumes spending on its own after the application exits.
    for (const record of this.records()) {
      if (record.status === "running") this.save({ ...record, status: "interrupted", replayQueue: [], error: "The Pixice backend stopped before this task finished. Open the task to continue." });
    }
  }

  records() {
    return this.database.db.prepare("SELECT data FROM task_results ORDER BY updated_at DESC").all().map((row) => JSON.parse(row.data));
  }

  get(threadId) {
    const row = this.database.db.prepare("SELECT data FROM task_results WHERE thread_id = ?").get(threadId);
    return row ? JSON.parse(row.data) : null;
  }

  importThread(project, thread) {
    if (this.get(thread.id) || this.database.getThreadLink(thread.id)) return;
    const latest = thread.turns?.at(-1);
    if (!latest || !terminal.has(latest.status)) return;
    const turns = thread.turns.map((turn) => ({ id: turn.id, status: turn.status,
      summary: bounded((turn.items ?? []).filter((item) => item.type === "agentMessage").at(-1)?.text),
      checks: verificationEvidence([turn]), startedAt: timestamp(turn.startedAt ?? turn.createdAt ?? thread.createdAt),
      completedAt: timestamp(turn.completedAt ?? thread.updatedAt) }));
    const prompts = thread.turns.flatMap((turn) => (turn.items ?? []).filter((item) => item.type === "userMessage").map((item) => ({
      text: bounded(item.text ?? (item.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n"), 100_000), turnId: turn.id
    })));
    const model = thread.model ?? this.database.db.prepare("SELECT model FROM usage_events WHERE thread_id=? ORDER BY recorded_at DESC LIMIT 1").get(thread.id)?.model;
    this.save({ threadId: thread.id, projectId: project.id, groupId: thread.id, originProjectId: project.id, projectName: project.displayName,
      status: latest.status, revision: randomUUID(), prompts, turns, model,
      startedAt: turns[0].startedAt, completedAt: turns.at(-1).completedAt, summary: turns.at(-1).summary,
      checks: turns.at(-1).checks, unresolved: latest.error ? [bounded(latest.error.message ?? latest.error)] : [],
      snapshotError: "No starting snapshot was recorded for this task. Replay is available for new tasks started in this version.",
      changesError: "Workspace changes were not captured for this earlier task." });
  }

  async observeThread(project, thread) {
    this.importThread(project, thread);
    const record = this.get(thread.id);
    const latest = thread.turns?.at(-1);
    if (!record || !latest) return;
    if (terminal.has(latest.status) && !record.turns.some((turn) => turn.id === latest.id)) {
      await this.complete(thread.id, latest);
    } else if (latest.status === "inProgress" && record.status !== "running") {
      this.observeStart(thread.id, latest.id);
    }
  }

  observeStart(threadId, turnId) {
    const record = this.get(threadId);
    if (!record || record.status === "running") return;
    this.save({ ...record, status: "running", error: null, revision: randomUUID(),
      activeTurnId: turnId, replayQueue: [],
      replayUnavailableReason: "This task resumed outside the recorded prompt sequence. Start a new task to make an exact replay." });
  }

  save(record) {
    const value = { ...record, updatedAt: now() };
    this.database.db.prepare(`INSERT INTO task_results VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET project_id=excluded.project_id, group_id=excluded.group_id, updated_at=excluded.updated_at, data=excluded.data`)
      .run(value.threadId, value.projectId, value.groupId, value.updatedAt, JSON.stringify(value));
    this.onChange({ threadId: value.threadId, projectId: value.projectId });
    return value;
  }

  async begin({ project, threadId, input, prompt, model, effort, serviceTier, attachmentRoot, frozenAttachments }) {
    // Do not let an older completion replace a new turn's receipt.
    await this.finishing.get(threadId);
    let record = this.get(threadId);
    if (!record) {
      try {
        const previous = await this.readThread?.(threadId);
        if (previous?.thread) this.importThread(project, previous.thread);
        record = this.get(threadId);
      } catch { /* New providers may not expose empty threads until the first turn. */ }
    }
    if (!record) {
      let snapshot = null;
      let snapshotError = null;
      try { snapshot = await this.captureSnapshot(project.folders?.length ? project.folders : [project.canonicalPath]); }
      catch (error) { snapshotError = error.message; }
      record = { threadId, projectId: project.id, groupId: threadId, originProjectId: project.id,
        projectName: project.displayName, snapshot, snapshotError, prompts: [], turns: [], startedAt: now() };
    }
    try { frozenAttachments ??= await freezeAttachments(input, attachmentRoot, path.join(this.directory, "inputs")); }
    catch (error) { record.replayUnavailableReason = `Could not preserve attached inputs: ${error.message}`; }
    return this.save({ ...record, status: "running",
      revision: randomUUID(), error: null, checks: [], unresolved: [], summary: null, completedAt: null, model, effort, serviceTier,
      attachmentRoot: attachmentRoot ?? record.attachmentRoot,
      prompts: [...record.prompts, { input, frozenAttachments, text: bounded(prompt, 100_000), model, effort, serviceTier, startedAt: now() }]
    });
  }

  started(threadId, turnId) {
    const record = this.get(threadId);
    if (!record || record.turns.some((turn) => turn.id === turnId)) return;
    const prompts = [...record.prompts];
    prompts[prompts.length - 1] = { ...prompts.at(-1), turnId };
    this.save({ ...record, prompts, activeTurnId: turnId });
  }

  failed(threadId, error) {
    const record = this.get(threadId);
    if (record) this.save({ ...record, status: "failed", replayQueue: [], error: bounded(error?.message ?? error), completedAt: now() });
  }

  stopReplay(threadId, steered = false) {
    const record = this.get(threadId);
    if (record) this.save({ ...record, replayQueue: [], ...(steered ? { replayUnavailableReason: "Live steering cannot be reproduced at the same point in another model's run." } : {}) });
  }

  complete(threadId, turn, plan = []) {
    const pending = this.finishing.get(threadId) ?? Promise.resolve();
    const operation = pending.then(() => this.finish(threadId, turn, plan));
    this.finishing.set(threadId, operation);
    operation.finally(() => { if (this.finishing.get(threadId) === operation) this.finishing.delete(threadId); }).catch(() => {});
    return operation;
  }

  async finish(threadId, turn, plan) {
    let record = this.get(threadId);
    if (!record || record.turns.some((candidate) => candidate.id === turn.id)) return;
    let detail = turn;
    try {
      const response = await this.readThread?.(threadId);
      detail = response?.thread?.turns?.find((candidate) => candidate.id === turn.id) ?? turn;
    } catch { /* The completion event remains usable while a provider is offline. */ }
    const status = terminal.has(detail.status) ? detail.status : detail.error ? "failed" : "completed";
    const items = detail.items?.length ? detail.items : turn.items ?? [];
    const summary = items.filter((item) => item.type === "agentMessage").map((item) => item.text ?? "").filter(Boolean).at(-1) ?? "";
    const checks = verificationEvidence([{ ...detail, items }]);
    const finishedTurn = { id: turn.id, status, summary: bounded(summary), checks,
      startedAt: detail.startedAt ?? turn.startedAt ?? record.prompts.at(-1)?.startedAt,
      completedAt: detail.completedAt ?? turn.completedAt ?? now() };
    let changes = record.changes ?? null;
    let changesError = record.snapshotError;
    if (record.snapshot) {
      try { changes = await this.readChanges(record.snapshot); changesError = null; }
      catch (error) { changesError = error.message; }
    }
    // An interrupt/steer can clear the replay queue while the diff is being read.
    record = this.get(threadId);
    const more = status === "completed" && record.replayQueue?.length > 0;
    const turns = [...record.turns, finishedTurn];
    const unresolved = [
      ...plan.filter((step) => step.status !== "completed").map((step) => bounded(step.step ?? step.title, 1_000)),
      ...(detail.error ? [bounded(detail.error.message ?? detail.error)] : [])
    ].filter(Boolean);
    this.save({ ...record, status: more ? "running" : status, turns, changes, changesError, summary: bounded(summary),
      checks, unresolved,
      completedAt: more ? null : now(), activeTurnId: null,
      replayQueue: status === "completed" ? record.replayQueue : [], error: detail.error?.message ?? null });
    // Submit after releasing the completion lock; begin() waits on that lock.
    if (more) setTimeout(() => this.nextReplayTurn(threadId).catch((error) => this.failed(threadId, error)), 0);
  }

  usage(threadId) {
    // Include Pixice bridge children so delegation is part of the task's cost.
    const rows = this.database.db.prepare(`WITH RECURSIVE children(id) AS (
      SELECT ? UNION SELECT child_thread_id FROM thread_links JOIN children ON parent_thread_id = children.id
    ) SELECT * FROM usage_events WHERE thread_id IN (SELECT id FROM children)`).all(threadId);
    return tokenTotals(rows);
  }

  receipt(threadId) {
    const record = this.get(threadId);
    if (!record) return null;
    const { snapshot, prompts, replayQueue, attachmentRoot, outcome, acceptedAt, ...receipt } = record;
    const durationMs = record.turns.reduce((total, turn) => {
      const time = (value) => typeof value === "number" ? value < 1e12 ? value * 1_000 : value : Date.parse(value);
      return total + Math.max(0, (time(turn.completedAt) - time(turn.startedAt)) || 0);
    }, 0);
    return { ...receipt, title: this.database.getThreadName(threadId) ?? prompts[0]?.text?.slice(0, 120) ?? "Task result",
      prompt: prompts[0]?.text ?? "", promptCount: prompts.length, durationMs, usage: this.usage(threadId),
      replayAvailable: Boolean(snapshot && prompts.length && terminal.has(record.status) && !record.replayUnavailableReason),
      replayUnavailableReason: record.replayUnavailableReason ?? record.snapshotError ?? (record.status === "running" ? "Wait for the task to finish before replaying it." : null),
      remainingReplayTurns: replayQueue?.length ?? 0 };
  }

  list({ projectId, groupId } = {}) {
    return this.records().filter((record) => (!projectId || record.projectId === projectId) && (!groupId || record.groupId === groupId))
      .map((record) => {
        const receipt = this.receipt(record.threadId);
        return { ...receipt, changes: receipt.changes ? { ...receipt.changes, patch: undefined, repositoryPatches: undefined } : null };
      });
  }

  async replay({ threadId, revision, model, effort, serviceTier }) {
    const original = this.get(threadId);
    if (!original || original.revision !== revision) throw new Error("This task changed. Refresh before replaying it.");
    const receipt = this.receipt(threadId);
    if (!receipt.replayAvailable) throw new Error(receipt.replayUnavailableReason ?? "This task has no replayable starting state.");
    const id = randomUUID();
    const destination = path.join(this.directory, "replays", id);
    const workspace = await this.createWorkspace(original.snapshot, destination);
    const mappings = original.snapshot.folders.map((folder, index) => [
      path.resolve(original.snapshot.repositories[folder.repository].root, folder.relative), workspace.folders[index]
    ]).sort((a, b) => b[0].length - a[0].length);
    const frozen = original.prompts.flatMap((prompt) => prompt.frozenAttachments ?? []);
    const attachmentMappings = new Map();
    if (frozen.length) {
      const inputs = path.join(destination, "inputs");
      await mkdir(inputs, { recursive: true });
      for (const attachment of frozen) {
        if (attachmentMappings.has(attachment.path)) continue;
        const target = path.join(inputs, randomUUID(), path.basename(attachment.path));
        await mkdir(path.dirname(target), { recursive: true });
        await cp(attachment.frozenPath, target, { errorOnExist: true, force: false });
        attachmentMappings.set(attachment.path, target);
      }
      mappings.unshift(...attachmentMappings);
      workspace.folders.push(inputs);
    }
    const replacements = new Map(mappings);
    const pattern = new RegExp([...replacements.keys()].sort((a, b) => b.length - a.length).map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
    const remap = (value) => typeof value === "string" ? value.replace(pattern, (match) => replacements.get(match))
      : Array.isArray(value) ? value.map(remap) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, remap(child)])) : value;
    const project = this.database.createProject({ id, displayName: `Replay · ${receipt.title.slice(0, 45)}`, folders: workspace.folders,
      icon: "git-branch", color: "purple", createdAt: now(), updatedAt: now() });
    const response = await this.startThread({ project, model, serviceTier });
    const childId = response.thread.id;
    const queue = original.prompts.map((prompt) => ({ input: remap(prompt.input), text: prompt.text, frozenAttachments: (prompt.frozenAttachments ?? []).map((attachment) => ({ ...attachment, path: attachmentMappings.get(attachment.path) })) }));
    this.save({ threadId: childId, projectId: project.id, originProjectId: original.originProjectId, projectName: original.projectName,
      groupId: original.groupId, sourceThreadId: threadId, snapshot: workspace.snapshot, prompts: [], turns: [],
      startedAt: now(), status: "running", revision: randomUUID(), model, effort, serviceTier, replayQueue: queue });
    try { await this.nextReplayTurn(childId); }
    catch (error) { this.failed(childId, error); }
    return { project, thread: response.thread, receipt: this.receipt(childId) };
  }

  async nextReplayTurn(threadId) {
    const record = this.get(threadId);
    if (!record?.replayQueue?.length || record.activeTurnId) return;
    const [prompt, ...rest] = record.replayQueue;
    this.save({ ...record, replayQueue: rest });
    await this.startTurn({ project: this.database.getProject(record.projectId), threadId,
      input: prompt.input, text: prompt.text, frozenAttachments: prompt.frozenAttachments, model: record.model, effort: record.effort, serviceTier: record.serviceTier });
  }
}

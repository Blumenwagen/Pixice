import { createHash, randomUUID } from "node:crypto";

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into", "is", "it",
  "of", "on", "or", "our", "that", "the", "this", "to", "we", "with", "you"
]);

const INTERNAL_TOOLS = /(?:pixice_board|pixice_bridge|update_plan|request_user_input|send_update|spawn_thread)/i;

function normalizedWords(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

function containsPhrase(haystack, needle) {
  const normalizedHaystack = ` ${normalizedWords(haystack).join(" ")} `;
  const normalizedNeedle = normalizedWords(needle).join(" ");
  return normalizedNeedle.length >= 4 && normalizedHaystack.includes(` ${normalizedNeedle} `);
}

export function taskMatchScore(task, { prompt = "", threadName = "" } = {}) {
  const titleWords = normalizedWords(task?.title);
  if (!titleWords.length) return 0;
  const normalizedTitle = titleWords.join(" ");
  if (normalizedWords(threadName).join(" ") === normalizedTitle) return 1;
  if (titleWords.length < 2) return 0;
  if (containsPhrase(threadName, task.title)) return 0.98;
  if (containsPhrase(prompt, task.title)) return 0.96;

  const sourceWords = new Set(normalizedWords(`${threadName} ${prompt}`));
  const matched = titleWords.filter((word) => sourceWords.has(word)).length;
  if (!matched) return 0;
  const coverage = matched / titleWords.length;
  if (titleWords.length >= 3 && coverage === 1) return 0.92;
  return coverage * 0.72;
}

export function findTaskMatch(tasks, context = {}) {
  const ranked = tasks
    .filter((task) => !task.threadId && ["backlog", "ready"].includes(task.column))
    .map((task) => ({ task, score: taskMatchScore(task, context) }))
    .filter((candidate) => candidate.score >= 0.9)
    .sort((left, right) => right.score - left.score);
  if (!ranked.length) return null;
  if (ranked[1] && ranked[0].score - ranked[1].score < 0.08) return null;
  return ranked[0];
}

function commandText(item) {
  return Array.isArray(item?.command) ? item.command.join(" ") : String(item?.command ?? "");
}

function canonicalCommand(value) {
  const raw = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!raw) return null;
  const tokens = raw.split(" ");
  const executable = tokens[0]?.split(/[\\/]/).at(-1)?.toLowerCase();
  if (!executable) return null;
  if (["pnpm", "npm", "yarn", "bun"].includes(executable)) {
    const runIndex = tokens[1] === "run" ? 2 : 1;
    return `${executable}:${tokens[runIndex] ?? "command"}`.replace(/[^a-z0-9:._-]/gi, "");
  }
  if (executable === "git") return `git:${tokens[1] ?? "command"}`.replace(/[^a-z0-9:._-]/gi, "");
  return [executable, tokens[1]].filter(Boolean).join(":").replace(/[^a-z0-9:._-]/gi, "");
}

function userPrompt(items) {
  const content = items.find((item) => item?.type === "userMessage")?.content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.type === "text" ? part.text : "").filter(Boolean).join("\n").trim();
}

function stepFromItem(item) {
  if (!item || item.status === "failed") return null;
  if (item.type === "commandExecution") {
    const command = commandText(item);
    const action = canonicalCommand(command);
    if (!action) return null;
    return { action: `command:${action}`, label: `Run ${command.slice(0, 140)}` };
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const tool = String(item.tool ?? "").trim();
    if (!tool || INTERNAL_TOOLS.test(tool)) return null;
    return { action: `tool:${tool.toLowerCase()}`, label: `Use ${tool}` };
  }
  return null;
}

export function workPatternFromTurn(turn, observedItems = []) {
  if (!turn || turn.status !== "completed") return null;
  const byId = new Map();
  for (const item of [...observedItems, ...(turn.items ?? [])]) {
    const key = item?.id ?? `${item?.type}:${byId.size}`;
    byId.set(key, item);
  }
  const items = [...byId.values()];
  const steps = [];
  for (const item of items) {
    const step = stepFromItem(item);
    if (!step || steps.at(-1)?.action === step.action) continue;
    steps.push(step);
  }
  if (steps.length < 2) return null;
  const bounded = steps.slice(0, 12);
  const signature = createHash("sha256").update(JSON.stringify(bounded.map((step) => step.action))).digest("hex");
  return { signature, steps: bounded, prompt: userPrompt(items) };
}

function suggestedWorkflowName(prompt, steps) {
  const firstLine = String(prompt ?? "").split("\n").map((line) => line.trim()).find(Boolean);
  if (firstLine) return firstLine.replace(/[.!?]+$/, "").slice(0, 72);
  const first = steps[0]?.label?.replace(/^(Run|Use)\s+/i, "") ?? "Repeated work";
  return `${first} routine`.slice(0, 72);
}

export class ProactiveStewardship {
  constructor({ database, threshold = 3, onBoardChange, onSuggestionChange, createWorkflowDraft }) {
    this.database = database;
    this.threshold = threshold;
    this.onBoardChange = onBoardChange;
    this.onSuggestionChange = onSuggestionChange;
    this.createWorkflowDraft = createWorkflowDraft;
    this.turnItems = new Map();
  }

  list(projectId, threadId = null) {
    return this.database.listProactiveSuggestions(projectId, threadId);
  }

  startTurn({ projectId, threadId, turnId = null, prompt = "", threadName = "" }) {
    const tasks = this.database.listBoardTasks(projectId);
    let task = tasks.find((candidate) => candidate.threadId === threadId) ?? null;
    let attached = false;
    if (!task) {
      const match = findTaskMatch(tasks, { prompt, threadName });
      if (match) {
        task = this.database.updateBoardTask(match.task.id, { threadId });
        attached = true;
        this.onBoardChange?.({ action: "stewarded", projectId, task });
      }
    }
    if (!task) return null;
    if (["backlog", "ready"].includes(task.column)) {
      task = this.database.moveBoardTask(task.id, "active");
      this.onBoardChange?.({ action: "moved", projectId, task });
    }
    if (turnId) {
      this.database.recordBoardTaskActivity({
        id: randomUUID(),
        taskId: task.id,
        projectId,
        threadId,
        turnId,
        kind: attached ? "linked" : "started",
        summary: attached ? "Pixice linked this conversation and started work." : "Pixice started another work turn.",
        dedupeKey: `turn-started:${turnId}`
      });
      task = this.database.getBoardTask(task.id);
      this.onBoardChange?.({ action: "activity", projectId, task });
    }
    if (attached) {
      this.#suggest({
        projectId,
        threadId,
        type: "task-stewarded",
        dedupeKey: `task-stewarded:${task.id}`,
        title: "Pixice linked this task",
        message: `Linked this conversation to “${task.title}” and moved it to Active.`,
        payload: { taskId: task.id, taskTitle: task.title }
      });
    }
    return task;
  }

  observeActivity({ method, threadId, turnId, item }) {
    if (!threadId || !turnId || !item || !["item/started", "item/completed"].includes(method)) return;
    const key = `${threadId}:${turnId}`;
    const items = this.turnItems.get(key) ?? new Map();
    items.set(item.id ?? `${item.type}:${items.size}`, item);
    this.turnItems.set(key, items);
  }

  completeTurn({ projectId, threadId, turn }) {
    if (!projectId || !threadId || !turn?.id) return [];
    const key = `${threadId}:${turn.id}`;
    const observedItems = [...(this.turnItems.get(key)?.values() ?? [])];
    this.turnItems.delete(key);
    if (turn.status !== "completed") return [];

    const suggestions = [];
    const task = this.database.listBoardTasks(projectId).find((candidate) => candidate.threadId === threadId);
    if (task?.column === "active") {
      this.database.recordBoardTaskActivity({
        id: randomUUID(),
        taskId: task.id,
        projectId,
        threadId,
        turnId: turn.id,
        kind: "completed",
        summary: "The latest work turn completed and is ready for review.",
        dedupeKey: `turn-completed:${turn.id}`
      });
      this.onBoardChange?.({ action: "activity", projectId, task: this.database.getBoardTask(task.id) });
      suggestions.push(this.#suggest({
        projectId,
        threadId,
        type: "task-status",
        dedupeKey: `task-status:${task.id}`,
        title: "Ready to close this task?",
        message: `The latest work for “${task.title}” completed.`,
        payload: { taskId: task.id, taskTitle: task.title, targetColumn: "done" }
      }));
    }

    const pattern = workPatternFromTurn(turn, observedItems);
    if (!pattern) return suggestions.filter(Boolean);
    const occurrence = this.database.recordWorkPatternOccurrence({
      id: randomUUID(),
      projectId,
      threadId,
      turnId: turn.id,
      signature: pattern.signature,
      steps: pattern.steps,
      prompt: pattern.prompt
    });
    if (occurrence.count >= this.threshold) {
      const name = suggestedWorkflowName(pattern.prompt, pattern.steps);
      suggestions.push(this.#suggest({
        projectId,
        threadId,
        type: "workflow-pattern",
        dedupeKey: `workflow-pattern:${pattern.signature}`,
        title: "Turn this into a workflow?",
        message: `Pixice has seen this sequence ${occurrence.count} times.`,
        payload: { signature: pattern.signature, count: occurrence.count, steps: pattern.steps, suggestedName: name }
      }));
    }
    return suggestions.filter(Boolean);
  }

  async resolve({ projectId, suggestionId, decision }) {
    const suggestion = this.database.getProactiveSuggestion(suggestionId);
    if (!suggestion || suggestion.projectId !== projectId) throw new Error("Suggestion not found in this project");
    if (suggestion.status !== "open") return suggestion;
    if (decision === "dismiss") {
      const dismissed = this.database.resolveProactiveSuggestion(suggestion.id, "dismissed");
      this.onSuggestionChange?.({ action: "dismissed", projectId, suggestion: dismissed });
      return dismissed;
    }
    if (decision !== "accept") throw new Error("Unknown suggestion decision");

    let result = null;
    if (suggestion.type === "task-status") {
      const task = this.database.getBoardTask(suggestion.payload.taskId);
      if (task?.projectId === projectId && task.column !== "done") {
        result = this.database.moveBoardTask(task.id, "done");
        this.onBoardChange?.({ action: "moved", projectId, task: result });
      }
    }
    if (suggestion.type === "workflow-pattern") {
      if (!this.createWorkflowDraft) throw new Error("Workflow drafts are unavailable");
      result = await this.createWorkflowDraft({ ...suggestion.payload, projectId, threadId: suggestion.threadId });
    }
    const resolved = this.database.resolveProactiveSuggestion(suggestion.id, "accepted", result ? { result } : {});
    this.onSuggestionChange?.({ action: "accepted", projectId, suggestion: resolved, result });
    return { suggestion: resolved, result };
  }

  #suggest(input) {
    const suggestion = this.database.createProactiveSuggestion({ id: randomUUID(), ...input });
    if (suggestion?.created) this.onSuggestionChange?.({ action: "created", projectId: input.projectId, suggestion: suggestion.value });
    return suggestion?.value ?? null;
  }
}

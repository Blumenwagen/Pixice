import { randomUUID } from "node:crypto";
import { z } from "zod";

const identifier = z.string().trim().min(1).max(160);
const planItemSchema = z.object({
  id: identifier.optional(),
  title: z.string().trim().min(1).max(240),
  description: z.string().max(10_000).default(""),
  kind: z.enum(["task", "milestone", "event"]).default("task"),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  column: z.enum(["backlog", "ready", "active", "done"]).default("backlog"),
  estimateMinutes: z.number().int().min(0).max(525_600).default(480),
  owner: z.string().trim().max(160).default(""),
  dependsOn: z.array(z.string().trim().min(1).max(160)).max(100).default([]),
  fixedStart: z.string().datetime().optional(),
  hardDeadline: z.string().datetime().optional(),
  lockedFields: z.array(z.enum(["plannedStart", "plannedEnd", "hardDeadline"])).max(3).default([]),
  confidence: z.enum(["low", "medium", "high"]).default("medium")
}).strict();

export const taskPlanInputSchema = z.object({
  title: z.string().trim().min(1).max(240),
  outcome: z.string().trim().max(10_000).default(""),
  startAt: z.string().datetime().optional(),
  deadline: z.string().datetime().optional(),
  timezone: z.string().trim().min(1).max(120).default("UTC"),
  workdayMinutes: z.number().int().min(15).max(1_440).default(480),
  items: z.array(planItemSchema).min(1).max(200)
}).strict();

function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

function maximumIso(values, fallback) {
  const valid = values.filter(Boolean).map((value) => new Date(value).getTime()).filter(Number.isFinite);
  return new Date(Math.max(new Date(fallback).getTime(), ...valid)).toISOString();
}

function topologicalItems(items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const indegree = new Map(items.map((item) => [item.id, 0]));
  const dependents = new Map(items.map((item) => [item.id, []]));
  for (const item of items) {
    for (const dependencyId of item.dependsOn) {
      if (!byId.has(dependencyId)) throw new Error(`Plan item ${item.title} references missing dependency ${dependencyId}`);
      indegree.set(item.id, (indegree.get(item.id) ?? 0) + 1);
      dependents.get(dependencyId).push(item.id);
    }
  }
  const ready = items.filter((item) => indegree.get(item.id) === 0).sort((a, b) => a.index - b.index);
  const ordered = [];
  while (ready.length) {
    const item = ready.shift();
    ordered.push(item);
    for (const dependentId of dependents.get(item.id) ?? []) {
      indegree.set(dependentId, indegree.get(dependentId) - 1);
      if (indegree.get(dependentId) === 0) {
        ready.push(byId.get(dependentId));
        ready.sort((a, b) => a.index - b.index);
      }
    }
  }
  if (ordered.length !== items.length) throw new Error("Plan dependencies contain a cycle");
  return ordered;
}

export function buildTaskPlan(input, existingTasks = [], { now = new Date() } = {}) {
  const value = taskPlanInputSchema.parse(input);
  const aliases = new Map();
  const items = value.items.map((item, index) => {
    const id = item.id ?? randomUUID();
    aliases.set(item.id ?? item.title, id);
    return { ...item, id, index };
  });
  const known = new Set([...items.map((item) => item.id), ...existingTasks.map((task) => task.id)]);
  for (const item of items) {
    item.dependsOn = item.dependsOn.map((dependency) => aliases.get(dependency) ?? dependency);
    for (const dependencyId of item.dependsOn) {
      if (!known.has(dependencyId)) throw new Error(`Plan item ${item.title} references missing dependency ${dependencyId}`);
    }
  }

  const existingById = new Map(existingTasks.map((task) => [task.id, task]));
  const internal = items.filter((item) => item.dependsOn.every((dependencyId) => items.some((candidate) => candidate.id === dependencyId)));
  const ordered = topologicalItems(internal.length === items.length ? items : items.map((item) => ({
    ...item,
    dependsOn: item.dependsOn.filter((dependencyId) => items.some((candidate) => candidate.id === dependencyId))
  })));
  const start = value.startAt ?? now.toISOString();
  const scheduled = new Map();
  const conflicts = [];
  const resultItems = ordered.map((item) => {
    const dependencyEnds = item.dependsOn.map((dependencyId) => scheduled.get(dependencyId)?.schedule?.plannedEnd ?? existingById.get(dependencyId)?.schedule?.plannedEnd).filter(Boolean);
    const dependencyReadyAt = maximumIso(dependencyEnds, start);
    const plannedStart = item.fixedStart ?? dependencyReadyAt;
    if (item.fixedStart && dependencyEnds.length && new Date(item.fixedStart) < new Date(dependencyReadyAt)) {
      conflicts.push({ type: "dependency", taskId: item.id, title: item.title, plannedStart, dependencyReadyAt, message: `${item.title} starts before its dependencies finish.` });
    }
    const duration = item.kind === "milestone" ? 0 : item.estimateMinutes;
    const plannedEnd = addMinutes(plannedStart, duration);
    const hardDeadline = item.hardDeadline ?? (item.index === items.length - 1 ? value.deadline : undefined) ?? null;
    if (hardDeadline && new Date(plannedEnd) > new Date(hardDeadline)) {
      conflicts.push({ type: "deadline", taskId: item.id, title: item.title, plannedEnd, hardDeadline, message: `${item.title} ends after its hard deadline.` });
    }
    const result = {
      id: item.id,
      title: item.title,
      description: item.description,
      kind: item.kind,
      priority: item.priority,
      column: item.column,
      estimateMinutes: item.estimateMinutes,
      owner: item.owner,
      confidence: item.confidence,
      dependencies: item.dependsOn.map((dependsOnTaskId) => ({ dependsOnTaskId, type: "finish-to-start", lagMinutes: 0 })),
      schedule: {
        plannedStart,
        plannedEnd,
        hardDeadline,
        allDay: false,
        timezone: value.timezone,
        constraintType: item.fixedStart ? "fixed-start" : "as-soon-as-possible",
        lockedFields: item.lockedFields,
        autoSchedule: true,
        explanation: item.dependsOn.length ? "Placed after its dependencies." : "Placed at the plan start."
      }
    };
    scheduled.set(item.id, result);
    return result;
  });

  return {
    title: value.title,
    outcome: value.outcome,
    timezone: value.timezone,
    workdayMinutes: value.workdayMinutes,
    startAt: start,
    deadline: value.deadline ?? null,
    items: resultItems,
    conflicts,
    assumptions: [
      `Durations use each item's estimate within a ${value.workdayMinutes}-minute planning day.`,
      "Independent items may overlap unless a dependency orders them.",
      "Dependencies use finish-to-start ordering.",
      "Unlocked dates may move when the plan is maintained."
    ]
  };
}

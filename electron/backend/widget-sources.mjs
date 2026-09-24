import { z } from 'zod';
import { BOARD_FIELDS, WIDGET_SOURCE_CATALOG } from '../../src/widgets/widget-catalog.mjs';
import { WIDGET_V2_LIMITS } from '../../src/widgets/widget-schema.mjs';

const sourceSchema = z.object({ capability: z.enum(Object.keys(WIDGET_SOURCE_CATALOG)), arguments: z.object({}).strict(), refresh: z.enum(['manual', 'onOpen', 'event']) }).strict();
const boardRowSchema = z.object({
  id: z.string(), title: z.string(), description: z.string().nullish(),
  column: z.string(), threadId: z.string().nullish(), updatedAt: z.string()
}).passthrough();
const MAX_ROWS = Math.min(200, WIDGET_V2_LIMITS.rows);

// The caller supplies a trusted, project-scoped service context with raw
// database.listBoardTasks(projectId) rows. Those rows contain projectId, which
// this adapter checks before exposing data. readInstrumentCapability('board.list')
// strips projectId and cannot be used here. Fetching occurs only on invocation;
// the document refresh policy is metadata.
export function refreshWidgetSource(source, context) {
  const parsed = sourceSchema.parse(source);
  const projectId = context?.projectId;
  if (typeof projectId !== 'string' || !projectId) throw new Error('Widget source requires a project context');
  if (typeof context.listBoardTasks !== 'function') throw new Error('Board source is unavailable');
  if (parsed.capability !== 'board.list') throw new Error('Unsupported widget source');
  const tasks = context.listBoardTasks(projectId);
  if (!Array.isArray(tasks)) throw new Error('Board source returned invalid rows');
  const rows = [];
  for (const task of tasks) {
    if (rows.length >= MAX_ROWS) break;
    // A backend service may return more than one project; never expose those rows.
    if (task?.projectId !== projectId) continue;
    const parsedRow = boardRowSchema.safeParse(task);
    if (!parsedRow.success) continue;
    const row = parsedRow.data;
    rows.push({
      id: row.id.slice(0, 160), title: row.title.slice(0, 160),
      description: (row.description ?? '').slice(0, 500), column: row.column.slice(0, 80),
      threadId: row.threadId, updatedAt: row.updatedAt
    });
  }
  return rows.map((row) => Object.fromEntries(BOARD_FIELDS.map((field) => [field, row[field]])));
}

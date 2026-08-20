import { z } from "zod";

const identifier = z.string().trim().min(1).max(160);
const node = z.object({
  id: identifier,
  type: z.enum(["manualTrigger", "loomAgent", "output"]),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2_000).default(""),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
  config: z.record(z.unknown()).default({})
}).strict();
const edge = z.object({
  id: identifier,
  source: identifier,
  target: identifier,
  sourcePort: z.string().trim().min(1).max(80).default("output"),
  targetPort: z.string().trim().min(1).max(80).default("input")
}).strict();

export const loomWorkflowToolShapes = {
  list_workflows: {},
  inspect_workflow: { workflowId: identifier },
  create_workflow: {
    name: z.string().trim().min(1).max(240),
    description: z.string().max(10_000).default("")
  },
  save_workflow: {
    workflowId: identifier,
    name: z.string().trim().min(1).max(240).optional(),
    description: z.string().max(10_000).optional(),
    nodes: z.array(node).max(200),
    edges: z.array(edge).max(600),
    viewport: z.object({
      x: z.number().finite().default(0),
      y: z.number().finite().default(0),
      zoom: z.number().finite().min(0.2).max(3).default(1)
    }).strict().optional(),
    expectedUpdatedAt: z.string().datetime().optional()
  },
  delete_workflow: { workflowId: identifier },
  run_workflow: {
    workflowId: identifier,
    input: z.unknown().optional()
  },
  open_workflow: { workflowId: identifier }
};

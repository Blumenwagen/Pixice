import { z } from "zod";

export const INSTRUMENT_SCHEMA_VERSION = 1;
export const MAX_INSTRUMENT_BYTES = 500_000;
export const MAX_INSTRUMENT_PRIMITIVES = 180;
export const MAX_INSTRUMENT_DEPTH = 14;
export const MAX_INSTRUMENT_COLLECTION = 2_000;
export const MAX_THREAD_INSTRUMENTS = 24;
export const MAX_INSTRUMENT_SOURCES = 12;
export const MAX_INSTRUMENT_PARAMETERS = 16;
export const MAX_INSTRUMENT_SOURCE_BYTES = 200_000;
export const MAX_INSTRUMENT_EVENT_BYTES = 32_000;

const identifier = z.string().trim().min(1).max(120).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
const boundedText = (maximum = 10_000) => z.string().max(maximum);
const bindingValue = z.unknown();
const common = {
  id: identifier.optional(),
  hidden: bindingValue.optional()
};

const optionSchema = z.object({
  label: boundedText(120),
  value: z.union([z.string(), z.number(), z.boolean()])
}).strict();

const columnSchema = z.object({
  key: identifier,
  label: boundedText(120),
  width: z.number().finite().min(60).max(800).optional()
}).strict();

const graphNodeSchema = z.object({
  id: z.string().trim().min(1).max(160),
  label: boundedText(240),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  group: boundedText(120).optional(),
  detail: boundedText(1_000).optional(),
  tone: z.enum(["neutral", "blue", "green", "purple", "orange", "red"]).optional()
}).strict();

const graphEdgeSchema = z.object({
  id: z.string().trim().min(1).max(160).optional(),
  source: z.string().trim().min(1).max(160),
  target: z.string().trim().min(1).max(160),
  label: boundedText(160).optional()
}).strict();

const statusItemSchema = z.object({
  id: z.string().trim().min(1).max(160).optional(),
  label: boundedText(240),
  detail: boundedText(1_000).optional(),
  status: z.enum(["pending", "running", "success", "warning", "error", "neutral"]).default("neutral")
}).strict();

const chartSeriesSchema = z.object({
  key: identifier,
  label: boundedText(120),
  color: z.enum(["blue", "green", "purple", "pink", "orange", "red", "grey"]).optional()
}).strict();

let primitiveSchema;
const childArray = () => z.array(primitiveSchema).max(80);

primitiveSchema = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ ...common, type: z.literal("stack"), gap: z.enum(["small", "medium", "large"]).default("medium"), children: childArray() }).strict(),
  z.object({ ...common, type: z.literal("grid"), columns: z.number().int().min(1).max(4).default(2), gap: z.enum(["small", "medium", "large"]).default("medium"), children: childArray() }).strict(),
  z.object({ ...common, type: z.literal("split"), direction: z.enum(["horizontal", "vertical"]).default("horizontal"), ratio: z.number().finite().min(0.2).max(0.8).default(0.6), children: z.array(primitiveSchema).length(2) }).strict(),
  z.object({ ...common, type: z.literal("card"), title: boundedText(160).optional(), description: boundedText(500).optional(), children: childArray() }).strict(),
  z.object({ ...common, type: z.literal("tabs"), tabs: z.array(z.object({ id: identifier, label: boundedText(120), children: childArray() }).strict()).min(1).max(12) }).strict(),
  z.object({ ...common, type: z.literal("text"), text: bindingValue, tone: z.enum(["default", "muted", "success", "warning", "danger"]).default("default"), size: z.enum(["small", "body", "lead", "title"]).default("body") }).strict(),
  z.object({ ...common, type: z.literal("metric"), label: boundedText(120), value: bindingValue, detail: bindingValue.optional(), format: z.enum(["number", "compact", "percent", "currency", "text"]).default("text"), unit: boundedText(12).optional() }).strict(),
  z.object({ ...common, type: z.literal("button"), label: boundedText(120), action: identifier, variant: z.enum(["primary", "secondary", "quiet", "danger"]).default("secondary"), disabled: bindingValue.optional() }).strict(),
  z.object({ ...common, type: z.literal("input"), id: identifier, label: boundedText(120), placeholder: boundedText(240).optional() }).strict(),
  z.object({ ...common, type: z.literal("textarea"), id: identifier, label: boundedText(120), placeholder: boundedText(240).optional(), rows: z.number().int().min(2).max(12).default(4) }).strict(),
  z.object({ ...common, type: z.literal("select"), id: identifier, label: boundedText(120), options: z.array(optionSchema).min(1).max(40) }).strict(),
  z.object({ ...common, type: z.literal("toggle"), id: identifier, label: boundedText(120) }).strict(),
  z.object({ ...common, type: z.literal("range"), id: identifier, label: boundedText(120), min: z.number().finite(), max: z.number().finite(), step: z.number().finite().positive().default(1), format: z.enum(["number", "percent", "currency"]).default("number"), unit: boundedText(12).optional() }).strict(),
  z.object({ ...common, type: z.literal("table"), columns: z.array(columnSchema).min(1).max(20), rows: bindingValue, selection: identifier.optional(), emptyLabel: boundedText(240).default("No rows") }).strict(),
  z.object({ ...common, type: z.literal("graph"), nodes: z.union([z.array(graphNodeSchema).max(MAX_INSTRUMENT_COLLECTION), z.string()]), edges: z.union([z.array(graphEdgeSchema).max(MAX_INSTRUMENT_COLLECTION), z.string()]), selection: identifier.optional(), height: z.number().finite().min(220).max(900).default(440) }).strict(),
  z.object({ ...common, type: z.literal("statusList"), items: z.union([z.array(statusItemSchema).max(MAX_INSTRUMENT_COLLECTION), z.string()]), emptyLabel: boundedText(240).default("Nothing to show") }).strict(),
  z.object({ ...common, type: z.literal("code"), code: bindingValue, language: boundedText(40).optional(), title: boundedText(160).optional() }).strict(),
  z.object({ ...common, type: z.literal("diff"), before: bindingValue, after: bindingValue, language: boundedText(40).optional(), title: boundedText(160).optional() }).strict(),
  z.object({ ...common, type: z.literal("chart"), chartType: z.enum(["area", "bar"]).default("bar"), data: bindingValue, xKey: identifier.default("label"), series: z.array(chartSeriesSchema).min(1).max(6), title: boundedText(160).optional(), height: z.number().finite().min(140).max(420).default(240), format: z.enum(["number", "compact", "percent", "currency"]).default("number"), unit: boundedText(12).optional() }).strict()
]));

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("setState"), path: identifier, value: bindingValue }).strict(),
  z.object({ type: z.literal("resetState") }).strict(),
  z.object({ type: z.literal("openResource"), target: bindingValue }).strict(),
  z.object({ type: z.literal("refreshData"), source: identifier.optional() }).strict(),
  z.object({ type: z.literal("sendAgentEvent"), event: identifier, payload: bindingValue.optional() }).strict(),
  z.object({
    type: z.literal("invokeCapability"),
    capability: z.enum(["board.create", "board.update", "board.move", "workflow.run"]),
    arguments: bindingValue,
    confirmation: boundedText(500).refine((value) => value.trim().length > 0, "Trusted actions require a confirmation message")
  }).strict()
]);

const sourceSchema = z.object({
  capability: z.enum(["project.summary", "git.status", "git.diff", "files.readText", "board.list", "workflows.list", "workflow.output", "tasks.plan"]),
  arguments: z.record(z.unknown()).default({}),
  refresh: z.enum(["manual", "onOpen", "event"]).default("manual")
}).strict();

const parameterOptionSchema = z.object({
  label: boundedText(120),
  value: z.union([z.string(), z.number(), z.boolean()])
}).strict();

const parameterSchema = z.object({
  label: boundedText(120),
  description: boundedText(500).default(""),
  type: z.enum(["string", "number", "boolean", "select"]),
  required: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  placeholder: boundedText(240).optional(),
  options: z.array(parameterOptionSchema).min(1).max(40).optional()
}).strict().superRefine((parameter, context) => {
  if (parameter.type === "select" && !parameter.options?.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Select parameters require options" });
  }
  if (parameter.type !== "select" && parameter.options) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only select parameters accept options" });
  }
  if (parameter.default !== undefined) {
    const expected = parameter.type === "select" ? null : parameter.type;
    if (expected && typeof parameter.default !== expected) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Parameter default must be ${expected}` });
    }
    if (parameter.type === "select" && !parameter.options?.some((option) => option.value === parameter.default)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Select parameter default must match an option" });
    }
  }
});

const sourceStateSchema = z.object({
  status: z.enum(["pending", "ready", "error"]),
  refreshedAt: z.string().datetime().nullable().default(null),
  error: boundedText(1_000).nullable().default(null)
}).strict();

export const instrumentDocumentSchema = z.object({
  version: z.literal(INSTRUMENT_SCHEMA_VERSION),
  title: boundedText(160).refine((value) => value.trim().length > 0, "Instrument title is required"),
  description: boundedText(1_000).default(""),
  parameters: z.record(identifier, parameterSchema).default({}),
  state: z.record(z.unknown()).default({}),
  data: z.record(z.unknown()).default({}),
  sources: z.record(identifier, sourceSchema).default({}),
  sourceState: z.record(identifier, sourceStateSchema).default({}),
  layout: primitiveSchema,
  actions: z.record(identifier, actionSchema).default({})
}).strict();

function jsonClone(value) {
  let source;
  try {
    source = JSON.stringify(value);
  } catch {
    throw new Error("Instrument documents must contain only JSON-compatible values");
  }
  if (Buffer.byteLength(source, "utf8") > MAX_INSTRUMENT_BYTES) {
    throw new Error(`Instrument document exceeds ${MAX_INSTRUMENT_BYTES} bytes`);
  }
  return JSON.parse(source);
}

function countCollection(value, path = "document") {
  if (Array.isArray(value)) {
    if (value.length > MAX_INSTRUMENT_COLLECTION) throw new Error(`${path} exceeds the collection limit`);
    value.forEach((entry, index) => countCollection(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) countCollection(entry, `${path}.${key}`);
}

function inspectPrimitive(primitive, depth, totals, ids) {
  if (depth > MAX_INSTRUMENT_DEPTH) throw new Error(`Instrument layout exceeds ${MAX_INSTRUMENT_DEPTH} levels`);
  totals.count += 1;
  if (totals.count > MAX_INSTRUMENT_PRIMITIVES) throw new Error(`Instrument exceeds ${MAX_INSTRUMENT_PRIMITIVES} primitives`);
  if (primitive.type === "range" && primitive.max < primitive.min) {
    throw new Error("Range maximum must be greater than or equal to its minimum");
  }
  if (primitive.id) {
    if (ids.has(primitive.id)) throw new Error(`Duplicate Instrument primitive id: ${primitive.id}`);
    ids.add(primitive.id);
  }
  if (Array.isArray(primitive.children)) primitive.children.forEach((child) => inspectPrimitive(child, depth + 1, totals, ids));
  if (Array.isArray(primitive.tabs)) primitive.tabs.forEach((tab) => tab.children.forEach((child) => inspectPrimitive(child, depth + 1, totals, ids)));
}

export function normalizeInstrumentDocument(input) {
  const clone = jsonClone(input);
  countCollection(clone);
  const document = instrumentDocumentSchema.parse(clone);
  if (Object.keys(document.sources).length > MAX_INSTRUMENT_SOURCES) {
    throw new Error(`Instrument exceeds ${MAX_INSTRUMENT_SOURCES} live data sources`);
  }
  if (Object.keys(document.parameters).length > MAX_INSTRUMENT_PARAMETERS) {
    throw new Error(`Instrument exceeds ${MAX_INSTRUMENT_PARAMETERS} launch parameters`);
  }
  inspectPrimitive(document.layout, 1, { count: 0 }, new Set());
  return document;
}

export function instrumentContractSummary() {
  return {
    version: INSTRUMENT_SCHEMA_VERSION,
    format: "Strict JSON rendered by Pixice. Scripts, HTML, CSS, SVG, shell commands, network calls, and arbitrary IPC are not supported.",
    limits: {
      documentBytes: MAX_INSTRUMENT_BYTES,
      primitives: MAX_INSTRUMENT_PRIMITIVES,
      depth: MAX_INSTRUMENT_DEPTH,
      collectionItems: MAX_INSTRUMENT_COLLECTION,
      instrumentsPerThread: MAX_THREAD_INSTRUMENTS,
      liveDataSources: MAX_INSTRUMENT_SOURCES,
      launchParameters: MAX_INSTRUMENT_PARAMETERS,
      liveSourceResultBytes: MAX_INSTRUMENT_SOURCE_BYTES,
      agentEventBytes: MAX_INSTRUMENT_EVENT_BYTES
    },
    layout: ["stack", "grid", "split", "card", "tabs"],
    display: ["text", "metric", "table", "graph", "statusList", "code", "diff", "chart"],
    controls: ["input", "textarea", "select", "toggle", "range", "button"],
    actions: ["setState", "resetState", "openResource", "refreshData", "sendAgentEvent", "invokeCapability"],
    trustedCapabilities: ["board.create", "board.update", "board.move", "workflow.run"],
    trustedCapabilityArguments: {
      "board.create": { title: "required", description: "optional", column: "backlog | ready | active | done" },
      "board.update": { taskId: "required", title: "optional", description: "optional" },
      "board.move": { taskId: "required", column: "required backlog | ready | active | done", beforeTaskId: "optional" },
      "workflow.run": { workflowId: "required", input: "optional JSON", triggerNodeId: "optional" }
    },
    parameters: "Optional string, number, boolean, or select launch parameters. Bind them with $params.name.",
    sources: ["project.summary", "git.status", "git.diff", "files.readText", "board.list", "workflows.list", "workflow.output", "tasks.plan"],
    sourceArguments: {
      "project.summary": {},
      "git.status": {},
      "git.diff": { maxBytes: "optional integer, 1000 to 160000, default 80000" },
      "files.readText": { path: "required project-relative path", maxBytes: "optional integer, 1000 to 160000, default 80000" },
      "board.list": {},
      "workflows.list": {},
      "workflow.output": { workflowId: "required", runId: "optional; defaults to the latest run" },
      "tasks.plan": {}
    },
    bindings: "Use $state.path, $data.path, $params.path, or $event.path in display values, rows, nodes, edges, action payloads, hidden, disabled, and openResource targets.",
    guidance: [
      "Use an Instrument only when interaction helps more than prose.",
      "Keep the first document small and immediately useful.",
      "Controls update Instrument-local state without a model call.",
      "Live sources are bounded read-only snapshots refreshed manually, when the Instrument opens, or after matching Pixice events.",
      "sendAgentEvent starts or steers the owning thread through its normal permission mode.",
      "invokeCapability always requires a user click and native confirmation naming the actual capability."
    ]
  };
}

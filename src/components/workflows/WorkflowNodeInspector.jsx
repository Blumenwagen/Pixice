import { Brain, Eye, Plus, Trash, X } from "../icons/index.jsx";
import { WorkflowNodeIcon } from "./workflow-icons.jsx";
import { WORKFLOW_NODE_META, workflowId } from "./workflow-utils.js";
import styles from "./WorkflowWorkspace.module.css";

const PERMISSIONS = [
  ["read-only", "Read only"],
  ["workspace-write", "Workspace access"],
  ["auto-approve", "Auto-review"],
  ["full-access", "Full access"]
];

const CONDITION_OPERATORS = [
  ["equals", "Equals"],
  ["notEquals", "Does not equal"],
  ["contains", "Contains"],
  ["notContains", "Does not contain"],
  ["startsWith", "Starts with"],
  ["endsWith", "Ends with"],
  ["matches", "Matches regex"],
  ["exists", "Exists"],
  ["notExists", "Does not exist"],
  ["greaterThan", "Greater than"],
  ["greaterThanOrEqual", "Greater than or equal"],
  ["lessThan", "Less than"],
  ["lessThanOrEqual", "Less than or equal"],
  ["isTrue", "Is true"],
  ["isFalse", "Is false"],
  ["isEmpty", "Is empty"],
  ["isNotEmpty", "Is not empty"]
];

const UNARY_OPERATORS = new Set(["exists", "notExists", "isTrue", "isFalse", "isEmpty", "isNotEmpty"]);

function IconButton({ label, children, ...props }) {
  return <button type="button" className={styles.iconButton} aria-label={label} title={label} {...props}>{children}</button>;
}

function Toggle({ label, detail, checked, onChange }) {
  return (
    <label className={styles.toggleField}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span><strong>{label}</strong>{detail && <small>{detail}</small>}</span>
    </label>
  );
}

function ExpressionHint() {
  return (
    <p className={styles.expressionHint}>
      Expressions support <code>{"{{input.path}}"}</code>, <code>{"{{run.path}}"}</code>, <code>{"{{nodes.nodeId.path}}"}</code>, helpers such as <code>length()</code>, and <code>??</code> fallbacks.
    </p>
  );
}

function AgentFields({ node, models, updateConfig }) {
  const selectedModel = models.find((model) => model.model === node.config?.model || model.id === node.config?.model);
  const efforts = selectedModel?.supportedReasoningEfforts?.map((option) => option.reasoningEffort ?? option.effort ?? option) ?? ["low", "medium", "high"];
  const executionMode = node.config?.executionMode ?? "background";
  return (
    <>
      <div className={styles.field}>
        <span>Run agent as</span>
        <div className={styles.executionModePicker} role="radiogroup" aria-label="Agent execution mode">
          <button type="button" role="radio" aria-checked={executionMode === "background"} data-selected={executionMode === "background"} onClick={() => updateConfig({ executionMode: "background" })}>
            <Brain size={16} /><span><strong>Background</strong><small>Stay inside the workflow and source task.</small></span>
          </button>
          <button type="button" role="radio" aria-checked={executionMode === "foreground"} data-selected={executionMode === "foreground"} onClick={() => updateConfig({ executionMode: "foreground" })}>
            <Eye size={16} /><span><strong>Foreground</strong><small>Create a normal Loom task thread.</small></span>
          </button>
        </div>
        <small>Both modes pass the final answer downstream. Foreground threads can be steered and continued directly.</small>
      </div>
      <label className={styles.field}>
        <span>Agent prompt</span>
        <textarea value={String(node.config?.prompt ?? "")} rows={7} onChange={(event) => updateConfig({ prompt: event.target.value })} />
        <small>Incoming values are appended as structured workflow context.</small>
      </label>
      <label className={styles.field}>
        <span>Model</span>
        <select value={String(node.config?.model ?? "")} onChange={(event) => updateConfig({ model: event.target.value || null, effort: null })}>
          <option value="">Project default</option>
          {models.map((model) => <option value={model.id ?? model.model} key={model.id ?? model.model}>{model.displayName ?? model.model}</option>)}
        </select>
      </label>
      <label className={styles.field}>
        <span>Reasoning effort</span>
        <select value={String(node.config?.effort ?? "")} onChange={(event) => updateConfig({ effort: event.target.value || null })}>
          <option value="">Model default</option>
          {efforts.map((effort) => <option value={effort} key={effort}>{String(effort).replace(/^./, (letter) => letter.toUpperCase())}</option>)}
        </select>
      </label>
      <label className={styles.field}>
        <span>Permissions</span>
        <select value={String(node.config?.permissionMode ?? "workspace-write")} onChange={(event) => updateConfig({ permissionMode: event.target.value })}>
          {PERMISSIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select>
      </label>
    </>
  );
}

function HttpFields({ config, updateConfig }) {
  const bodyMode = config.bodyMode ?? "json";
  return (
    <>
      <div className={styles.inlineFields}>
        <label className={styles.field}>
          <span>Method</span>
          <select value={config.method ?? "GET"} onChange={(event) => updateConfig({ method: event.target.value })}>
            {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].map((method) => <option key={method}>{method}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          <span>Response</span>
          <select value={config.responseType ?? "auto"} onChange={(event) => updateConfig({ responseType: event.target.value })}>
            <option value="auto">Auto-detect</option><option value="json">JSON</option><option value="text">Text</option>
          </select>
        </label>
      </div>
      <label className={styles.field}><span>URL</span><input value={config.url ?? ""} onChange={(event) => updateConfig({ url: event.target.value })} placeholder="https://api.example.com/items/{{input.id}}" /></label>
      <label className={styles.field}><span>Query parameters · JSON</span><textarea rows={4} value={config.query ?? "{}"} onChange={(event) => updateConfig({ query: event.target.value })} spellCheck="false" /></label>
      <label className={styles.field}><span>Headers · JSON</span><textarea rows={5} value={config.headers ?? "{}"} onChange={(event) => updateConfig({ headers: event.target.value })} spellCheck="false" /></label>
      {!new Set(["GET", "HEAD"]).has(config.method ?? "GET") && (
        <>
          <label className={styles.field}>
            <span>Body format</span>
            <select value={bodyMode} onChange={(event) => updateConfig({ bodyMode: event.target.value })}>
              <option value="json">JSON</option><option value="text">Text</option><option value="none">No body</option>
            </select>
          </label>
          {bodyMode !== "none" && <label className={styles.field}><span>Request body</span><textarea rows={7} value={config.body ?? ""} onChange={(event) => updateConfig({ body: event.target.value })} spellCheck="false" /></label>}
        </>
      )}
      <div className={styles.inlineFields}>
        <label className={styles.field}><span>Timeout · ms</span><input type="number" min="100" max="300000" value={config.timeoutMs ?? 30000} onChange={(event) => updateConfig({ timeoutMs: Number(event.target.value) })} /></label>
        <label className={styles.field}><span>Max response · bytes</span><input type="number" min="1024" max="25000000" value={config.maxBytes ?? 5000000} onChange={(event) => updateConfig({ maxBytes: Number(event.target.value) })} /></label>
      </div>
      <Toggle label="Fail on HTTP errors" detail="Stop the workflow for non-2xx responses." checked={config.failOnHttpError !== false} onChange={(value) => updateConfig({ failOnHttpError: value })} />
      <ExpressionHint />
    </>
  );
}

function TransformFields({ config, updateConfig }) {
  return (
    <>
      <label className={styles.field}>
        <span>Output type</span>
        <select value={config.mode ?? "json"} onChange={(event) => updateConfig({ mode: event.target.value })}><option value="json">Typed JSON</option><option value="text">Text</option></select>
      </label>
      <label className={styles.field}>
        <span>{config.mode === "text" ? "Text template" : "JSON template"}</span>
        <textarea rows={11} value={config.template ?? ""} onChange={(event) => updateConfig({ template: event.target.value })} spellCheck="false" />
      </label>
      {config.mode !== "text" && <Toggle label="Merge with input object" detail="Keeps existing input fields and overwrites matching keys." checked={Boolean(config.mergeInput)} onChange={(value) => updateConfig({ mergeInput: value })} />}
      <ExpressionHint />
    </>
  );
}

function ConditionFields({ config, updateConfig }) {
  const operator = config.operator ?? "isTrue";
  return (
    <>
      <label className={styles.field}><span>Left value</span><input value={config.left ?? "{{input}}"} onChange={(event) => updateConfig({ left: event.target.value })} /></label>
      <label className={styles.field}>
        <span>Comparison</span>
        <select value={operator} onChange={(event) => updateConfig({ operator: event.target.value })}>
          {CONDITION_OPERATORS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select>
      </label>
      {!UNARY_OPERATORS.has(operator) && <label className={styles.field}><span>Right value</span><input value={config.right ?? ""} onChange={(event) => updateConfig({ right: event.target.value })} /></label>}
      <ExpressionHint />
    </>
  );
}

function SwitchFields({ config, updateConfig }) {
  const rules = Array.isArray(config.rules) ? config.rules : [];
  const updateRule = (index, patch) => updateConfig({ rules: rules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patch } : rule) });
  const removeRule = (index) => updateConfig({ rules: rules.filter((_rule, ruleIndex) => ruleIndex !== index) });
  const addRule = () => {
    const index = rules.length + 1;
    updateConfig({ rules: [...rules, { id: `case-${workflowId("port").slice(-6)}`, label: `Case ${index}`, operator: "equals", compare: "value" }] });
  };
  return (
    <>
      <label className={styles.field}><span>Value to route</span><input value={config.value ?? "{{input}}"} onChange={(event) => updateConfig({ value: event.target.value })} /></label>
      <div className={styles.field}>
        <span>Cases</span>
        <div className={styles.ruleList}>
          {rules.map((rule, index) => (
            <div className={styles.ruleRow} key={rule.id ?? index}>
              <input aria-label={`Case ${index + 1} label`} value={rule.label ?? ""} onChange={(event) => updateRule(index, { label: event.target.value })} placeholder="Case label" />
              <select aria-label={`Case ${index + 1} comparison`} value={rule.operator ?? "equals"} onChange={(event) => updateRule(index, { operator: event.target.value })}>
                {CONDITION_OPERATORS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
              {!UNARY_OPERATORS.has(rule.operator ?? "equals") && <input aria-label={`Case ${index + 1} value`} value={rule.compare ?? ""} onChange={(event) => updateRule(index, { compare: event.target.value })} placeholder="Compare value" />}
              <IconButton label={`Remove ${rule.label ?? `case ${index + 1}`}`} onClick={() => removeRule(index)}><Trash size={13} /></IconButton>
            </div>
          ))}
        </div>
        <button type="button" className={styles.secondaryButton} disabled={rules.length >= 8} onClick={addRule}><Plus size={13} />Add case</button>
        <small>Cases expose named output ports. Unmatched values use the Default port.</small>
      </div>
      <ExpressionHint />
    </>
  );
}

function MergeFields({ config, updateConfig }) {
  return (
    <label className={styles.field}>
      <span>Merge mode</span>
      <select value={config.mode ?? "array"} onChange={(event) => updateConfig({ mode: event.target.value })}>
        <option value="array">Array of inputs</option>
        <option value="object">Merge objects</option>
        <option value="keyed">Object keyed by source node</option>
        <option value="concatenate">Flatten arrays</option>
        <option value="first">First active input</option>
        <option value="last">Last active input</option>
      </select>
    </label>
  );
}

function DelayFields({ config, updateConfig }) {
  return (
    <div className={styles.inlineFields}>
      <label className={styles.field}><span>Amount</span><input type="number" min="0" max="86400" value={config.amount ?? 1} onChange={(event) => updateConfig({ amount: Number(event.target.value) })} /></label>
      <label className={styles.field}><span>Unit</span><select value={config.unit ?? "seconds"} onChange={(event) => updateConfig({ unit: event.target.value })}><option value="milliseconds">Milliseconds</option><option value="seconds">Seconds</option><option value="minutes">Minutes</option><option value="hours">Hours</option></select></label>
    </div>
  );
}

function FileFields({ config, updateConfig }) {
  const operation = config.operation ?? "readText";
  return (
    <>
      <label className={styles.field}><span>Operation</span><select value={operation} onChange={(event) => updateConfig({ operation: event.target.value })}><option value="readText">Read text</option><option value="writeText">Write text</option><option value="list">List directory</option><option value="stat">File information</option><option value="exists">Check existence</option></select></label>
      <label className={styles.field}><span>Project-relative path</span><input value={config.path ?? ""} onChange={(event) => updateConfig({ path: event.target.value })} /></label>
      {operation === "writeText" && (
        <>
          <label className={styles.field}><span>Content</span><textarea rows={9} value={config.content ?? ""} onChange={(event) => updateConfig({ content: event.target.value })} /></label>
          <Toggle label="Allow project writes" detail="Required before this node may create or overwrite a file." checked={Boolean(config.allowWrite)} onChange={(value) => updateConfig({ allowWrite: value })} />
          <Toggle label="Create parent directories" checked={config.createDirectories !== false} onChange={(value) => updateConfig({ createDirectories: value })} />
        </>
      )}
      {operation === "list" && <Toggle label="List recursively" detail="Limited to eight directory levels and 2,000 entries." checked={Boolean(config.recursive)} onChange={(value) => updateConfig({ recursive: value })} />}
      {(operation === "readText" || operation === "writeText") && <label className={styles.field}><span>Maximum bytes</span><input type="number" min="1024" max="25000000" value={config.maxBytes ?? 5000000} onChange={(event) => updateConfig({ maxBytes: Number(event.target.value) })} /></label>}
      <ExpressionHint />
    </>
  );
}

function GitFields({ config, updateConfig }) {
  const operation = config.operation ?? "status";
  return (
    <>
      <label className={styles.field}><span>Operation</span><select value={operation} onChange={(event) => updateConfig({ operation: event.target.value })}><option value="status">Repository status</option><option value="diff">Diff</option><option value="changedFiles">Changed files</option><option value="log">Commit history</option><option value="show">Show commit</option></select></label>
      {operation !== "status" && <label className={styles.field}><span>Git target</span><input value={config.target ?? "HEAD"} onChange={(event) => updateConfig({ target: event.target.value })} /></label>}
      {operation !== "status" && operation !== "show" && <label className={styles.field}><span>Optional path</span><input value={config.pathspec ?? ""} onChange={(event) => updateConfig({ pathspec: event.target.value })} /></label>}
      {(operation === "diff" || operation === "changedFiles") && <Toggle label="Staged changes" checked={Boolean(config.staged)} onChange={(value) => updateConfig({ staged: value })} />}
      {operation === "log" && <label className={styles.field}><span>Maximum commits</span><input type="number" min="1" max="100" value={config.maxEntries ?? 20} onChange={(event) => updateConfig({ maxEntries: Number(event.target.value) })} /></label>}
      <small className={styles.safetyNote}>Git nodes are deliberately read-only and never invoke an arbitrary shell command.</small>
    </>
  );
}

function BoardFields({ config, updateConfig }) {
  const operation = config.operation ?? "list";
  const needsTask = new Set(["update", "move", "delete"]).has(operation);
  return (
    <>
      <label className={styles.field}><span>Operation</span><select value={operation} onChange={(event) => updateConfig({ operation: event.target.value })}><option value="list">List tasks</option><option value="create">Create task</option><option value="update">Update task</option><option value="move">Move task</option><option value="delete">Delete task</option></select></label>
      {needsTask && <label className={styles.field}><span>Task ID</span><input value={config.taskId ?? ""} onChange={(event) => updateConfig({ taskId: event.target.value })} placeholder="{{input.task.id}}" /></label>}
      {(operation === "create" || operation === "update") && (
        <>
          <label className={styles.field}><span>Title</span><input value={config.title ?? ""} onChange={(event) => updateConfig({ title: event.target.value })} /></label>
          <label className={styles.field}><span>Description</span><textarea rows={6} value={config.description ?? ""} onChange={(event) => updateConfig({ description: event.target.value })} /></label>
        </>
      )}
      {(operation === "create" || operation === "move") && <label className={styles.field}><span>Column</span><select value={config.column ?? "backlog"} onChange={(event) => updateConfig({ column: event.target.value })}><option value="backlog">Backlog</option><option value="ready">Ready</option><option value="active">Active</option><option value="done">Done</option></select></label>}
      {operation === "move" && <label className={styles.field}><span>Place before task ID · optional</span><input value={config.beforeTaskId ?? ""} onChange={(event) => updateConfig({ beforeTaskId: event.target.value })} /></label>}
      {operation === "create" && <Toggle label="Attach source conversation" detail="Links the task to the thread that started this workflow run." checked={Boolean(config.attachSourceThread)} onChange={(value) => updateConfig({ attachSourceThread: value })} />}
      {operation !== "list" && <ExpressionHint />}
    </>
  );
}

function ConfigFields({ node, models, updateConfig }) {
  const config = node.config ?? {};
  if (node.type === "loomAgent") return <AgentFields node={node} models={models} updateConfig={updateConfig} />;
  if (node.type === "httpRequest") return <HttpFields config={config} updateConfig={updateConfig} />;
  if (node.type === "transform") return <TransformFields config={config} updateConfig={updateConfig} />;
  if (node.type === "condition") return <ConditionFields config={config} updateConfig={updateConfig} />;
  if (node.type === "switch") return <SwitchFields config={config} updateConfig={updateConfig} />;
  if (node.type === "merge") return <MergeFields config={config} updateConfig={updateConfig} />;
  if (node.type === "delay") return <DelayFields config={config} updateConfig={updateConfig} />;
  if (node.type === "file") return <FileFields config={config} updateConfig={updateConfig} />;
  if (node.type === "git") return <GitFields config={config} updateConfig={updateConfig} />;
  if (node.type === "board") return <BoardFields config={config} updateConfig={updateConfig} />;
  return <small className={styles.safetyNote}>This node has no additional configuration.</small>;
}

export function WorkflowNodeInspector({ node, models, onUpdate, onDelete, onClose }) {
  const meta = WORKFLOW_NODE_META[node.type];
  const updateConfig = (patch) => onUpdate({ config: { ...(node.config ?? {}), ...patch } });
  return (
    <aside className={styles.inspector} aria-label="Workflow node inspector">
      <header className={styles.inspectorHeader}>
        <span className={styles.inspectorGlyph} data-tone={meta.tone}><WorkflowNodeIcon type={node.type} size={17} /></span>
        <span><small>{meta.label}</small><strong>{node.name}</strong></span>
        <IconButton label="Close node inspector" onClick={onClose}><X size={14} /></IconButton>
      </header>
      <div className={styles.inspectorBody}>
        <label className={styles.field}><span>Name</span><input value={node.name} maxLength={160} onChange={(event) => onUpdate({ name: event.target.value })} /></label>
        <label className={styles.field}><span>Description</span><textarea value={node.description ?? ""} maxLength={2000} rows={3} onChange={(event) => onUpdate({ description: event.target.value })} /></label>
        <ConfigFields node={node} models={models} updateConfig={updateConfig} />
      </div>
      <footer className={styles.inspectorFooter}><button type="button" className={styles.dangerButton} onClick={onDelete}><Trash size={14} />Delete node</button></footer>
    </aside>
  );
}

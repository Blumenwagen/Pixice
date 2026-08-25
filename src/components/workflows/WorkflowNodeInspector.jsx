import { useEffect, useState } from "react";
import { Brain, Eye, Plus, Trash, X } from "../icons/index.jsx";
import { WorkflowNodeIcon } from "./workflow-icons.jsx";
import { WORKFLOW_NODE_META, workflowId } from "./workflow-utils.js";
import workspaceStyles from "./WorkflowWorkspace.module.css";
import nodeStyles from "./WorkflowNodes.module.css";

const styles = { ...workspaceStyles, ...nodeStyles };
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

function ExpressionHint({ loop = false }) {
  return (
    <p className={styles.expressionHint}>
      Expressions support <code>{"{{input.path}}"}</code>, <code>{"{{run.path}}"}</code>, <code>{"{{nodes.nodeId.path}}"}</code>, helpers such as <code>length()</code>, and <code>??</code> fallbacks.
      {loop && <> Loop input also exposes <code>{"{{item}}"}</code>, <code>{"{{index}}"}</code>, <code>{"{{batch}}"}</code>, and <code>{"{{items}}"}</code>.</>}
    </p>
  );
}

function CredentialSelect({ api, projectId, value, onChange, label = "Credential" }) {
  const [credentials, setCredentials] = useState([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState("bearer");
  const [secret, setSecret] = useState("");
  const [username, setUsername] = useState("");
  const [keyName, setKeyName] = useState("x-api-key");
  const [location, setLocation] = useState("header");
  const [headers, setHeaders] = useState('{\n  "x-api-key": ""\n}');
  const [error, setError] = useState("");
  const credentialApi = api?.workflowCredentials;

  const load = async () => {
    if (!credentialApi || !projectId) return setCredentials([]);
    try {
      const response = await credentialApi.list(projectId);
      setCredentials(response?.data ?? response ?? []);
      setError("");
    } catch (loadError) {
      setError(loadError.message);
    }
  };

  useEffect(() => { void load(); }, [credentialApi, projectId]);

  const create = async () => {
    if (!credentialApi || !projectId) return;
    try {
      let values;
      if (type === "bearer") values = { token: secret };
      else if (type === "basic") values = { username, password: secret };
      else if (type === "apiKey") values = { name: keyName, value: secret, in: location };
      else values = { headers: JSON.parse(headers) };
      const created = await credentialApi.create({ projectId, name, type, values });
      await load();
      onChange(created.id);
      setOpen(false);
      setName("");
      setSecret("");
      setUsername("");
      setError("");
    } catch (createError) {
      setError(createError.message);
    }
  };

  const remove = async () => {
    if (!credentialApi || !projectId || !value) return;
    try {
      await credentialApi.delete(projectId, value);
      onChange(null);
      await load();
      setError("");
    } catch (deleteError) {
      setError(deleteError.message);
    }
  };

  return (
    <div className={styles.field}>
      <span>{label}</span>
      <div className={styles.inlineFields}>
        <select value={value ?? ""} onChange={(event) => onChange(event.target.value || null)} disabled={!credentialApi || !projectId}>
          <option value="">No credential</option>
          {credentials.map((credential) => <option value={credential.id} key={credential.id}>{credential.name} · {credential.type}</option>)}
        </select>
        <button type="button" className={styles.secondaryButton} onClick={() => setOpen((current) => !current)} disabled={!credentialApi || !projectId}>
          <Plus size={13} />{open ? "Close" : "New"}
        </button>
      </div>
      {value && <button type="button" className={styles.dangerButton} onClick={remove}><Trash size={13} />Delete selected credential</button>}
      {open && (
        <div className={styles.ruleList}>
          <label className={styles.field}><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="GitHub API" /></label>
          <label className={styles.field}>
            <span>Type</span>
            <select value={type} onChange={(event) => setType(event.target.value)}>
              <option value="bearer">Bearer token</option>
              <option value="basic">Basic authentication</option>
              <option value="apiKey">API key</option>
              <option value="headers">Custom headers</option>
            </select>
          </label>
          {type === "basic" && <label className={styles.field}><span>Username</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" /></label>}
          {type === "apiKey" && (
            <div className={styles.inlineFields}>
              <label className={styles.field}><span>Key name</span><input value={keyName} onChange={(event) => setKeyName(event.target.value)} /></label>
              <label className={styles.field}><span>Location</span><select value={location} onChange={(event) => setLocation(event.target.value)}><option value="header">Header</option><option value="query">Query</option></select></label>
            </div>
          )}
          {type === "headers"
            ? <label className={styles.field}><span>Headers · JSON</span><textarea rows={6} value={headers} onChange={(event) => setHeaders(event.target.value)} spellCheck="false" /></label>
            : <label className={styles.field}><span>{type === "basic" ? "Password" : type === "apiKey" ? "API key" : "Token"}</span><input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" /></label>}
          <button type="button" className={styles.primaryButton} onClick={create} disabled={!name.trim()}>Save encrypted credential</button>
          <small className={styles.safetyNote}>Secrets are encrypted by the operating system and are never shown again after saving.</small>
        </div>
      )}
      {!credentialApi && <small>Credentials are available in the Pixice desktop runtime.</small>}
      {error && <small className={styles.safetyNote}>{error}</small>}
    </div>
  );
}

function WorkflowSelect({ workflows, currentWorkflowId, value, onChange, label = "Workflow" }) {
  const choices = workflows.filter((workflow) => workflow.id !== currentWorkflowId);
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <select value={value ?? ""} onChange={(event) => onChange(event.target.value)}>
        <option value="">Select workflow…</option>
        {choices.map((workflow) => <option value={workflow.id} key={workflow.id}>{workflow.name}{workflow.enabled ? " · enabled" : ""}</option>)}
      </select>
      {!choices.length && <small>Create another workflow first. Recursive workflow calls are rejected at runtime.</small>}
    </label>
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
            <Eye size={16} /><span><strong>Foreground</strong><small>Create a normal Pixice task thread.</small></span>
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

function ScheduleFields({ config, updateConfig }) {
  const mode = config.mode ?? "interval";
  return (
    <>
      <label className={styles.field}><span>Schedule type</span><select value={mode} onChange={(event) => updateConfig({ mode: event.target.value })}><option value="interval">Interval</option><option value="cron">Cron expression</option></select></label>
      {mode === "interval" ? (
        <div className={styles.inlineFields}>
          <label className={styles.field}><span>Every</span><input type="number" min="1" max="86400" value={config.every ?? 15} onChange={(event) => updateConfig({ every: Number(event.target.value) })} /></label>
          <label className={styles.field}><span>Unit</span><select value={config.unit ?? "minutes"} onChange={(event) => updateConfig({ unit: event.target.value })}><option value="seconds">Seconds</option><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option></select></label>
        </div>
      ) : <label className={styles.field}><span>Cron</span><input value={config.cron ?? "0 * * * *"} onChange={(event) => updateConfig({ cron: event.target.value })} placeholder="minute hour day month weekday" /><small>Five fields in the computer’s local timezone. Names, lists, ranges, and steps are supported.</small></label>}
      <Toggle label="Run when Pixice starts" detail="Fires once when this enabled workflow is loaded." checked={Boolean(config.runOnStartup)} onChange={(value) => updateConfig({ runOnStartup: value })} />
      <label className={styles.field}><span>Overlapping runs</span><select value={config.overlapPolicy ?? "skip"} onChange={(event) => updateConfig({ overlapPolicy: event.target.value })}><option value="skip">Skip while already running</option><option value="allow">Allow parallel runs</option></select></label>
      <small className={styles.safetyNote}>Schedule triggers run only while the Pixice desktop app is running and the workflow is enabled.</small>
    </>
  );
}

function WebhookFields({ config, updateConfig, api, projectId }) {
  return (
    <>
      <div className={styles.inlineFields}>
        <label className={styles.field}><span>Method</span><select value={config.method ?? "POST"} onChange={(event) => updateConfig({ method: event.target.value })}>{["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => <option key={method}>{method}</option>)}</select></label>
        <label className={styles.field}><span>Port</span><input type="number" min="1024" max="65535" value={config.port ?? 5679} onChange={(event) => updateConfig({ port: Number(event.target.value) })} /></label>
      </div>
      <label className={styles.field}><span>Path</span><input value={config.path ?? "/hook"} onChange={(event) => updateConfig({ path: event.target.value })} placeholder="/hooks/release" /><small>{`http://127.0.0.1:${config.port ?? 5679}${config.path ?? "/hook"}`}</small></label>
      <label className={styles.field}><span>Response</span><select value={config.responseMode ?? "immediate"} onChange={(event) => updateConfig({ responseMode: event.target.value })}><option value="immediate">202 as soon as accepted</option><option value="workflow">Wait for workflow output</option></select></label>
      {config.responseMode === "workflow" && <label className={styles.field}><span>Response timeout · ms</span><input type="number" min="100" max="300000" value={config.timeoutMs ?? 30000} onChange={(event) => updateConfig({ timeoutMs: Number(event.target.value) })} /></label>}
      <label className={styles.field}><span>Maximum request bytes</span><input type="number" min="1024" max="25000000" value={config.maxBytes ?? 1000000} onChange={(event) => updateConfig({ maxBytes: Number(event.target.value) })} /></label>
      <CredentialSelect api={api} projectId={projectId} label="Webhook authentication" value={config.authCredentialId ?? null} onChange={(authCredentialId) => updateConfig({ authCredentialId })} />
      <small className={styles.safetyNote}>The server binds only to 127.0.0.1. It is intentionally unreachable from other devices unless you place your own trusted proxy or tunnel in front of it.</small>
    </>
  );
}

function HttpFields({ config, updateConfig, api, projectId }) {
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
      <CredentialSelect api={api} projectId={projectId} value={config.credentialId ?? null} onChange={(credentialId) => updateConfig({ credentialId })} />
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

function AggregateFields({ config, updateConfig }) {
  const operation = config.operation ?? "collect";
  return (
    <>
      <label className={styles.field}><span>Array source</span><input value={config.source ?? "{{input}}"} onChange={(event) => updateConfig({ source: event.target.value })} /></label>
      <label className={styles.field}><span>Operation</span><select value={operation} onChange={(event) => updateConfig({ operation: event.target.value })}><option value="collect">Collect values</option><option value="count">Count</option><option value="sum">Sum</option><option value="average">Average</option><option value="min">Minimum</option><option value="max">Maximum</option><option value="groupBy">Group by field</option><option value="unique">Unique values</option><option value="mergeObjects">Merge objects</option></select></label>
      {!new Set(["count", "groupBy", "mergeObjects"]).has(operation) && <label className={styles.field}><span>Value field · optional</span><input value={config.field ?? ""} onChange={(event) => updateConfig({ field: event.target.value })} placeholder="price" /><small>Dot path read from every item. Leave empty to use the whole item.</small></label>}
      {operation === "groupBy" && <label className={styles.field}><span>Group field</span><input value={config.groupBy ?? ""} onChange={(event) => updateConfig({ groupBy: event.target.value })} placeholder="status" /></label>}
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

function LoopFields({ config, updateConfig, workflows, currentWorkflowId }) {
  return (
    <>
      <WorkflowSelect workflows={workflows} currentWorkflowId={currentWorkflowId} value={config.workflowId ?? ""} onChange={(workflowIdValue) => updateConfig({ workflowId: workflowIdValue })} label="Workflow per item" />
      <label className={styles.field}><span>Array source</span><input value={config.source ?? "{{input}}"} onChange={(event) => updateConfig({ source: event.target.value })} /></label>
      <label className={styles.field}><span>Mode</span><select value={config.mode ?? "items"} onChange={(event) => updateConfig({ mode: event.target.value })}><option value="items">One run per item</option><option value="batches">One run per batch</option></select></label>
      {config.mode === "batches" && <label className={styles.field}><span>Batch size</span><input type="number" min="1" max="1000" value={config.batchSize ?? 10} onChange={(event) => updateConfig({ batchSize: Number(event.target.value) })} /></label>}
      <div className={styles.inlineFields}>
        <label className={styles.field}><span>Concurrency</span><input type="number" min="1" max="10" value={config.concurrency ?? 1} onChange={(event) => updateConfig({ concurrency: Number(event.target.value) })} /></label>
        <label className={styles.field}><span>Timeout · ms</span><input type="number" min="100" max="3600000" value={config.timeoutMs ?? 300000} onChange={(event) => updateConfig({ timeoutMs: Number(event.target.value) })} /></label>
      </div>
      <label className={styles.field}><span>Subworkflow input</span><textarea rows={6} value={config.input ?? "{{item}}"} onChange={(event) => updateConfig({ input: event.target.value })} spellCheck="false" /></label>
      <Toggle label="Continue when an item fails" detail="The failed item becomes a structured error in the ordered result array." checked={Boolean(config.continueOnError)} onChange={(value) => updateConfig({ continueOnError: value })} />
      <ExpressionHint loop />
    </>
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

function CommandFields({ config, updateConfig }) {
  return (
    <>
      <label className={styles.field}><span>Executable</span><input value={config.executable ?? ""} onChange={(event) => updateConfig({ executable: event.target.value })} placeholder="pnpm" /><small>Use a command from Pixice's PATH or a project-relative executable such as ./scripts/release.</small></label>
      <label className={styles.field}><span>Arguments · JSON array</span><textarea rows={6} value={config.arguments ?? "[]"} onChange={(event) => updateConfig({ arguments: event.target.value })} spellCheck="false" placeholder={'["build"]'} /></label>
      <label className={styles.field}><span>Working directory</span><input value={config.workingDirectory ?? "."} onChange={(event) => updateConfig({ workingDirectory: event.target.value })} placeholder="." /></label>
      <label className={styles.field}><span>Environment overrides · JSON object</span><textarea rows={5} value={config.environment ?? "{}"} onChange={(event) => updateConfig({ environment: event.target.value })} spellCheck="false" /></label>
      <div className={styles.inlineFields}>
        <label className={styles.field}><span>Timeout · ms</span><input type="number" min="100" max="3600000" value={config.timeoutMs ?? 300000} onChange={(event) => updateConfig({ timeoutMs: Number(event.target.value) })} /></label>
        <label className={styles.field}><span>Maximum output bytes</span><input type="number" min="1024" max="25000000" value={config.maxBytes ?? 5000000} onChange={(event) => updateConfig({ maxBytes: Number(event.target.value) })} /></label>
      </div>
      <Toggle label="Allow command execution" detail="Required before this node may start a local process." checked={Boolean(config.allowExecution)} onChange={(value) => updateConfig({ allowExecution: value })} />
      <Toggle label="Continue after non-zero exit" detail="Return the exit code and captured output instead of failing the workflow." checked={Boolean(config.continueOnError)} onChange={(value) => updateConfig({ continueOnError: value })} />
      <small className={styles.safetyNote}>Commands run without a shell, inside the current project, with Pixice's OS permissions. They may modify files or start other processes.</small>
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

function DatabaseFields({ config, updateConfig }) {
  const operation = config.operation ?? "query";
  return (
    <>
      <label className={styles.field}><span>Operation</span><select value={operation} onChange={(event) => updateConfig({ operation: event.target.value })}><option value="query">Query rows</option><option value="execute">Execute write statement</option></select></label>
      <label className={styles.field}><span>Project-relative database</span><input value={config.databasePath ?? "data.sqlite"} onChange={(event) => updateConfig({ databasePath: event.target.value })} /></label>
      <label className={styles.field}><span>SQL</span><textarea rows={9} value={config.sql ?? ""} onChange={(event) => updateConfig({ sql: event.target.value })} spellCheck="false" /></label>
      <label className={styles.field}><span>Parameters · JSON array or object</span><textarea rows={5} value={config.parameters ?? "[]"} onChange={(event) => updateConfig({ parameters: event.target.value })} spellCheck="false" /><small>Use SQLite placeholders such as ?, :name, or $name. Values are bound rather than concatenated.</small></label>
      {operation === "query" ? <label className={styles.field}><span>Maximum rows</span><input type="number" min="1" max="10000" value={config.maxRows ?? 1000} onChange={(event) => updateConfig({ maxRows: Number(event.target.value) })} /></label> : <Toggle label="Allow database writes" detail="Required before execute mode can mutate the selected SQLite file." checked={Boolean(config.allowWrite)} onChange={(value) => updateConfig({ allowWrite: value })} />}
      <small className={styles.safetyNote}>Only the selected project directory is accessible. Query mode opens SQLite read-only.</small>
      <ExpressionHint />
    </>
  );
}

function ExecuteWorkflowFields({ config, updateConfig, workflows, currentWorkflowId }) {
  return (
    <>
      <WorkflowSelect workflows={workflows} currentWorkflowId={currentWorkflowId} value={config.workflowId ?? ""} onChange={(workflowIdValue) => updateConfig({ workflowId: workflowIdValue })} />
      <label className={styles.field}><span>Input</span><textarea rows={7} value={config.input ?? "{{input}}"} onChange={(event) => updateConfig({ input: event.target.value })} spellCheck="false" /></label>
      <label className={styles.field}><span>Return</span><select value={config.returnMode ?? "output"} onChange={(event) => updateConfig({ returnMode: event.target.value })}><option value="output">Workflow output</option><option value="run">Complete run record</option></select></label>
      <label className={styles.field}><span>Timeout · ms</span><input type="number" min="100" max="3600000" value={config.timeoutMs ?? 300000} onChange={(event) => updateConfig({ timeoutMs: Number(event.target.value) })} /></label>
      <Toggle label="Continue when subworkflow fails" detail="Emit a structured error instead of failing this workflow." checked={Boolean(config.continueOnError)} onChange={(value) => updateConfig({ continueOnError: value })} />
      <ExpressionHint />
    </>
  );
}

function NotificationFields({ config, updateConfig }) {
  return (
    <>
      <label className={styles.field}><span>Title</span><input value={config.title ?? "Pixice workflow"} onChange={(event) => updateConfig({ title: event.target.value })} /></label>
      <label className={styles.field}><span>Body</span><textarea rows={7} value={config.body ?? ""} onChange={(event) => updateConfig({ body: event.target.value })} /></label>
      <label className={styles.field}><span>Urgency</span><select value={config.urgency ?? "normal"} onChange={(event) => updateConfig({ urgency: event.target.value })}><option value="low">Low</option><option value="normal">Normal</option><option value="critical">Critical</option></select></label>
      <Toggle label="Silent notification" checked={Boolean(config.silent)} onChange={(value) => updateConfig({ silent: value })} />
      <ExpressionHint />
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

function ConfigFields({ node, models, api, projectId, workflows, currentWorkflowId, updateConfig }) {
  const config = node.config ?? {};
  if (node.type === "scheduleTrigger") return <ScheduleFields config={config} updateConfig={updateConfig} />;
  if (node.type === "webhookTrigger") return <WebhookFields config={config} updateConfig={updateConfig} api={api} projectId={projectId} />;
  if (node.type === "pixiceAgent") return <AgentFields node={node} models={models} updateConfig={updateConfig} />;
  if (node.type === "httpRequest") return <HttpFields config={config} updateConfig={updateConfig} api={api} projectId={projectId} />;
  if (node.type === "transform") return <TransformFields config={config} updateConfig={updateConfig} />;
  if (node.type === "aggregate") return <AggregateFields config={config} updateConfig={updateConfig} />;
  if (node.type === "condition") return <ConditionFields config={config} updateConfig={updateConfig} />;
  if (node.type === "switch") return <SwitchFields config={config} updateConfig={updateConfig} />;
  if (node.type === "merge") return <MergeFields config={config} updateConfig={updateConfig} />;
  if (node.type === "delay") return <DelayFields config={config} updateConfig={updateConfig} />;
  if (node.type === "loop") return <LoopFields config={config} updateConfig={updateConfig} workflows={workflows} currentWorkflowId={currentWorkflowId} />;
  if (node.type === "file") return <FileFields config={config} updateConfig={updateConfig} />;
  if (node.type === "command") return <CommandFields config={config} updateConfig={updateConfig} />;
  if (node.type === "git") return <GitFields config={config} updateConfig={updateConfig} />;
  if (node.type === "database") return <DatabaseFields config={config} updateConfig={updateConfig} />;
  if (node.type === "executeWorkflow") return <ExecuteWorkflowFields config={config} updateConfig={updateConfig} workflows={workflows} currentWorkflowId={currentWorkflowId} />;
  if (node.type === "notification") return <NotificationFields config={config} updateConfig={updateConfig} />;
  if (node.type === "board") return <BoardFields config={config} updateConfig={updateConfig} />;
  return <small className={styles.safetyNote}>This node has no additional configuration.</small>;
}

export function WorkflowNodeInspector({
  node,
  models,
  api,
  projectId,
  workflows = [],
  currentWorkflowId,
  onUpdate,
  onDelete,
  onClose
}) {
  const meta = WORKFLOW_NODE_META[node.type];
  const updateConfig = (patch) => onUpdate({ config: { ...(node.config ?? {}), ...patch } });
  return (
    <aside className={styles.inspector} aria-label="Workflow node inspector">
      <header className={styles.inspectorHeader}>
        <span className={`${styles.inspectorGlyph} ${styles.inspectorTone}`} data-tone={meta.tone}><WorkflowNodeIcon type={node.type} size={17} /></span>
        <span><small>{meta.label}</small><strong>{node.name}</strong></span>
        <IconButton label="Close node inspector" onClick={onClose}><X size={14} /></IconButton>
      </header>
      <div className={styles.inspectorBody}>
        <label className={styles.field}><span>Name</span><input value={node.name} maxLength={160} onChange={(event) => onUpdate({ name: event.target.value })} /></label>
        <label className={styles.field}><span>Description</span><textarea value={node.description ?? ""} maxLength={2000} rows={3} onChange={(event) => onUpdate({ description: event.target.value })} /></label>
        <ConfigFields node={node} models={models} api={api} projectId={projectId} workflows={workflows} currentWorkflowId={currentWorkflowId} updateConfig={updateConfig} />
      </div>
      <footer className={styles.inspectorFooter}><button type="button" className={styles.dangerButton} onClick={onDelete}><Trash size={14} />Delete node</button></footer>
    </aside>
  );
}

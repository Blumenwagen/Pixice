// Reference: T3 Code's provider/CodexMcpElicitation.ts. Keep this module free of
// runtime dependencies so the renderer and backend interpret the same choices.
const ACCEPT_DECISIONS = ["accept", "acceptForSession", "acceptAlways"];
const DECISIONS = new Set([...ACCEPT_DECISIONS, "decline", "cancel"]);
const APPROVAL_KEYS = new Set(["approval", "decision", "permission", "consent", "authorization", "approval_scope", "permission_scope"]);
const ALWAYS_KEYS = new Set(["always", "always_allow", "allow_always", "persist", "persistent", "persistent_approval", "allow_persistent_approval"]);
const SESSION_KEYS = new Set(["session", "allow_for_session", "session_approval"]);
const BOOLEAN_APPROVAL_KEYS = new Set(["approval", "allow", "approved", "consent", "authorize"]);

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
const key = value => String(value).replace(/([a-z0-9])([A-Z])/g, "$1_$2").trim().toLowerCase().replace(/[\s-]+/g, "_");
const primitive = value => value === null || ["string", "boolean"].includes(typeof value) || typeof value === "number" && Number.isFinite(value);

function semanticChoice(value) {
  switch (key(value)) {
    case "once": case "allow_once": case "accept_once": case "approve_once": case "one_time": return "accept";
    case "accept": case "approve": case "allow": case "yes": return "affirm";
    case "session": case "for_session": case "this_session": case "allow_for_session": return "acceptForSession";
    case "always": case "permanent": case "persistent": case "forever": case "allow_always": case "always_allow": return "acceptAlways";
    default: return null;
  }
}

function fieldOptions(field) {
  if (field.oneOf != null) {
    if (!Array.isArray(field.oneOf) || !field.oneOf.length || field.oneOf.some(option => !record(option) || typeof option.const !== "string")) return null;
    return field.oneOf.map(option => ({ value: option.const, label: text(option.title), decision: semanticChoice(option.const) }));
  }
  if (field.enum != null) {
    if (!Array.isArray(field.enum) || !field.enum.length || field.enum.some(value => typeof value !== "string")) return null;
    if (field.enumNames != null && !Array.isArray(field.enumNames)) return null;
    return field.enum.map((value, index) => ({ value, label: text(field.enumNames?.[index]), decision: semanticChoice(value) }));
  }
  return [];
}

function appName(payload, metadata) {
  const candidates = [metadata.app_name, metadata.appName, metadata.app,
    metadata.target?.app, metadata.target?.name, metadata.tool_params?.app_name, metadata.tool_params?.app,
    text(payload.message)?.match(/^Allow ChatGPT to use (.+?)\?$/i)?.[1],
    metadata.connector_name, metadata.connectorName, payload.serverName];
  return candidates.map(text).find(Boolean) ?? "this app";
}

function analyze(payload) {
  if (!record(payload) || payload.mode === "url" || payload.mode != null && !["form", "openai/form", "openaiForm"].includes(payload.mode)) return null;
  const metadata = record(payload._meta) ? payload._meta : {};
  const advertised = new Set();
  const persistence = typeof metadata.persist === "string" ? [metadata.persist] : Array.isArray(metadata.persist) ? metadata.persist : [];
  for (const value of persistence) {
    if (typeof value !== "string") continue;
    const decision = semanticChoice(value);
    if (decision === "acceptAlways" || decision === "acceptForSession") advertised.add(decision);
  }
  if (metadata.allowPersistentApproval === true) advertised.add("acceptAlways");
  const metadataApproval = advertised.size > 0;
  const schema = payload.requestedSchema;
  if (schema != null && (!record(schema) || schema.type != null && schema.type !== "object")) return null;
  if (schema?.properties != null && !record(schema.properties)) return null;
  if (schema?.required != null && (!Array.isArray(schema.required) || schema.required.some(name => typeof name !== "string"))) return null;
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  if ([...required].some(name => !Object.hasOwn(properties, name))) return null;
  const fields = [];
  const labels = new Map();
  let approvalField = false;
  for (const [name, field] of Object.entries(properties)) {
    if (!record(field)) return null;
    const normalized = key(name);
    const approvalKey = APPROVAL_KEYS.has(normalized) || ALWAYS_KEYS.has(normalized) || SESSION_KEYS.has(normalized);
    if (field.type === "boolean" && (ALWAYS_KEYS.has(normalized) || SESSION_KEYS.has(normalized) || BOOLEAN_APPROVAL_KEYS.has(normalized))) {
      const role = ALWAYS_KEYS.has(normalized) ? "acceptAlways" : SESSION_KEYS.has(normalized) ? "acceptForSession" : "affirm";
      fields.push({ name, role, field });
      approvalField = true;
      if (role !== "affirm") { advertised.add(role); if (text(field.title)) labels.set(role, text(field.title)); }
      continue;
    }
    if (approvalKey && (field.type == null || field.type === "string")) {
      const options = fieldOptions(field);
      if (!options || !options.some(option => option.decision) || field.format != null) return null;
      fields.push({ name, role: "choice", field, options, required: required.has(name) });
      approvalField = true;
      for (const option of options) {
        if (option.decision === "acceptForSession" || option.decision === "acceptAlways") advertised.add(option.decision);
        if (option.decision && option.label) labels.set(option.decision === "affirm" ? "accept" : option.decision, option.label);
      }
      continue;
    }
    // A literal provider field can travel with an approval. Any editable data
    // field, even an optional one with a default, keeps the ordinary form UI.
    if (Object.hasOwn(field, "const") && primitive(field.const) && valueMatchesField(field, field.const)) {
      fields.push({ name, role: "constant", value: field.const });
      continue;
    }
    return null;
  }
  if (!metadataApproval && !approvalField) return null;
  if (metadata.allowPersistentApproval === false) advertised.delete("acceptAlways");
  return { appName: appName(payload, metadata), advertised, labels, fields, hasForm: schema != null };
}

function valueMatchesField(field, value) {
  if (field.type != null) {
    if (field.type === "null" ? value !== null : field.type === "integer" ? !Number.isInteger(value)
      : !["string", "boolean", "number"].includes(field.type) || typeof value !== field.type) return false;
  }
  if (Object.hasOwn(field, "const") && field.const !== value) return false;
  if (field.enum != null && (!Array.isArray(field.enum) || !field.enum.includes(value))) return false;
  if (field.oneOf != null && (!Array.isArray(field.oneOf) || field.oneOf.filter(option => record(option) && option.const === value).length !== 1)) return false;
  if (typeof value === "string") {
    if (field.minLength != null && (!Number.isInteger(field.minLength) || value.length < field.minLength)) return false;
    if (field.maxLength != null && (!Number.isInteger(field.maxLength) || value.length > field.maxLength)) return false;
    // Approval options never require free-form pattern matching.
    if (field.pattern != null || field.format != null) return false;
  }
  if (typeof value === "number") {
    if (field.minimum != null && (typeof field.minimum !== "number" || value < field.minimum)) return false;
    if (field.maximum != null && (typeof field.maximum !== "number" || value > field.maximum)) return false;
  }
  return true;
}

function acceptedValue(item, value) {
  if (!valueMatchesField(item.field, value)) throw new Error("This approval choice cannot satisfy the requested form.");
  return [item.name, value];
}

function acceptedResponse(analysis, decision) {
  if (decision !== "accept" && !analysis.advertised.has(decision)) throw new Error("This app does not offer that approval scope.");
  const values = [];
  for (const item of analysis.fields) {
    if (item.role === "constant") { values.push([item.name, item.value]); continue; }
    if (item.role === "affirm") { values.push(acceptedValue(item, true)); continue; }
    if (item.role === "acceptAlways" || item.role === "acceptForSession") { values.push(acceptedValue(item, item.role === decision)); continue; }
    const option = item.options.find(candidate => candidate.decision === decision)
      ?? item.options.find(candidate => candidate.decision === "affirm");
    if (option) { values.push(acceptedValue(item, option.value)); continue; }
    // Never let an omitted field's persistent default turn Allow once into a
    // saved grant, or combine an explicit once-only choice with persistence.
    if (!item.required && item.field.default == null && decision === "accept") continue;
    throw new Error("This approval choice cannot satisfy the requested form.");
  }
  const persist = decision === "acceptAlways" ? "always" : decision === "acceptForSession" ? "session" : null;
  return { action: "accept", ...(persist ? { _meta: { persist } } : {}), ...(analysis.hasForm ? { content: Object.fromEntries(values) } : {}) };
}

/** Describe only provider-advertised approval forms, preserving generic input. */
export function describeMcpElicitationApproval(payload) {
  const analysis = analyze(payload);
  if (!analysis) return null;
  const options = [];
  const labels = { accept: "Allow once", acceptForSession: "Allow for this session", acceptAlways: `Always allow ${analysis.appName}` };
  for (const decision of ACCEPT_DECISIONS) {
    try {
      acceptedResponse(analysis, decision);
      options.push({ decision, label: analysis.labels.get(decision) ?? labels[decision] });
    } catch { /* An advertised option still needs to satisfy every field. */ }
  }
  if (!options.length) return null;
  return { appName: analysis.appName, options: [...options, { decision: "decline", label: "Decline" }, { decision: "cancel", label: "Cancel" }] };
}

/** Produce the native MCP response; persistence remains owned by its provider. */
export function mcpElicitationApprovalResponse(payload, decision) {
  if (!DECISIONS.has(decision)) throw new Error("Unsupported MCP approval decision.");
  if (decision === "decline" || decision === "cancel") return { action: decision };
  const analysis = analyze(payload);
  if (!analysis) throw new Error("This elicitation needs its ordinary input form.");
  return acceptedResponse(analysis, decision);
}

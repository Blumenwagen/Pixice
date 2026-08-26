import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WORKFLOW_CREDENTIAL_TYPES } from "./workflow-node-catalog.mjs";

function nonEmptyString(value, label, maximum = 100_000) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maximum) throw new Error(`${label} is too long`);
  return normalized;
}

function normalizeHeaderObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Credential headers must be a JSON object");
  const headers = {};
  for (const [name, rawValue] of Object.entries(value)) {
    const normalizedName = nonEmptyString(name, "Header name", 240);
    if (/[^!#$%&'*+.^_`|~0-9a-z-]/i.test(normalizedName)) throw new Error(`Header name is invalid: ${normalizedName}`);
    headers[normalizedName] = nonEmptyString(rawValue, `Header ${normalizedName}`, 100_000);
  }
  if (!Object.keys(headers).length) throw new Error("At least one credential header is required");
  return headers;
}

export function normalizeWorkflowCredentialValues(type, values) {
  if (!WORKFLOW_CREDENTIAL_TYPES.includes(type)) throw new Error(`Unsupported workflow credential type: ${type}`);
  if (type === "bearer") return { token: nonEmptyString(values?.token, "Bearer token") };
  if (type === "basic") {
    return {
      username: nonEmptyString(values?.username, "Username", 10_000),
      password: nonEmptyString(values?.password, "Password")
    };
  }
  if (type === "apiKey") {
    return {
      name: nonEmptyString(values?.name, "API key name", 240),
      value: nonEmptyString(values?.value, "API key value"),
      in: values?.in === "query" ? "query" : "header"
    };
  }
  return { headers: normalizeHeaderObject(values?.headers) };
}

function publicCredential(record) {
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    type: record.type,
    hasSecret: Boolean(record.encrypted),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function encryptionAvailable(crypto) {
  if (!crypto) return false;
  if (typeof crypto.isEncryptionAvailable === "function") return Boolean(crypto.isEncryptionAvailable());
  return typeof crypto.encryptString === "function" && typeof crypto.decryptString === "function";
}

function encryptValues(crypto, value) {
  if (!encryptionAvailable(crypto)) throw new Error("Secure credential storage is unavailable on this system");
  return Buffer.from(crypto.encryptString(JSON.stringify(value))).toString("base64");
}

function decryptValues(crypto, encrypted) {
  if (!encryptionAvailable(crypto)) throw new Error("Secure credential storage is unavailable on this system");
  try {
    return JSON.parse(crypto.decryptString(Buffer.from(encrypted, "base64")));
  } catch (error) {
    throw new Error(`Workflow credential could not be decrypted: ${error.message}`);
  }
}

export class WorkflowCredentialStore {
  constructor(userDataPath, { crypto } = {}) {
    this.crypto = crypto;
    this.filePath = path.join(userDataPath, "pixice-workflow-credentials.json");
    this.records = this.#load();
  }

  list(projectId) {
    return this.records
      .filter((record) => record.projectId === projectId)
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))
      .map(publicCredential);
  }

  create({ projectId, name, type, values }) {
    const normalizedName = nonEmptyString(name, "Credential name", 160);
    if (this.records.some((record) => record.projectId === projectId && record.name.toLowerCase() === normalizedName.toLowerCase())) {
      throw new Error("A workflow credential with this name already exists in the project");
    }
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      projectId: nonEmptyString(projectId, "Project id", 160),
      name: normalizedName,
      type,
      encrypted: encryptValues(this.crypto, normalizeWorkflowCredentialValues(type, values)),
      createdAt: now,
      updatedAt: now
    };
    this.records.push(record);
    this.#save();
    return publicCredential(record);
  }

  update({ projectId, credentialId, name, type, values }) {
    const index = this.records.findIndex((record) => record.id === credentialId && record.projectId === projectId);
    if (index === -1) throw new Error("Workflow credential not found in this project");
    const current = this.records[index];
    const nextName = name === undefined ? current.name : nonEmptyString(name, "Credential name", 160);
    if (this.records.some((record, recordIndex) => recordIndex !== index && record.projectId === projectId && record.name.toLowerCase() === nextName.toLowerCase())) {
      throw new Error("A workflow credential with this name already exists in the project");
    }
    const nextType = type ?? current.type;
    if (!WORKFLOW_CREDENTIAL_TYPES.includes(nextType)) throw new Error(`Unsupported workflow credential type: ${nextType}`);
    if (nextType !== current.type && values === undefined) throw new Error("Enter new secret values when changing the credential type");
    const record = {
      ...current,
      name: nextName,
      type: nextType,
      encrypted: values === undefined ? current.encrypted : encryptValues(this.crypto, normalizeWorkflowCredentialValues(nextType, values)),
      updatedAt: new Date().toISOString()
    };
    this.records[index] = record;
    this.#save();
    return publicCredential(record);
  }

  delete(projectId, credentialId) {
    const index = this.records.findIndex((record) => record.id === credentialId && record.projectId === projectId);
    if (index === -1) return null;
    const [record] = this.records.splice(index, 1);
    this.#save();
    return publicCredential(record);
  }

  deleteProject(projectId) {
    const deleted = this.records.filter((record) => record.projectId === projectId);
    if (!deleted.length) return [];
    this.records = this.records.filter((record) => record.projectId !== projectId);
    this.#save();
    return deleted.map(publicCredential);
  }

  resolve(projectId, credentialId) {
    if (!credentialId) return null;
    const record = this.records.find((candidate) => candidate.id === credentialId && candidate.projectId === projectId);
    if (!record) throw new Error("Workflow credential not found in this project");
    return { ...publicCredential(record), values: decryptValues(this.crypto, record.encrypted) };
  }

  #load() {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (!Array.isArray(parsed.credentials)) return [];
      return parsed.credentials.filter((record) => record?.id && record?.projectId && record?.encrypted);
    } catch (error) {
      throw new Error(`Workflow credential store could not be opened: ${error.message}`);
    }
  }

  #save() {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, credentials: this.records }, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.filePath);
    try { chmodSync(this.filePath, 0o600); } catch { /* Windows and some filesystems ignore POSIX file modes. */ }
  }
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(String(left ?? ""));
  const rightBytes = Buffer.from(String(right ?? ""));
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

function requestHeader(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name) ?? "";
  const value = headers?.[String(name).toLowerCase()] ?? headers?.[name];
  return Array.isArray(value) ? value.join(", ") : String(value ?? "");
}

export function applyWorkflowCredential(credential, { url, headers }) {
  if (!credential) return { url, headers };
  const values = credential.values ?? {};
  if (credential.type === "bearer") headers.set("authorization", `Bearer ${values.token}`);
  else if (credential.type === "basic") headers.set("authorization", `Basic ${Buffer.from(`${values.username}:${values.password}`, "utf8").toString("base64")}`);
  else if (credential.type === "apiKey") {
    if (values.in === "query") url.searchParams.set(values.name, values.value);
    else headers.set(values.name, values.value);
  } else if (credential.type === "headers") {
    for (const [name, value] of Object.entries(values.headers ?? {})) headers.set(name, value);
  }
  return { url, headers };
}

export function workflowCredentialAuthorizesRequest(credential, { url, headers }) {
  if (!credential) return true;
  const values = credential.values ?? {};
  if (credential.type === "bearer") return safeEqual(requestHeader(headers, "authorization"), `Bearer ${values.token}`);
  if (credential.type === "basic") {
    const expected = `Basic ${Buffer.from(`${values.username}:${values.password}`, "utf8").toString("base64")}`;
    return safeEqual(requestHeader(headers, "authorization"), expected);
  }
  if (credential.type === "apiKey") {
    const actual = values.in === "query" ? url.searchParams.get(values.name) : requestHeader(headers, values.name);
    return safeEqual(actual, values.value);
  }
  if (credential.type === "headers") {
    return Object.entries(values.headers ?? {}).every(([name, value]) => safeEqual(requestHeader(headers, name), value));
  }
  return false;
}

import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeWorkflowNodeConfig } from "./workflow-node-catalog.mjs";
import {
  workflowEvaluateCondition,
  workflowExpressionContext,
  workflowInputValue,
  workflowParseJsonTemplate,
  workflowRenderTemplate
} from "./workflow-values.mjs";

const execFile = promisify(execFileCallback);
const RESULT_MARKER = "__loomWorkflowNodeResult";

export function workflowNodeResult(output, ports = { output }) {
  return { [RESULT_MARKER]: true, output, ports };
}

export function normalizeWorkflowNodeResult(value) {
  if (value?.[RESULT_MARKER]) return value;
  return workflowNodeResult(value);
}

function renderString(value, context) {
  const rendered = workflowRenderTemplate(value, context);
  if (rendered === undefined || rendered === null) return "";
  if (typeof rendered === "string") return rendered;
  if (typeof rendered === "object") {
    try { return JSON.stringify(rendered); } catch { return String(rendered); }
  }
  return String(rendered);
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must evaluate to a JSON object`);
  return value;
}

function nodeOutputsObject(nodeOutputs) {
  if (nodeOutputs instanceof Map) {
    return Object.fromEntries([...nodeOutputs.entries()].map(([nodeId, value]) => [nodeId, value?.output ?? value]));
  }
  return nodeOutputs ?? {};
}

function expressionContext({ inputs, run, nodeOutputs }) {
  return workflowExpressionContext({
    inputs,
    runInput: run.input,
    nodeOutputs: nodeOutputsObject(nodeOutputs)
  });
}

async function sleepWithCancellation(durationMs, assertActive) {
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    assertActive();
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, end - Date.now()))));
  }
  assertActive();
}

function delayMilliseconds(config) {
  const multipliers = {
    milliseconds: 1,
    seconds: 1_000,
    minutes: 60_000,
    hours: 3_600_000
  };
  return Math.round(config.amount * (multipliers[config.unit] ?? 1_000));
}

function mergeValues(inputs, mode) {
  const values = inputs.map((entry) => entry.value);
  if (mode === "first") return values[0] ?? null;
  if (mode === "last") return values.at(-1) ?? null;
  if (mode === "keyed") return Object.fromEntries(inputs.map((entry) => [entry.sourceNodeId, entry.value]));
  if (mode === "concatenate") return values.flatMap((value) => Array.isArray(value) ? value : [value]);
  if (mode === "object") {
    return Object.assign({}, ...values.map((value) => value && typeof value === "object" && !Array.isArray(value) ? value : {}));
  }
  return values;
}

function assertHttpUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new Error(`HTTP Request URL is invalid: ${error.message}`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("HTTP Request supports only http:// and https:// URLs");
  if (url.username || url.password) throw new Error("Put HTTP credentials in headers instead of the URL");
  return url;
}

async function responseBytes(response, maxBytes) {
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`HTTP response exceeded ${maxBytes} bytes`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`HTTP response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function executeHttpRequest({ config, context, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== "function") throw new Error("HTTP requests are unavailable in this runtime");
  const url = assertHttpUrl(renderString(config.url, context));
  const query = objectValue(workflowParseJsonTemplate(config.query, context, "HTTP query"), "HTTP query");
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((entry) => url.searchParams.append(key, String(entry)));
    else url.searchParams.set(key, String(value));
  }

  const headers = new Headers(objectValue(workflowParseJsonTemplate(config.headers, context, "HTTP headers"), "HTTP headers"));
  let body;
  if (!new Set(["GET", "HEAD"]).has(config.method) && config.bodyMode !== "none") {
    if (config.bodyMode === "json") {
      const value = workflowParseJsonTemplate(config.body, context, "HTTP JSON body");
      body = JSON.stringify(value);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    } else {
      body = renderString(config.body, context);
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`HTTP request timed out after ${config.timeoutMs}ms`)), config.timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: config.method,
      headers,
      body,
      redirect: "follow",
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`HTTP request timed out after ${config.timeoutMs}ms`);
    throw new Error(`HTTP request failed: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }

  const bytes = await responseBytes(response, config.maxBytes);
  const text = new TextDecoder().decode(bytes);
  const contentType = response.headers.get("content-type") ?? "";
  let responseBody = text;
  if (config.responseType === "json" || (config.responseType === "auto" && /(?:application|text)\/(?:[^;]+\+)?json/i.test(contentType))) {
    try { responseBody = text ? JSON.parse(text) : null; } catch (error) {
      throw new Error(`HTTP response was not valid JSON: ${error.message}`);
    }
  }
  const output = {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers: Object.fromEntries(response.headers.entries()),
    body: responseBody
  };
  if (!response.ok && config.failOnHttpError) {
    const preview = typeof responseBody === "string" ? responseBody.slice(0, 500) : JSON.stringify(responseBody).slice(0, 500);
    throw new Error(`HTTP ${response.status} ${response.statusText}${preview ? `: ${preview}` : ""}`);
  }
  return output;
}

function projectPath(root, configuredPath) {
  if (!root) throw new Error("The workflow project is no longer available");
  if (configuredPath.includes("\0")) throw new Error("File path contains an invalid null byte");
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, configuredPath || ".");
  const relative = path.relative(resolvedRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("File nodes may access only the current Loom project");
  return { root: resolvedRoot, candidate, relative: relative || "." };
}

async function assertRealPathInside(root, candidate, allowMissing = false) {
  let realCandidate;
  try {
    realCandidate = await realpath(candidate);
  } catch (error) {
    if (!allowMissing || error.code !== "ENOENT") throw error;
    let ancestor = path.dirname(candidate);
    while (ancestor !== path.dirname(ancestor)) {
      try {
        const realAncestor = await realpath(ancestor);
        const relativeTail = path.relative(ancestor, candidate);
        realCandidate = path.resolve(realAncestor, relativeTail);
        break;
      } catch (ancestorError) {
        if (ancestorError.code !== "ENOENT") throw ancestorError;
        ancestor = path.dirname(ancestor);
      }
    }
    if (!realCandidate) realCandidate = candidate;
  }
  const realRoot = await realpath(root);
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("File path escapes the current Loom project through a symbolic link");
  return realCandidate;
}

async function listProjectFiles(directory, root, recursive, depth = 0) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute);
    result.push({ path: relative, type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file" });
    if (recursive && entry.isDirectory() && depth < 8) result.push(...await listProjectFiles(absolute, root, true, depth + 1));
    if (result.length >= 2_000) break;
  }
  return result;
}

async function executeFileNode({ config, context, projectRoot }) {
  const configuredPath = renderString(config.path, context).trim() || ".";
  const resolved = projectPath(projectRoot, configuredPath);
  if (config.operation === "exists") {
    try {
      await assertRealPathInside(resolved.root, resolved.candidate);
      return { path: resolved.relative, exists: true };
    } catch (error) {
      if (error.code === "ENOENT") return { path: resolved.relative, exists: false };
      throw error;
    }
  }
  if (config.operation === "writeText") {
    if (!config.allowWrite) throw new Error("Enable “Allow project writes” on this File node before it can write");
    await assertRealPathInside(resolved.root, resolved.candidate, true);
    if (config.createDirectories) await mkdir(path.dirname(resolved.candidate), { recursive: true });
    const content = renderString(config.content, context);
    if (Buffer.byteLength(content, "utf8") > config.maxBytes) throw new Error(`File content exceeded ${config.maxBytes} bytes`);
    await writeFile(resolved.candidate, content, "utf8");
    return { path: resolved.relative, bytes: Buffer.byteLength(content, "utf8"), written: true };
  }
  const realCandidate = await assertRealPathInside(resolved.root, resolved.candidate);
  if (config.operation === "readText") {
    const info = await stat(realCandidate);
    if (!info.isFile()) throw new Error("File node path is not a file");
    if (info.size > config.maxBytes) throw new Error(`File exceeded ${config.maxBytes} bytes`);
    return { path: resolved.relative, content: await readFile(realCandidate, "utf8"), bytes: info.size };
  }
  if (config.operation === "list") {
    const info = await stat(realCandidate);
    if (!info.isDirectory()) throw new Error("File list path is not a directory");
    return { path: resolved.relative, entries: await listProjectFiles(realCandidate, resolved.root, Boolean(config.recursive)) };
  }
  const info = await stat(realCandidate);
  return {
    path: resolved.relative,
    type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
    bytes: info.size,
    modifiedAt: info.mtime.toISOString(),
    createdAt: info.birthtime.toISOString()
  };
}

function safeGitTarget(value) {
  const target = String(value ?? "HEAD").trim() || "HEAD";
  if (target.startsWith("-")) throw new Error("Git target cannot start with a dash");
  return target;
}

async function gitCommand(cwd, args) {
  try {
    const { stdout, stderr } = await execFile("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 5_000_000,
      windowsHide: true
    });
    return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
  } catch (error) {
    const detail = String(error.stderr ?? error.stdout ?? error.message).trim();
    throw new Error(`Git ${args[0]} failed${detail ? `: ${detail}` : ""}`);
  }
}

function parseGitLog(stdout) {
  return stdout.split("\u001e").map((record) => record.trim()).filter(Boolean).map((record) => {
    const [sha, shortSha, author, authoredAt, subject] = record.split("\u001f");
    return { sha, shortSha, author, authoredAt, subject };
  });
}

function parseNameStatus(stdout) {
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [status, ...paths] = line.split("\t");
    return { status, paths };
  });
}

async function executeGitNode({ config, context, projectRoot }) {
  const cwd = projectPath(projectRoot, ".").candidate;
  const target = safeGitTarget(renderString(config.target, context));
  const pathspec = renderString(config.pathspec, context).trim();
  if (config.operation === "status") {
    const { stdout } = await gitCommand(cwd, ["status", "--short", "--branch", "--untracked-files=all"]);
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const branch = lines[0]?.startsWith("## ") ? lines.shift().slice(3) : "";
    return {
      branch,
      clean: lines.length === 0,
      changes: lines.map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }))
    };
  }
  if (config.operation === "log") {
    const { stdout } = await gitCommand(cwd, [
      "log",
      "-n",
      String(config.maxEntries),
      "--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e",
      target,
      ...(pathspec ? ["--", pathspec] : [])
    ]);
    return { target, commits: parseGitLog(stdout) };
  }
  if (config.operation === "show") {
    const { stdout } = await gitCommand(cwd, ["show", "--no-ext-diff", "--format=fuller", "--stat", target]);
    return { target, text: stdout };
  }
  const args = ["diff", "--no-ext-diff"];
  if (config.staged) args.push("--cached");
  if (config.operation === "changedFiles") args.push("--name-status");
  else args.push("--unified=3");
  args.push(target);
  if (pathspec) args.push("--", pathspec);
  const { stdout } = await gitCommand(cwd, args);
  return config.operation === "changedFiles"
    ? { target, staged: config.staged, files: parseNameStatus(stdout) }
    : { target, staged: config.staged, diff: stdout };
}

function boardTask(database, projectId, taskId) {
  const task = database.getBoardTask(taskId);
  if (!task || task.projectId !== projectId) throw new Error("Board task was not found in this workflow project");
  return task;
}

async function executeBoardNode({ config, context, database, workflow, run }) {
  if (!database) throw new Error("The Loom board is unavailable");
  if (config.operation === "list") return { tasks: database.listBoardTasks(workflow.projectId) };
  const taskId = renderString(config.taskId, context).trim();
  if (config.operation === "create") {
    const title = renderString(config.title, context).trim();
    if (!title) throw new Error("Board task title cannot be empty");
    const task = database.createBoardTask({
      id: randomUUID(),
      projectId: workflow.projectId,
      title,
      description: renderString(config.description, context),
      column: config.column,
      threadId: config.attachSourceThread ? run.sourceThreadId : null,
      createdByThreadId: run.sourceThreadId
    });
    return { task };
  }
  if (!taskId) throw new Error("Board task ID is required for this operation");
  const task = boardTask(database, workflow.projectId, taskId);
  if (config.operation === "delete") return { deleted: database.deleteBoardTask(task.id) };
  if (config.operation === "move") {
    const beforeTaskId = renderString(config.beforeTaskId, context).trim() || null;
    if (beforeTaskId) boardTask(database, workflow.projectId, beforeTaskId);
    return { task: database.moveBoardTask(task.id, config.column, beforeTaskId) };
  }
  const title = renderString(config.title, context).trim();
  return {
    task: database.updateBoardTask(task.id, {
      ...(title ? { title } : {}),
      description: renderString(config.description, context)
    })
  };
}

export async function executeBuiltInWorkflowNode({
  node,
  inputs,
  run,
  workflow,
  nodeOutputs,
  projectRoot,
  database,
  assertActive,
  fetchImpl
}) {
  const config = normalizeWorkflowNodeConfig(node);
  const context = expressionContext({ inputs, run, nodeOutputs });
  const input = workflowInputValue(inputs);

  if (node.type === "httpRequest") return workflowNodeResult(await executeHttpRequest({ config, context, fetchImpl }));
  if (node.type === "transform") {
    const transformed = config.mode === "json"
      ? workflowParseJsonTemplate(config.template, context, "Transform template")
      : renderString(config.template, context);
    const output = config.mergeInput && input && typeof input === "object" && !Array.isArray(input)
      && transformed && typeof transformed === "object" && !Array.isArray(transformed)
      ? { ...input, ...transformed }
      : transformed;
    return workflowNodeResult(output);
  }
  if (node.type === "condition") {
    const left = workflowRenderTemplate(config.left, context);
    const right = workflowRenderTemplate(config.right, context);
    const matched = workflowEvaluateCondition(left, config.operator, right);
    return workflowNodeResult({ matched, value: input }, { [matched ? "true" : "false"]: input });
  }
  if (node.type === "switch") {
    const value = workflowRenderTemplate(config.value, context);
    const rule = config.rules.find((candidate) => workflowEvaluateCondition(
      value,
      candidate.operator,
      workflowRenderTemplate(candidate.compare, context)
    ));
    const port = rule?.id ?? "default";
    return workflowNodeResult({ matchedPort: port, value: input }, { [port]: input });
  }
  if (node.type === "merge") return workflowNodeResult(mergeValues(inputs, config.mode));
  if (node.type === "delay") {
    await sleepWithCancellation(delayMilliseconds(config), assertActive);
    return workflowNodeResult(input);
  }
  if (node.type === "file") return workflowNodeResult(await executeFileNode({ config, context, projectRoot }));
  if (node.type === "git") return workflowNodeResult(await executeGitNode({ config, context, projectRoot }));
  if (node.type === "board") return workflowNodeResult(await executeBoardNode({ config, context, database, workflow, run }));
  return null;
}

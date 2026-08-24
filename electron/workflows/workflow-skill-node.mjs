import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { normalizeWorkflowNodeConfig } from "./workflow-node-catalog.mjs";

const DEFAULT_MAX_BYTES = 500_000;
const MAX_COMBINED_SKILL_BYTES = 2_000_000;

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function skillPathCandidate(skill) {
  return textValue(skill?.path)
    || textValue(skill?.filePath)
    || textValue(skill?.skillPath)
    || textValue(skill?.location?.path)
    || textValue(skill?.metadata?.path);
}

function skillName(skill, fallback = "Installed skill") {
  return textValue(skill?.name)
    || textValue(skill?.displayName)
    || textValue(skill?.id)
    || fallback;
}

function skillReference(skill) {
  return skillPathCandidate(skill)
    || textValue(skill?.id)
    || textValue(skill?.name)
    || textValue(skill?.displayName);
}

export function flattenInstalledWorkflowSkills(response) {
  const data = Array.isArray(response) ? response : response?.data ?? [];
  const result = [];
  for (const entry of data) {
    const skills = Array.isArray(entry?.skills) ? entry.skills : [entry];
    for (const skill of skills) {
      if (!skill || typeof skill !== "object") continue;
      const reference = skillReference(skill);
      if (!reference) continue;
      result.push({
        ...skill,
        reference,
        name: skillName(skill, path.basename(skillPathCandidate(skill) || reference)),
        description: textValue(skill.description) || textValue(skill.shortDescription),
        cwd: textValue(entry?.cwd) || textValue(entry?.path) || null
      });
    }
  }
  return result;
}

function projectRelativeTarget(projectRoot, configuredPath) {
  if (!projectRoot) throw new Error("The workflow project is no longer available");
  const value = textValue(configuredPath);
  if (!value) throw new Error("Choose a project Markdown file for this Use Skill node");
  if (value.includes("\0")) throw new Error("Skill file path contains an invalid null byte");
  const root = path.resolve(projectRoot);
  const candidate = path.resolve(root, value);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Use Skill Markdown files must remain inside the current Pixice project");
  }
  return { root, candidate, relative: relative || path.basename(candidate) };
}

async function ensureRealPathInside(root, candidate) {
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Use Skill Markdown file escapes the current Pixice project through a symbolic link");
  }
  return realCandidate;
}

async function markdownFile(pathname, maximumBytes, label) {
  const info = await stat(pathname);
  if (info.isDirectory()) return markdownFile(path.join(pathname, "SKILL.md"), maximumBytes, label);
  if (!info.isFile()) throw new Error(`${label} is not a file`);
  if (path.extname(pathname).toLowerCase() !== ".md") throw new Error(`${label} must be a .md file`);
  if (info.size > maximumBytes) throw new Error(`${label} exceeded ${maximumBytes} bytes`);
  return {
    path: pathname,
    content: await readFile(pathname, "utf8"),
    bytes: info.size
  };
}

async function resolveInstalledSkill({ config, runtime, projectRoot }) {
  if (!runtime?.request) throw new Error("Installed Skills are unavailable in this runtime");
  if (!config.skillRef && !config.skillName) throw new Error("Choose an installed Skill for this Use Skill node");
  const response = await runtime.request("skills/list", { cwds: projectRoot ? [projectRoot] : [] });
  const skills = flattenInstalledWorkflowSkills(response);
  const selected = skills.find((skill) => (
    skill.reference === config.skillRef
    || textValue(skill.id) === config.skillRef
    || textValue(skill.path) === config.skillRef
    || textValue(skill.name) === config.skillName
    || textValue(skill.displayName) === config.skillName
  ));
  if (!selected) {
    throw new Error(`Installed Skill “${config.skillName || config.skillRef}” is no longer available`);
  }

  const inlineContent = textValue(selected.instructions)
    || textValue(selected.content)
    || textValue(selected.markdown);
  let resolved;
  if (inlineContent) {
    const bytes = Buffer.byteLength(inlineContent, "utf8");
    if (bytes > config.maxBytes) throw new Error(`Installed Skill ${selected.name} exceeded ${config.maxBytes} bytes`);
    resolved = { path: skillPathCandidate(selected) || null, content: inlineContent, bytes };
  } else {
    const installedPath = skillPathCandidate(selected);
    if (!installedPath) throw new Error(`Installed Skill ${selected.name} did not expose readable instructions`);
    const absolutePath = path.isAbsolute(installedPath)
      ? installedPath
      : path.resolve(selected.cwd || projectRoot || process.cwd(), installedPath);
    resolved = await markdownFile(absolutePath, config.maxBytes, `Installed Skill ${selected.name}`);
  }

  return {
    kind: "workflowSkillAttachment",
    source: "installed",
    reference: selected.reference,
    name: selected.name,
    description: selected.description || "",
    path: resolved.path,
    content: resolved.content,
    bytes: resolved.bytes
  };
}

async function resolveMarkdownSkill({ config, projectRoot }) {
  const target = projectRelativeTarget(projectRoot, config.path);
  const realTarget = await ensureRealPathInside(target.root, target.candidate);
  const resolved = await markdownFile(realTarget, config.maxBytes, "Attached Markdown skill");
  return {
    kind: "workflowSkillAttachment",
    source: "markdown",
    reference: target.relative,
    name: config.skillName || path.basename(realTarget, ".md"),
    description: "Project Markdown instructions",
    path: target.relative,
    content: resolved.content,
    bytes: resolved.bytes
  };
}

export async function resolveWorkflowSkillAttachment({ node, runtime, projectRoot }) {
  const config = normalizeWorkflowNodeConfig(node);
  if (node.type !== "useSkill") throw new Error("Only Use Skill nodes can resolve skill attachments");
  return config.source === "markdown"
    ? resolveMarkdownSkill({ config, projectRoot })
    : resolveInstalledSkill({ config, runtime, projectRoot });
}

export function workflowSkillPublicMetadata(attachment) {
  return {
    source: attachment.source,
    reference: attachment.reference,
    name: attachment.name,
    description: attachment.description,
    path: attachment.path,
    bytes: attachment.bytes
  };
}

export function workflowSkillDeveloperInstructions(attachments) {
  const unique = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const attachment of attachments ?? []) {
    if (attachment?.kind !== "workflowSkillAttachment") continue;
    const key = `${attachment.source}:${attachment.reference || attachment.path || attachment.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    totalBytes += attachment.bytes ?? Buffer.byteLength(String(attachment.content ?? ""), "utf8");
    if (totalBytes > MAX_COMBINED_SKILL_BYTES) {
      throw new Error(`Attached Skills exceeded the combined ${MAX_COMBINED_SKILL_BYTES} byte limit`);
    }
    unique.push(attachment);
  }
  if (!unique.length) return "";
  const sections = unique.map((attachment, index) => [
    `### Attached Skill ${index + 1}: ${attachment.name}`,
    `Source: ${attachment.source}${attachment.path ? ` · ${attachment.path}` : ""}`,
    attachment.description ? `Description: ${attachment.description}` : "",
    "",
    "--- BEGIN ATTACHED SKILL INSTRUCTIONS ---",
    String(attachment.content ?? "").trim(),
    "--- END ATTACHED SKILL INSTRUCTIONS ---"
  ].filter(Boolean).join("\n"));
  return [
    "## Workflow-attached Skills",
    "The following instruction documents were explicitly connected to this Pixice Agent node. Apply all compatible instructions while completing this workflow step. When instructions conflict, preserve Pixice runtime safety and follow the more specific attached instruction.",
    "",
    ...sections
  ].join("\n\n");
}

export const WORKFLOW_SKILL_DEFAULT_MAX_BYTES = DEFAULT_MAX_BYTES;

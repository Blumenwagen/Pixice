import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flattenInstalledWorkflowSkills,
  resolveWorkflowSkillAttachment,
  workflowSkillDeveloperInstructions,
  workflowSkillPublicMetadata
} from "../electron/workflows/workflow-skill-node.mjs";

const temporaryDirectories = [];
afterEach(() => temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function useSkill(config) {
  return {
    id: "skill-node",
    type: "useSkill",
    name: "Use Skill",
    description: "",
    position: { x: 0, y: 0 },
    config
  };
}

describe("workflow skill attachments", () => {
  it("flattens installed skill groups and resolves a directory SKILL.md", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-installed-skill-"));
    temporaryDirectories.push(directory);
    const skillDirectory = path.join(directory, "release-review");
    mkdirSync(skillDirectory);
    writeFileSync(path.join(skillDirectory, "SKILL.md"), "# Release review\nAlways verify the changelog.", "utf8");
    const runtime = {
      request: vi.fn(async () => ({
        data: [{ cwd: directory, skills: [{ id: "release-review", name: "Release Review", description: "Review releases", path: skillDirectory }] }]
      }))
    };

    expect(flattenInstalledWorkflowSkills(await runtime.request())).toEqual([
      expect.objectContaining({ reference: skillDirectory, name: "Release Review", cwd: directory })
    ]);

    const attachment = await resolveWorkflowSkillAttachment({
      node: useSkill({ source: "installed", skillRef: skillDirectory, skillName: "Release Review", maxBytes: 50_000 }),
      runtime,
      projectRoot: directory
    });

    expect(runtime.request).toHaveBeenLastCalledWith("skills/list", { cwds: [directory] });
    expect(attachment).toMatchObject({
      kind: "workflowSkillAttachment",
      source: "installed",
      name: "Release Review",
      path: path.join(skillDirectory, "SKILL.md")
    });
    expect(attachment.content).toContain("Always verify the changelog");
    expect(workflowSkillPublicMetadata(attachment)).not.toHaveProperty("content");
  });

  it("attaches only project-scoped .md files and rejects escapes", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-markdown-skill-"));
    const outside = mkdtempSync(path.join(tmpdir(), "loom-markdown-outside-"));
    temporaryDirectories.push(directory, outside);
    mkdirSync(path.join(directory, "instructions"));
    writeFileSync(path.join(directory, "instructions", "review.md"), "# Review\nCheck every failure.", "utf8");
    writeFileSync(path.join(directory, "instructions", "not-skill.txt"), "no", "utf8");
    writeFileSync(path.join(outside, "secret.md"), "outside", "utf8");

    const attachment = await resolveWorkflowSkillAttachment({
      node: useSkill({ source: "markdown", path: "instructions/review.md", skillName: "Strict review", maxBytes: 50_000 }),
      runtime: null,
      projectRoot: directory
    });
    expect(attachment).toMatchObject({ source: "markdown", name: "Strict review", path: path.join("instructions", "review.md") });

    await expect(resolveWorkflowSkillAttachment({
      node: useSkill({ source: "markdown", path: "instructions/not-skill.txt", maxBytes: 50_000 }),
      projectRoot: directory
    })).rejects.toThrow(/must be a \.md file/i);
    await expect(resolveWorkflowSkillAttachment({
      node: useSkill({ source: "markdown", path: "../secret.md", maxBytes: 50_000 }),
      projectRoot: directory
    })).rejects.toThrow(/inside the current Pixice project/i);

    if (process.platform !== "win32") {
      symlinkSync(path.join(outside, "secret.md"), path.join(directory, "instructions", "linked.md"));
      await expect(resolveWorkflowSkillAttachment({
        node: useSkill({ source: "markdown", path: "instructions/linked.md", maxBytes: 50_000 }),
        projectRoot: directory
      })).rejects.toThrow(/symbolic link/i);
    }
  });

  it("combines multiple attached skills into agent developer instructions", () => {
    const instructions = workflowSkillDeveloperInstructions([
      { kind: "workflowSkillAttachment", source: "installed", reference: "one", name: "One", path: "/skills/one/SKILL.md", description: "First", content: "Do the first thing.", bytes: 19 },
      { kind: "workflowSkillAttachment", source: "markdown", reference: "docs/two.md", name: "Two", path: "docs/two.md", description: "Second", content: "Do the second thing.", bytes: 20 },
      { kind: "workflowSkillAttachment", source: "installed", reference: "one", name: "Duplicate", content: "Ignored duplicate.", bytes: 18 }
    ]);

    expect(instructions).toContain("Attached Skill 1: One");
    expect(instructions).toContain("Attached Skill 2: Two");
    expect(instructions).toContain("Do the first thing.");
    expect(instructions).toContain("Do the second thing.");
    expect(instructions).not.toContain("Ignored duplicate");
  });
});

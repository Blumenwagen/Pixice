import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPreviewFile } from "../electron/runtime/preview-files.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "pixice-preview-files-"));
  temporaryDirectories.push(directory);
  const projectRoot = path.join(directory, "project");
  const externalRoot = path.join(directory, "skills");
  mkdirSync(projectRoot);
  mkdirSync(externalRoot);
  writeFileSync(path.join(projectRoot, "notes.md"), "# Project notes\n", "utf8");
  writeFileSync(path.join(externalRoot, "SKILL.md"), "# External skill\n", "utf8");
  return { directory, projectRoot, externalRoot };
}

describe("Preview files", () => {
  it("keeps project files editable", () => {
    const { projectRoot } = fixture();

    const file = readPreviewFile({ reference: "notes.md", primaryRoot: projectRoot, roots: [projectRoot] });

    expect(file).toMatchObject({ relativePath: "notes.md", external: false, editable: true, kind: "markdown" });
  });

  it("opens explicitly allowed external text files for editing", () => {
    const { projectRoot, externalRoot } = fixture();
    const filePath = path.join(externalRoot, "SKILL.md");

    const file = readPreviewFile({ reference: filePath, primaryRoot: projectRoot, roots: [projectRoot], allowExternal: true });

    const canonicalPath = realpathSync(filePath);
    expect(file).toMatchObject({ path: canonicalPath, relativePath: canonicalPath, external: true, editable: true, content: "# External skill\n" });
  });

  it("rejects external files on the project-only path, including symlinks", () => {
    const { projectRoot, externalRoot } = fixture();
    const filePath = path.join(externalRoot, "SKILL.md");
    symlinkSync(filePath, path.join(projectRoot, "linked-skill.md"));

    expect(() => readPreviewFile({ reference: filePath, primaryRoot: projectRoot, roots: [projectRoot] })).toThrow(/outside the selected project/i);
    expect(() => readPreviewFile({ reference: "linked-skill.md", primaryRoot: projectRoot, roots: [projectRoot] })).toThrow(/outside the selected project/i);
  });
});

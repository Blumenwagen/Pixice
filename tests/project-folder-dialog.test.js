import { describe, expect, it } from "vitest";
import { projectFolderDialogProperties } from "../electron/projects/project-folder-dialog.mjs";

describe("project folder dialog", () => {
  it("allows folders to be created while selecting multiple project roots", () => {
    expect(projectFolderDialogProperties()).toEqual([
      "openDirectory",
      "multiSelections",
      "createDirectory"
    ]);
  });

  it("keeps folder creation available for single-directory selection", () => {
    expect(projectFolderDialogProperties({ multiple: false })).toEqual([
      "openDirectory",
      "createDirectory"
    ]);
  });
});

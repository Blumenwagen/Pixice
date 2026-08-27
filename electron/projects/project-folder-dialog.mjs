export function projectFolderDialogProperties({ multiple = true } = {}) {
  return [
    "openDirectory",
    ...(multiple ? ["multiSelections"] : []),
    "createDirectory"
  ];
}

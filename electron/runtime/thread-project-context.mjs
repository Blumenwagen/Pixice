export function resolveThreadProject({ database, projectId, cwd, projectForPath }) {
  const mappedProject = typeof projectId === "string" && projectId.trim()
    ? database.getProject(projectId)
    : null;
  return mappedProject ?? projectForPath(cwd);
}

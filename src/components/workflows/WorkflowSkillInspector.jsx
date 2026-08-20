import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowClockwise, Files, SpinnerGap, Trash, X } from "../icons/index.jsx";
import workspaceStyles from "./WorkflowWorkspace.module.css";
import nodeStyles from "./WorkflowNodes.module.css";

const styles = { ...workspaceStyles, ...nodeStyles };

function IconButton({ label, children, ...props }) {
  return <button type="button" className={styles.iconButton} aria-label={label} title={label} {...props}>{children}</button>;
}

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function skillReference(skill) {
  return textValue(skill?.path)
    || textValue(skill?.filePath)
    || textValue(skill?.skillPath)
    || textValue(skill?.location?.path)
    || textValue(skill?.metadata?.path)
    || textValue(skill?.id)
    || textValue(skill?.name)
    || textValue(skill?.displayName);
}

function skillName(skill, fallback = "Installed Skill") {
  return textValue(skill?.name)
    || textValue(skill?.displayName)
    || textValue(skill?.id)
    || fallback;
}

function flattenSkills(result) {
  const groups = Array.isArray(result?.skills) ? result.skills : [];
  const skills = [];
  for (const group of groups) {
    const entries = Array.isArray(group?.skills) ? group.skills : [group];
    for (const skill of entries) {
      if (!skill || typeof skill !== "object") continue;
      const reference = skillReference(skill);
      if (!reference) continue;
      skills.push({
        ...skill,
        reference,
        name: skillName(skill),
        description: textValue(skill.description) || textValue(skill.shortDescription),
        scope: textValue(group?.cwd) || textValue(group?.path)
      });
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

export function WorkflowSkillInspector({ node, api, projectId, onUpdate, onDelete, onClose }) {
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const config = node.config ?? {};
  const source = config.source === "markdown" ? "markdown" : "installed";
  const updateConfig = (patch) => onUpdate({ config: { ...config, ...patch } });

  const loadSkills = useCallback(async () => {
    if (!api?.extensions?.list || !projectId) {
      setSkills([]);
      setError("Installed Skills require the Loom desktop capability bridge.");
      return;
    }
    setLoading(true);
    try {
      const result = await api.extensions.list({ projectId });
      setSkills(flattenSkills(result));
      const errors = Array.isArray(result?.errors) ? result.errors.filter(Boolean) : [];
      setError(errors.length ? errors.join(" · ") : "");
    } catch (loadError) {
      setSkills([]);
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, [api, projectId]);

  useEffect(() => {
    if (source === "installed") void loadSkills();
  }, [loadSkills, source]);

  const selectedSkill = useMemo(() => skills.find((skill) => skill.reference === config.skillRef) ?? null, [config.skillRef, skills]);
  const selectedMissing = Boolean(config.skillRef && !selectedSkill);

  return (
    <aside className={styles.inspector} aria-label="Workflow node inspector">
      <header className={styles.inspectorHeader}>
        <span className={`${styles.inspectorGlyph} ${styles.inspectorTone}`} data-tone="orange"><Files size={17} /></span>
        <span><small>Use Skill</small><strong>{node.name}</strong></span>
        <IconButton label="Close node inspector" onClick={onClose}><X size={14} /></IconButton>
      </header>
      <div className={styles.inspectorBody}>
        <label className={styles.field}>
          <span>Name</span>
          <input value={node.name} maxLength={160} onChange={(event) => onUpdate({ name: event.target.value })} />
        </label>
        <label className={styles.field}>
          <span>Description</span>
          <textarea value={node.description ?? ""} maxLength={2000} rows={3} onChange={(event) => onUpdate({ description: event.target.value })} />
        </label>
        <label className={styles.field}>
          <span>Instruction source</span>
          <select
            value={source}
            onChange={(event) => updateConfig({
              source: event.target.value,
              skillRef: "",
              skillName: "",
              path: ""
            })}
          >
            <option value="installed">Installed Skill</option>
            <option value="markdown">Project Markdown file</option>
          </select>
        </label>

        {source === "installed" ? (
          <div className={styles.field}>
            <span>Installed Skill</span>
            <div className={styles.inlineFields}>
              <select
                aria-label="Installed Skill"
                value={config.skillRef ?? ""}
                onChange={(event) => {
                  const selected = skills.find((skill) => skill.reference === event.target.value);
                  updateConfig({
                    skillRef: event.target.value,
                    skillName: selected?.name ?? ""
                  });
                }}
                disabled={loading}
              >
                <option value="">Choose a Skill…</option>
                {selectedMissing && <option value={config.skillRef}>{config.skillName || "Unavailable Skill"} · unavailable</option>}
                {skills.map((skill) => (
                  <option value={skill.reference} key={`${skill.reference}:${skill.name}`}>
                    {skill.name}{skill.scope ? ` · ${skill.scope}` : ""}
                  </option>
                ))}
              </select>
              <button type="button" className={styles.secondaryButton} onClick={() => void loadSkills()} disabled={loading}>
                {loading ? <SpinnerGap className={styles.spin} size={13} /> : <ArrowClockwise size={13} />}
                Refresh
              </button>
            </div>
            {selectedSkill?.description && <small>{selectedSkill.description}</small>}
            {!loading && !skills.length && !error && <small>No installed Skills were reported for this project.</small>}
          </div>
        ) : (
          <>
            <label className={styles.field}>
              <span>Project-relative .md file</span>
              <input
                aria-label="Skill Markdown path"
                value={config.path ?? ""}
                onChange={(event) => updateConfig({ path: event.target.value })}
                placeholder="docs/review-guidelines.md"
              />
              <small>The file is read when the connected Agent runs. Paths outside the project and non-Markdown files are rejected.</small>
            </label>
            <label className={styles.field}>
              <span>Skill label · optional</span>
              <input value={config.skillName ?? ""} onChange={(event) => updateConfig({ skillName: event.target.value })} placeholder="Release review rules" />
            </label>
          </>
        )}

        <label className={styles.field}>
          <span>Maximum instruction bytes</span>
          <input
            type="number"
            min="1024"
            max="2000000"
            value={config.maxBytes ?? 500000}
            onChange={(event) => updateConfig({ maxBytes: Number(event.target.value) })}
          />
        </label>

        <small className={styles.safetyNote}>
          Connect this node’s Skill output directly to a Loom Agent’s Skill input. Attach as many Use Skill nodes to the same Agent as needed; they add instructions without becoming workflow data or activating an otherwise inactive branch.
        </small>
        {error && <small className={styles.safetyNote}>{error}</small>}
      </div>
      <footer className={styles.inspectorFooter}>
        <button type="button" className={styles.dangerButton} onClick={onDelete}><Trash size={14} />Delete node</button>
      </footer>
    </aside>
  );
}

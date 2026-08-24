import { useEffect, useId, useRef, useState } from "react";
import {
  Brain,
  CaretDown,
  Check,
  ChartLineUp,
  Code,
  Desktop,
  File,
  Files,
  Folder,
  FolderOpen,
  Gauge,
  GitBranch,
  Globe,
  ImageSquare,
  LockKey,
  PlugsConnected,
  Plus,
  ShieldCheck,
  Sparkle,
  Stack,
  TerminalWindow,
  TreeStructure,
  X
} from "../icons/index.jsx";
import styles from "./ProjectSwitcher.module.css";

export const PROJECT_ICON_OPTIONS = Object.freeze([
  { id: "folder", label: "Folder", icon: Folder },
  { id: "code", label: "Code", icon: Code },
  { id: "terminal", label: "Terminal", icon: TerminalWindow },
  { id: "globe", label: "Web", icon: Globe },
  { id: "sparkles", label: "Sparkles", icon: Sparkle },
  { id: "stack", label: "Stack", icon: Stack },
  { id: "brain", label: "Brain", icon: Brain },
  { id: "chart", label: "Chart", icon: ChartLineUp },
  { id: "desktop", label: "Desktop", icon: Desktop },
  { id: "file", label: "File", icon: File },
  { id: "files", label: "Files", icon: Files },
  { id: "git-branch", label: "Git branch", icon: GitBranch },
  { id: "image", label: "Image", icon: ImageSquare },
  { id: "lock", label: "Lock", icon: LockKey },
  { id: "shield", label: "Shield", icon: ShieldCheck },
  { id: "workflow", label: "Workflow", icon: TreeStructure },
  { id: "gauge", label: "Gauge", icon: Gauge },
  { id: "connect", label: "Connect", icon: PlugsConnected }
]);

export const PROJECT_COLOR_OPTIONS = Object.freeze([
  { id: "gray", label: "Gray", value: "#b7bcc8", surface: "#33363c" },
  { id: "blue", label: "Blue", value: "#9bbcf5", surface: "#26364c" },
  { id: "indigo", label: "Indigo", value: "#a6aaf3", surface: "#2e3150" },
  { id: "purple", label: "Purple", value: "#c3a7ee", surface: "#3a2d48" },
  { id: "pink", label: "Pink", value: "#efadd1", surface: "#462e3d" },
  { id: "rose", label: "Rose", value: "#f2aab4", surface: "#472f35" },
  { id: "red", label: "Red", value: "#f2a29c", surface: "#482f2e" },
  { id: "orange", label: "Orange", value: "#efb083", surface: "#47352b" },
  { id: "amber", label: "Amber", value: "#e4be78", surface: "#443a27" },
  { id: "yellow", label: "Yellow", value: "#d9cc7a", surface: "#403d28" },
  { id: "green", label: "Green", value: "#98cda7", surface: "#293d31" },
  { id: "teal", label: "Teal", value: "#8bcac3", surface: "#293d3b" }
]);

const DEFAULT_ICON = PROJECT_ICON_OPTIONS[0].id;
const DEFAULT_COLOR = "blue";

function iconOption(icon) {
  return PROJECT_ICON_OPTIONS.find((option) => option.id === icon) ?? PROJECT_ICON_OPTIONS[0];
}

function colorOption(color) {
  return PROJECT_COLOR_OPTIONS.find((option) => option.id === color || option.value === color)
    ?? PROJECT_COLOR_OPTIONS.find((option) => option.id === DEFAULT_COLOR);
}

function folderPath(folder) {
  if (typeof folder === "string") return folder.trim();
  return String(folder?.canonicalPath ?? folder?.path ?? "").trim();
}

function folderName(folder) {
  if (typeof folder === "object" && folder?.displayName) return folder.displayName;
  const path = folderPath(folder).replace(/[\\/]+$/, "");
  return path.split(/[\\/]/).pop() || path;
}

function normalizeFolders(value) {
  const source = Array.isArray(value)
    ? value
    : Array.isArray(value?.folders)
      ? value.folders
      : value == null
        ? []
        : [value];
  const seen = new Set();
  return source.filter((folder) => {
    const path = folderPath(folder);
    if (!path || seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

function mergeFolders(current, incoming) {
  const byPath = new Map(normalizeFolders(current).map((folder) => [folderPath(folder), folder]));
  normalizeFolders(incoming).forEach((folder) => byPath.set(folderPath(folder), folder));
  return [...byPath.values()];
}

function projectStyle(project) {
  const option = colorOption(project?.color);
  return { "--project-color": option.value, "--project-surface": option.surface };
}

function projectActivityDetails(activity) {
  const running = activity?.runningThreadIds?.length ?? activity?.runningCount ?? 0;
  const unseen = activity?.unseenThreadIds?.length ?? activity?.unseenCount ?? 0;
  const parts = [];
  if (running) parts.push(`${running} running`);
  if (unseen) parts.push(`${unseen} finished, unseen`);
  return { running, unseen, description: parts.join(" · ") };
}

function ProjectActivityMarks({ activity, inline = false }) {
  const { running, unseen } = projectActivityDetails(activity);
  if (!running && !unseen) return null;
  return (
    <span className={`${styles.activityMarks} ${inline ? styles.inlineActivityMarks : ""}`.trim()} aria-hidden="true">
      {running > 0 && <span className={`${styles.activityMark} ${styles.runningMark}`}><i />{running}</span>}
      {unseen > 0 && <span className={`${styles.activityMark} ${styles.unseenMark}`}><Check size={8} />{unseen}</span>}
    </span>
  );
}

export function ProjectGlyph({ icon, size = 22, className = "" }) {
  const Icon = iconOption(icon).icon;
  return <Icon className={className} size={size} />;
}

export function ProjectSwitcher({
  projects = [],
  activityByProject = {},
  selectedProjectId = null,
  onSelectProject,
  onCreateProject,
  expanded = true,
  recentProjectLimit = 6,
  className = ""
}) {
  const overflowId = useId();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const visibleProjectLimit = expanded ? Math.max(1, recentProjectLimit) : Math.min(6, Math.max(1, recentProjectLimit));
  const recentProjects = projects.slice(0, visibleProjectLimit);
  const overflowProjects = projects.slice(visibleProjectLimit);

  useEffect(() => {
    if (!expanded) setOverflowOpen(false);
  }, [expanded]);

  const selectProject = (projectId) => onSelectProject?.(projectId);

  return (
    <section className={`${styles.switcher} ${className}`.trim()} aria-label="Projects">
      <div className={styles.grid} role="list" aria-label="Recent projects">
        {recentProjects.map((project) => {
          const selected = project.id === selectedProjectId;
          const label = project.displayName || "Untitled project";
          const activity = activityByProject[project.id];
          const activityDescription = projectActivityDetails(activity).description;
          return (
            <div className={styles.tileSlot} role="listitem" key={project.id}>
              <button
                type="button"
                className={`${styles.tile} ${selected ? styles.activeTile : ""}`.trim()}
                style={projectStyle(project)}
                aria-label={label}
                aria-current={selected ? "true" : undefined}
                aria-pressed={selected}
                title={activityDescription ? `${label} · ${activityDescription}` : label}
                onClick={() => selectProject(project.id)}
              >
                <span className={styles.projectIcon} aria-hidden="true">
                  <ProjectGlyph icon={project.icon} size={20} />
                </span>
                <ProjectActivityMarks activity={activity} />
                <span className={styles.tooltip} role="tooltip">{label}{activityDescription ? ` · ${activityDescription}` : ""}</span>
              </button>
            </div>
          );
        })}
      </div>
      <div className={styles.projectActions}>
        {expanded && overflowProjects.length > 0 && (
          <button
            type="button"
            className={styles.overflowToggle}
            aria-expanded={overflowOpen}
            aria-controls={overflowId}
            aria-label={overflowOpen ? "Hide older projects" : "Show all projects"}
            onClick={() => setOverflowOpen((current) => !current)}
          >
            <span>{overflowOpen ? "Hide projects" : `${overflowProjects.length} more project${overflowProjects.length === 1 ? "" : "s"}`}</span>
            <CaretDown className={styles.overflowCaret} size={14} />
          </button>
        )}
        <button type="button" className={styles.createControl} aria-label="New project" title="New project" onClick={onCreateProject}>
          <Plus size={15} />
        </button>
      </div>
      {expanded && overflowProjects.length > 0 && overflowOpen && (
        <section className={styles.overflowList} id={overflowId} role="region" aria-label="Older projects">
          <div role="list">
            {overflowProjects.map((project) => {
              const selected = project.id === selectedProjectId;
              const label = project.displayName || "Untitled project";
              const activity = activityByProject[project.id];
              const activityDescription = projectActivityDetails(activity).description;
              return (
                <div role="listitem" key={project.id}>
                  <button
                    type="button"
                    className={`${styles.overflowProject} ${selected ? styles.activeOverflowProject : ""}`.trim()}
                    style={projectStyle(project)}
                    aria-current={selected ? "true" : undefined}
                    title={activityDescription ? `${label} · ${activityDescription}` : label}
                    onClick={() => selectProject(project.id)}
                  >
                    <span className={styles.overflowGlyph} aria-hidden="true"><ProjectGlyph icon={project.icon} size={15} /></span>
                    <span className={styles.overflowLabel}>{label}</span>
                    <ProjectActivityMarks activity={activity} inline />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </section>
  );
}

export function ProjectCreationDialog({
  open,
  onClose,
  onCreate,
  onAddFolders,
  busy = false,
  initialValue = null
}) {
  const titleId = useId();
  const descriptionId = useId();
  const nameRef = useRef(null);
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  const [displayName, setDisplayName] = useState("");
  const [icon, setIcon] = useState(DEFAULT_ICON);
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [folders, setFolders] = useState([]);
  const [addingFolders, setAddingFolders] = useState(false);
  const [error, setError] = useState("");

  closeRef.current = onClose;
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return undefined;
    const previousFocus = document.activeElement;
    setDisplayName(initialValue?.displayName ?? "");
    setIcon(iconOption(initialValue?.icon).id);
    setColor(colorOption(initialValue?.color).id);
    setFolders(normalizeFolders(initialValue?.folders ?? initialValue?.canonicalPath));
    setAddingFolders(false);
    setError("");

    const canAnimateFrame = typeof window.requestAnimationFrame === "function";
    const focusFrame = canAnimateFrame
      ? window.requestAnimationFrame(() => nameRef.current?.focus())
      : window.setTimeout(() => nameRef.current?.focus(), 0);
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busyRef.current) closeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      if (canAnimateFrame) window.cancelAnimationFrame(focusFrame);
      else window.clearTimeout(focusFrame);
      window.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus?.();
    };
  }, [initialValue, open]);

  if (!open) return null;

  const addFolders = async () => {
    if (!onAddFolders || addingFolders || busy) return;
    setAddingFolders(true);
    setError("");
    try {
      const selected = await onAddFolders();
      setFolders((current) => mergeFolders(current, selected));
    } catch (cause) {
      setError(cause?.message ?? "Pixice could not add those folders.");
    } finally {
      setAddingFolders(false);
    }
  };

  const removeFolder = (target) => {
    const targetPath = folderPath(target);
    setFolders((current) => current.filter((folder) => folderPath(folder) !== targetPath));
  };

  const submit = async (event) => {
    event.preventDefault();
    const name = displayName.trim();
    if (!name || folders.length === 0 || busy) return;
    setError("");
    try {
      await onCreate?.({
        displayName: name,
        icon,
        color,
        folders: folders.map(folderPath)
      });
    } catch (cause) {
      setError(cause?.message ?? "Pixice could not create this project.");
    }
  };

  return (
    <div
      className={styles.dialogBackdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose?.();
      }}
    >
      <form
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy || addingFolders}
        onSubmit={submit}
      >
        <header className={styles.dialogHeader}>
          <span className={styles.dialogMark} aria-hidden="true"><FolderOpen size={20} /></span>
          <span className={styles.dialogHeading}>
            <strong id={titleId}>Create project</strong>
            <small id={descriptionId}>Group related folders, threads, and Pixice tools.</small>
          </span>
          <button type="button" className={styles.closeButton} aria-label="Close project dialog" disabled={busy} onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <label className={styles.fieldLabel}>
          <span>Project name</span>
          <input
            ref={nameRef}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Project name"
            autoComplete="off"
            maxLength={80}
          />
        </label>

        <fieldset className={styles.choiceFieldset}>
          <legend>Icon</legend>
          <div className={styles.iconChoices} role="radiogroup" aria-label="Project icon">
            {PROJECT_ICON_OPTIONS.map((option) => {
              const Icon = option.icon;
              return (
                <button
                  type="button"
                  className={`${styles.iconChoice} ${icon === option.id ? styles.selectedChoice : ""}`.trim()}
                  role="radio"
                  aria-checked={icon === option.id}
                  aria-label={`${option.label} icon`}
                  title={option.label}
                  onClick={() => setIcon(option.id)}
                  key={option.id}
                >
                  <Icon size={19} />
                </button>
              );
            })}
          </div>
        </fieldset>

        <fieldset className={styles.choiceFieldset}>
          <legend>Color</legend>
          <div className={styles.colorChoices} role="radiogroup" aria-label="Project color">
            {PROJECT_COLOR_OPTIONS.map((option) => (
              <button
                type="button"
                className={`${styles.colorChoice} ${color === option.id ? styles.selectedColor : ""}`.trim()}
                style={{ "--swatch-color": option.value }}
                role="radio"
                aria-checked={color === option.id}
                aria-label={`${option.label} color`}
                title={option.label}
                onClick={() => setColor(option.id)}
                key={option.id}
              >
                {color === option.id && <Check size={13} />}
              </button>
            ))}
          </div>
        </fieldset>

        <section className={styles.folderSection} aria-labelledby={`${titleId}-folders`}>
          <div className={styles.folderHeading}>
            <span>
              <strong id={`${titleId}-folders`}>Folders</strong>
              <small>{folders.length ? `${folders.length} added` : "Add at least one folder"}</small>
            </span>
            <button type="button" className={styles.addFolderButton} disabled={busy || addingFolders || !onAddFolders} onClick={addFolders}>
              <Plus size={14} />{addingFolders ? "Adding..." : "Add folders"}
            </button>
          </div>
          <div className={styles.folderList} aria-live="polite">
            {folders.length === 0 ? (
              <button type="button" className={styles.emptyFolders} disabled={busy || addingFolders || !onAddFolders} onClick={addFolders}>
                <FolderOpen size={19} />
                <span><strong>Choose project folders</strong><small>You can select more than one.</small></span>
              </button>
            ) : folders.map((folder) => {
              const path = folderPath(folder);
              return (
                <div className={styles.folderRow} key={path}>
                  <span className={styles.folderGlyph} aria-hidden="true"><Folder size={16} /></span>
                  <span className={styles.folderCopy}><strong>{folderName(folder)}</strong><small title={path}>{path}</small></span>
                  <button type="button" className={styles.removeFolderButton} aria-label={`Remove ${folderName(folder)}`} disabled={busy} onClick={() => removeFolder(folder)}>
                    <X size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        {error && <p className={styles.dialogError} role="alert">{error}</p>}

        <footer className={styles.dialogFooter}>
          <button type="button" className={styles.cancelButton} disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className={styles.createButton} disabled={busy || addingFolders || !displayName.trim() || folders.length === 0}>
            {busy ? "Creating..." : "Create project"}
          </button>
        </footer>
      </form>
    </div>
  );
}

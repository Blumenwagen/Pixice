import { readFileSync } from "node:fs";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectCreationDialog, ProjectSwitcher } from "../src/components/sidebar/ProjectSwitcher.jsx";

const projectSwitcherCss = readFileSync("src/components/sidebar/ProjectSwitcher.module.css", "utf8");
const appCss = readFileSync("src/styles.css", "utf8");

const projects = Array.from({ length: 10 }, (_, index) => ({
  id: `project-${index + 1}`,
  displayName: `Project ${index + 1}`,
  canonicalPath: `/work/project-${index + 1}`,
  icon: "folder",
  color: "blue",
  folders: [`/work/project-${index + 1}`],
  updatedAt: new Date(Date.UTC(2026, 7, 22, 12, 0, 10 - index)).toISOString()
}));

describe("ProjectSwitcher", () => {
  it("keeps six recent project tiles and exposes older projects only while expanded", () => {
    const { rerender } = render(
      <ProjectSwitcher
        projects={projects}
        selectedProjectId="project-1"
        expanded
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
      />
    );

    const projectSection = screen.getByRole("region", { name: "Projects" });
    const recent = within(projectSection).getByRole("list", { name: "Recent projects" });
    expect(within(recent).getAllByRole("button")).toHaveLength(6);
    projects.slice(0, 6).forEach((project) => {
      expect(within(recent).getByRole("button", { name: project.displayName })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Project 7" })).not.toBeInTheDocument();
    expect(recent).not.toContainElement(screen.getByRole("button", { name: "New project" }));

    const showAll = screen.getByRole("button", { name: "Show all projects" });
    const create = screen.getByRole("button", { name: "New project" });
    expect(showAll.parentElement).toBe(create.parentElement);
    fireEvent.click(showAll);
    const older = within(screen.getByRole("region", { name: "Older projects" })).getByRole("list");
    expect(within(older).getByRole("button", { name: "Project 7" })).toBeInTheDocument();
    expect(within(older).getByRole("button", { name: "Project 8" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide older projects" })).toBeInTheDocument();

    rerender(
      <ProjectSwitcher
        projects={projects}
        selectedProjectId="project-1"
        expanded={false}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: "Show all projects" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hide older projects" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Older projects" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project 1" })).toHaveAttribute("aria-current", "true");
  });

  it("shows nine recent project tiles when the third row limit is enabled", () => {
    render(
      <ProjectSwitcher
        projects={projects}
        selectedProjectId="project-1"
        expanded
        recentProjectLimit={9}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
      />
    );

    const recent = screen.getByRole("list", { name: "Recent projects" });
    expect(within(recent).getAllByRole("button")).toHaveLength(9);
    expect(within(recent).getByRole("button", { name: "Project 9" })).toBeInTheDocument();
    expect(within(recent).queryByRole("button", { name: "Project 10" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show all projects" }));
    expect(within(screen.getByRole("region", { name: "Older projects" })).getByRole("button", { name: "Project 10" })).toBeInTheDocument();
    expect(projectSwitcherCss).toMatch(/\.grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,/s);
  });

  it("keeps the collapsed rail at six projects when the third row is enabled", () => {
    render(
      <ProjectSwitcher
        projects={projects}
        selectedProjectId="project-1"
        expanded={false}
        recentProjectLimit={9}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
      />
    );

    expect(within(screen.getByRole("list", { name: "Recent projects" })).getAllByRole("button")).toHaveLength(6);
  });

  it("marks projects with running and unseen finished threads", () => {
    render(
      <ProjectSwitcher
        projects={projects.slice(0, 2)}
        selectedProjectId="project-1"
        expanded
        activityByProject={{
          "project-1": { runningThreadIds: ["thread-a", "thread-b"], unseenThreadIds: [] },
          "project-2": { runningThreadIds: [], unseenThreadIds: ["thread-c"] }
        }}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Project 1" })).toHaveAttribute("title", "Project 1 · 2 running");
    expect(screen.getByRole("button", { name: "Project 2" })).toHaveAttribute("title", "Project 2 · 1 finished, unseen");
    expect(projectSwitcherCss).toMatch(/\.runningMark i\s*\{[^}]*animation:\s*project-running-pulse/s);
    expect(projectSwitcherCss).toMatch(/data-reduce-motion="true"[^}]*animation:\s*none/s);
  });

  it("offers a richer icon and pastel color palette in the creation dialog", () => {
    render(
      <ProjectCreationDialog
        open
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onAddFolders={vi.fn().mockResolvedValue([])}
      />
    );

    const iconChoices = within(screen.getByRole("radiogroup", { name: "Project icon" })).getAllByRole("radio");
    const colorChoices = within(screen.getByRole("radiogroup", { name: "Project color" })).getAllByRole("radio");
    const swatches = colorChoices.map((choice) => choice.style.getPropertyValue("--swatch-color"));

    expect(iconChoices.length).toBeGreaterThanOrEqual(8);
    expect(colorChoices.length).toBeGreaterThanOrEqual(8);
    expect(new Set(swatches).size).toBe(colorChoices.length);
    expect(swatches.every(Boolean)).toBe(true);
    expect(projectSwitcherCss).toMatch(/\.iconChoice\s*\{[^}]*border-radius:\s*50%/s);
    expect(projectSwitcherCss).toMatch(/\.colorChoice\s*\{[^}]*border-radius:\s*50%/s);
  });

  it("uses compact tiles and separate pastel foreground and surface tokens", () => {
    render(<ProjectSwitcher projects={[projects[0]]} selectedProjectId="project-1" expanded />);

    const tile = screen.getByRole("button", { name: "Project 1" });
    const tileRule = projectSwitcherCss.match(/\.tile\s*\{([^}]*)\}/)?.[1] ?? "";
    const tileHeight = Number.parseInt(tileRule.match(/height:\s*(\d+)px/)?.[1] ?? "", 10);

    expect(tileHeight).toBeLessThan(60);
    expect(tile.style.getPropertyValue("--project-color")).toBe("#9bbcf5");
    expect(tile.style.getPropertyValue("--project-surface")).toBe("#26364c");
    expect(projectSwitcherCss).toMatch(/\.createControl,\s*\.overflowToggle\s*\{[^}]*background:\s*transparent/s);
    expect(projectSwitcherCss).toMatch(/\.activeOverflowProject\s*\{[^}]*background:\s*transparent/s);
    expect(appCss.match(/\.project-rail-header\s*\{([^}]*)\}/)?.[1]).not.toContain("border-top");
  });

  it("keeps project name tooltips above sibling tiles and outside the sidebar edge", () => {
    expect(projectSwitcherCss).toMatch(/\.tileSlot:hover,\s*\.tileSlot:focus-within\s*\{\s*z-index:\s*60;/s);
    expect(projectSwitcherCss).toMatch(/\.tooltip\s*\{[^}]*z-index:\s*60;/s);
    expect(appCss).toMatch(/\.sidebar\s*\{[^}]*overflow:\s*visible;/s);
  });
});

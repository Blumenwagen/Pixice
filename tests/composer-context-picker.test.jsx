import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContextInspector, ContextPicker } from "../src/composer/ContextPicker.jsx";

describe("Composer context selection", () => {
  it("finds a matching Skill even when many unrelated thread records precede it", async () => {
    render(<ContextPicker projectId="p1" threadId="t1" query="release" threads={Array.from({ length: 64 }, (_, index) => ({ id: `thread${index}`, name: `Unrelated ${index}` }))} skills={[{ name: "Release checklist", path: "/work/skills/release/SKILL.md" }]} />);
    expect(await screen.findByRole("option", { name: /Release checklist/ })).toBeInTheDocument();
  });

  it("preserves working thread and file choices when installed Skills fail", async () => {
    const onSelect = vi.fn();
    const api = { files: { list: vi.fn().mockResolvedValue({ files: [{ path: "/work/src/main.js", relativePath: "src/main.js", name: "main.js" }] }) }, extensions: { list: vi.fn().mockRejectedValue(new Error("Provider disconnected")) } };
    render(<ContextPicker api={api} projectId="p1" threadId="t1" hostId="host1" threads={[{ id: "t2", name: "Prior investigation" }]} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /Prior investigation/ })).toBeInTheDocument());
    expect(screen.getByText("Skills: Provider disconnected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /src\/main.js/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: "file", source: expect.objectContaining({ path: "/work/src/main.js", projectId: "p1", hostId: "host1" }) }));
    expect(api.files.list).toHaveBeenCalledWith({ projectId: "p1", threadId: "t1", query: "", limit: 60 });
  });
  it("resolves an exact older PR without eagerly reading other thread histories", async () => {
    const onSelect = vi.fn();
    const api = { pullRequests: { list: vi.fn(), read: vi.fn().mockResolvedValue({ number: 42, url: "https://github.com/example/app/pull/42", title: "Composer", state: "MERGED", baseRefName: "main", headRefName: "composer" }) }, threads: { read: vi.fn() } };
    render(<ContextPicker api={api} projectId="p1" threadId="t1" marker="#" query="42" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /#42 Composer/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("option", { name: /#42 Composer/ }));
    expect(api.pullRequests.read).toHaveBeenCalledWith({ projectId: "p1", threadId: "t1", reference: "#42" });
    expect(api.threads.read).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: "pull-request", source: expect.objectContaining({ state: "merged", baseBranch: "main", headBranch: "composer" }) }));
  });
  it("keeps quote source immutable while editing a comment", () => {
    const onChange = vi.fn();
    const onSourceOpen = vi.fn();
    const record = { id: "q1", kind: "citation", label: "Earlier response", source: { threadId: "t1", itemId: "message1" }, text: "Original source text", comment: "" };
    render(<ContextInspector record={record} onChange={onChange} onSourceOpen={onSourceOpen} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Comment on context" }), { target: { value: "Explain this" } });
    expect(onChange).toHaveBeenCalledWith({ ...record, comment: "Explain this" });
    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    expect(onSourceOpen).toHaveBeenCalledWith(record);
    expect(screen.getByText("Original source text")).toBeInTheDocument();
  });
});

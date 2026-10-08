import React, { createRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getSchema } from "@tiptap/core";
import { PromptEditor, createPromptEditorExtensions } from "../src/composer/PromptEditor.jsx";
import { buildDocJson, serializeEditorDoc } from "../src/composer/composer-rich-text-doc";
import { CONTEXT_CLIPBOARD_MIME, createContextRecord, encodeContextClipboard, serializeContextToken } from "../src/composer/context.js";

beforeAll(() => {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [];
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
});

const schema = rich => getSchema(createPromptEditorExtensions(rich));
const roundTrip = (source, rich = true) => serializeEditorDoc(schema(rich).nodeFromJSON(buildDocJson(source, name => ({ label: name, description: null }), { styling: rich }))).value;

function Harness({ initial = "", initialRecords = [], editorRef = createRef(), richTextEnabled = true, onChange, ...props }) {
  const [value, setValue] = useState(initial);
  const [records, setRecords] = useState(initialRecords);
  return <>
    <PromptEditor {...props} ref={editorRef} value={value} records={records} onRecordsChange={setRecords} richTextEnabled={richTextEnabled} onChange={text => { setValue(text); onChange?.(text); }} />
    <output data-testid="markdown">{value}</output><output data-testid="records">{JSON.stringify(records)}</output>
  </>;
}

describe("T3 reference Markdown source retention", () => {
  it.each([
    "A **bold** word, *italic*, ~~removed~~ and `code`.",
    "# Heading\n\n## Next heading\nParagraph", "#123 is a PR, not a heading",
    "- first\n- second\n  - nested", "* first\n+ second", "03) third\n04) fourth",
    "- [ ] pending\n- [x] finished\n  - [ ] nested", "> quoted **text**\n> another line",
    "```javascript\nconst value = 42;\n```", "~~~python\nprint('hello')\n~~~",
    "```\nA code block containing [literal](pixice-context://v1/file/a)\n```",
    "An **unmatched marker and \\*escaped markers\\*", "one\n\n\nthree\n",
    "```json\n{\"a\":true}", "before\r\nafter\r\n", "**`nested code`**",
    "**bold [file](pixice-context://v1/file/one) text**"
  ])("round trips %s", value => { expect(roundTrip(value)).toBe(value); });

  it.each(["__alternate__ _italic_", "# Heading\n- [X] complete\n```js\ncode\n```", "**unmatched\n*literal*\r\n"])('plain mode preserves every literal marker in %s', value => { expect(roundTrip(value, false)).toBe(value); });

  it("retains context atoms as their exact source, with code fences staying literal", () => {
    const source = "Read [strange \\[name\\]](pixice-context://v1/file/id%3Aone) then answer";
    const doc = schema(true).nodeFromJSON(buildDocJson(source, () => ({ label: "" })));
    let chips = 0;
    doc.descendants(node => { if (node.type.name === "composer-context-reference") chips++; });
    expect(chips).toBe(1);
    expect(serializeEditorDoc(doc).value).toBe(source);
  });
});

describe("PromptEditor integration", () => {
  it("exposes an accessible textbox and textarea-compatible source selection", () => {
    const ref = createRef();
    render(<Harness editorRef={ref} initial="before **bold** after" ariaLabel="Project request" placeholder="Describe your task" spellCheck={false} aria-expanded={true} aria-controls="commands" />);
    expect(screen.getByRole("textbox", { name: "Project request" })).toHaveAttribute("aria-multiline", "true");
    expect(screen.getByRole("textbox")).toHaveAttribute("spellcheck", "false");
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-expanded", "true");
    act(() => ref.current.setSelectionRange(7, 15));
    expect(ref.current.value).toBe("before **bold** after");
    // Source markers clamp to the styled edge, leaving the selected prose intact.
    expect(ref.current.selectionStart).toBeGreaterThanOrEqual(7);
    expect(ref.current.selectionEnd).toBeGreaterThanOrEqual(ref.current.selectionStart);
  });

  it("ARIA/menu/disabled changes do not emit synthetic prompt edits", () => {
    const onChange = vi.fn();
    const { rerender } = render(<PromptEditor value="/" onChange={onChange} aria-expanded={true} aria-activedescendant="commands-model" />);
    rerender(<PromptEditor value="/" onChange={onChange} aria-expanded={true} aria-activedescendant="commands-review" />);
    rerender(<PromptEditor value="/" onChange={onChange} disabled aria-expanded={false} />);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-expanded", "false");
  });

  it("inserts dictation/text at the source caret and supports undo/redo", () => {
    const ref = createRef();
    render(<Harness editorRef={ref} initial="hello world" />);
    act(() => { ref.current.setSelectionRange(6, 11); ref.current.insertText("Pixice"); });
    expect(screen.getByTestId("markdown")).toHaveTextContent("hello Pixice");
    act(() => ref.current.undo());
    expect(screen.getByTestId("markdown")).toHaveTextContent("hello world");
    act(() => ref.current.redo());
    expect(screen.getByTestId("markdown")).toHaveTextContent("hello Pixice");
  });

  it("context insertion, deletion and undo retain the source-backed record", () => {
    const ref = createRef();
    const record = createContextRecord("file", { source: { projectId: "p", path: "/project/file.js" }, label: "file.js" });
    render(<Harness editorRef={ref} />);
    act(() => ref.current.insertContext(record));
    expect(screen.getByTestId("markdown").textContent).toBe(`${serializeContextToken(record)} `);
    expect(screen.getByRole("button", { name: "file: file.js" })).toBeInTheDocument();
    act(() => ref.current.undo());
    expect(screen.getByTestId("markdown").textContent).toBe("");
    expect(JSON.parse(screen.getByTestId("records").textContent)).toHaveLength(1);
    act(() => ref.current.redo());
    expect(screen.getByRole("button", { name: "file: file.js" })).toBeInTheDocument();
  });

  it("copy/cut exports Markdown plus records and cut is recoverable", () => {
    const ref = createRef();
    const record = createContextRecord("terminal", { id: "term", label: "Build output", text: "error at line 4", source: { projectId: "p", terminalId: "shell", lineStart: 3, lineEnd: 4 } });
    const source = `Fix ${serializeContextToken(record)} please`;
    render(<Harness initial={source} initialRecords={[record]} editorRef={ref} />);
    act(() => ref.current.setSelectionRange(0, source.length));
    const values = new Map();
    const clipboardData = { setData: (key, value) => values.set(key, value), getData: key => values.get(key) || "", files: [] };
    fireEvent.cut(screen.getByRole("textbox"), { clipboardData });
    expect(values.get("text/plain")).toBe(source);
    expect(JSON.parse(values.get(CONTEXT_CLIPBOARD_MIME)).records[0].text).toBe("error at line 4");
    expect(screen.getByTestId("markdown").textContent).toBe("");
    let undone;
    act(() => { undone = ref.current.undo(); });
    expect(undone).toBe(true);
    expect(ref.current.value).toBe(source);
    expect(screen.getByTestId("markdown").textContent).toBe(source);
  });

  it("structured paste restores records and safely remaps conflicting IDs", () => {
    const existing = createContextRecord("file", { id: "same", label: "old", source: { projectId: "p", path: "/old" } });
    const incoming = createContextRecord("file", { id: "same", label: "new", source: { projectId: "p", path: "/new" } });
    const text = serializeContextToken(incoming);
    render(<Harness initialRecords={[existing]} />);
    const fragment = encodeContextClipboard(text, [incoming]);
    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [], getData: key => key === CONTEXT_CLIPBOARD_MIME ? fragment : key === "text/plain" ? text : "" } });
    const records = JSON.parse(screen.getByTestId("records").textContent);
    expect(records).toHaveLength(2);
    expect(records[0].source.path).toBe("/old");
    expect(records[1].id).not.toBe("same");
    expect(screen.getByTestId("markdown").textContent).toBe(serializeContextToken(records[1]));
  });

  it("rich code blocks have highlighted source and a wired language picker", async () => {
    render(<Harness initial={'```javascript\nconst value = 42;\n```'} />);
    expect(await screen.findByLabelText("Code language")).toHaveValue("javascript");
    expect(document.querySelector(".hljs-keyword")).toHaveTextContent("const");
    fireEvent.change(screen.getByLabelText("Code language"), { target: { value: "typescript" } });
    expect(screen.getByTestId("markdown").textContent).toContain("```typescript\n");
  });

  it("parent paste can claim large text before the editor consumes it", () => {
    const onPaste = vi.fn(event => event.preventDefault());
    render(<Harness onPaste={onPaste} />);
    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [], getData: () => "large prose" } });
    expect(onPaste).toHaveBeenCalledOnce();
    expect(screen.getByTestId("markdown").textContent).toBe("");
  });

  it.each([
    ["- one", "- one\n- "],
    ["- [ ] one", "- [ ] one\n- [ ] "],
    ["> one", "> one\n> "],
    ["```javascript\nconst value = 42;\n```", "```javascript\nconst value = 42;\n\n```"]
  ])("Enter extends a multiline block rather than invoking submit: %s", (initial, expected) => {
    const editorRef = createRef();
    const onKeyDown = vi.fn(event => event.preventDefault());
    render(<Harness initial={initial} editorRef={editorRef} onKeyDown={onKeyDown} />);
    act(() => { editorRef.current.focus(); editorRef.current.setSelectionRange(initial.length); });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(screen.getByTestId("markdown").textContent).toBe(expected);
  });

  it("expanded command menus and modifier sends still reach the parent handler", () => {
    const editorRef = createRef();
    const onKeyDown = vi.fn(event => event.preventDefault());
    render(<Harness initial="- item" editorRef={editorRef} onKeyDown={onKeyDown} aria-expanded={true} />);
    act(() => { editorRef.current.focus(); editorRef.current.setSelectionRange(6); });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", metaKey: true });
    expect(onKeyDown).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("markdown").textContent).toBe("- item");
  });

  it("plain Markdown lists continue on Shift+Enter and source indentation stays in sync", () => {
    const editorRef = createRef();
    render(<Harness initial="03) first" editorRef={editorRef} richTextEnabled={false} />);
    act(() => { editorRef.current.focus(); editorRef.current.setSelectionRange(9); });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", shiftKey: true });
    expect(screen.getByTestId("markdown").textContent).toBe("03) first\n04) ");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Tab" });
    expect(screen.getByTestId("markdown").textContent).toBe("03) first\n  04) ");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Tab", shiftKey: true });
    expect(screen.getByTestId("markdown").textContent).toBe("03) first\n04) ");
    act(() => editorRef.current.undo());
    expect(screen.getByTestId("markdown").textContent).toBe("03) first\n  04) ");
  });

  it("a context chip can be reached from the caret and inspected by keyboard without sending", async () => {
    const editorRef = createRef();
    const onContextOpen = vi.fn();
    const onKeyDown = vi.fn();
    const record = createContextRecord("file", { id: "file", label: "index.js", source: { projectId: "p", path: "/project/index.js" } });
    const source = `${serializeContextToken(record)} `;
    render(<Harness initial={source} initialRecords={[record]} editorRef={editorRef} onContextOpen={onContextOpen} onKeyDown={onKeyDown} />);
    const button = await screen.findByRole("button", { name: "file: index.js" });
    act(() => { editorRef.current.focus(); editorRef.current.setSelectionRange(source.length - 1); });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Tab", shiftKey: true });
    expect(button).toHaveFocus();
    onKeyDown.mockClear();
    fireEvent.keyDown(button, { key: "Enter" });
    expect(onKeyDown).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(onContextOpen).toHaveBeenCalledWith(record);
  });

  it("disabled editors reject insertions and show an actionable missing-context chip", async () => {
    const ref = createRef();
    render(<Harness disabled editorRef={ref} initial="[missing.js](pixice-context://v1/file/missing)" />);
    expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "false");
    expect(await screen.findByRole("button", { name: "file: missing.js, context unavailable" })).toBeInTheDocument();
    act(() => ref.current.insertText("anything"));
    expect(screen.getByTestId("markdown").textContent).toBe("[missing.js](pixice-context://v1/file/missing)");
  });
});

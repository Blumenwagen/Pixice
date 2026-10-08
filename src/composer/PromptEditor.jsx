import React, { createContext, forwardRef, useContext, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { Extension, Node, mergeAttributes } from "@tiptap/core";
import { EditorContent, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { newlineInCode, splitBlockKeepMarks } from "@tiptap/pm/commands";
import hljs from "highlight.js/lib/common";
import {
  ComposerBlockExtensions, ComposerCodeBlockExtension, ComposerCodeExtension,
  ComposerListExtensions, ComposerTaskItemExtension, ComposerTaskListExtension,
  buildDocJson, buildTiptapContent, flatToMarkdown, flatToPm, pmToFlat,
  serializeEditorDoc, serializeSelection, splitOrLiftListItem, stepCaretAcrossStyledEdge,
  parseOpeningFence
} from "./composer-rich-text-doc";
import {
  convertCodeFenceOnEnter, exitCodeBlockOnClosingFence, exitCodeBlockOnTrailingBlankLines,
  indentCodeBlock, indentedNewlineInCodeBlock, selectionInOneCodeBlock
} from "./composer-code-block";
import { COMPOSER_UNDO_GROUP_DELAY, groupUndoByChangeKind, markAsClipboardEdit } from "./composer-undo-grouping";
import { listContinuationForEnter, listIndentForTab } from "./composer-list-continuation";
import {
  blockquoteInputRule, bulletToTaskInputRule, headingInputRule,
  horizontalRuleInputRule, listMarkerInputRule, taskInputRule, hasAncestor
} from "./composer-input-rules";
import { markdownToFlat } from "./composer-editor-mentions";
import {
  CONTEXT_CLIPBOARD_MIME, decodeContextClipboard, encodeContextClipboard,
  mergeContextRecords, normalizeContextRecord, normalizeContextRecords,
  parseContextTokens, serializeContextToken
} from "./context.js";
import "./prompt-editor.css";

const RecordContext = createContext({ records: [], onOpen: null });
const skillLabelFor = name => ({ label: name, description: null });
const languages = ["", "javascript", "typescript", "jsx", "tsx", "python", "json", "bash", "css", "html", "sql", "markdown", "rust", "go", "java", "c", "cpp", "swift", "yaml", "xml", "plaintext"];

function ContextAtomView({ node, selected }) {
  const { records, onOpen } = useContext(RecordContext);
  const record = records.find(candidate => candidate.id === node.attrs.contextId && candidate.kind === node.attrs.kind);
  const unavailable = !record || record.unavailable;
  return <NodeViewWrapper as="span" className={`prompt-context-chip${selected ? " selected" : ""}${unavailable ? " unavailable" : ""}`} contentEditable={false} data-context-id={node.attrs.contextId}>
    <button type="button" tabIndex={-1} aria-label={`${node.attrs.kind}: ${node.attrs.label}${unavailable ? ", context unavailable" : ""}`} title={unavailable ? "Context unavailable. Reselect this source before sending." : record.source?.path || record.source?.url || record.label} onMouseDown={event => event.preventDefault()} onClick={() => onOpen?.(record ?? { id: node.attrs.contextId, kind: node.attrs.kind, label: node.attrs.label, unavailable: true })}>
      <span className="prompt-context-kind" aria-hidden="true">{unavailable ? "!" : node.attrs.kind === "file" ? "@" : node.attrs.kind === "skill" ? "$" : node.attrs.kind === "pull-request" ? "#" : "↗"}</span>{node.attrs.label}
    </button>
  </NodeViewWrapper>;
}

const ContextAtom = Node.create({
  name: "composer-context-reference", group: "inline", inline: true, atom: true, selectable: true,
  addAttributes() { return { kind: { default: "file" }, contextId: { default: "" }, label: { default: "" }, source: { default: "" } }; },
  parseHTML() { return [{ tag: "span[data-pixice-context]" }]; },
  renderHTML({ node, HTMLAttributes }) { return ["span", mergeAttributes(HTMLAttributes, { "data-pixice-context": node.attrs.source }), node.attrs.label]; },
  addNodeView() { return ReactNodeViewRenderer(ContextAtomView); }
});

function CodeBlockView({ node, updateAttributes }) {
  const language = String(node.attrs.language ?? "").trim();
  return <NodeViewWrapper className="prompt-code-block">
    <div className="prompt-code-header" contentEditable={false} onMouseDown={event => event.stopPropagation()}>
      <select aria-label="Code language" value={languages.includes(language) ? language : "custom"} onChange={event => updateAttributes({ language: event.target.value })}>
        <option value="">Code</option>
        {languages.filter(Boolean).map(name => <option key={name} value={name}>{name === "plaintext" ? "Plain text" : name}</option>)}
        {!languages.includes(language) && <option value="custom">{language}</option>}
      </select>
    </div>
    <pre><NodeViewContent as="code" /></pre>
  </NodeViewWrapper>;
}

function highlightDecorations(doc) {
  const decorations = [];
  doc.descendants((node, position) => {
    if (node.type.name !== "codeBlock" || !node.textContent) return;
    const language = String(node.attrs.language ?? "").trim();
    if (!language || !hljs.getLanguage(language)) return;
    let highlighted;
    try { highlighted = hljs.highlight(node.textContent, { language, ignoreIllegals: true }).value; } catch { return; }
    const template = document.createElement("template");
    template.innerHTML = highlighted; // Highlight.js emits escaped source and fixed span classes.
    let offset = position + 1;
    const walk = (parent, inherited = []) => {
      for (const child of parent.childNodes) {
        if (child.nodeType === 3) {
          const length = child.textContent.length;
          if (length && inherited.length) decorations.push(Decoration.inline(offset, offset + length, { class: inherited.join(" ") }));
          offset += length;
        } else if (child.nodeType === 1) {
          walk(child, [...inherited, ...Array.from(child.classList).filter(name => /^hljs-[a-z_-]+$/i.test(name))]);
        }
      }
    };
    walk(template.content);
  });
  return DecorationSet.create(doc, decorations);
}

const CodeHighlight = Extension.create({
  name: "pixiceCodeHighlight",
  addProseMirrorPlugins() { const plugin = new Plugin({
    state: { init: (_, state) => highlightDecorations(state.doc), apply: (tr, previous) => tr.docChanged ? highlightDecorations(tr.doc) : previous.map(tr.mapping, tr.doc) },
    props: { decorations: state => plugin.getState(state) }
  }); return [plugin]; }
});

// Use T3's change-kind grouping so a paste, a chip insertion and later typing
// remain separate, recoverable undo steps.
const UndoGrouping = Extension.create({
  name: "pixiceUndoGrouping",
  addStorage() { return { previous: null }; },
  dispatchTransaction({ transaction, next }) {
    this.storage.previous = groupUndoByChangeKind(transaction, this.storage.previous);
    next(transaction);
  }
});

function extensions(rich) {
  return [StarterKit.configure({
    blockquote: false, code: false, codeBlock: false, heading: false, horizontalRule: false,
    bulletList: false, orderedList: false, listItem: false, listKeymap: false,
    link: false, underline: false, dropcursor: false, gapcursor: false, trailingNode: false,
    undoRedo: { newGroupDelay: COMPOSER_UNDO_GROUP_DELAY },
    ...(rich ? {} : { bold: false, italic: false, strike: false })
  }), UndoGrouping, ContextAtom,
  ...(rich ? [
    ComposerCodeExtension,
    ComposerCodeBlockExtension.extend({ addInputRules() { return []; }, addNodeView() { return ReactNodeViewRenderer(CodeBlockView, { stopEvent: ({ event }) => event.target instanceof Element && Boolean(event.target.closest(".prompt-code-header")) }); } }),
    CodeHighlight,
    ...ComposerBlockExtensions.map(extension => extension.extend({ addInputRules() { return [extension.name === "heading" ? headingInputRule : extension.name === "blockquote" ? blockquoteInputRule : horizontalRuleInputRule]; } })),
    ...ComposerListExtensions.map(extension => extension.name === "listItem" ? extension : extension.extend({ addInputRules() { return this.name === "bulletList" ? [listMarkerInputRule(/^(?<marker>[*+])(?<space>\s)$/, "bulletList"), listMarkerInputRule(/^(?<marker>-)(?<space>[ \t]+)(?<carried>[^\s[])$/, "bulletList")] : [listMarkerInputRule(/^(?<marker>\d+[.)])(?<space>\s)$/, "orderedList")]; } })),
    ComposerTaskListExtension,
    ComposerTaskItemExtension.extend({ addInputRules() { return [taskInputRule(this.type), bulletToTaskInputRule]; } })
  ] : [])];
}

export const createPromptEditorExtensions = extensions;

function sourceSelection(editor) {
  const map = serializeEditorDoc(editor.state.doc);
  const { from, to } = editor.state.selection;
  return { value: map.value, start: flatToMarkdown(map, pmToFlat(map, from)), end: flatToMarkdown(map, pmToFlat(map, to)), map };
}

function setSourceSelection(editor, start, end = start) {
  const map = serializeEditorDoc(editor.state.doc);
  const from = flatToPm(map, markdownToFlat(map, start, start === end ? 1 : -1));
  const to = flatToPm(map, markdownToFlat(map, end, 1));
  editor.commands.setTextSelection({ from, to });
}

function insertMarkdown(editor, text, rich, clipboard = false) {
  if (!text) return;
  if (selectionInOneCodeBlock(editor.state)) {
    let tr = editor.state.tr.insertText(text, editor.state.selection.from, editor.state.selection.to);
    if (clipboard) tr = markAsClipboardEdit(tr, "paste");
    editor.view.dispatch(tr.scrollIntoView());
    return;
  }
  const nested = ["listItem", "taskItem", "blockquote"].some(name => hasAncestor(editor.state.selection.$from, name));
  const blocks = buildTiptapContent(text, skillLabelFor, { styling: rich, blocks: !nested });
  const content = blocks.length === 1 && blocks[0].type === "paragraph" ? blocks[0].content ?? [] : blocks;
  if (!content.length) return;
  editor.chain().command(({ tr }) => { if (clipboard) markAsClipboardEdit(tr, "paste"); return true; }).insertContent(content).run();
}

function applySourceEdit(editor, edit, rich) {
  const previous = sourceSelection(editor);
  const text = previous.value.slice(0, edit.start) + edit.replacement + previous.value.slice(edit.end);
  const content = editor.schema.nodeFromJSON(buildDocJson(text, skillLabelFor, { styling: rich }));
  let tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, content.content);
  const nextCursor = previous.start < edit.start ? previous.start : previous.start > edit.end ? previous.start + edit.replacement.length - (edit.end - edit.start) : edit.start + edit.replacement.length;
  const map = serializeEditorDoc(tr.doc);
  tr = tr.setSelection(TextSelection.create(tr.doc, flatToPm(map, markdownToFlat(map, nextCursor))));
  editor.view.dispatch(tr.scrollIntoView());
}

function readClipboard(event) {
  const clipboard = event.clipboardData;
  const structured = decodeContextClipboard(clipboard?.getData(CONTEXT_CLIPBOARD_MIME));
  if (structured) return structured;
  const html = clipboard?.getData("text/html");
  if (!html || html.length > 1024 * 1024) return null;
  const template = document.createElement("template");
  template.innerHTML = html;
  const encoded = template.content.querySelector("[data-pixice-composer-fragment]")?.getAttribute("data-pixice-composer-fragment");
  try { return encoded ? decodeContextClipboard(decodeURIComponent(encoded)) : null; } catch { return null; }
}

function importClipboard(fragment, existing) {
  const current = normalizeContextRecords(existing);
  const imported = normalizeContextRecords(fragment.records);
  const replacements = new Map();
  const records = imported.map(record => {
    const collision = current.find(candidate => candidate.id === record.id && candidate.kind === record.kind && JSON.stringify(candidate) !== JSON.stringify(record));
    if (!collision) return record;
    const updated = { ...record, id: globalThis.crypto?.randomUUID?.() ?? `${record.id}-${Date.now()}` };
    replacements.set(`${record.kind}:${record.id}`, updated);
    return updated;
  });
  let text = fragment.text;
  for (const token of parseContextTokens(text).toReversed()) {
    const replacement = replacements.get(`${token.kind}:${token.id}`);
    if (replacement) text = text.slice(0, token.start) + serializeContextToken({ ...replacement, label: token.label }) + text.slice(token.end);
  }
  return { text, records: mergeContextRecords(current, records), insertedRecords: records };
}

export const PromptEditor = forwardRef(function PromptEditor(props, ref) {
  return <PromptEditorInner key={props.richTextEnabled === false ? "plain" : "rich"} {...props} ref={ref} />;
});

const PromptEditorInner = forwardRef(function PromptEditorInner({
  value = "", onChange, records = [], onRecordsChange, richTextEnabled = true,
  disabled = false, ariaLabel = "Task prompt", placeholder = "", spellCheck = true,
  onKeyDown, onPaste, onFocus, onBlur, onContextOpen, onSelectionChange, className = "", ...aria
}, ref) {
  const latest = useRef({ value, onChange, records, onRecordsChange, onKeyDown, onPaste, disabled, onContextOpen, onSelectionChange });
  latest.current = { value, onChange, records, onRecordsChange, onKeyDown, onPaste, disabled, onContextOpen, onSelectionChange };
  const applied = useRef(false);
  const valueRevision = useRef(0);
  const editor = useEditor({
    extensions: extensions(richTextEnabled), content: buildDocJson(value, skillLabelFor, { styling: richTextEnabled }),
    editable: !disabled, immediatelyRender: true,
    editorProps: {
      attributes: { role: "textbox", "aria-multiline": "true", "aria-label": ariaLabel, class: "prompt-editor-content", spellcheck: String(spellCheck), "data-placeholder": placeholder },
      handleKeyDown: (view, event) => {
        if (event.defaultPrevented) return true;
        if (event.isComposing || event.keyCode === 229) return event.key === "Enter";
        if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && view.state.selection.empty) {
          const tr = stepCaretAcrossStyledEdge(view.state, event.key === "ArrowLeft" ? -1 : 1);
          if (tr) { view.dispatch(tr); return true; }
        }
        if (event.key === "Tab" && event.shiftKey && !event.metaKey && !event.ctrlKey && view.state.selection.empty) {
          const before = view.state.selection.$from.nodeBefore;
          if (before?.type.name === "composer-context-reference") {
            const chip = view.nodeDOM(view.state.selection.from - before.nodeSize);
            const button = chip instanceof Element ? chip.querySelector("button") : null;
            if (button) { button.focus(); return true; }
          }
        }
        if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && selectionInOneCodeBlock(view.state)) return indentCodeBlock(view.state, event.shiftKey ? "out" : "in", tr => view.dispatch(tr));
        if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && editorHolder.current) {
          const source = sourceSelection(editorHolder.current);
          const edit = listIndentForTab(source.value, source.start, source.end);
          if (edit) {
            if (!event.shiftKey) { applySourceEdit(editorHolder.current, edit, richTextEnabled); return true; }
            const leading = /^[ \t]+/.exec(source.value.slice(edit.start))?.[0] || "";
            if (leading) {
              const removed = leading.startsWith("\t") ? 1 : Math.min(2, leading.length);
              applySourceEdit(editorHolder.current, { start: edit.start, end: edit.start + removed, replacement: "" }, richTextEnabled);
              return true;
            }
          }
        }
        if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
          if (event.target instanceof HTMLInputElement) return true;
          const dispatch = tr => view.dispatch(tr.scrollIntoView());
          if (richTextEnabled && selectionInOneCodeBlock(view.state)) return exitCodeBlockOnClosingFence(view.state, dispatch) || exitCodeBlockOnTrailingBlankLines(view) || indentedNewlineInCodeBlock(view.state, dispatch) || newlineInCode(view.state, dispatch);
          if (richTextEnabled && convertCodeFenceOnEnter(view.state, dispatch)) return true;
          const instance = editorHolder.current;
          if (!richTextEnabled && instance) {
            const source = sourceSelection(instance);
            const edit = source.start === source.end ? listContinuationForEnter(source.value, source.start) : null;
            if (edit) { applySourceEdit(instance, edit, false); return true; }
          }
          if (instance && (instance.isActive("taskItem") || instance.isActive("listItem")) && splitOrLiftListItem(instance)) return true;
          if (instance && hasAncestor(view.state.selection.$from, "blockquote") && view.state.selection.$from.parent.content.size === 0 && instance.commands.lift("blockquote")) return true;
          return splitBlockKeepMarks(view.state, dispatch);
        }
        return false;
      },
      handlePaste: (view, event) => {
        if (event.defaultPrevented) return true;
        if (event.clipboardData?.files?.length) return false;
        let text = event.clipboardData?.getData("text/plain") || "";
        const fragment = readClipboard(event);
        if (fragment && !selectionInOneCodeBlock(view.state)) {
          const imported = importClipboard(fragment, latest.current.records);
          text = imported.text;
          latest.current.records = imported.records;
          latest.current.onRecordsChange?.(imported.records, { insertedRecords: imported.insertedRecords });
        }
        if (!text) return false;
        event.preventDefault();
        insertMarkdown(editorHolder.current, text, richTextEnabled, true);
        return true;
      }
    },
    onSelectionUpdate: ({ editor: updated }) => {
      latest.current.onSelectionChange?.(sourceSelection(updated).start);
    },
    onUpdate: ({ editor: updated }) => {
      if (applied.current) return;
      const text = serializeEditorDoc(updated.state.doc).value;
      latest.current.onChange?.(text);
      updated.view.dom.setAttribute("data-empty", String(text.length === 0));
    }
  }, []);
  const editorHolder = useRef(editor);
  editorHolder.current = editor;

  useLayoutEffect(() => {
    if (!editor) return;
    const current = serializeEditorDoc(editor.state.doc).value;
    if (current === value) return;
    const revision = ++valueRevision.current;
    // React node views flush their portals synchronously. Updating the Tiptap
    // document after this commit avoids nesting flushSync inside a lifecycle;
    // the latest draft wins and the microtask still lands before the next paint.
    queueMicrotask(() => {
      if (editor.isDestroyed || revision !== valueRevision.current || latest.current.value !== value) return;
      const previous = sourceSelection(editor);
      const wasFocused = editor.isFocused;
      applied.current = true;
      try {
        editor.commands.setContent(buildDocJson(value, skillLabelFor, { styling: richTextEnabled }), { emitUpdate: false });
        setSourceSelection(editor, Math.min(previous.start, value.length), Math.min(previous.end, value.length));
        if (wasFocused) editor.view.focus();
      } finally { applied.current = false; }
    });
    return () => { valueRevision.current++; };
  }, [editor, value, richTextEnabled]);

  useLayoutEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled, false);
    const element = editor.view.dom;
    element.setAttribute("aria-label", ariaLabel);
    element.setAttribute("aria-disabled", String(disabled));
    element.setAttribute("spellcheck", String(spellCheck));
    element.setAttribute("data-placeholder", placeholder);
    element.setAttribute("data-empty", String(value.length === 0));
    for (const key of ["aria-autocomplete", "aria-expanded", "aria-controls", "aria-activedescendant", "aria-describedby", "aria-invalid"]) {
      const next = aria[key];
      if (next === undefined || next === null) element.removeAttribute(key); else element.setAttribute(key, String(next));
    }
  }, [editor, disabled, ariaLabel, spellCheck, placeholder, value.length, aria["aria-autocomplete"], aria["aria-expanded"], aria["aria-controls"], aria["aria-activedescendant"], aria["aria-describedby"], aria["aria-invalid"]]);

  useImperativeHandle(ref, () => ({
    focus() { editor?.view.focus(); },
    get element() { return editor?.view.dom; },
    get value() { return editor ? sourceSelection(editor).value : value; },
    get selectionStart() { return editor ? sourceSelection(editor).start : value.length; },
    get selectionEnd() { return editor ? sourceSelection(editor).end : value.length; },
    get style() { return editor?.view.dom.style; },
    get scrollHeight() { return editor?.view.dom.scrollHeight ?? 0; },
    setSelectionRange(start, end = start) { if (editor) setSourceSelection(editor, start, end); },
    replaceText(text) {
      if (!editor) return;
      editor.commands.setContent(buildDocJson(String(text), skillLabelFor, { styling: richTextEnabled }), { emitUpdate: true });
      setSourceSelection(editor, String(text).length);
    },
    insertText(text) { if (!editor || latest.current.disabled) return; insertMarkdown(editor, String(text), richTextEnabled); editor.view.focus(); },
    insertContext(input) {
      if (!editor || latest.current.disabled) return;
      const record = normalizeContextRecord(input);
      if (!record) return;
      const next = mergeContextRecords(latest.current.records, [record]);
      if (!next.some(candidate => candidate.id === record.id && candidate.kind === record.kind)) return false;
      latest.current.records = next;
      latest.current.onRecordsChange?.(next, { insertedRecords: [record] });
      insertMarkdown(editor, `${serializeContextToken(record)} `, richTextEnabled);
      editor.view.focus();
      return true;
    },
    readSelectionRange() { return editor ? { start: sourceSelection(editor).start, end: sourceSelection(editor).end } : { start: 0, end: 0 }; },
    isInMultilineBlock() { return Boolean(editor && ["codeBlock", "listItem", "taskItem", "blockquote"].some(name => hasAncestor(editor.state.selection.$from, name))); },
    isCaretOnVisualEdge(edge) {
      if (!editor || !editor.state.selection.empty) return false;
      const selection = sourceSelection(editor);
      if (!selection.value) return true;
      const text = edge === "start" ? selection.value.slice(0, selection.start) : selection.value.slice(selection.end);
      if (text.includes("\n")) return false;
      const native = window.getSelection();
      if (!native?.isCollapsed || !native.rangeCount || !editor.view.dom.contains(native.anchorNode)) return false;
      const range = native.getRangeAt(0);
      const rectangles = typeof range.getClientRects === "function" ? Array.from(range.getClientRects()).filter(rect => rect.height > 0) : [];
      if (!rectangles.length) return edge === "start" ? selection.start === 0 : selection.end === selection.value.length;
      const caret = rectangles[0];
      const boundary = (edge === "start" ? editor.view.dom.firstElementChild : editor.view.dom.lastElementChild)?.getBoundingClientRect();
      return boundary ? edge === "start" ? caret.top - boundary.top < caret.height / 2 : boundary.bottom - caret.bottom < caret.height / 2 : false;
    },
    undo() { return editor?.commands.undo(); }, redo() { return editor?.commands.redo(); }
  }), [editor, value, richTextEnabled]);

  const copyCut = (event, cut) => {
    if (!editor || (cut && disabled) || editor.state.selection.empty) return;
    const text = serializeSelection(editor.state.doc, editor.state.selection.from, editor.state.selection.to);
    const fragment = encodeContextClipboard(text, latest.current.records);
    event.preventDefault();
    event.clipboardData.setData("text/plain", text);
    if (parseContextTokens(text).length) {
      event.clipboardData.setData(CONTEXT_CLIPBOARD_MIME, fragment);
      event.clipboardData.setData("text/html", `<span data-pixice-composer-fragment="${encodeURIComponent(fragment)}"></span>`);
    }
    if (cut) editor.chain().command(({ tr }) => { markAsClipboardEdit(tr, "cut"); return true; }).deleteSelection().run();
  };

  return <RecordContext.Provider value={{ records: normalizeContextRecords(records), onOpen: onContextOpen }}>
    <div className={`prompt-editor${className ? ` ${className}` : ""}`} data-rich-text={richTextEnabled}>
      <EditorContent editor={editor} onCopyCapture={event => copyCut(event, false)} onCutCapture={event => copyCut(event, true)}
        onPasteCapture={onPaste} onFocus={onFocus} onBlur={onBlur}
        onKeyDownCapture={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.target instanceof Element && event.target.closest(".prompt-context-chip button, .prompt-code-header")) return;
          const state = editor?.state;
          const menuOpen = aria["aria-expanded"] === true || aria["aria-expanded"] === "true";
          const blockKey = state && !event.metaKey && !event.ctrlKey && !menuOpen && ((event.key === "Tab" && selectionInOneCodeBlock(state)) || (event.key === "Enter" && richTextEnabled && (selectionInOneCodeBlock(state) || ["listItem", "taskItem", "blockquote"].some(name => hasAncestor(state.selection.$from, name)) || (state.selection.$from.depth === 1 && parseOpeningFence(state.selection.$from.parent.textContent)))));
          if (!blockKey) onKeyDown?.(event);
        }} />
    </div>
  </RecordContext.Provider>;
});

export default PromptEditor;

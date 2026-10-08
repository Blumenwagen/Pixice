// Adapted from T3 Code v0.0.46-nightly.20261008.2813 (30cc788975500a8c00d32a50f348174d1ce578d1).
// Copyright (c) 2026 T3 Tools Inc. MIT license; see T3-LICENSE.txt.
import { InputRule, wrappingInputRule } from "@tiptap/core";
import type { NodeType, ResolvedPos } from "@tiptap/pm/model";
import { convertBulletItemToTask } from "./composer-rich-text-doc";

export function listMarkerInputRule(find: RegExp, listType: "bulletList" | "orderedList"): InputRule {
  return new InputRule({
    find,
    handler: ({ state, range, match, chain }) => {
      const marker = match.groups?.marker ?? "-";
      const space = match.groups?.space ?? " ";
      const carried = match.groups?.carried ?? "";
      // Top-level paragraphs only: inside an item or a quote the new list
      // would nest under a line the stored draft writes flat.
      const $from = state.doc.resolve(range.from);
      if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
      const command = chain()
        .deleteRange(range)
        .wrapInList(
          listType,
          listType === "orderedList" ? { start: Number.parseInt(marker, 10) || 1 } : {},
        )
        .updateAttributes("listItem", { marker, space });
      (carried ? command.insertContent(carried) : command).run();
      return undefined;
    },
  });
}

/**
 * `[ ] ` at the start of an existing bullet item turns it into a task, for
 * items that were already a list when the checkbox was wanted. New tasks are
 * typed whole, `- [ ] `, and reach the task rule directly.
 */
export const bulletToTaskInputRule = new InputRule({
  find: /^\[([ xX])\] $/,
  handler: ({ state, range, match, chain }) => {
    const $from = state.doc.resolve(range.from);
    const item = $from.node(-1);
    if ($from.parent.type.name !== "paragraph" || item?.type.name !== "listItem") return null;
    // Any bullet converts; the task grammar only knows `-`, so a `*` or `+`
    // item comes back out as `- [ ]`.
    if (!["-", "*", "+"].includes((item.attrs as { marker?: string }).marker ?? "")) return null;
    const checked = (match[1] ?? " ").toLowerCase() === "x";
    chain()
      .command(({ tr }) => {
        convertBulletItemToTask(tr, range.from, range.to, checked);
        return true;
      })
      .run();
    return undefined;
  },
});

/** `- [ ] ` or `- [x] ` at a top-level paragraph, for the same reason as the list markers. */
export function taskInputRule(type: NodeType): InputRule {
  const rule = wrappingInputRule({
    find: /^- \[([ xX])\] $/,
    type,
    getAttributes: (match) => ({ checked: match[1]?.toLowerCase() === "x" }),
  });
  return new InputRule({
    find: rule.find,
    handler: (props) =>
      props.state.doc.resolve(props.range.from).depth === 1 ? rule.handler(props) : null,
  });
}

export function hasAncestor($pos: ResolvedPos, name: string): boolean {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === name) return true;
  }
  return false;
}

/**
 * `> ` at the start of a top-level paragraph opens a quote. Not inside a list:
 * a quote holds prose lines, and a list item is not one.
 */
export const blockquoteInputRule = new InputRule({
  find: /^>(\s)$/,
  handler: ({ state, range, match, chain }) => {
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
    chain()
      .deleteRange(range)
      .wrapIn("blockquote", { prefix: `>${match[1] ?? " "}` })
      .run();
    return undefined;
  },
});

/**
 * `---` becomes a rule as the third dash lands; `***` and `___` need a space
 * after them so typing bold or an underscore is not interrupted, matching
 * Tiptap's own rule. Only at a top-level paragraph: the list and quote
 * serializers have no line to write a rule into. The typed characters are
 * kept as the rule's source, and `setHorizontalRule` adds a paragraph after a
 * rule at the end so the caret has somewhere to go.
 */
export const horizontalRuleInputRule = new InputRule({
  find: /^(---|\*\*\*|___)\s?$/,
  handler: ({ state, range, match, chain }) => {
    const source = match[0] ?? "---";
    if (!source.startsWith("---") && !/\s$/.test(source)) return null;
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
    chain()
      .deleteRange(range)
      .setHorizontalRule()
      .command(({ tr }) => {
        // The rule is the block before the caret's paragraph.
        const $pos = tr.selection.$from;
        const index = $pos.index(0) - 1;
        if (index < 0) return true;
        const rulePos = $pos.posAtIndex(index, 0);
        const rule = tr.doc.nodeAt(rulePos);
        if (rule?.type.name === "horizontalRule") {
          tr.setNodeMarkup(rulePos, undefined, { ...rule.attrs, source });
        }
        return true;
      })
      .run();
    return undefined;
  },
});

/**
 * `# ` through `###### ` at a top-level paragraph make a heading. The space
 * is required, which is exactly what keeps `#1234` a pull request reference
 * with its picker rather than a heading. Not inside lists or quotes, whose
 * serializers have no line for one.
 */
export const headingInputRule = new InputRule({
  find: /^(#{1,6})(\s)$/,
  handler: ({ state, range, match, chain }) => {
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
    chain()
      .deleteRange(range)
      .setNode("heading", { level: match[1]?.length ?? 1, space: match[2] ?? " " })
      .run();
    return undefined;
  },
});

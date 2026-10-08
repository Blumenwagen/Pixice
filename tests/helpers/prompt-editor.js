import { act, fireEvent } from '@testing-library/react';
import { toHaveValue } from '@testing-library/jest-dom/matchers';
import userEvent from '@testing-library/user-event';
import { buildDocJson, serializeEditorDoc } from '../../src/composer/composer-rich-text-doc';

// jsdom has no text layout. Production browsers supply these Range methods;
// zero geometry lets the real ProseMirror editor exercise source/caret logic.
export function installPromptEditorGeometry() {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [];
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}

/** Uses Tiptap's real document API, retaining source markers and context atoms. */
export function changeEditable(element, options = {}) {
  const value = options.target?.value;
  if (!element.editor || typeof value !== 'string') return fireEvent.change(element, options);
  act(() => {
    const rich = element.closest('.prompt-editor')?.dataset.richText !== 'false';
    const document = buildDocJson(value, name => ({ label: name }), { styling: rich });
    const end = element.editor.schema.nodeFromJSON(document).content.size - 1;
    element.editor.chain().setContent(document, { emitUpdate: true }).setTextSelection(end).run();
  });
  return true;
}

export function editableValue(element) {
  return element.editor ? serializeEditorDoc(element.editor.state.doc).value : element.value;
}

/** Native fields retain jest-dom's matcher; rich prompts assert serialized source. */
export function toHaveEditableValue(element, expected) {
  if (!element.editor) return toHaveValue.call(this, element, expected);
  const received = editableValue(element);
  return { pass: this.equals(received, expected), message: () => `Expected prompt source ${this.isNot ? 'not ' : ''}to equal ${this.utils.printExpected(expected)}; received ${this.utils.printReceived(received)}.` };
}

/** Avoid mouse-coordinate placement that jsdom cannot provide for editable prose. */
export function createEditorAwareUser(options) {
  const user = userEvent.setup(options);
  return { ...user, async type(element, text, settings) {
    if (!element.editor) return user.type(element, text, settings);
    fireEvent.pointerDown(element);
    act(() => { element.editor.view.focus(); element.editor.commands.setTextSelection(element.editor.state.doc.content.size - 1); });
    return user.type(element, text, { ...settings, skipClick: true });
  } };
}

export function buildCodexUserInput(text, images = []) {
  const input = [];
  const trimmedText = String(text ?? "").trim();
  if (trimmedText) input.push({ type: "text", text: trimmedText, text_elements: [] });
  for (const url of images) input.push({ type: "image", url });
  return input;
}

export function buildClaudeUserMessage(text, images = []) {
  const content = [];
  const trimmedText = String(text ?? "").trim();
  if (trimmedText) content.push({ type: "text", text: trimmedText });
  for (const dataUrl of images) {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/i.exec(dataUrl);
    if (!match) throw new Error("Claude received an unsupported image attachment");
    content.push({
      type: "image",
      source: { type: "base64", media_type: match[1].toLowerCase(), data: match[2] }
    });
  }
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: ""
  };
}

import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE_MIME_TYPES = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"], [".avif", "image/avif"],
  [".svg", "image/svg+xml"], [".bmp", "image/bmp"], [".ico", "image/x-icon"]
]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;
const MAX_EDITABLE_BYTES = 4 * 1024 * 1024;

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function cleanPreviewFileReference(reference) {
  let value = String(reference ?? "").trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  if (value.startsWith("file://")) value = fileURLToPath(value);
  try { value = decodeURIComponent(value); } catch { /* Keep paths that are not URI encoded. */ }
  return value.replace(/#L\d+(?:-L?\d+)?$/i, "").replace(/:(\d+)(?::\d+)?$/, "");
}

export function previewFileTarget({ reference, primaryRoot, roots, allowExternal = false }) {
  const cleaned = cleanPreviewFileReference(reference);
  if (!cleaned) throw new Error("File path is required");
  const canonicalPrimaryRoot = realpathSync(primaryRoot);
  const canonicalRoots = roots.map((root) => realpathSync(root));
  const candidate = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(canonicalPrimaryRoot, cleaned);
  const resolved = realpathSync(candidate);
  const folderPath = canonicalRoots
    .filter((root) => isWithin(root, resolved))
    .sort((left, right) => right.length - left.length)[0] ?? null;
  if (!folderPath && !allowExternal) throw new Error("File is outside the selected project");
  const metadata = statSync(resolved);
  if (!metadata.isFile()) throw new Error("The selected path is not a file");
  return { resolved, metadata, folderPath: folderPath ?? path.dirname(resolved), external: !folderPath };
}

export function readPreviewFile(options) {
  const { resolved, metadata, folderPath, external } = previewFileTarget(options);
  if (metadata.size > MAX_PREVIEW_BYTES) throw new Error("File is too large to open in Pixice");
  const extension = path.extname(resolved).toLowerCase();
  const buffer = readFileSync(resolved);
  const imageMime = IMAGE_MIME_TYPES.get(extension);
  const isPdf = extension === ".pdf";
  const common = {
    path: resolved,
    relativePath: external ? resolved : path.relative(folderPath, resolved),
    folderPath,
    name: path.basename(resolved),
    extension,
    external,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs
  };
  if (imageMime || isPdf) {
    const mimeType = imageMime || "application/pdf";
    return {
      ...common,
      kind: imageMime ? "image" : "pdf",
      mimeType,
      dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
      editable: false
    };
  }
  const content = buffer.toString("utf8");
  const binary = content.includes("\u0000");
  return {
    ...common,
    kind: binary ? "unsupported" : MARKDOWN_EXTENSIONS.has(extension) ? "markdown" : HTML_EXTENSIONS.has(extension) ? "html" : "text",
    content: binary ? null : content,
    editable: !binary && metadata.size <= MAX_EDITABLE_BYTES
  };
}

export { MAX_EDITABLE_BYTES };

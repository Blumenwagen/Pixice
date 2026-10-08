const DATABASE = "pixice-canvases-v1";
const STORE = "documents";
let databasePromise;

function database() {
  if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { databasePromise = null; reject(request.error); };
  });
  return databasePromise;
}

async function transact(mode, operation) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = operation(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Canvas storage was interrupted."));
  });
}

export function createCanvasStore(hostId = "local") {
  return {
    async list() {
      const records = await transact("readonly", store => store.getAll());
      return records.filter(record => record.hostId === hostId).map(record => record.document)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async save(document) {
      await transact("readwrite", store => store.put({ key: JSON.stringify([hostId, document.id]), hostId, document }));
    },
    async remove(id) {
      await transact("readwrite", store => store.delete(JSON.stringify([hostId, id])));
    }
  };
}

export function createCanvas(name = "Untitled canvas") {
  return { id: crypto.randomUUID(), name, projectId: null, nodes: [], edges: [], viewport: { x: 80, y: 80, zoom: 1 }, updatedAt: new Date().toISOString() };
}

export const ITEM_SIZES = { text: [320, 260], image: [360, 320], agent: [400, 480], workflow: [820, 580], task: [460, 600], tool: [500, 520], file: [400, 340], link: [320, 210] };
export function createCanvasItem(kind, position, data = {}) {
  const [width, height] = ITEM_SIZES[kind] ?? ITEM_SIZES.text;
  return { id: crypto.randomUUID(), type: "canvasItem", dragHandle: ".pixice-canvas-item-handle", position,
    style: { width, height }, data: { kind, title: ({ text: "Note", image: "Image", agent: "Agent", workflow: "Workflow", task: "Board task", tool: "Tool", file: "File", link: "Link" })[kind], ...data } };
}

// A composer sees this canvas. Explicit connections narrow its context to those
// items. Other composers' private drafts never accompany a request.
export function canvasAgentContext(document, agentId) {
  if (!document.nodes.some(node => node.id === agentId && node.data.kind === "agent")) return { text: "", images: [] };
  const neighborIds = new Set(document.edges.flatMap(edge => edge.target === agentId ? [edge.source] : edge.source === agentId ? [edge.target] : []));
  const neighbors = document.nodes.filter(node => node.data.kind !== "agent" && (neighborIds.size ? neighborIds.has(node.id) : node.id !== agentId)).slice(0, 12);
  const entries = neighbors.map(({ data }) => {
    const body = data.kind === "text" || data.kind === "file" ? data.content : data.kind === "workflow" ? data.workflow?.description : data.kind === "workflowNode" ? `${data.node?.description ?? ""}\n${JSON.stringify(data.node?.config ?? {})}` : data.kind === "link" ? data.url : data.kind === "task" ? `${data.taskDescription ?? ""}\nTask: ${data.taskId}` : data.workflowId ?? "";
    return `${data.kind}: ${data.title}\n${String(body ?? "").slice(0, 2000)}`;
  });
  return { text: entries.length ? `\n\nReferenced canvas items (user-provided context):\n${entries.join("\n\n").slice(0, 12000)}` : "",
    images: neighbors.filter(node => node.data.kind === "image" && /^data:image\/(png|jpeg|webp|gif);/.test(node.data.src ?? "")).slice(0, 4).map(node => node.data.src) };
}

let pixiceApi;

const sourceThreadId = "preview-task";
const forkThreadId = "preview-task-fork";
const startedAt = new Date(Date.now() - 94_000).toISOString();
const completedAt = new Date(Date.now() - 52_000).toISOString();
const generatedImage = "http://127.0.0.1:5173/src/assets/pixice-icon.png";

function completedSourceThread(thread) {
  return {
    ...thread,
    id: sourceThreadId,
    name: "Refine chat forking",
    preview: "Refine chat forking",
    parentThreadId: null,
    forkedFromId: null,
    status: { type: "idle" },
    planProgress: null,
    updatedAt: Math.floor(Date.now() / 1000) - 52,
    turns: [{
      id: "fork-source-turn",
      status: "completed",
      startedAt,
      completedAt,
      items: [
        {
          id: "fork-source-prompt",
          type: "userMessage",
          createdAt: startedAt,
          content: [{
            type: "text",
            text: "Make chat forking work like Codex. Put a small fork button below each agent answer, then open the fork as a normal sidebar thread instead of a Preview tab."
          }]
        },
        {
          id: "fork-source-image-tool",
          type: "dynamicToolCall",
          tool: "image_gen__imagegen",
          status: "completed",
          arguments: {
            prompt: "A clean Pixice workspace mark on a soft blue field",
            size: "1254x1254"
          }
        },
        {
          id: "fork-source-answer",
          type: "agentMessage",
          createdAt: completedAt,
          phase: "final_answer",
          text: "Forking now starts from the selected agent answer. The new conversation opens as a regular sidebar thread, keeps the context through this response, and stays separate from Preview Side Threads. The generated image remains part of the forked history."
        },
        {
          id: "fork-source-generated-image",
          type: "imageGeneration",
          createdAt: completedAt,
          status: "completed",
          resolution: "1254x1254",
          result: generatedImage,
          revisedPrompt: "A clean Pixice workspace mark on a soft blue field"
        }
      ]
    }]
  };
}

function forkedThread(source) {
  return {
    ...source,
    id: forkThreadId,
    name: "Refine chat forking (fork)",
    preview: "Refine chat forking (fork)",
    parentThreadId: null,
    forkedFromId: sourceThreadId,
    status: { type: "idle" },
    updatedAt: Math.floor(Date.now() / 1000)
  };
}

Object.defineProperty(window, "pixice", {
  configurable: true,
  get() {
    return pixiceApi;
  },
  set(api) {
    const listThreads = api.threads.list.bind(api.threads);
    const readThread = api.threads.read.bind(api.threads);
    let createdFork = null;

    api.threads.list = async (payload) => {
      const response = await listThreads(payload);
      const source = completedSourceThread(response.data.find((thread) => thread.id === sourceThreadId) ?? response.data[0]);
      const rest = response.data.filter((thread) => thread.id !== sourceThreadId && thread.id !== forkThreadId);
      return {
        ...response,
        data: createdFork ? [createdFork, source, ...rest] : [source, ...rest]
      };
    };

    api.threads.read = async (payload) => {
      if (payload.threadId === forkThreadId && createdFork) return { thread: createdFork, plan: [] };
      const response = await readThread(payload);
      if (payload.threadId !== sourceThreadId) return response;
      return { ...response, thread: completedSourceThread(response.thread), plan: [] };
    };

    api.threads.children = async () => ({ data: [], nextCursor: null });
    api.threads.fork = async (payload) => {
      window.__chatForkPayload = payload;
      const response = await readThread({ projectId: payload.projectId, threadId: sourceThreadId });
      createdFork = forkedThread(completedSourceThread(response.thread));
      await new Promise((resolve) => setTimeout(resolve, 220));
      return { thread: createdFork };
    };

    pixiceApi = api;
  }
});

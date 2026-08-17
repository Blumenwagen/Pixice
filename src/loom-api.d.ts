export {};

type LoomEvent = {
  type: "TaskUpdated" | "AgentUpdated" | "ActivityReceived" | "AttentionRequired" | "RuntimeError";
  payload: unknown;
  at: string;
};

declare global {
  interface Window {
    loom?: {
      projects: { list(): Promise<unknown[]>; open(): Promise<unknown | null> };
      tasks: { create(payload?: unknown): Promise<unknown>; archive(payload: unknown): Promise<unknown>; interrupt(payload: unknown): Promise<unknown> };
      turns: { start(payload: { threadId?: string; text: string }): Promise<unknown>; steer(payload: unknown): Promise<unknown> };
      approvals: { resolve(payload: { requestId: string; decision: "accept" | "decline" | "acceptForSession" }): Promise<unknown> };
      review: { read(payload: { workingPath: string; baseCommit: string | null }): Promise<string> };
      extensions: { list(): Promise<unknown>; update(payload: unknown): Promise<unknown> };
      external: { openEditor(payload: { path: string }): Promise<unknown>; openTerminal(payload: { path: string }): Promise<unknown>; reveal(payload: { path: string }): Promise<unknown> };
      events: { subscribe(listener: (event: LoomEvent) => void): () => void };
    };
  }
}

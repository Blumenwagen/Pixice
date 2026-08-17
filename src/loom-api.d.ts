export {};

type LoomEvent = {
  type: "TaskUpdated" | "AgentUpdated" | "ActivityReceived" | "AttentionRequired" | "RuntimeError" | "RuntimeStatus";
  payload: any;
  at: string;
};

type ProjectScope = { projectId: string };
type ThreadScope = ProjectScope & { threadId: string };

declare global {
  interface Window {
    loom?: {
      app: {
        bootstrap(): Promise<{ projects: any[]; models: any[]; runtime: any }>;
      };
      runtime: { status(): Promise<any> };
      projects: {
        list(): Promise<any[]>;
        open(): Promise<any | null>;
      };
      threads: {
        list(payload: ProjectScope): Promise<{ data: any[]; nextCursor: string | null }>;
        read(payload: ThreadScope): Promise<{ thread: any }>;
        create(payload: ProjectScope & { model?: string }): Promise<{ thread: any }>;
        archive(payload: ThreadScope): Promise<unknown>;
      };
      turns: {
        start(payload: ThreadScope & { text: string; model?: string; effort?: string }): Promise<{ turn: any }>;
        steer(payload: ThreadScope & { turnId: string; text: string }): Promise<unknown>;
        interrupt(payload: ThreadScope & { turnId: string }): Promise<unknown>;
      };
      approvals: {
        resolve(payload: { requestId: string | number; decision: "accept" | "decline" | "acceptForSession" | "cancel" }): Promise<unknown>;
      };
      review: { read(payload: ProjectScope): Promise<{ repository: any; diff: string }> };
      models: { list(): Promise<any[]> };
      extensions: { list(payload?: { cwd?: string; threadId?: string }): Promise<any> };
      external: {
        openEditor(payload: ProjectScope & { path?: string }): Promise<unknown>;
        openTerminal(payload: ProjectScope & { path?: string }): Promise<unknown>;
        reveal(payload: ProjectScope & { path?: string }): Promise<unknown>;
      };
      events: { subscribe(listener: (event: LoomEvent) => void): () => void };
    };
  }
}

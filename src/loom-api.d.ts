export {};

type LoomEvent = {
  type: "TaskUpdated" | "AgentUpdated" | "ActivityReceived" | "AttentionRequired" | "AttentionReset" | "RuntimeError" | "RuntimeStatus" | "BrowserState" | "BrowserOpenRequested" | "BoardUpdated" | "UpdateState" | "UsageUpdated";
  payload: any;
  at: string;
};

type ProjectScope = { projectId: string };
type ThreadScope = ProjectScope & { threadId: string };

declare global {
  interface Window {
    loom?: {
      app: {
        bootstrap(): Promise<{ projects: any[]; models: any[]; runtime: any; settings?: Record<string, unknown>; agentBehaviors?: Array<{ id: string; label: string; description: string; defaultEnabled: boolean }> }>;
        saveSettings(payload: { defaultModel?: string; defaultEffort?: string; defaultPermissionMode?: "read-only" | "workspace-write" | "auto-approve" | "full-access"; agentBehaviors?: Record<string, boolean> }): Promise<any>;
      };
      runtime: { status(): Promise<any> };
      providers: {
        list(): Promise<any[]>;
        login(payload: { provider: string }): Promise<{ provider: string; opened: boolean; loginId?: string | null }>;
      };
      usage: { summary(payload: { days: number }): Promise<any> };
      updates: {
        status(): Promise<any>;
        check(): Promise<any>;
        download(): Promise<any>;
        install(): Promise<{ ok: boolean }>;
      };
      browser: {
        state(payload: { workspaceId: string }): Promise<any>;
        create(payload: { workspaceId: string; url?: string }): Promise<any>;
        close(payload: { workspaceId: string; tabId: string }): Promise<any>;
        activate(payload: { workspaceId: string; tabId: string }): Promise<any>;
        navigate(payload: { workspaceId: string; tabId?: string; url: string }): Promise<any>;
        history(payload: { workspaceId: string; action: "back" | "forward" | "reload" | "stop" }): Promise<any>;
        setViewport(payload: { workspaceId: string; visible: boolean; bounds?: { x: number; y: number; width: number; height: number } }): Promise<any>;
        adopt(payload: { fromWorkspaceId: string; toWorkspaceId: string }): Promise<any>;
      };
      files: {
        read(payload: ProjectScope & { path: string }): Promise<any>;
        write(payload: ProjectScope & { path: string; content: string; expectedMtimeMs?: number }): Promise<any>;
      };
      projects: {
        list(): Promise<any[]>;
        open(): Promise<any | null>;
      };
      board: {
        list(payload: ProjectScope): Promise<{ data: Array<{ id: string; projectId: string; title: string; description: string; column: "backlog" | "ready" | "active" | "done"; position: number; threadId: string | null; createdByThreadId: string | null; createdAt: string; updatedAt: string }> }>;
        create(payload: ProjectScope & { title: string; description?: string; column?: "backlog" | "ready" | "active" | "done" }): Promise<any>;
        update(payload: ProjectScope & { taskId: string; title?: string; description?: string }): Promise<any>;
        move(payload: ProjectScope & { taskId: string; column: "backlog" | "ready" | "active" | "done"; beforeTaskId?: string }): Promise<any>;
        delete(payload: ProjectScope & { taskId: string }): Promise<any>;
        attach(payload: ProjectScope & { taskId: string; threadId: string }): Promise<any>;
      };
      threads: {
        list(payload: ProjectScope): Promise<{ data: any[]; nextCursor: string | null }>;
        read(payload: ThreadScope): Promise<{ thread: any }>;
        children(payload: ThreadScope): Promise<{ data: any[]; nextCursor: string | null }>;
        create(payload: ProjectScope & { model?: string; serviceTier?: string | null; permissionMode?: "read-only" | "workspace-write" | "auto-approve" | "full-access" }): Promise<{ thread: any }>;
        archive(payload: ThreadScope): Promise<unknown>;
      };
      turns: {
        start(payload: ThreadScope & { text: string; images?: string[]; model?: string; serviceTier?: string | null; effort?: string; permissionMode?: "read-only" | "workspace-write" | "auto-approve" | "full-access" }): Promise<{ turn: any }>;
        steer(payload: ThreadScope & { turnId: string; text: string; images?: string[] }): Promise<unknown>;
        interrupt(payload: ThreadScope & { turnId: string }): Promise<unknown>;
      };
      approvals: {
        resolve(payload: { requestId: string | number; decision: "accept" | "decline" | "acceptForSession" | "cancel" }): Promise<unknown>;
      };
      requests: {
        respond(payload: { requestId: string | number; answers: Record<string, { answers: string[] }> }): Promise<unknown>;
      };
      questions: {
        respond(payload: { requestId: string | number; action: "answer" | "cancel"; answers: Record<string, string> }): Promise<unknown>;
      };
      elicitations: {
        respond(payload: { requestId: string | number; action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }): Promise<unknown>;
      };
      review: { read(payload: ProjectScope): Promise<{ repository: any; diff: string }> };
      models: { list(): Promise<any[]> };
      extensions: { list(payload?: { projectId?: string; threadId?: string }): Promise<any> };
      external: {
        openEditor(payload: ProjectScope & { path?: string }): Promise<unknown>;
        openTerminal(payload: ProjectScope & { path?: string }): Promise<unknown>;
        reveal(payload: ProjectScope & { path?: string }): Promise<unknown>;
      };
      events: { subscribe(listener: (event: LoomEvent) => void): () => void };
    };
  }
}

import { z } from "zod";

export const PIXICE_IOS_NAMESPACE = "pixice_ios";

const normalizedCoordinate = z.number().min(0).max(1);
export const iosToolSchemas = {
  environment: z.object({}).strict(),
  discover: z.object({}).strict(),
  create_starter: z.object({
    name: z.string().trim().min(1).max(80),
    relativeDirectory: z.string().trim().min(1).max(1_000).optional()
  }).strict(),
  start: z.object({
    containerPath: z.string().trim().min(1).max(10_000),
    scheme: z.string().trim().min(1).max(500),
    simulatorUdid: z.string().trim().min(1).max(200),
    configuration: z.string().trim().min(1).max(200).default("Debug")
  }).strict(),
  status: z.object({}).strict(),
  stop: z.object({}).strict(),
  inspect: z.object({ maxElements: z.number().int().min(1).max(500).default(100) }).strict(),
  tap: z.object({
    elementId: z.string().trim().min(1).max(500).optional(),
    x: normalizedCoordinate.optional(),
    y: normalizedCoordinate.optional()
  }).strict().refine((value) => Boolean(value.elementId) !== (value.x !== undefined && value.y !== undefined), {
    message: "Pass either elementId or both normalized x and y coordinates"
  }),
  type: z.object({ text: z.string().max(10_000) }).strict(),
  swipe: z.object({
    startX: normalizedCoordinate,
    startY: normalizedCoordinate,
    endX: normalizedCoordinate,
    endY: normalizedCoordinate,
    durationMs: z.number().int().min(50).max(5_000).default(350)
  }).strict(),
  button: z.object({ name: z.enum(["home", "swipe_home", "app_switcher", "lock", "siri", "side_button"]) }).strict(),
  rotate: z.object({ orientation: z.enum(["portrait", "portrait_upside_down", "landscape_left", "landscape_right"]) }).strict(),
  appearance: z.object({ theme: z.enum(["light", "dark"]) }).strict(),
  screenshot: z.object({}).strict(),
  logs: z.object({ limit: z.number().int().min(1).max(1_000).default(200) }).strict()
};

function functionTool(name, description, properties = {}, required = []) {
  return {
    type: "function",
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false }
  };
}

export const iosDynamicTools = [{
  type: "namespace",
  name: PIXICE_IOS_NAMESPACE,
  description: "Build, run, inspect, and control the iOS Simulator session owned by the current Pixice thread.",
  tools: [
    functionTool("environment", "Inspect Xcode readiness and list available iOS Simulators."),
    functionTool("discover", "Discover supported Xcode containers and shared schemes in the current project."),
    functionTool("create_starter", "Create a runnable SwiftUI starter with previews, accessibility IDs, and a UI test target in the current project.", {
      name: { type: "string", description: "App and scheme name." },
      relativeDirectory: { type: "string", description: "Optional project-relative destination directory." }
    }, ["name"]),
    functionTool("start", "Build and launch a scheme on an explicit Simulator, then open its interactive Preview.", {
      containerPath: { type: "string", description: "Project-relative .xcodeproj or .xcworkspace path." },
      scheme: { type: "string" },
      simulatorUdid: { type: "string" },
      configuration: { type: "string", default: "Debug" }
    }, ["containerPath", "scheme", "simulatorUdid"]),
    functionTool("status", "Read lifecycle state, bounded diagnostics, and stream readiness for this thread's session."),
    functionTool("stop", "Stop and clean up only this thread's iOS session."),
    functionTool("inspect", "Return normalized accessibility elements and screenshot evidence for the current frame.", {
      maxElements: { type: "integer", minimum: 1, maximum: 500, default: 100 }
    }),
    functionTool("tap", "Tap a current accessibility element or normalized screen coordinates.", {
      elementId: { type: "string" },
      x: { type: "number", minimum: 0, maximum: 1 },
      y: { type: "number", minimum: 0, maximum: 1 }
    }),
    functionTool("type", "Type bounded text into the focused Simulator control.", {
      text: { type: "string", maxLength: 10_000 }
    }, ["text"]),
    functionTool("swipe", "Perform a normalized swipe gesture.", {
      startX: { type: "number", minimum: 0, maximum: 1 },
      startY: { type: "number", minimum: 0, maximum: 1 },
      endX: { type: "number", minimum: 0, maximum: 1 },
      endY: { type: "number", minimum: 0, maximum: 1 },
      durationMs: { type: "integer", minimum: 50, maximum: 5_000, default: 350 }
    }, ["startX", "startY", "endX", "endY"]),
    functionTool("button", "Press a bounded Simulator hardware button.", {
      name: { type: "string", enum: ["home", "swipe_home", "app_switcher", "lock", "siri", "side_button"] }
    }, ["name"]),
    functionTool("rotate", "Rotate the Simulator to an explicit orientation.", {
      orientation: { type: "string", enum: ["portrait", "portrait_upside_down", "landscape_left", "landscape_right"] }
    }, ["orientation"]),
    functionTool("appearance", "Set the Simulator to light or dark appearance.", {
      theme: { type: "string", enum: ["light", "dark"] }
    }, ["theme"]),
    functionTool("screenshot", "Capture the current Simulator frame."),
    functionTool("logs", "Return a bounded application and Simulator log tail.", {
      limit: { type: "integer", minimum: 1, maximum: 1_000, default: 200 }
    })
  ]
}];

export const PIXICE_IOS_MCP_TOOLS = new Set(
  Object.keys(iosToolSchemas).map((name) => `mcp__${PIXICE_IOS_NAMESPACE}__${name}`)
);

function textResult(value, success = true) {
  return {
    success,
    contentItems: [{
      type: "inputText",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
    }]
  };
}

export class IosTools {
  constructor({ service, threadContext, onOpen = null }) {
    this.service = service;
    this.threadContext = threadContext;
    this.onOpen = onOpen;
  }

  async handleToolCall(params) {
    const workspaceId = params.threadId;
    if (!workspaceId) return textResult("Pixice iOS tools require a thread-scoped call.", false);
    const context = this.threadContext(workspaceId);
    if (!context?.projectId || !context?.roots?.length) return textResult("The calling thread is not attached to a Pixice project.", false);
    const schema = iosToolSchemas[params.tool];
    if (!schema) return textResult(`Unknown Pixice iOS tool: ${params.tool}`, false);

    try {
      const args = schema.parse(params.arguments ?? {});
      if (params.tool === "environment") return textResult(await this.service.environment());
      if (params.tool === "discover") return textResult(await this.service.discover(context));
      if (params.tool === "create_starter") return textResult(await this.service.createStarter(context, args));
      if (params.tool === "start") {
        const session = await this.service.start({ workspaceId, ...context, ...args, source: params.source ?? "agent" });
        this.onOpen?.({ workspaceId, projectId: context.projectId, session, source: params.source ?? "agent" });
        return textResult(session);
      }
      if (params.tool === "status") return textResult(await this.service.status(workspaceId));
      if (params.tool === "stop") return textResult(await this.service.stop(workspaceId, "Stopped by the controlling agent"));
      if (params.tool === "screenshot") {
        const result = await this.service.action(workspaceId, "screenshot", args);
        if (!result?.dataUrl) return textResult(result);
        return {
          success: true,
          contentItems: [
            { type: "inputText", text: JSON.stringify(result.evidence ?? { captured: true }) },
            { type: "inputImage", imageUrl: result.dataUrl }
          ]
        };
      }
      if (params.tool === "inspect") {
        const result = await this.service.action(workspaceId, "inspect", args);
        const imageUrl = result?.screenshot?.dataUrl;
        if (!imageUrl) return textResult(result);
        const safeResult = {
          ...result,
          screenshot: { ...result.screenshot, dataUrl: undefined }
        };
        return {
          success: true,
          contentItems: [
            { type: "inputText", text: JSON.stringify(safeResult, null, 2) },
            { type: "inputImage", imageUrl }
          ]
        };
      }
      return textResult(await this.service.action(workspaceId, params.tool, args));
    } catch (error) {
      return textResult(error.message, false);
    }
  }
}

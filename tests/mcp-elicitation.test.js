import { describe, expect, it } from "vitest";
import { describeMcpElicitationApproval, mcpElicitationApprovalResponse } from "../electron/runtime/mcp-elicitation.mjs";

const request = {
  mode: "form", serverName: "computer-use", message: "Allow ChatGPT to use Safari?",
  threadId: "worker", turnId: "turn", _meta: { app_name: "Safari", persist: ["session", "always"] },
  requestedSchema: { type: "object", required: ["approval"], properties: { approval: { type: "string", oneOf: [
    { const: "once", title: "Allow once" }, { const: "session", title: "Allow for this session" }, { const: "always", title: "Always allow Safari" }
  ] } } }
};
const choices = payload => describeMcpElicitationApproval(payload)?.options.map(option => option.decision);

describe("native MCP per-app approval choices", () => {
  it("describes the app and preserves provider labels", () => {
    expect(describeMcpElicitationApproval(request)).toEqual({ appName: "Safari", options: [
      { decision: "accept", label: "Allow once" }, { decision: "acceptForSession", label: "Allow for this session" },
      { decision: "acceptAlways", label: "Always allow Safari" }, { decision: "decline", label: "Decline" }, { decision: "cancel", label: "Cancel" }
    ] });
  });

  it.each([
    ["accept", { action: "accept", content: { approval: "once" } }],
    ["acceptForSession", { action: "accept", _meta: { persist: "session" }, content: { approval: "session" } }],
    ["acceptAlways", { action: "accept", _meta: { persist: "always" }, content: { approval: "always" } }],
    ["decline", { action: "decline" }], ["cancel", { action: "cancel" }]
  ])("serializes %s with its exact native scope", (decision, response) => {
    expect(mcpElicitationApprovalResponse(request, decision)).toEqual(response);
  });

  it("preserves enum values, nullable metadata and alternate provider form modes", () => {
    const payload = { ...request, mode: "openai/form", _meta: { app_name: null, appName: "Safari", persist: null, target: null, tool_params: null }, requestedSchema: {
      type: "object", required: ["permission"], properties: { permission: { type: "string", enum: ["ALLOW_ONCE", "PERMANENT"], enumNames: ["Allow once", "Always allow Safari"], title: null, default: null } }
    } };
    expect(choices(payload)).toEqual(["accept", "acceptAlways", "decline", "cancel"]);
    expect(mcpElicitationApprovalResponse(payload, "acceptAlways")).toEqual({ action: "accept", _meta: { persist: "always" }, content: { permission: "PERMANENT" } });
    expect(() => mcpElicitationApprovalResponse(payload, "acceptForSession")).toThrow("does not offer");
  });

  it("extracts the app label without metadata and offers enum-advertised persistence", () => {
    const { _meta, ...payload } = request;
    expect(describeMcpElicitationApproval(payload).appName).toBe("Safari");
    expect(choices(payload)).toContain("acceptAlways");
  });

  it("supports boolean permanent approval while Allow once sends false", () => {
    const payload = { ...request, _meta: { app_name: "Safari" }, requestedSchema: { type: "object", required: ["always"], properties: { always: { type: "boolean", title: "Always allow Safari", default: true } } } };
    expect(mcpElicitationApprovalResponse(payload, "acceptAlways")).toEqual({ action: "accept", _meta: { persist: "always" }, content: { always: true } });
    expect(mcpElicitationApprovalResponse(payload, "accept")).toEqual({ action: "accept", content: { always: false } });
    expect(choices(payload)).not.toContain("acceptForSession");
  });

  it("keeps boolean session approval distinct from a permanent grant", () => {
    const payload = { ...request, _meta: {}, requestedSchema: { type: "object", properties: { allowForSession: { type: "boolean" }, allow: { type: "boolean" } } } };
    expect(choices(payload)).toEqual(["accept", "acceptForSession", "decline", "cancel"]);
    expect(mcpElicitationApprovalResponse(payload, "acceptForSession")).toEqual({ action: "accept", _meta: { persist: "session" }, content: { allowForSession: true, allow: true } });
    expect(() => mcpElicitationApprovalResponse(payload, "acceptAlways")).toThrow("does not offer");
  });

  it("supports persistence advertised only by native metadata", () => {
    const payload = { ...request, requestedSchema: { type: "object", properties: {} } };
    expect(mcpElicitationApprovalResponse(payload, "acceptAlways")).toEqual({ action: "accept", _meta: { persist: "always" }, content: {} });
    const noSchema = { mode: "openaiForm", serverName: "computer-use", _meta: { allowPersistentApproval: true, target: { name: "Safari" } } };
    expect(describeMcpElicitationApproval(noSchema).appName).toBe("Safari");
    expect(mcpElicitationApprovalResponse(noSchema, "acceptAlways")).toEqual({ action: "accept", _meta: { persist: "always" } });
  });

  it("does not invent persistent choices when the required form only allows once", () => {
    const payload = { ...request, requestedSchema: { type: "object", required: ["approval"], properties: { approval: { type: "string", enum: ["once"] } } } };
    expect(choices(payload)).toEqual(["accept", "decline", "cancel"]);
    expect(() => mcpElicitationApprovalResponse(payload, "acceptAlways")).toThrow("cannot satisfy");
    expect(() => mcpElicitationApprovalResponse(payload, "acceptForSession")).toThrow("cannot satisfy");
  });

  it("does not turn Allow once into a persistent default", () => {
    const payload = { ...request, requestedSchema: { type: "object", properties: { approval: { type: "string", enum: ["always"], default: "always" } } } };
    expect(choices(payload)).toEqual(["acceptAlways", "decline", "cancel"]);
    expect(() => mcpElicitationApprovalResponse(payload, "accept")).toThrow("cannot satisfy");
  });

  it("honors an explicit provider prohibition on saved approval", () => {
    const payload = { ...request, _meta: { ...request._meta, allowPersistentApproval: false } };
    expect(choices(payload)).not.toContain("acceptAlways");
    expect(() => mcpElicitationApprovalResponse(payload, "acceptAlways")).toThrow("does not offer");
  });

  it("honors boolean field constraints instead of advertising an invalid permanent grant", () => {
    const payload = { ...request, _meta: {}, requestedSchema: { type: "object", required: ["always"], properties: { always: { type: "boolean", enum: [false] } } } };
    expect(choices(payload)).toEqual(["accept", "decline", "cancel"]);
    expect(() => mcpElicitationApprovalResponse(payload, "acceptAlways")).toThrow("cannot satisfy");
  });

  it("omits enum choices that contradict the remaining field constraints", () => {
    const payload = { ...request, requestedSchema: { type: "object", required: ["approval"], properties: { approval: { type: "string", enum: ["once", "always"], const: "once" } } } };
    expect(choices(payload)).toEqual(["accept", "decline", "cancel"]);
    expect(() => mcpElicitationApprovalResponse(payload, "acceptAlways")).toThrow("cannot satisfy");
  });

  it("preserves literal provider fields without altering the source request", () => {
    const payload = { ...request, requestedSchema: { ...request.requestedSchema, required: ["approval", "requestType"], properties: { ...request.requestedSchema.properties, requestType: { type: "string", const: "app_permission" } } } };
    const before = JSON.stringify(payload);
    expect(mcpElicitationApprovalResponse(payload, "acceptAlways").content).toEqual({ approval: "always", requestType: "app_permission" });
    expect(JSON.stringify(payload)).toBe(before);
  });
});

describe("ordinary MCP forms and malformed requests", () => {
  it.each([true, false])("keeps %s required generic input interactive", required => {
    const payload = { ...request, requestedSchema: { type: "object", required: required ? ["approval", "email"] : ["approval"], properties: { ...request.requestedSchema.properties, email: { type: "string", format: "email" } } } };
    expect(describeMcpElicitationApproval(payload)).toBeNull();
    expect(() => mcpElicitationApprovalResponse(payload, "acceptAlways")).toThrow("ordinary input form");
  });

  it.each(["string", "number", "boolean", "array"])("keeps optional %s data editable even when it has a default", type => {
    const defaults = { string: "example", number: 3, boolean: true, array: [] };
    const payload = { ...request, requestedSchema: { type: "object", properties: { ...request.requestedSchema.properties, userData: { type, default: defaults[type] } } } };
    expect(describeMcpElicitationApproval(payload)).toBeNull();
  });

  it("does not interpret arbitrary enum substrings or field descriptions as permission grants", () => {
    const payload = { mode: "form", serverName: "forms", requestedSchema: { type: "object", properties: { schedule: { type: "string", enum: ["always", "session"] }, notes: { type: "string", description: "always allow" } } } };
    expect(describeMcpElicitationApproval(payload)).toBeNull();
    const substring = { ...request, _meta: { persist: ["save_everything_always", "session_backup"] }, requestedSchema: { type: "object", properties: { approval: { type: "string", enum: ["almost_always", "session_backup"] } } } };
    expect(describeMcpElicitationApproval(substring)).toBeNull();
  });

  it("does not bypass URL authentication", () => {
    const payload = { ...request, mode: "url", url: "https://example.test/sign-in" };
    expect(describeMcpElicitationApproval(payload)).toBeNull();
    expect(() => mcpElicitationApprovalResponse(payload, "accept")).toThrow("ordinary input form");
    expect(mcpElicitationApprovalResponse(payload, "decline")).toEqual({ action: "decline" });
    expect(mcpElicitationApprovalResponse(payload, "cancel")).toEqual({ action: "cancel" });
  });

  it.each([
    null, [], { ...request, mode: "unsupported" }, { ...request, requestedSchema: [] },
    { ...request, requestedSchema: { type: "array" } }, { ...request, requestedSchema: { properties: [] } },
    { ...request, requestedSchema: { required: "approval" } }, { ...request, requestedSchema: { required: ["missing"], properties: {} } },
    { ...request, requestedSchema: { properties: { approval: null } } },
    { ...request, requestedSchema: { properties: { approval: { type: "string", enum: ["once", 1] } } } },
    { ...request, requestedSchema: { properties: { approval: { type: "string", oneOf: [{ const: null }] } } } },
    { ...request, requestedSchema: { properties: { approval: { type: "string", enum: ["once"], enumNames: "invalid" } } } },
    { ...request, requestedSchema: { properties: { approval: { type: "string", enum: ["once"] }, data: { type: "string", const: true } } } }
  ])("leaves malformed shape %# out of the shortcut UI", payload => {
    expect(describeMcpElicitationApproval(payload)).toBeNull();
    expect(() => mcpElicitationApprovalResponse(payload, "accept")).toThrow();
  });

  it("ignores malformed metadata without manufacturing persistence", () => {
    const payload = { ...request, _meta: { app_name: [], appName: "Safari", persist: [true, "always_in_every_project"], allowPersistentApproval: "true" }, requestedSchema: { type: "object", required: ["approval"], properties: { approval: { type: "string", enum: ["once"] } } } };
    expect(choices(payload)).toEqual(["accept", "decline", "cancel"]);
    expect(describeMcpElicitationApproval(payload).appName).toBe("Safari");
  });

  it("rejects unsupported decisions instead of forwarding arbitrary metadata", () => {
    expect(() => mcpElicitationApprovalResponse(request, "allow_everything")).toThrow("Unsupported");
    expect(() => mcpElicitationApprovalResponse(request, { action: "accept" })).toThrow("Unsupported");
  });
});

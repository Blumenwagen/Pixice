import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkflowCredentialStore,
  applyWorkflowCredential,
  workflowCredentialAuthorizesRequest
} from "../electron/workflows/workflow-credential-store.mjs";

const directories = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
  decryptString: (buffer) => buffer.toString("utf8").replace(/^encrypted:/, "")
};

describe("workflow credentials", () => {
  it("stores project-scoped secrets encrypted and returns only safe metadata", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-credentials-"));
    directories.push(directory);
    const store = new WorkflowCredentialStore(directory, { crypto });
    const created = store.create({
      projectId: "project-1",
      name: "GitHub",
      type: "bearer",
      values: { token: "super-secret-token" }
    });

    expect(created).toMatchObject({ projectId: "project-1", name: "GitHub", type: "bearer", hasSecret: true });
    expect(store.list("project-1")[0]).not.toHaveProperty("values");
    expect(store.list("project-2")).toEqual([]);
    expect(store.resolve("project-1", created.id).values).toEqual({ token: "super-secret-token" });
    const file = readFileSync(path.join(directory, "pixice-workflow-credentials.json"), "utf8");
    expect(file).not.toContain("super-secret-token");

    const renamed = store.update({ projectId: "project-1", credentialId: created.id, name: "GitHub prod" });
    expect(renamed.name).toBe("GitHub prod");
    expect(store.delete("project-1", created.id)?.id).toBe(created.id);
    expect(store.list("project-1")).toEqual([]);
  });

  it("applies and verifies bearer, basic, API-key, and custom-header credentials", () => {
    const bearerUrl = new URL("https://example.test/items");
    const bearerHeaders = new Headers();
    const bearer = { type: "bearer", values: { token: "token" } };
    applyWorkflowCredential(bearer, { url: bearerUrl, headers: bearerHeaders });
    expect(bearerHeaders.get("authorization")).toBe("Bearer token");
    expect(workflowCredentialAuthorizesRequest(bearer, { url: bearerUrl, headers: bearerHeaders })).toBe(true);

    const basic = { type: "basic", values: { username: "pixice", password: "secret" } };
    const basicHeaders = new Headers();
    applyWorkflowCredential(basic, { url: bearerUrl, headers: basicHeaders });
    expect(workflowCredentialAuthorizesRequest(basic, { url: bearerUrl, headers: basicHeaders })).toBe(true);

    const apiKey = { type: "apiKey", values: { name: "key", value: "abc", in: "query" } };
    const keyedUrl = new URL("https://example.test");
    applyWorkflowCredential(apiKey, { url: keyedUrl, headers: new Headers() });
    expect(keyedUrl.searchParams.get("key")).toBe("abc");
    expect(workflowCredentialAuthorizesRequest(apiKey, { url: keyedUrl, headers: {} })).toBe(true);

    const custom = { type: "headers", values: { headers: { "x-hook": "correct" } } };
    expect(workflowCredentialAuthorizesRequest(custom, { url: keyedUrl, headers: { "x-hook": "wrong" } })).toBe(false);
  });
});

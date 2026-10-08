import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HtmlReplies, MAX_HTML_SOURCE_BYTES } from "../electron/runtime/html-replies.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "pixice-html-")); directories.push(directory);
  const root = path.join(directory, "project"); await mkdir(root);
  return { directory, root, service: new HtmlReplies({ storagePath: path.join(directory, "replies") }), context: { projectId: "project-1", threadId: "thread-1", primaryRoot: root, roots: [root] } };
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const readOptions = (context, id) => ({ projectId: context.projectId, threadId: context.threadId, id });

describe("thread HTML reply attachments", () => {
  it("persists and deduplicates concurrent publishes, keeping embedded images after their source is deleted", async () => {
    const { directory, root, service, context } = await fixture();
    await writeFile(path.join(root, "chart.png"), PNG);
    const input = { ...context, title: "Comparison", html: '<h2>Comparison</h2><img src="chart.png"><script>document.body.dataset.ready="yes"</script>' };
    const [first, second] = await Promise.all([service.publish(input), service.publish(input)]);
    expect(second).toEqual(first);
    await rm(path.join(root, "chart.png"));
    const restarted = new HtmlReplies({ storagePath: path.join(directory, "replies") });
    const reply = await restarted.read({ projectId: context.projectId, threadId: context.threadId, id: first.id });
    expect(reply.html).toContain(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(reply.html).toContain('<script>document.body.dataset.ready="yes"</script>');
    expect(await restarted.list(context)).toEqual([first]);
  });
  it("rejects source and image paths outside permitted roots, including symlink escapes and fake raster images", async () => {
    const { directory, root, service, context } = await fixture();
    const external = path.join(directory, "secret.png"); await writeFile(external, PNG);
    await symlink(external, path.join(root, "escape.png"));
    await expect(service.publish({ ...context, title: "Escape", html: '<img src="escape.png">' })).rejects.toThrow("project roots");
    await writeFile(path.join(directory, "outside.html"), "<p>Outside</p>");
    await expect(service.publish({ ...context, title: "Escape", path: "../outside.html" })).rejects.toThrow("project roots");
    await writeFile(path.join(root, "secret.png"), "credentials should not become an image");
    await expect(service.publish({ ...context, title: "Invalid", html: '<img src="secret.png">' })).rejects.toThrow("raster image");
    expect(await service.list(context)).toEqual([]);
  });
  it("resolves image paths relative to an HTML file, embeds CSS images, and never fetches remote resources", async () => {
    const { root, service, context } = await fixture();
    await mkdir(path.join(root, "reports"));
    await writeFile(path.join(root, "reports", "chart.png"), PNG);
    await writeFile(path.join(root, "reports", "reply.html"), '<style>.plot{background:url("chart.png")}</style><img src="https://example.com/remote.png">');
    const ref = await service.publish({ ...context, title: "Plot", path: "reports/reply.html" });
    const reply = await service.read(readOptions(context, ref.id));
    expect(reply.html).toContain("background:url(\"data:image/png;base64,");
    expect(reply.html).toContain('src="https://example.com/remote.png"');
  });
  it("enforces thread/project ownership, validates identifiers, and removes attachments with the thread", async () => {
    const { service, context } = await fixture();
    const ref = await service.publish({ ...context, title: "Page", html: "<p>Local</p>" });
    await expect(service.read({ ...readOptions(context, ref.id), projectId: "other-project" })).rejects.toThrow("selected project and thread");
    await expect(service.read({ ...readOptions(context, ref.id), threadId: "other-thread" })).rejects.toMatchObject({ code: "ENOENT" });
    await expect(service.read(readOptions(context, "../escape"))).rejects.toThrow();
    await service.deleteThread(context.threadId);
    expect(await service.list(context)).toEqual([]);
  });
  it("detects attachment corruption rather than rendering substituted source", async () => {
    const { directory, service, context } = await fixture();
    const ref = await service.publish({ ...context, title: "Page", html: "<p>Original</p>" });
    const [threadDirectory] = await readdir(path.join(directory, "replies"));
    const file = path.join(directory, "replies", threadDirectory, `${ref.id}.json`);
    const document = JSON.parse(await readFile(file, "utf8")); document.html = "<p>Substituted</p>"; await writeFile(file, JSON.stringify(document));
    await expect(service.read(readOptions(context, ref.id))).rejects.toThrow("damaged");
  });
  it("rejects oversized or ambiguous input and produces a reusable final-answer reference", async () => {
    const { service, context } = await fixture();
    await expect(service.publish({ ...context, title: "Large", html: "x".repeat(MAX_HTML_SOURCE_BYTES + 1) })).rejects.toThrow();
    await expect(service.publish({ ...context, title: "Ambiguous", html: "<p>One</p>", path: "other.html" })).rejects.toThrow("exactly one");
    const result = await service.invokeTool({ ...context, tool: "publish", arguments: { title: "Page", html: "<button>Try it</button>" } });
    const published = JSON.parse(result.contentItems[0].text);
    expect(published.replyMarkdown).toMatch(/^```pixice-html\n\{/);
    expect(JSON.parse(published.replyMarkdown.split("\n")[1]).id).toBe(published.id);
  });
  it("copies durable pages into a fork's own attachment scope, so deletion of the original cannot break the fork", async () => {
    const { service, context } = await fixture();
    const original = await service.publish({ ...context, title: "Page", html: "<button>Persistent page</button>" });
    const copied = await service.copyThread({ projectId: context.projectId, sourceThreadId: context.threadId, threadId: "fork-thread" });
    expect(copied).toEqual([expect.objectContaining({ id: original.id, threadId: "fork-thread", copiedFromThreadIds: [context.threadId], reference: `pixice-html://fork-thread/${original.id}` })]);
    const [secondFork] = await service.copyThread({ projectId: context.projectId, sourceThreadId: "fork-thread", threadId: "nested-fork-thread" });
    expect(secondFork.copiedFromThreadIds).toEqual(["fork-thread", context.threadId]);
    await service.deleteThread(context.threadId);
    expect((await service.read({ projectId: context.projectId, threadId: "fork-thread", id: original.id })).html).toContain("Persistent page");
    expect((await service.list({ projectId: context.projectId, threadId: "nested-fork-thread" }))[0].copiedFromThreadIds).toEqual(["fork-thread", context.threadId]);
    await expect(service.copyThread({ projectId: "other-project", sourceThreadId: "fork-thread", threadId: "escaped-thread" })).rejects.toThrow("selected project and thread");
  });
});

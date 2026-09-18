import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSCRIPTION_MODELS } from "../electron/transcription/catalog.mjs";
import { TranscriptionModelLibrary } from "../electron/transcription/model-library.mjs";

const MODEL = TRANSCRIPTION_MODELS[0];
let directory;

// A stand-in archive. `install` verifies bytes and digest before extracting,
// so the payload only has to hash and measure the way the catalog claims.
function archiveBody(bytes) {
  return Buffer.alloc(bytes, 7);
}

function respondWith(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    body: Readable.toWeb(Readable.from([body]))
  };
}

function libraryFor({ fetchImpl, extract }) {
  return new TranscriptionModelLibrary({ directory, fetchImpl, extract });
}

// The catalog entry is frozen and describes a 487 MB archive. Tests point it
// at a small fixture instead so they verify the same code path without
// allocating half a gigabyte per case.
async function stubArchive(body) {
  const { archive } = (await import("../electron/transcription/catalog.mjs")).TRANSCRIPTION_MODELS[0];
  const original = { sha256: archive.sha256, bytes: archive.bytes };
  const override = (key, value) => Object.defineProperty(archive, key, { value, configurable: true, writable: true });
  override("sha256", createHash("sha256").update(body).digest("hex"));
  override("bytes", body.length);
  return () => { override("sha256", original.sha256); override("bytes", original.bytes); };
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "pixice-models-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("transcription model library", () => {
  it("reports nothing installed on a clean profile", async () => {
    const library = libraryFor({ fetchImpl: vi.fn() });
    expect(await library.list()).toEqual([]);
    expect(await library.read(MODEL.id)).toBeNull();
  });

  it("verifies the digest, extracts, and records a manifest", async () => {
    const body = archiveBody(4096);
    const restore = await stubArchive(body);
    try {
      const extract = vi.fn(async (_archivePath, destination) => {
        await mkdir(destination, { recursive: true });
        for (const name of ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]) {
          await writeFile(path.join(destination, name), "x");
        }
      });
      const library = libraryFor({ fetchImpl: vi.fn(async () => respondWith(body)), extract });

      const phases = [];
      const result = await library.install(MODEL.id, { onProgress: (progress) => phases.push(progress.phase) });

      expect(extract).toHaveBeenCalledOnce();
      expect(result.files).toMatchObject({ encoder: "encoder.int8.onnx", joiner: "joiner.int8.onnx", tokens: "tokens.txt" });
      expect(phases).toContain("downloading");
      expect(phases).toContain("extracting");

      const stored = await library.read(MODEL.id);
      expect(stored.files).toEqual(result.files);
      expect(stored.installedAt).toBeTruthy();
      expect((await library.list()).map((entry) => entry.id)).toEqual([MODEL.id]);
    } finally {
      restore();
    }
  });

  it("discards an archive whose digest does not match and leaves nothing installed", async () => {
    const body = archiveBody(4096);
    const extract = vi.fn();
    const library = libraryFor({ fetchImpl: vi.fn(async () => respondWith(body)), extract });

    await expect(library.install(MODEL.id)).rejects.toThrow(/checksum/);
    expect(extract).not.toHaveBeenCalled();
    expect(await library.read(MODEL.id)).toBeNull();
    await expect(stat(path.join(directory, ".downloads", `${MODEL.id}.part`))).rejects.toThrow();
  });

  it("rejects an archive that is the wrong length", async () => {
    // The catalog promises `body`, but the server truncates the response. The
    // digest is stubbed to the truncated payload so the size check, not the
    // checksum check, is what rejects it.
    const body = archiveBody(4096);
    const truncated = body.subarray(0, body.length - 1);
    const restore = await stubArchive(truncated);
    Object.defineProperty(MODEL.archive, "bytes", { value: body.length, configurable: true, writable: true });
    try {
      const library = libraryFor({ fetchImpl: vi.fn(async () => respondWith(truncated)), extract: vi.fn() });
      await expect(library.install(MODEL.id)).rejects.toThrow(/4095 bytes but 4096 were expected/);
      expect(await library.read(MODEL.id)).toBeNull();
    } finally {
      restore();
    }
  });

  it("surfaces an HTTP failure as a readable error", async () => {
    const library = libraryFor({ fetchImpl: vi.fn(async () => respondWith(Buffer.alloc(0), { status: 404 })), extract: vi.fn() });
    await expect(library.install(MODEL.id)).rejects.toThrow(/HTTP 404/);
  });

  it("joins a second caller to the download already in flight", async () => {
    const body = archiveBody(4096);
    const restore = await stubArchive(body);
    try {
      const fetchImpl = vi.fn(async () => respondWith(body));
      const extract = vi.fn(async (_archive, destination) => {
        await mkdir(destination, { recursive: true });
        for (const name of ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"]) {
          await writeFile(path.join(destination, name), "x");
        }
      });
      const library = libraryFor({ fetchImpl, extract });

      const [first, second] = await Promise.all([library.install(MODEL.id), library.install(MODEL.id)]);

      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(first.id).toBe(second.id);
    } finally {
      restore();
    }
  });

  it("resumes a partial download with a Range request instead of starting over", async () => {
    const body = archiveBody(4096);
    const restore = await stubArchive(body);
    try {
      const alreadyHave = 1000;
      await mkdir(path.join(directory, ".downloads"), { recursive: true });
      await writeFile(path.join(directory, ".downloads", `${MODEL.id}.part`), body.subarray(0, alreadyHave));

      const seen = [];
      const fetchImpl = vi.fn(async (_url, options) => {
        seen.push(options.headers.range);
        return respondWith(body.subarray(alreadyHave), { status: 206 });
      });
      const extract = vi.fn(async (_archive, destination) => {
        await mkdir(destination, { recursive: true });
        for (const name of ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"]) {
          await writeFile(path.join(destination, name), "x");
        }
      });

      const library = libraryFor({ fetchImpl, extract });
      const result = await library.install(MODEL.id);

      expect(seen).toEqual([`bytes=${alreadyHave}-`]);
      // The digest still covers the whole file, including the resumed prefix.
      expect(result.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    } finally {
      restore();
    }
  });

  it("removes an installed model and its directory", async () => {
    const modelDirectory = path.join(directory, MODEL.id);
    await mkdir(modelDirectory, { recursive: true });
    await writeFile(path.join(modelDirectory, ".pixice-model.json"), JSON.stringify({ files: { tokens: "tokens.txt" }, bytes: 4 }));

    const library = libraryFor({ fetchImpl: vi.fn() });
    expect(await library.read(MODEL.id)).not.toBeNull();

    await library.remove(MODEL.id);

    expect(await library.read(MODEL.id)).toBeNull();
    await expect(stat(modelDirectory)).rejects.toThrow();
  });

  it("refuses to install or remove a model that is not in the catalog", async () => {
    const library = libraryFor({ fetchImpl: vi.fn() });
    await expect(library.install("not-a-model")).rejects.toThrow(/Unknown transcription model/);
    await expect(library.remove("not-a-model")).rejects.toThrow(/Unknown transcription model/);
  });

  it("reports disk usage across installed models", async () => {
    const modelDirectory = path.join(directory, MODEL.id);
    await mkdir(modelDirectory, { recursive: true });
    await writeFile(path.join(modelDirectory, "weights.onnx"), Buffer.alloc(2048));

    const library = libraryFor({ fetchImpl: vi.fn() });
    expect(await library.diskUsage()).toBeGreaterThanOrEqual(2048);
  });

  it("ignores a model directory with no manifest", async () => {
    await mkdir(path.join(directory, MODEL.id), { recursive: true });
    await writeFile(path.join(directory, MODEL.id, "stray.onnx"), "x");

    const library = libraryFor({ fetchImpl: vi.fn() });
    expect(await library.read(MODEL.id)).toBeNull();
    expect(await library.list()).toEqual([]);
  });

  it("throttles byte progress but never drops a phase change", async () => {
    // Many small chunks, the way a real response body arrives.
    const body = archiveBody(4096);
    const restore = await stubArchive(body);
    try {
      const chunks = [];
      for (let offset = 0; offset < body.length; offset += 16) chunks.push(body.subarray(offset, offset + 16));

      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: Readable.toWeb(Readable.from(chunks))
      }));
      const extract = vi.fn(async (_archive, destination) => {
        await mkdir(destination, { recursive: true });
        for (const name of ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"]) {
          await writeFile(path.join(destination, name), "x");
        }
      });

      const seen = [];
      const library = libraryFor({ fetchImpl, extract });
      await library.install(MODEL.id, { onProgress: (progress) => seen.push(progress.phase) });

      // 256 chunks arrive, but the listener is not called 256 times.
      expect(chunks.length).toBe(256);
      expect(seen.length).toBeLessThan(chunks.length);
      // Every phase transition still reaches the listener.
      expect(seen).toContain("downloading");
      expect(seen).toContain("extracting");
      expect(seen.at(-1)).toBe("installed");
    } finally {
      restore();
    }
  });

  it("reports the cancelled phase even though byte updates are throttled", async () => {
    const body = archiveBody(4096);
    const restore = await stubArchive(body);
    try {
      const library = libraryFor({
        fetchImpl: vi.fn(async (_url, options) => {
          // Abort mid-flight, the way the capsule's Cancel action does.
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(body.subarray(0, 16));
              options.signal.addEventListener("abort", () => controller.error(options.signal.reason));
            }
          });
          return { ok: true, status: 200, headers: new Headers(), body: stream };
        }),
        extract: vi.fn()
      });

      const seen = [];
      const pending = library.install(MODEL.id, { onProgress: (progress) => seen.push(progress.phase) });
      await vi.waitFor(() => expect(seen).toContain("downloading"));
      expect(library.cancel(MODEL.id)).toBe(true);

      await expect(pending).rejects.toThrow();
      expect(seen.at(-1)).toBe("cancelled");
      expect(await library.read(MODEL.id)).toBeNull();
    } finally {
      restore();
    }
  });

  it("reports a cancel for a download that is not running", () => {
    const library = libraryFor({ fetchImpl: vi.fn() });
    expect(library.cancel(MODEL.id)).toBe(false);
    expect(library.installState(MODEL.id)).toBeNull();
  });

  it("fails the install when the archive is missing a required file", async () => {
    const body = archiveBody(4096);
    const restore = await stubArchive(body);
    try {
      const extract = vi.fn(async (_archive, destination) => {
        await mkdir(destination, { recursive: true });
        await writeFile(path.join(destination, "tokens.txt"), "x");
      });
      const library = libraryFor({ fetchImpl: vi.fn(async () => respondWith(body)), extract });

      await expect(library.install(MODEL.id)).rejects.toThrow(/encoder/);
      expect(await library.read(MODEL.id)).toBeNull();
    } finally {
      restore();
    }
  });
});

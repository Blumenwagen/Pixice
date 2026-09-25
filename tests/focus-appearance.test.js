import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readCustomFocusBackground,
  removeCustomFocusBackground,
  saveCustomFocusBackground,
  validateCustomFocusBackground
} from "../src/focus-appearance.js";

function imageDatabase() {
  const values = new Map();
  const database = {
    createObjectStore: vi.fn(),
    close: vi.fn(),
    transaction: () => {
      const transaction = {
        objectStore: () => Object.fromEntries(["get", "put", "delete"].map((method) => [method, (...args) => {
          const request = {};
          queueMicrotask(() => {
            if (method === "get") request.result = values.get(args[0]);
            if (method === "put") values.set(args[1], args[0]);
            if (method === "delete") values.delete(args[0]);
            request.onsuccess?.();
            transaction.oncomplete?.();
          });
          return request;
        }]))
      };
      return transaction;
    }
  };
  vi.stubGlobal("indexedDB", {
    open: () => {
      const request = { result: database };
      queueMicrotask(() => { request.onupgradeneeded?.(); request.onsuccess?.(); });
      return request;
    }
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("custom Focus background", () => {
  it("stores, reads, and removes an image without putting it in localStorage", async () => {
    imageDatabase();
    const image = new File(["image"], "background.png", { type: "image/png" });
    await saveCustomFocusBackground(image);
    expect(await readCustomFocusBackground()).toBe(image);
    await removeCustomFocusBackground();
    expect(await readCustomFocusBackground()).toBeUndefined();
  });

  it("rejects unsupported or oversized files", async () => {
    await expect(validateCustomFocusBackground(new File(["x"], "image.svg", { type: "image/svg+xml" }))).rejects.toThrow("PNG, JPEG, WebP, or AVIF");
    await expect(validateCustomFocusBackground({ type: "image/png", size: 13 * 1024 * 1024 })).rejects.toThrow("smaller than 12 MB");
  });
});

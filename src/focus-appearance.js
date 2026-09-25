import { useCallback, useEffect, useState } from "react";

const DATABASE_NAME = "pixice-appearance";
const STORE_NAME = "images";
const CUSTOM_BACKGROUND_KEY = "focus-background";
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/avif"]);

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error("Custom backgrounds are unavailable in this browser."));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open image storage."));
    request.onblocked = () => reject(new Error("Image storage is busy. Close other Pixice windows and try again."));
  });
}

async function imageOperation(mode, operation) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let result;
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("Could not save the background image.")); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("Image storage was interrupted.")); };
  });
}

export function readCustomFocusBackground() {
  return imageOperation("readonly", (store) => store.get(CUSTOM_BACKGROUND_KEY));
}

export function saveCustomFocusBackground(file) {
  return imageOperation("readwrite", (store) => store.put(file, CUSTOM_BACKGROUND_KEY));
}

export function removeCustomFocusBackground() {
  return imageOperation("readwrite", (store) => store.delete(CUSTOM_BACKGROUND_KEY));
}

export async function validateCustomFocusBackground(file) {
  if (!file || !IMAGE_TYPES.has(file.type)) throw new Error("Choose a PNG, JPEG, WebP, or AVIF image.");
  if (!file.size || file.size > MAX_IMAGE_BYTES) throw new Error("Choose an image smaller than 12 MB.");
  if (typeof createImageBitmap === "function") {
    let bitmap;
    try { bitmap = await createImageBitmap(file); }
    catch { throw new Error("This image could not be opened."); }
    try {
      if (bitmap.width * bitmap.height > 24_000_000) throw new Error("Choose an image under 24 megapixels.");
    } finally { bitmap.close?.(); }
  }
}

export function useCustomFocusBackground() {
  const [blob, setBlob] = useState(null);
  const [url, setUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    readCustomFocusBackground()
      .then((stored) => { if (active) setBlob(stored ?? null); })
      .catch(() => { if (active) setError("Could not load the custom background on this device."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!blob) { setUrl(null); return undefined; }
    const nextUrl = URL.createObjectURL(blob);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [blob]);

  const save = useCallback(async (file) => {
    await validateCustomFocusBackground(file);
    await saveCustomFocusBackground(file);
    setBlob(file);
    setError("");
  }, []);

  const remove = useCallback(async () => {
    await removeCustomFocusBackground();
    setBlob(null);
    setError("");
  }, []);

  return { url, loading, error, save, remove };
}

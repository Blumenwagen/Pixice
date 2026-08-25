import { describe, expect, it, vi } from "vitest";
import { createSystemAwakeController } from "../electron/runtime/system-awake.mjs";

describe("system awake controller", () => {
  it("starts one idle-sleep blocker and stops it when disabled", () => {
    const started = new Set();
    const powerSaveBlocker = {
      start: vi.fn(() => {
        started.add(17);
        return 17;
      }),
      isStarted: vi.fn((id) => started.has(id)),
      stop: vi.fn((id) => started.delete(id))
    };
    const controller = createSystemAwakeController(powerSaveBlocker);

    expect(controller.setEnabled(true)).toBe(true);
    expect(controller.setEnabled(true)).toBe(true);
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.start).toHaveBeenCalledWith("prevent-app-suspension");

    expect(controller.setEnabled(false)).toBe(false);
    expect(controller.setEnabled(false)).toBe(false);
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.stop).toHaveBeenCalledWith(17);
  });
});

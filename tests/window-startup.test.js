import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("desktop window startup", () => {
  it("boots the hidden renderer unthrottled and restores throttling on first reveal", () => {
    const source = readFileSync(path.resolve("electron/main.mjs"), "utf8");
    expect(source).toMatch(/show:\s*false[\s\S]*backgroundThrottling:\s*false/);
    expect(source).toMatch(/setBackgroundThrottling\(true\)[\s\S]*mainWindow\.show\(\)/);
  });

  it("opens answer forks without continuing a source goal", () => {
    const source = readFileSync(path.resolve("electron/main.mjs"), "utf8");
    const application = readFileSync(path.resolve("electron/backend/application.mjs"), "utf8");
    const forkHandler = application.slice(application.indexOf('handlers.handle("threads:fork"'), application.indexOf('handlers.handle("threads:archive"'));
    expect(forkHandler).toMatch(/runtime\.request\("thread\/fork",\s*\{[\s\S]*deferGoalContinuation:\s*true/);
  });
});

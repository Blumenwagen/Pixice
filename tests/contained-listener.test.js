import { describe, expect, it, vi } from "vitest";
import { containListenerErrors } from "../electron/runtime/contained-listener.mjs";

describe("containListenerErrors", () => {
  it("reports a synchronous listener failure without letting it escape", () => {
    const failure = new Error("bad runtime event");
    const onError = vi.fn();
    const listener = containListenerErrors(() => { throw failure; }, onError);

    expect(() => listener({ type: "AgentUpdated" })).not.toThrow();
    expect(onError).toHaveBeenCalledWith(failure, { type: "AgentUpdated" });
  });

  it("still contains the failure if the error reporter also fails", () => {
    const listener = containListenerErrors(
      () => { throw new Error("bad runtime event"); },
      () => { throw new Error("bad reporter"); }
    );

    expect(() => listener()).not.toThrow();
  });
});

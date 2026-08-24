import { describe, expect, it, vi } from "vitest";
import { parseCodeSignatureDetails, verifyMacAppSignature } from "../scripts/macos-signing.mjs";

const validDetails = `
Identifier=com.blumenwagen.pixice
Authority=Apple Development: Example Person (CERTIFICATE)
TeamIdentifier=ABCDE12345
`;

describe("macOS signing verification", () => {
  it("parses the application identity and signing authorities", () => {
    expect(parseCodeSignatureDetails(validDetails)).toEqual({
      identifier: "com.blumenwagen.pixice",
      teamIdentifier: "ABCDE12345",
      authorities: ["Apple Development: Example Person (CERTIFICATE)"]
    });
  });

  it("runs strict signature and entitlement checks", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "valid on disk" })
      .mockResolvedValueOnce({ stdout: "", stderr: validDetails })
      .mockResolvedValueOnce({ stdout: "<plist/>", stderr: "" });

    await expect(verifyMacAppSignature("/tmp/Pixice.app", { run })).resolves.toMatchObject({
      identifier: "com.blumenwagen.pixice",
      teamIdentifier: "ABCDE12345"
    });
    expect(run).toHaveBeenNthCalledWith(1, "/usr/bin/codesign", [
      "--verify", "--deep", "--strict", "--verbose=4", "/tmp/Pixice.app"
    ]);
    expect(run).toHaveBeenNthCalledWith(3, "/usr/bin/codesign", [
      "--display", "--entitlements", "-", "/tmp/Pixice.app"
    ]);
  });

  it("rejects an ad hoc signature without a team identifier", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "valid on disk" })
      .mockResolvedValueOnce({ stdout: "", stderr: "Identifier=com.blumenwagen.pixice\nTeamIdentifier=not set\n" });

    await expect(verifyMacAppSignature("/tmp/Pixice.app", { run })).rejects.toThrow("signed by an Apple team");
  });

  it("runs Gatekeeper assessment when required", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "valid on disk" })
      .mockResolvedValueOnce({ stdout: "", stderr: validDetails })
      .mockResolvedValueOnce({ stdout: "<plist/>", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "accepted" });

    await verifyMacAppSignature("/tmp/Pixice.app", { run, requireGatekeeper: true });
    expect(run).toHaveBeenLastCalledWith("/usr/sbin/spctl", [
      "--assess", "--type", "execute", "--verbose=4", "/tmp/Pixice.app"
    ]);
  });
});

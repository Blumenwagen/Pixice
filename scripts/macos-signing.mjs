import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const defaultAppId = "com.blumenwagen.pixice";

export function parseCodeSignatureDetails(output) {
  const text = String(output ?? "");
  return {
    identifier: text.match(/^Identifier=(.+)$/m)?.[1]?.trim() || null,
    teamIdentifier: text.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || null,
    authorities: [...text.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1].trim())
  };
}

function commandOutput(result) {
  return `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
}

export async function verifyMacAppSignature(
  appPath,
  {
    run = execFile,
    expectedAppId = defaultAppId,
    requireTeamIdentifier = true,
    requireGatekeeper = false
  } = {}
) {
  const resolvedPath = path.resolve(appPath);

  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", resolvedPath]);
  const detailsResult = await run("/usr/bin/codesign", ["--display", "--verbose=4", resolvedPath]);
  const details = parseCodeSignatureDetails(commandOutput(detailsResult));

  if (details.identifier !== expectedAppId) {
    throw new Error(`Unexpected macOS application identifier ${details.identifier || "<missing>"}; expected ${expectedAppId}`);
  }
  if (requireTeamIdentifier && (!details.teamIdentifier || details.teamIdentifier === "not set")) {
    throw new Error("Pixice must be signed by an Apple team before it can be installed");
  }

  const entitlementsResult = await run("/usr/bin/codesign", ["--display", "--entitlements", "-", resolvedPath]);
  const entitlementsOutput = commandOutput(entitlementsResult);
  if (/invalid entitlements blob|will ignore the entitlements|will be ignored/i.test(entitlementsOutput)) {
    throw new Error("Pixice contains an invalid entitlements blob");
  }

  if (requireGatekeeper) {
    await run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", resolvedPath]);
  }

  return { path: resolvedPath, ...details };
}

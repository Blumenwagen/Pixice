// Read-only protocol probe. Never starts a thread, realtime session, or microphone.
import { spawn } from "node:child_process";
import readline from "node:readline";
import { writeFile } from "node:fs/promises";

const child = spawn("/Users/blumenwagen/.local/bin/codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let nextId = 0;
const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let value;
  try { value = JSON.parse(line); } catch { return; }
  const request = pending.get(value.id);
  if (!request) return;
  pending.delete(value.id);
  clearTimeout(request.timeout);
  if (value.error) request.reject(new Error(value.error.message));
  else request.resolve(value.result);
});
child.stderr.resume(); // Do not publish runtime diagnostics or account identifiers.
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
    pending.set(id, { resolve, reject, timeout });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
const report = { version: "0.159.0", checkedAt: new Date().toISOString(), openedRealtimeSession: false, usedMicrophone: false };
try {
  await request("initialize", { clientInfo: { name: "pixice_voice_schema_probe", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const account = await request("account/read", { refreshToken: false });
  report.accountType = account.account?.type ?? null;
  try {
    report.catalog = await request("thread/realtime/listVoices", {});
    report.catalogSupported = true;
  } catch (error) {
    report.catalogSupported = false;
    report.catalogError = error.message;
  }
} finally {
  child.kill("SIGTERM");
  lines.close();
  for (const request of pending.values()) clearTimeout(request.timeout);
}
await writeFile(new URL("./probe-result.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));

import { spawn } from 'node:child_process';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { detectGitRuntime } from '../git/git-runtime.mjs';

const identifier = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/, 'Use the environment or task identifier from Codex Cloud.');
export const cloudEnvironmentSchema = z.object({ id: identifier, name: z.string().trim().min(1).max(120) }).strict();
export const cloudListSchema = z.object({ environmentId: identifier.optional(), cursor: z.string().min(1).max(4096).optional(), limit: z.number().int().min(1).max(20).default(20) }).strict();
export const cloudSubmitSchema = z.object({ environmentId: identifier, prompt: z.string().trim().min(1).max(100_000), attempts: z.number().int().min(1).max(4).default(1), branch: z.string().trim().min(1).max(256).optional() }).strict();
export const cloudTaskSchema = z.object({ taskId: identifier, attempt: z.number().int().min(1).max(4).optional() }).strict();

export function runCloudCommand(executable, args, { cwd, environment = process.env, timeoutMs = 60_000, maxBytes = 4 * 1024 * 1024 } = {}) {
  if (!executable) throw new Error('Install or locate Codex in Providers first.');
  return new Promise((resolve, reject) => {
    // Argument arrays only. Never launch a shell or forward the app's SIWC token.
    const env = { ...environment }; delete env.ACCESS_TOKEN;
    const child = spawn(executable, ['cloud', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = ''; let bytes = 0; let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Codex Cloud command timed out. Check task status before retrying a submission or apply.')); }, timeoutMs);
    const append = (kind, chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { child.kill('SIGKILL'); finish(new Error('Codex Cloud output exceeded the display limit. Inspect it in the Codex CLI.')); return; }
      if (kind === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.once('error', () => finish(new Error('Codex Cloud executable could not start. Check Providers.')));
    child.once('close', (code) => finish(code === 0 ? null : new Error(`Codex Cloud failed (${code ?? 'stopped'}). ${stderr.trim().slice(0, 2000) || stdout.trim().slice(0, 2000)}`), { output: stdout, warnings: stderr.trim() }));
  });
}

export class CodexCloud {
  constructor({ executable, getEnvironments, saveEnvironments, runner = runCloudCommand, patchApplier = applyReviewedCloudPatch }) {
    this.executable = executable; this.getEnvironments = getEnvironments; this.saveEnvironments = saveEnvironments; this.runner = runner;
    this.mutations = new Set();
    this.reviews = new Map(); this.patchApplier = patchApplier;
  }
  async state(projectId) {
    let available = false;
    try { await this.runner(this.executable(), ['--help'], { timeoutMs: 5_000 }); available = true; } catch { /* Version/runtime availability is separate from account access. */ }
    return { available, experimental: true, environments: this.getEnvironments(projectId), environmentDiscovery: 'manual', reason: available ? 'This CLI supports Cloud tasks. Copy environment IDs from Codex Cloud; noninteractive environment discovery is not exposed.' : 'This Codex CLI does not expose Cloud commands. Install or update it in Providers.', authentication: 'Uses the existing Codex CLI account, separately from ChatGPT app sign-in.' };
  }
  saveEnvironment(projectId, value) {
    const environment = cloudEnvironmentSchema.parse(value);
    const environments = this.getEnvironments(projectId);
    this.saveEnvironments(projectId, [...environments.filter((e) => e.id !== environment.id), environment]);
    return { environments: this.getEnvironments(projectId) };
  }
  removeEnvironment(projectId, id) {
    this.saveEnvironments(projectId, this.getEnvironments(projectId).filter((e) => e.id !== identifier.parse(id)));
    return { environments: this.getEnvironments(projectId) };
  }
  async list(value, cwd) {
    const { environmentId, cursor, limit } = cloudListSchema.parse(value);
    const result = await this.runner(this.executable(), ['list', '--json', '--limit', String(limit), ...(environmentId ? ['--env', environmentId] : []), ...(cursor ? ['--cursor', cursor] : [])], { cwd });
    let data; try { data = JSON.parse(result.output); } catch { throw new Error('Codex Cloud did not return a valid task list. Update Codex or inspect it in the CLI.'); }
    return { data, warnings: result.warnings };
  }
  async submit(projectId, value, cwd) {
    const { environmentId, prompt, attempts, branch } = cloudSubmitSchema.parse(value);
    return this.mutate(projectId, () => this.runner(this.executable(), ['exec', '--env', environmentId, '--attempts', String(attempts), ...(branch ? ['--branch', branch] : []), '--', prompt], { cwd }));
  }
  inspect(operation, value, cwd) {
    if (!['status', 'diff'].includes(operation)) throw new Error('Unsupported Cloud inspection.');
    const { taskId, attempt } = cloudTaskSchema.parse(value);
    return this.runner(this.executable(), [operation, ...(operation === 'diff' && attempt ? ['--attempt', String(attempt)] : []), '--', taskId], { cwd });
  }
  async review(projectId, value, cwd) {
    const { taskId, attempt = 1 } = cloudTaskSchema.parse(value);
    const result = await this.inspect('diff', { taskId, attempt }, cwd);
    const reviewId = randomUUID();
    const diffHash = createHash('sha256').update(result.output).digest('hex');
    const now = Date.now();
    for (const [id, review] of this.reviews) if (review.expiresAt < now) this.reviews.delete(id);
    while (this.reviews.size >= 20) this.reviews.delete(this.reviews.keys().next().value);
    this.reviews.set(reviewId, { projectId, taskId, attempt, cwd, diffHash, patch: result.output, expiresAt: now + 10 * 60_000 });
    return { ...result, reviewId, diffHash, attempt };
  }
  apply(projectId, value, cwd) {
    const { taskId, reviewId, expectedDiffHash } = z.object({ taskId: identifier, reviewId: z.string().uuid(), expectedDiffHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(value);
    return this.mutate(projectId, async () => {
      const review = this.reviews.get(reviewId);
      if (!review || review.projectId !== projectId || review.cwd !== cwd || review.taskId !== taskId || review.diffHash !== expectedDiffHash || review.expiresAt < Date.now()) throw new Error('This patch review expired or does not match. Review the diff again.');
      if (!review.patch.trim()) throw new Error('The reviewed patch is empty.');
      const result = await this.patchApplier(review.patch, { cwd });
      this.reviews.delete(reviewId);
      return result;
    });
  }
  async mutate(projectId, operation) {
    if (this.mutations.has(projectId)) throw new Error('A Cloud submission or apply is already running for this project.');
    this.mutations.add(projectId);
    try { return await operation(); } finally { this.mutations.delete(projectId); }
  }
}

// Apply the exact host-held bytes shown in Review, with Git's default atomic
// hunk handling and path safeguards. Do not refetch a mutable cloud task here.
export async function applyReviewedCloudPatch(patch, { cwd }) {
  const environment = { ...process.env }; delete environment.ACCESS_TOKEN;
  for (const key of Object.keys(environment)) if (key.startsWith('GIT_')) delete environment[key];
  const git = await detectGitRuntime({ environment });
  if (!git.available) throw new Error('Git is unavailable. Install Git before applying this reviewed patch.');
  return new Promise((resolve, reject) => {
    const child = spawn(git.executablePath, ['apply', '--binary', '--whitespace=nowarn', '-'], { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = ''; let warnings = ''; let settled = false;
    const done = (error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve({ output: output.trim() || 'Applied the exact reviewed patch. Open Review to inspect local changes.', warnings: warnings.trim() }); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(new Error('Patch application timed out. Inspect local changes before retrying.')); }, 30_000);
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => { output = (output + chunk.toString()).slice(0, 8_000); });
    child.stderr.on('data', (chunk) => { warnings = (warnings + chunk.toString()).slice(0, 8_000); });
    child.once('error', () => done(new Error('Git could not start.')));
    child.once('close', (code) => done(code === 0 ? null : new Error(`The reviewed patch could not be applied. ${warnings.trim()}`)));
    child.stdin.end(patch);
  });
}

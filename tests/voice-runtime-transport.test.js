import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexRuntime } from '../electron/runtime/codex-runtime.mjs';
import { CODEX_0159_VOICE_CAPABILITIES } from '../electron/runtime/voice-session.mjs';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe('native runtime voice privacy with an in-memory stdio transport', () => {
  it('routes realtime notifications away from generic provider events and suppresses late stderr after voice starts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pixice-voice-runtime-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const binary = path.join(root, 'fake-codex'); await writeFile(binary, 'fixture executable, never spawned', { mode: 0o755 });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null;
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString());
      if (request.id != null) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n'));
      callback();
    } });
    child.kill = vi.fn(() => { child.exitCode = 0; child.emit('exit', 0); child.stdout.end(); });
    const spawnProcess = vi.fn(() => child);
    const runtime = new CodexRuntime({ executablePath: binary, clientVersion: 'fixture', spawnProcess, inspectVoiceSupport: async () => CODEX_0159_VOICE_CAPABILITIES });
    cleanup.push(() => runtime.stop());
    const generic = [], voice = [], diagnostic = [], errors = [];
    runtime.on('event', (e) => generic.push(e)); runtime.on('voice-event', (e) => voice.push(e)); runtime.on('diagnostic', (e) => diagnostic.push(e)); runtime.on('recoverable-error', (e) => errors.push(e));
    await expect(runtime.start()).resolves.toBe(true);
    const emit = (method, params) => child.stdout.write(JSON.stringify({ method, params }) + '\n');
    emit('thread/realtime/sdp', { threadId: 'voice-thread', sdp: 'private-answer' });
    emit('thread/realtime/transcript/done', { threadId: 'voice-thread', role: 'user', text: 'private-caption' });
    emit('turn/completed', { threadId: 'text-thread', turn: { id: 'fixture' } });
    expect(voice).toHaveLength(2); expect(generic).toHaveLength(1); expect(generic[0].payload.method).toBe('turn/completed');
    await expect(Promise.resolve().then(() => runtime.request('thread/realtime/start', {}))).rejects.toThrow(/not been verified/);
    await runtime.verifyVoiceSupport();
    await runtime.request('thread/realtime/start', { threadId: 'voice-thread', outputModality: 'audio', transport: { type: 'webrtc', sdp: 'private-offer' } });
    child.stderr.write('private SDP and bearer secret');
    await runtime.request('thread/realtime/stop', { threadId: 'voice-thread' }); child.stderr.write('late private SDP');
    child.stdout.write('invalid payload containing a private SDP\n');
    expect(diagnostic).toEqual([]); expect(errors).toEqual([{ code: 'protocol_error', message: 'Codex returned an invalid protocol message' }]);
    expect(spawnProcess).toHaveBeenCalledOnce();
    await writeFile(binary, 'changed executable, still never spawned', { mode: 0o755 });
    await expect(runtime.verifyVoiceSupport()).rejects.toThrow(/executable changed/);
  });
});

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { assertMacUpdateEligible, stageMacUpdate } from '../electron/updater/macos-update.mjs';

describe('macOS update handoff', () => {
  it('rejects the installed ad-hoc signature before offering an automatic update', async () => {
    const run = vi.fn(async () => ({ stderr: 'Identifier=com.blumenwagen.pixice\nSignature=adhoc\nTeamIdentifier=not set\n' }));
    await expect(assertMacUpdateEligible('/Users/me/Applications/Pixice.app/Contents/MacOS/Pixice', { run })).rejects.toThrow('Replace it once with the signed Pixice release');
    expect(run).toHaveBeenCalledOnce();
  });

  it('verifies the complete installed bundle, including nested helpers', async () => {
    const run = vi.fn(async () => ({ stderr: 'Identifier=com.blumenwagen.pixice\nTeamIdentifier=ABCDE12345\n' }));
    await assertMacUpdateEligible('/Applications/Pixice.app/Contents/MacOS/Pixice', { run });
    expect(run).toHaveBeenLastCalledWith('/usr/bin/codesign', ['--verify', '--deep', '--strict', '/Applications/Pixice.app'], { timeout: 30_000 });
  });

  it('does not wait indefinitely when the native installer has no update', async () => {
    const native = Object.assign(new EventEmitter(), { checkForUpdates: vi.fn(() => native.emit('update-not-available')) });
    await expect(stageMacUpdate(native)).rejects.toThrow('did not accept');
    expect(native.listenerCount('update-downloaded')).toBe(0);
    expect(native.listenerCount('error')).toBe(0);
  });

  it('cancels cleanly without making a late native event quit the application', async () => {
    const native = Object.assign(new EventEmitter(), { checkForUpdates: vi.fn() });
    const controller = new AbortController();
    const result = stageMacUpdate(native, { signal: controller.signal });
    const rejected = expect(result).rejects.toThrow('cancelled');
    controller.abort(new Error('cancelled')); await rejected;
    expect(native.listenerCount('update-downloaded')).toBe(0);
  });
});

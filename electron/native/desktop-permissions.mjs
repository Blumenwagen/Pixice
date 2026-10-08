import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isDesktopUrl(url, { isDev, indexPath }) {
  try {
    const value = new URL(url);
    return isDev ? value.origin === 'http://127.0.0.1:5173'
      : value.protocol === 'file:' && path.normalize(fileURLToPath(value)) === path.normalize(indexPath);
  } catch { return false; }
}
export function isDesktopCaller(event, window, options) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame && isDesktopUrl(event.senderFrame.url, options));
}
export function installDesktopMediaPermissions({ session, getWindow, options, systemPreferences, platform = process.platform }) {
  const trusted = (contents, details) => {
    const window = getWindow();
    return Boolean(window && !window.isDestroyed() && contents === window.webContents && details?.isMainFrame === true
      && isDesktopUrl(details.requestingUrl, options) && isDesktopUrl(contents.getURL(), options)
      && isDesktopUrl(contents.mainFrame?.url, options));
  };
  session.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (permission !== 'media' && permission !== 'speaker-selection') return true;
    if (!trusted(contents, details)) return false;
    // Electron passes a security origin here, not necessarily the full file URL.
    if (options.isDev ? origin !== 'http://127.0.0.1:5173' && !isDesktopUrl(origin, options)
      : !['file://', 'file:///'].includes(origin) && !isDesktopUrl(origin, options)) return false;
    if (permission === 'speaker-selection') return true;
    return details.mediaType === 'audio'
      && (platform !== 'darwin' || systemPreferences?.getMediaAccessStatus('microphone') === 'granted');
  });
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    // Preserve Electron's existing defaults for unrelated permission types.
    if (permission !== 'media' && permission !== 'speaker-selection') { callback(true); return; }
    if (!trusted(contents, details)) { callback(false); return; }
    if (permission === 'media') {
      if (!Array.isArray(details.mediaTypes) || details.mediaTypes.length !== 1 || details.mediaTypes[0] !== 'audio') { callback(false); return; }
      // Only an actual renderer audio request reaches this branch. No startup,
      // enumeration or test code requests OS microphone permission.
      if (platform === 'darwin' && systemPreferences?.getMediaAccessStatus('microphone') === 'not-determined') {
        try { Promise.resolve(systemPreferences.askForMediaAccess('microphone')).then((allowed) => callback(allowed === true && trusted(contents, details)), () => callback(false)); }
        catch { callback(false); }
      } else callback(platform !== 'darwin' || systemPreferences?.getMediaAccessStatus('microphone') === 'granted');
      return;
    }
    callback(permission === 'speaker-selection');
  });
}

const installListeners = new Set();
let deferredInstallPrompt = null;
let installListenerWindow = null;

function attachInstallListener(windowRef = globalThis.window) {
  if (installListenerWindow === windowRef || !windowRef?.addEventListener) return;
  installListenerWindow = windowRef;
  windowRef.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    for (const listener of installListeners) listener(getInstallState(windowRef));
  });
  windowRef.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    for (const listener of installListeners) listener(getInstallState(windowRef));
  });
}

export function isStandaloneDisplay({ windowRef = globalThis.window, navigatorRef = globalThis.navigator } = {}) {
  return Boolean(windowRef?.matchMedia?.('(display-mode: standalone)')?.matches || navigatorRef?.standalone === true);
}

export function isIosBrowser({ navigatorRef = globalThis.navigator } = {}) {
  return /iphone|ipad|ipod/i.test(navigatorRef?.userAgent || '') || navigatorRef?.platform === 'MacIntel' && navigatorRef?.maxTouchPoints > 1;
}

export function getInstallState(windowRef = globalThis.window) {
  return {
    available: Boolean(deferredInstallPrompt),
    standalone: isStandaloneDisplay({ windowRef }),
    ios: isIosBrowser({ navigatorRef: globalThis.navigator }),
  };
}

export function subscribeInstallPrompt(listener, windowRef = globalThis.window) {
  attachInstallListener(windowRef);
  installListeners.add(listener);
  listener(getInstallState(windowRef));
  return () => installListeners.delete(listener);
}

export async function requestInstall() {
  if (!deferredInstallPrompt) return { state: 'unavailable' };
  const prompt = deferredInstallPrompt;
  deferredInstallPrompt = null;
  await prompt.prompt();
  const choice = await prompt.userChoice;
  return { state: choice?.outcome === 'accepted' ? 'accepted' : 'dismissed' };
}

export function installHelp({ windowRef = globalThis.window, navigatorRef = globalThis.navigator } = {}) {
  if (isStandaloneDisplay({ windowRef, navigatorRef })) return 'Pixice is already installed on this device.';
  if (isIosBrowser({ navigatorRef })) return 'In Safari, use Share, then Add to Home Screen.';
  return 'Use your browser menu to install Pixice when it offers Install app.';
}

function secureBrowserClient({ windowRef, navigatorRef, locationRef }) {
  if (!windowRef || !navigatorRef?.serviceWorker || windowRef.pixice) return false;
  if (!['http:', 'https:'].includes(locationRef?.protocol)) return false;
  if (locationRef.protocol === 'https:') return true;
  return ['localhost', '127.0.0.1', '[::1]'].includes(locationRef.hostname) && windowRef.isSecureContext !== false;
}

export async function registerRootConnectServiceWorker({ windowRef = globalThis.window, navigatorRef = globalThis.navigator, locationRef = globalThis.location } = {}) {
  attachInstallListener(windowRef);
  if (!secureBrowserClient({ windowRef, navigatorRef, locationRef })) return { state: 'skipped' };
  try {
    const registration = await navigatorRef.serviceWorker.register('/connect-sw.js', { scope: '/' });
    return { state: 'registered', registration };
  } catch (error) {
    return { state: 'error', error };
  }
}

export { secureBrowserClient };

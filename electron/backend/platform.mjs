import { createCredentialCrypto } from './credential-crypto.mjs';
export function createNativePlatform({ native, directory, environment }) {
  const invoke = (method) => (...args) => native.invoke(method, args);
  const browser = Object.fromEntries(['snapshot', 'createTab', 'closeTab', 'activateTab', 'navigate', 'history', 'setViewport', 'adoptWorkspace', 'destroyWorkspace', 'remoteFrame', 'remoteInput', 'handleToolCall'].map((name) => [name, invoke(`browser.${name}`)]));
  const snapshot = browser.snapshot;
  browser.snapshot = (workspaceId) => native.status().connected ? snapshot(workspaceId) : Promise.resolve({ native: true, workspaceId, activeTabId: null, tabs: [] });
  const destroy = browser.destroyWorkspace;
  browser.destroyWorkspace = (workspaceId) => native.status().connected ? destroy(workspaceId) : Promise.resolve({ destroyed: true, workspaceId });
  return {
    browser,
    openExternal: invoke('desktop.openExternal'), openDialog: invoke('desktop.openDialog'),
    reveal: invoke('desktop.reveal'), openTerminal: invoke('desktop.openTerminal'),
    setKeepAwake: invoke('desktop.setKeepAwake'), confirmAction: invoke('desktop.confirmAction'),
    notify: async (value) => native.status().connected ? native.invoke('desktop.notify', [value]) : false,
    credentialCrypto: createCredentialCrypto({ directory, native, environment })
  };
}

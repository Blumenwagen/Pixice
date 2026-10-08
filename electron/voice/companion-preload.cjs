const { contextBridge, ipcRenderer } = require('electron');
const invoke = (action) => (payload) => ipcRenderer.invoke(`voice-companion:${action}`, payload);
// No application API, provider credentials, generic IPC, or approval response.
contextBridge.exposeInMainWorld('pixiceVoiceCompanion', Object.freeze({
  configuration: invoke('configuration'), report: invoke('report'),
  state: invoke('state'), mute: invoke('mute'), end: invoke('end'), detach: invoke('detach'), attach: invoke('attach'), returnToPixice: invoke('return'),
  voice: Object.freeze({ start: invoke('start'), stop: invoke('stop') }),
  events: Object.freeze({ subscribe(listener) {
    const wrapped = (_event, value) => listener(value);
    ipcRenderer.on('voice-companion:event', wrapped);
    return () => ipcRenderer.removeListener('voice-companion:event', wrapped);
  } })
}));

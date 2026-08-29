const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pixiceTray", Object.freeze({
  action: (action, value) => ipcRenderer.invoke("tray:action", { action, value }),
  subscribe: (listener) => {
    const wrapped = (_event, state) => listener(state);
    ipcRenderer.on("tray:state", wrapped);
    return () => ipcRenderer.removeListener("tray:state", wrapped);
  }
}));

import { contextBridge, ipcRenderer } from "electron";

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);
const onEvent = (listener) => {
  const wrapped = (_event, message) => listener(message);
  ipcRenderer.on("loom:event", wrapped);
  return () => ipcRenderer.removeListener("loom:event", wrapped);
};

contextBridge.exposeInMainWorld("loom", Object.freeze({
  projects: Object.freeze({ list: invoke("projects:list"), open: invoke("projects:open") }),
  tasks: Object.freeze({ create: invoke("tasks:create"), archive: invoke("tasks:archive"), interrupt: invoke("tasks:interrupt") }),
  turns: Object.freeze({ start: invoke("turns:start"), steer: invoke("turns:steer") }),
  approvals: Object.freeze({ resolve: invoke("approvals:resolve") }),
  review: Object.freeze({ read: invoke("review:read") }),
  extensions: Object.freeze({ list: invoke("extensions:list"), update: invoke("extensions:update") }),
  external: Object.freeze({ openEditor: invoke("external:editor"), openTerminal: invoke("external:terminal"), reveal: invoke("external:reveal") }),
  events: Object.freeze({ subscribe: onEvent })
}));

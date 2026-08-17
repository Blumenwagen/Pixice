const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);
const onEvent = (listener) => {
  const wrapped = (_event, message) => listener(message);
  ipcRenderer.on("loom:event", wrapped);
  return () => ipcRenderer.removeListener("loom:event", wrapped);
};

contextBridge.exposeInMainWorld("loom", Object.freeze({
  app: Object.freeze({ bootstrap: invoke("app:bootstrap") }),
  runtime: Object.freeze({ status: invoke("runtime:status") }),
  projects: Object.freeze({ list: invoke("projects:list"), open: invoke("projects:open") }),
  threads: Object.freeze({
    list: invoke("threads:list"),
    read: invoke("threads:read"),
    create: invoke("threads:create"),
    archive: invoke("threads:archive")
  }),
  turns: Object.freeze({ start: invoke("turns:start"), steer: invoke("turns:steer"), interrupt: invoke("turns:interrupt") }),
  approvals: Object.freeze({ resolve: invoke("approvals:resolve") }),
  review: Object.freeze({ read: invoke("review:read") }),
  models: Object.freeze({ list: invoke("models:list") }),
  extensions: Object.freeze({ list: invoke("extensions:list") }),
  external: Object.freeze({ openEditor: invoke("external:editor"), openTerminal: invoke("external:terminal"), reveal: invoke("external:reveal") }),
  events: Object.freeze({ subscribe: onEvent })
}));

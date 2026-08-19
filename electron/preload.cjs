const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);
const onEvent = (listener) => {
  const wrapped = (_event, message) => listener(message);
  ipcRenderer.on("loom:event", wrapped);
  return () => ipcRenderer.removeListener("loom:event", wrapped);
};

contextBridge.exposeInMainWorld("loom", Object.freeze({
  app: Object.freeze({ bootstrap: invoke("app:bootstrap"), saveSettings: invoke("app:settings:update") }),
  runtime: Object.freeze({ status: invoke("runtime:status") }),
  providers: Object.freeze({ list: invoke("providers:list"), login: invoke("providers:login") }),
  usage: Object.freeze({ summary: invoke("usage:summary") }),
  updates: Object.freeze({ status: invoke("updates:status"), check: invoke("updates:check"), download: invoke("updates:download"), install: invoke("updates:install") }),
  browser: Object.freeze({
    state: invoke("browser:state"),
    create: invoke("browser:create"),
    close: invoke("browser:close"),
    activate: invoke("browser:activate"),
    navigate: invoke("browser:navigate"),
    history: invoke("browser:history"),
    setViewport: invoke("browser:viewport"),
    adopt: invoke("browser:adopt")
  }),
  files: Object.freeze({ read: invoke("files:read"), write: invoke("files:write") }),
  projects: Object.freeze({ list: invoke("projects:list"), open: invoke("projects:open") }),
  board: Object.freeze({
    list: invoke("board:list"),
    create: invoke("board:create"),
    update: invoke("board:update"),
    move: invoke("board:move"),
    delete: invoke("board:delete"),
    attach: invoke("board:attach")
  }),
  threads: Object.freeze({
    list: invoke("threads:list"),
    read: invoke("threads:read"),
    children: invoke("threads:children"),
    create: invoke("threads:create"),
    archive: invoke("threads:archive")
  }),
  turns: Object.freeze({ start: invoke("turns:start"), steer: invoke("turns:steer"), interrupt: invoke("turns:interrupt") }),
  approvals: Object.freeze({ resolve: invoke("approvals:resolve") }),
  requests: Object.freeze({ respond: invoke("requests:respond") }),
  questions: Object.freeze({ respond: invoke("questions:respond") }),
  elicitations: Object.freeze({ respond: invoke("elicitations:respond") }),
  review: Object.freeze({ read: invoke("review:read") }),
  models: Object.freeze({ list: invoke("models:list") }),
  extensions: Object.freeze({ list: invoke("extensions:list") }),
  external: Object.freeze({ openEditor: invoke("external:editor"), openTerminal: invoke("external:terminal"), reveal: invoke("external:reveal") }),
  events: Object.freeze({ subscribe: onEvent })
}));

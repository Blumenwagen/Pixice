const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);
const onEvent = (listener) => {
  const wrapped = (_event, message) => listener(message);
  ipcRenderer.on("pixice:event", wrapped);
  return () => ipcRenderer.removeListener("pixice:event", wrapped);
};

contextBridge.exposeInMainWorld("pixice", Object.freeze({
  connect: Object.freeze({ status: invoke("connect:status"), configure: invoke("connect:configure"), pair: invoke("connect:pair"), renew: invoke("connect:renew"), revoke: invoke("connect:revoke"), startTunnel: invoke("connect:tunnel:start"), stopTunnel: invoke("connect:tunnel:stop") }),
  app: Object.freeze({ bootstrap: invoke("app:bootstrap"), overview: invoke("app:overview"), saveSettings: invoke("app:settings:update") }),
  runtime: Object.freeze({ status: invoke("runtime:status") }),
  git: Object.freeze({ status: invoke("git:status"), installCommandLineTools: invoke("git:install-command-line-tools") }),
  providers: Object.freeze({
    list: invoke("providers:list"),
    install: invoke("providers:install"),
    locate: invoke("providers:locate"),
    repair: invoke("providers:repair"),
    checkUpdates: invoke("providers:check-updates"),
    update: invoke("providers:update"),
    login: invoke("providers:login"),
    logout: invoke("providers:logout")
  }),
  github: Object.freeze({ status: invoke("github:status"), login: invoke("github:login"), logout: invoke("github:logout") }),
  usage: Object.freeze({ summary: invoke("usage:summary"), limits: invoke("usage:limits") }),
  tasks: Object.freeze({
    receipts: invoke("tasks:receipts"), receipt: invoke("tasks:receipt"),
    replay: invoke("tasks:replay"), interventions: invoke("tasks:interventions")
  }),
  updates: Object.freeze({ status: invoke("updates:status"), check: invoke("updates:check"), download: invoke("updates:download"), install: invoke("updates:install") }),
  browser: Object.freeze({
    state: invoke("browser:state"),
    create: invoke("browser:create"),
    close: invoke("browser:close"),
    activate: invoke("browser:activate"),
    navigate: invoke("browser:navigate"),
    history: invoke("browser:history"),
    setViewport: invoke("browser:viewport"),
    adopt: invoke("browser:adopt"),
    destroy: invoke("browser:destroy")
  }),
  preview: Object.freeze({ setContext: invoke("preview:context") }),
  ios: Object.freeze({
    environment: invoke("ios:environment"),
    discover: invoke("ios:discover"),
    createStarter: invoke("ios:create-starter"),
    start: invoke("ios:start"),
    state: invoke("ios:state"),
    stop: invoke("ios:stop"),
    action: invoke("ios:action"),
    adopt: invoke("ios:adopt")
  }),
  files: Object.freeze({ list: invoke("files:list"), read: invoke("files:read"), preview: invoke("files:preview"), write: invoke("files:write") }),
  projects: Object.freeze({
    list: invoke("projects:list"),
    touch: invoke("projects:touch"),
    pickFolders: invoke("projects:pick-folders"),
    create: invoke("projects:create"),
    delete: invoke("projects:delete"),
    open: invoke("projects:open")
  }),
  focus: Object.freeze({
    state: invoke("focus:state"),
    controlWork: invoke("focus:work:control"),
    followUp: invoke("focus:work:follow-up"),
    updatePolicy: invoke("focus:policy:update"),
    markSeen: invoke("focus:seen"),
    ensure: invoke("focus:ensure"),
    readMemory: invoke("focus:memory"),
    updateMemory: invoke("focus:memory:update"),
    clearMemory: invoke("focus:memory:clear")
  }),
  board: Object.freeze({
    list: invoke("board:list"),
    read: invoke("board:read"),
    create: invoke("board:create"),
    update: invoke("board:update"),
    move: invoke("board:move"),
    delete: invoke("board:delete"),
    attach: invoke("board:attach"),
    createPhase: invoke("board:phase:create"),
    activity: invoke("board:activity"),
    readProposal: invoke("board:proposal:read"),
    applyProposal: invoke("board:proposal:apply"),
    discardProposal: invoke("board:proposal:discard"),
    saveBinding: invoke("board:binding:save"),
    deleteBinding: invoke("board:binding:delete")
  }),
  proactivity: Object.freeze({
    list: invoke("proactivity:list"),
    resolve: invoke("proactivity:resolve")
  }),
  instruments: Object.freeze({
    list: invoke("instruments:list"),
    tools: invoke("instruments:tools"),
    read: invoke("instruments:read"),
    open: invoke("instruments:open"),
    refresh: invoke("instruments:refresh"),
    event: invoke("instruments:event"),
    invoke: invoke("instruments:invoke"),
    pin: invoke("instruments:pin"),
    events: invoke("instruments:events"),
    receipts: invoke("instruments:receipts"),
    launch: invoke("instruments:launch"),
    rename: invoke("instruments:rename"),
    grants: invoke("instruments:grants"),
    duplicate: invoke("instruments:duplicate"),
    revisions: invoke("instruments:revisions"),
    restore: invoke("instruments:restore"),
    deleteTool: invoke("instruments:delete-tool"),
    delete: invoke("instruments:delete")
  }),
  workflows: Object.freeze({
    list: invoke("workflows:list"),
    read: invoke("workflows:read"),
    taskRuns: invoke("workflows:task-runs"),
    create: invoke("workflows:create"),
    save: invoke("workflows:save"),
    generate: invoke("workflows:generate"),
    delete: invoke("workflows:delete"),
    run: invoke("workflows:run"),
    cancel: invoke("workflows:cancel"),
    triggers: invoke("workflows:triggers"),
    resolveMissedTrigger: invoke("workflows:resolve-missed-trigger")
  }),
  workflowCredentials: Object.freeze({
    list: (projectId) => ipcRenderer.invoke("workflow-credentials:list", { projectId }),
    create: invoke("workflow-credentials:create"),
    update: invoke("workflow-credentials:update"),
    delete: (projectId, credentialId) => ipcRenderer.invoke("workflow-credentials:delete", { projectId, credentialId })
  }),
  threads: Object.freeze({
    list: invoke("threads:list"),
    read: invoke("threads:read"),
    children: invoke("threads:children"),
    create: invoke("threads:create"),
    fork: invoke("threads:fork"),
    archive: invoke("threads:archive")
  }),
  turns: Object.freeze({ start: invoke("turns:start"), steer: invoke("turns:steer"), interrupt: invoke("turns:interrupt"), queue: invoke("turns:queue"), queueList: invoke("turns:queue:list"), queueDraft: invoke("turns:queue:draft"), queueEdit: invoke("turns:queue:edit"), queueRemove: invoke("turns:queue:remove"), queueReorder: invoke("turns:queue:reorder"), queueHold: invoke("turns:queue:hold"), queueResume: invoke("turns:queue:resume"), queueSteer: invoke("turns:queue:steer") }),
  approvals: Object.freeze({ resolve: invoke("approvals:resolve") }),
  requests: Object.freeze({ respond: invoke("requests:respond") }),
  questions: Object.freeze({ respond: invoke("questions:respond") }),
  elicitations: Object.freeze({ respond: invoke("elicitations:respond") }),
  review: Object.freeze({ read: invoke("review:read"), file: invoke("review:file") }),
  htmlReplies: Object.freeze({ read: invoke("html-replies:read"), list: invoke("html-replies:list"), document: invoke("html-replies:document") }),
  taskWorkspaces: Object.freeze({ read: invoke("task-workspaces:read"), remove: invoke("task-workspaces:remove") }),
  history: Object.freeze({ list: invoke("history:list"), preview: invoke("history:preview"), rewind: invoke("history:rewind"), restoreFile: invoke("history:restore-file"), attachment: invoke("history:attachment") }),
  pullRequests: Object.freeze({ workspace: invoke("pull-requests:workspace"), list: invoke("pull-requests:list"), read: invoke("pull-requests:read"), link: invoke("pull-requests:link"), unlink: invoke("pull-requests:unlink"), diff: invoke("pull-requests:diff"), commit: invoke("pull-requests:commit"), push: invoke("pull-requests:push"), create: invoke("pull-requests:create"), update: invoke("pull-requests:update"), watch: invoke("pull-requests:watch"), stopWatch: invoke("pull-requests:stop-watch") }),
  transcription: Object.freeze({
    state: invoke("transcription:state"),
    install: invoke("transcription:install"),
    cancelInstall: invoke("transcription:install-cancel"),
    remove: invoke("transcription:remove"),
    select: invoke("transcription:select"),
    configure: invoke("transcription:configure"),
    start: invoke("transcription:start"),
    chunk: invoke("transcription:chunk"),
    finish: invoke("transcription:finish"),
    abort: invoke("transcription:abort")
  }),
  models: Object.freeze({ list: invoke("models:list") }),
  extensions: Object.freeze({ list: invoke("extensions:list") }),
  external: Object.freeze({ openEditor: invoke("external:editor"), openTerminal: invoke("external:terminal"), reveal: invoke("external:reveal") }),
  service: Object.freeze({ connection: invoke('service:connection'), status: invoke('service:status'), start: invoke('service:start'), stop: invoke('service:stop'), restart: invoke('service:restart'), setOpenAtLogin: invoke('service:login') }),
  events: Object.freeze({ subscribe: onEvent })
}));

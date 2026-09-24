import { CAPABILITIES, READ_OPERATIONS } from './protocol.mjs';
// The application API is transport independent. Remote sessions receive the
// existing restricted capability set; the OS user's local client can administer it.
export const APPLICATION_CAPABILITIES = {
  ...CAPABILITIES,
  connect: { status: 'connect:status', configure: 'connect:configure', pair: 'connect:pair', renew: 'connect:renew', revoke: 'connect:revoke', startTunnel: 'connect:tunnel:start', stopTunnel: 'connect:tunnel:stop' },
  app: { ...CAPABILITIES.app, saveSettings: 'app:settings:update' },
  git: { ...CAPABILITIES.git, installCommandLineTools: 'git:install-command-line-tools' },
  providers: { ...CAPABILITIES.providers, install: 'providers:install', locate: 'providers:locate', repair: 'providers:repair', checkUpdates: 'providers:check-updates', update: 'providers:update', login: 'providers:login', logout: 'providers:logout' },
  github: { status: 'github:status', login: 'github:login', logout: 'github:logout' },
  browser: { ...CAPABILITIES.browser, setViewport: 'browser:viewport', adopt: 'browser:adopt', destroy: 'browser:destroy' },
  preview: { setContext: 'preview:context' },
  ios: { environment: 'ios:environment', discover: 'ios:discover', createStarter: 'ios:create-starter', start: 'ios:start', state: 'ios:state', stop: 'ios:stop', action: 'ios:action', adopt: 'ios:adopt' },
  projects: { ...CAPABILITIES.projects, pickFolders: 'projects:pick-folders', open: 'projects:open' },
  widgets: { ...CAPABILITIES.widgets, keyStatus: 'widgets:key-status', keySave: 'widgets:key-save', keyRemove: 'widgets:key-remove' },
  workflowCredentials: { list: 'workflow-credentials:list', create: 'workflow-credentials:create', update: 'workflow-credentials:update', delete: 'workflow-credentials:delete' },
  extensions: { list: 'extensions:list' },
  external: { openEditor: 'external:editor', openTerminal: 'external:terminal', reveal: 'external:reveal' },
  tray: { state: 'tray:state', refresh: 'tray:refresh', thread: 'tray:thread', followUp: 'tray:follow-up' },
  service: { backup: 'service:backup', status: 'service:status', stop: 'service:stop', prepareUpdate: 'service:prepare-update' },
  native: { register: 'native:register', poll: 'native:poll', respond: 'native:respond', event: 'native:event', disconnect: 'native:disconnect' }
};
export const APPLICATION_OPERATIONS = new Map(Object.entries(APPLICATION_CAPABILITIES).flatMap(([group, entries]) => Object.entries(entries).map(([name, channel]) => [`${group}.${name}`, channel])));
export const APPLICATION_CHANNELS = new Map([...APPLICATION_OPERATIONS].map(([name, channel]) => [channel, name]));
export const APPLICATION_READ_OPERATIONS = new Set([...READ_OPERATIONS, 'widgets.keyStatus', 'connect.status', 'github.status', 'workflowCredentials.list', 'extensions.list', 'ios.environment', 'ios.discover', 'ios.state', 'tray.state', 'tray.refresh', 'tray.thread', 'service.status', 'native.poll']);

import { CAPABILITIES, READ_OPERATIONS } from './protocol.mjs';
// The application API is transport independent. Remote sessions receive the
// existing restricted capability set; the OS user's local client can administer it.
export const APPLICATION_CAPABILITIES = {
  ...CAPABILITIES,
  voice: { state: 'voice:state', context: 'voice:context', availability: 'voice:availability', prepare: 'voice:prepare', start: 'voice:start', stop: 'voice:stop', appendText: 'voice:appendText', appendSpeech: 'voice:appendSpeech', appendAudio: 'voice:appendAudio', snapshot: 'voice:snapshot' },
  connect: { status: 'connect:status', configure: 'connect:configure', pair: 'connect:pair', renew: 'connect:renew', revoke: 'connect:revoke', startTunnel: 'connect:tunnel:start', stopTunnel: 'connect:tunnel:stop' },
  app: { ...CAPABILITIES.app, saveSettings: 'app:settings:update' },
  git: { ...CAPABILITIES.git, installCommandLineTools: 'git:install-command-line-tools' },
  providers: { ...CAPABILITIES.providers, install: 'providers:install', locate: 'providers:locate', repair: 'providers:repair', checkUpdates: 'providers:check-updates', update: 'providers:update', login: 'providers:login', logout: 'providers:logout' },
  chatgpt: { state: 'chatgpt:state', signIn: 'chatgpt:sign-in', cancel: 'chatgpt:cancel', select: 'chatgpt:select', signOut: 'chatgpt:sign-out', manage: 'chatgpt:manage' },
  cloud: { state: 'cloud:state', saveEnvironment: 'cloud:environment:save', removeEnvironment: 'cloud:environment:remove', list: 'cloud:list', submit: 'cloud:submit', status: 'cloud:status', diff: 'cloud:diff', apply: 'cloud:apply', open: 'cloud:open' },
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
  native: { register: 'native:register', poll: 'native:poll', respond: 'native:respond', event: 'native:event', disconnect: 'native:disconnect', voiceAttach: 'native:voiceAttach', voiceCall: 'native:voiceCall', voicePoll: 'native:voicePoll', voiceDisconnect: 'native:voiceDisconnect' }
};
export const APPLICATION_OPERATIONS = new Map(Object.entries(APPLICATION_CAPABILITIES).flatMap(([group, entries]) => Object.entries(entries).map(([name, channel]) => [`${group}.${name}`, channel])));
export const APPLICATION_CHANNELS = new Map([...APPLICATION_OPERATIONS].map(([name, channel]) => [channel, name]));
export const APPLICATION_READ_OPERATIONS = new Set([...READ_OPERATIONS, 'widgets.keyStatus', 'connect.status', 'github.status', 'workflowCredentials.list', 'extensions.list', 'ios.environment', 'ios.discover', 'ios.state', 'tray.state', 'tray.refresh', 'tray.thread', 'service.status', 'native.poll', 'chatgpt.state', 'voice.state', 'voice.context', 'cloud.state', 'cloud.list', 'cloud.status', 'cloud.diff']);
// Voice is ephemeral even when it changes session state. Never retain SDP,
// owner tokens or native responses in the command recovery cache.
// Every helper payload can carry bootstrap proof, so native registration and
// nonvoice helper calls also bypass recovery records and cached responses.
for (const group of ['voice', 'native']) for (const name of Object.keys(APPLICATION_CAPABILITIES[group])) {
  APPLICATION_READ_OPERATIONS.add(`${group}.${name}`);
}

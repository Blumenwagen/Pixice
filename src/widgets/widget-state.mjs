import { WIDGET_V2_LIMITS } from './widget-schema.mjs';

export function initialWidgetState(document, saved) {
  const state = { user: { ...document.state.user }, view: { ...document.state.view } };
  if (!saved || typeof saved !== 'object') return state;
  for (const scope of ['user', 'view']) {
    for (const [name, defaultValue] of Object.entries(state[scope])) {
      const value = saved[scope]?.[name];
      if (typeof value === typeof defaultValue && (typeof value !== 'number' || Number.isFinite(value)) && (typeof value !== 'string' || value.length <= WIDGET_V2_LIMITS.text)) state[scope][name] = value;
    }
  }
  return state;
}

export function dispatchWidgetAction(document, state, actionId, payload = {}) {
  const action = document.actions[actionId];
  if (!action || action.type === 'refresh') return state;
  const [, scope, name] = action.target.split('/');
  if (!['user', 'view'].includes(scope) || !Object.hasOwn(state[scope], name)) throw new Error('Invalid action target.');
  const previous = state[scope][name];
  let next;
  if (action.type === 'set') next = action.value;
  else if (action.type === 'toggle') next = !previous;
  else if (action.type === 'increment') next = previous + action.amount;
  else if (action.type === 'assign') next = payload[action.input];
  else throw new Error('Unsupported widget action.');
  if (typeof next !== typeof previous || (typeof next === 'number' && !Number.isFinite(next)) || (typeof next === 'string' && next.length > WIDGET_V2_LIMITS.text)) throw new Error('Invalid action value.');
  return { ...state, [scope]: { ...state[scope], [name]: next } };
}

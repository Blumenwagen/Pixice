// The catalog is data, so a future renderer can register components without a
// switch over document node types. This module does not register a renderer.
export const WIDGET_CATALOG_VERSION = 1;

const entry = (group, props, slots = {}, events = [], required = [], description, cues = []) => {
  if (!description || description.length > 120 || cues.length > 4 || cues.some((cue) => !cue || cue.length > 32)) throw new Error('Invalid widget candidate metadata');
  return Object.freeze({ group, props, slots, events, required, candidate: Object.freeze({ description, cues: Object.freeze(cues), recipe: 'catalog-node-v1' }) });
};

export const widgetCatalog = Object.freeze({
  Stack: entry('layout', { direction: 'string', gap: 'number' }, { children: { min: 1, max: 24 } }, [], [], 'Arrange child components in one direction.', ['group', 'stack']),
  Grid: entry('layout', { columns: 'number', gap: 'number' }, { children: { min: 1, max: 24 } }, [], [], 'Arrange child components in columns.', ['grid', 'columns']),
  Card: entry('layout', { title: 'string' }, { body: { min: 1, max: 12 }, footer: { min: 0, max: 4 } }, [], [], 'Group content and controls in a titled card.', ['card', 'panel']),
  Text: entry('content', { text: 'string', tone: 'string' }, {}, [], ['text'], 'Show a short piece of text.', ['text', 'note']),
  Heading: entry('content', { text: 'string', level: 'number' }, {}, [], ['text'], 'Label a section with a heading.', ['heading', 'section']),
  Number: entry('content', { value: 'number', label: 'string' }, {}, [], ['value'], 'Display a numeric result.', ['result', 'formula', 'metric']),
  Button: entry('control', { label: 'string', disabled: 'boolean' }, {}, ['press'], ['label'], 'Run a declared action on press.', ['button', 'action']),
  TextInput: entry('control', { label: 'string', value: 'string', placeholder: 'string' }, {}, ['change'], ['label', 'value'], 'Edit a text value.', ['text input', 'search']),
  NumberInput: entry('control', { label: 'string', value: 'number', min: 'number', max: 'number', step: 'number' }, {}, ['change'], ['label', 'value'], 'Edit a numeric user value.', ['number input', 'operand', 'calculator']),
  Select: entry('control', { label: 'string', value: 'string', options: 'stringList' }, {}, ['change'], ['label', 'value', 'options'], 'Choose one value from a fixed list.', ['select', 'filter']),
  Toggle: entry('control', { label: 'string', checked: 'boolean' }, {}, ['change'], ['label', 'checked'], 'Switch a boolean value.', ['toggle', 'switch']),
  Table: entry('collection', { rows: 'boardRows', columns: 'boardColumns', emptyText: 'string' }, {}, [], ['rows', 'columns'], 'Show Board rows in selected columns.', ['table', 'board']),
  List: entry('collection', { items: 'stringList' }, {}, [], ['items'], 'Show a short list of text items.', ['list', 'items']),
  BarChart: entry('visualization', { rows: 'chartRows', xKey: 'string', yKey: 'string' }, {}, [], ['rows', 'xKey', 'yKey'], 'Compare values with bars.', ['bar chart', 'compare']),
  Progress: entry('visualization', { value: 'number', max: 'number' }, {}, [], ['value', 'max'], 'Show progress toward a numeric maximum.', ['progress', 'goal']),
  Timer: entry('utility', { label: 'string', durationSeconds: 'number', endAt: 'string' }, {}, ['restart'], ['label', 'durationSeconds'], 'Show a countdown timer.', ['timer', 'countdown']),
  Checklist: entry('utility', { label: 'string', items: 'checklistItems' }, {}, ['toggle'], ['label', 'items'], 'Track completion of named items.', ['checklist', 'tasks']),
  Counter: entry('utility', { label: 'string', value: 'number', step: 'number' }, {}, ['increment', 'decrement'], ['label', 'value', 'step'], 'Count up or down by a fixed step.', ['counter', 'tally'])
});

// A future composer can send this bounded list to Jev, then resolve the chosen
// type through widgetCatalog. The recipe name is a hook, not a runtime factory.
export const widgetCandidateCatalog = Object.freeze(Object.entries(widgetCatalog).map(([type, definition]) => Object.freeze({ type, ...definition.candidate })));

export const BOARD_FIELDS = Object.freeze(['id', 'title', 'description', 'column', 'threadId', 'updatedAt']);
export const WIDGET_SOURCE_CATALOG = Object.freeze({
  'board.list': Object.freeze({ output: 'boardRows', arguments: [] })
});

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CAPABILITIES, OPERATIONS, READ_OPERATIONS } from '../electron/connect/protocol.mjs';
import { APPLICATION_OPERATIONS } from '../electron/connect/application-protocol.mjs';
import { operationAllowed } from '../electron/connect/access-policy.mjs';

test('widget API is transport mapped and credentials are host-only', () => {
  assert.equal(OPERATIONS.get('widgets.draft'), CAPABILITIES.widgets.draft);
  assert.equal(APPLICATION_OPERATIONS.get('widgets.keySave'), 'widgets:key-save');
  assert.equal(OPERATIONS.has('widgets.keySave'), false);
  assert.equal(READ_OPERATIONS.has('widgets.list'), true);
  assert.equal(READ_OPERATIONS.has('widgets.readSource'), true);
  assert.equal(READ_OPERATIONS.has('widgets.updateUserState'), false);
  assert.equal(OPERATIONS.get('widgets.readSource'), 'widgets:read-source');
  assert.equal(OPERATIONS.get('widgets.updateUserState'), 'widgets:update-user-state');
  assert.equal(READ_OPERATIONS.has('widgets.commit'), false);
  const preload = readFileSync('electron/preload.cjs', 'utf8');
  assert.match(preload, /updateUserState: invoke\('widgets:update-user-state'\)/);
  assert.match(preload, /readSource: invoke\('widgets:read-source'\)/);
});

test('Connect observer cannot invoke widget methods', () => {
  assert.equal(operationAllowed({ role: 'observer', projectIds: ['p'] }, 'widgets.list', () => true), false);
  assert.equal(operationAllowed({ role: 'observer', projectIds: ['p'] }, 'widgets.draft', () => true), false);
  assert.equal(operationAllowed({ role: 'observer', projectIds: ['p'] }, 'widgets.readSource', () => true), false);
});

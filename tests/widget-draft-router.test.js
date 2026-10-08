import { expect, it, vi } from 'vitest';
import { draftFocusWidget } from '../electron/backend/widget-draft-router.mjs';
import { materializeWidgetCandidates } from '../electron/backend/widget-composition.mjs';

const yes = { type: 'noul', noul: .95 };
const pick = (choice) => ({ type: 'choice', choice, confidence: .9 });

it('routes math and expanded families through Jev v2 while preserving v1 counter drafting', async () => {
  const resolveKey = vi.fn(async () => 'host-key');
  const fetchImpl = vi.fn(async (_url, request) => {
    expect(request.headers.authorization).toBe('Bearer host-key');
    const body = JSON.parse(request.body);
    if (body.state.candidates.some((item) => item.key === 'counter')) return { ok: true, json: async () => ({ answers: {
      suitable: yes, selection: pick('counter'), utility: { type: 'score', score: 2, confidence: .9 }, include_counter: yes
    } }) };
    const material = materializeWidgetCandidates(body.state.request);
    return { ok: true, json: async () => ({ answers: {
      suitable: yes, layout: pick('layoutCard'), grouping: pick('flat'), order: pick('inputsFirst'),
      ...Object.fromEntries(material.parts.map((item) => [`include_${item.id}`, yes])), include_heading: { type: 'noul', noul: .05 }
    } }) };
  });
  for (const [text, expected] of [
    ['12 + 8', 'formula'],
    ['calculator: (hours * rate) + fee with hours=4, rate=100, fee=20', 'formula'],
    ['Goal progress meter current 3 target 10', 'goal'],
    ['Small bar chart: Alpha 4, Beta 7', 'chart']
  ]) {
    const result = await draftFocusWidget({ projectId: 'p', text }, { resolveKey, fetchImpl });
    expect(result.status).toBe('draft');
    expect(result.spec.version).toBe(2);
    expect(result.candidate).toBe(expected);
    if (text === '12 + 8') expect(result.spec.size).toBe('small');
  }
  const v1 = await draftFocusWidget({ projectId: 'p', text: 'Count my laps' }, { resolveKey, fetchImpl });
  expect(v1.status).toBe('draft');
  expect(v1.spec.version).toBe(1);
  expect(v1.spec.blocks[0].type).toBe('counter');
  expect(resolveKey).toHaveBeenCalledTimes(5);
});

it('rejects invalid math and ordinary chat before credential lookup, and keeps eligible drafts key gated', async () => {
  const resolveKey = vi.fn(async () => null);
  const fetchImpl = vi.fn();
  expect(await draftFocusWidget({ projectId: 'p', text: 'calculator: 4 +' }, { resolveKey, fetchImpl })).toEqual({ status: 'fallback', reason: 'no_candidate' });
  expect(await draftFocusWidget({ projectId: 'p', text: 'Explain the release plan' }, { resolveKey, fetchImpl })).toEqual({ status: 'fallback', reason: 'no_candidate' });
  expect(resolveKey).not.toHaveBeenCalled();
  expect(await draftFocusWidget({ projectId: 'p', text: '12 + 8' }, { resolveKey, fetchImpl })).toEqual({ status: 'fallback', reason: 'key_missing' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

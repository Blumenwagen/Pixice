import { composeWidgetV2Draft, materializeWidgetCandidates } from './widget-composition.mjs';
import { composeWidgetDraft, widgetCandidates } from './widgets.mjs';

// Candidate selection stays local. The key is resolved only for a request that
// can become a widget; both composers still make the Jev decision on the host.
export async function draftFocusWidget(input, { resolveKey, signal, fetchImpl } = {}) {
  const material = materializeWidgetCandidates(input.text);
  if (material?.invalid) return { status: 'fallback', reason: 'no_candidate' };
  const useV2 = Boolean(material);
  if (!useV2 && widgetCandidates(input.text).length === 0) return { status: 'fallback', reason: 'no_candidate' };
  let key;
  try { key = await resolveKey(); }
  catch { return { status: 'fallback', reason: 'credential_error' }; }
  if (!key) return { status: 'fallback', reason: 'key_missing' };
  const options = { key, signal, ...(fetchImpl ? { fetchImpl } : {}) };
  if (useV2) {
    const draft = await composeWidgetV2Draft({ projectId: input.projectId, text: input.text }, options);
    const bareMath = material.kind === 'formula' && /^[\d\s()+\-*/×÷−.]+$/.test(input.text.trim());
    return draft.status === 'draft' && bareMath && !draft.spec.size
      ? { ...draft, spec: { ...draft.spec, size: 'small' } }
      : draft;
  }
  return composeWidgetDraft({ projectId: input.projectId, text: input.text, context: { projectName: input.projectName ?? '' } }, options);
}

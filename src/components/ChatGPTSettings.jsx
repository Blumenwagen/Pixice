import { useEffect, useState } from 'react';
import './devday.css';
export function ChatGPTSettings({ api }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!api?.chatgpt) return;
    let alive = true;
    const update = (value) => { if (alive) setState(value); };
    void api.chatgpt.state().then(update).catch((e) => { if (alive) setError(e.message); });
    const off = api.events.subscribe((event) => { if (event.type === 'ChatGPTState') update(event.payload); });
    return () => { alive = false; off(); };
  }, [api]);
  if (!api?.chatgpt) return null;
  const run = async (action) => {
    setBusy(true); setError('');
    try { await action(); setState(await api.chatgpt.state()); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <section className="settings-group devday-settings" aria-label="ChatGPT app sign-in">
    <header><h2>ChatGPT app sign-in</h2><p>Connect a ChatGPT account to Pixice and use its plan for eligible Codex inference. Your existing Codex account stays separate.</p></header>
    <div className="settings-card">
    <div className="settings-row"><div><strong>Continue with ChatGPT</strong><p>For personal projects running locally and eligible open-source apps. Paid or hosted distribution needs OpenAI participation access.</p></div><button className="settings-action primary" type="button" disabled={busy || state?.pending} onClick={() => run(() => api.chatgpt.signIn({}))}>Continue with ChatGPT</button></div>
    {state?.pending && <div className="settings-row"><div><strong>Finish sign-in in your browser</strong><p>Pixice verifies the account before saving it.</p></div><button className="settings-action" type="button" onClick={() => run(() => api.chatgpt.cancel())}>Cancel sign-in</button></div>}
    {state?.profiles.map((profile) => <div className="settings-row" key={profile.id}><div><strong>{profile.email ?? profile.name ?? 'ChatGPT account'}</strong><p>{profile.planEnabled ? 'Plan usage authorized' : profile.signedIn ? 'Identity connected. Plan usage is not authorized.' : 'Signed out'}{state.selectedProfileId === profile.id ? ' · Used for Codex' : ''}</p><small>{profile.clientId}</small></div><div className="devday-actions">
      <button className="settings-action" type="button" disabled={busy || state.pending} onClick={() => run(() => api.chatgpt.signIn({ profileId: profile.id }))}>{profile.signedIn ? 'Reauthorize' : 'Sign in'}</button>
      {profile.planEnabled && state.selectedProfileId !== profile.id && <button className="settings-action primary" type="button" disabled={busy} onClick={() => run(() => api.chatgpt.select({ profileId: profile.id }))}>Use for Codex</button>}
      {profile.signedIn && <button className="settings-action" type="button" disabled={busy} onClick={() => run(() => api.chatgpt.signOut({ profileId: profile.id }))}>Sign out</button>}
    </div></div>)}
    <div className="settings-row"><div><strong>Codex account source</strong><p>{state?.selectedProfileId ? 'Using the selected Pixice ChatGPT profile. Finish active Codex work before switching.' : 'Using the existing Codex CLI account.'}</p></div>{state?.selectedProfileId && <button className="settings-action" type="button" disabled={busy} onClick={() => run(() => api.chatgpt.select({ profileId: null }))}>Use existing Codex account</button>}</div>
    <div className="settings-row"><div><strong>Manage access and usage</strong><p>App sign-in grants eligible Responses requests. Cloud and conversational Voice currently use the existing Codex account.</p></div><button className="settings-action" type="button" onClick={() => run(() => api.chatgpt.manage())}>Open ChatGPT settings</button></div>
    </div>
    {state?.signOutResult && <p className="devday-notice" role={state.signOutResult.status === 'confirmed' ? 'status' : 'alert'}>{state.signOutResult.message}{state.signOutResult.status === 'unconfirmed' && <button className="settings-action" type="button" onClick={() => run(() => api.chatgpt.manage())}>Open ChatGPT settings</button>}</p>}
    {(error || state?.error) && <p className="devday-notice" role="alert">{error || state.error}</p>}
  </section>;
}

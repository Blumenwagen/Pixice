import { useEffect, useRef, useState } from 'react';
import './devday.css';
export function CodexCloudSettings({ api, projects = [], projectId: initialProjectId }) {
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? '');
  const [state, setState] = useState(null);
  const [environmentId, setEnvironmentId] = useState('');
  const [environmentName, setEnvironmentName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [branch, setBranch] = useState('');
  const [attempts, setAttempts] = useState(1);
  const [tasks, setTasks] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [taskId, setTaskId] = useState('');
  const [reviewAttempt, setReviewAttempt] = useState(1);
  const [inspection, setInspection] = useState(null);
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState(null);
  const confirmationRef = useRef(null);
  useEffect(() => { if (confirmation) confirmationRef.current?.focus(); }, [confirmation]);
  useEffect(() => {
    setState(null); setTasks([]); setCursor(null); setTaskId(''); setInspection(null); setResult(''); setEnvironmentId(''); setConfirmation(null);
    if (!api?.cloud || !projectId) return;
    let alive = true;
    void api.cloud.state({ projectId }).then((value) => { if (alive) setState(value); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [api, projectId]);
  if (!api?.cloud) return <p className="devday-notice">Manage Codex Cloud on the Pixice host desktop.</p>;
  const run = async (action) => {
    setError(''); setBusy(true);
    try { await action(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const list = async (nextCursor = null) => {
    const response = await api.cloud.list({ projectId, ...(environmentId ? { environmentId } : {}), ...(nextCursor ? { cursor: nextCursor } : {}) });
    if (!Array.isArray(response.data?.tasks)) throw new Error('The CLI returned an unsupported Cloud task-list format.');
    setTasks((current) => nextCursor ? [...current, ...response.data.tasks] : response.data.tasks);
    setCursor(response.data.cursor ?? null);
    if (response.warnings) setResult(response.warnings);
  };
  const inspect = async (operation, id = taskId) => {
    const response = await api.cloud[operation]({ projectId, taskId: id, ...(operation === 'diff' ? { attempt: reviewAttempt } : {}) });
    setInspection({ ...response, operation, taskId: id });
    setTaskId(id); setConfirmation(null);
  };
  const confirm = async () => {
    const action = confirmation;
    setConfirmation(null);
    if (action === 'submit') {
      const response = await api.cloud.submit({ projectId, environmentId, prompt, attempts, ...(branch.trim() ? { branch: branch.trim() } : {}) });
      setResult(response.output || 'Cloud submission accepted. Refresh tasks to inspect it.');
      setPrompt('');
      await list();
    } else if (action === 'apply') {
      const response = await api.cloud.apply({ projectId, taskId: inspection.taskId, reviewId: inspection.reviewId, expectedDiffHash: inspection.diffHash });
      setResult(response.output || 'Cloud patch applied to the selected project. Open Review to inspect local changes.');
      setInspection(null);
    }
  };
  const project = projects.find((p) => p.id === projectId);
  return <>
    <section className="settings-group devday-settings" aria-label="Codex Cloud">
      <header><h2>Codex Cloud</h2><p>Run a task in a published cloud environment, inspect its result, and choose when to apply its patch locally.</p></header>
      <div className="settings-card">
      <div className="settings-row"><div><strong>Project</strong><p>Cloud patches apply in this project's primary folder.</p></div><select className="settings-select" aria-label="Cloud project" value={projectId} disabled={busy} onChange={(e) => setProjectId(e.target.value)}><option value="" disabled>Choose project</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></div>
      <div className="settings-row"><div><strong>{state?.available ? 'CLI ready' : state ? 'CLI unavailable' : 'Checking Codex CLI…'}</strong><p>{state?.reason}</p></div><button className="settings-action" type="button" onClick={() => run(() => api.cloud.open())}>Open Codex Cloud</button></div>
      </div>
      <p className="settings-footnote">{state?.authentication} Cloud receives your prompt and uses the environment's repositories and services. Local files and Pixice browser sessions are not transferred.</p>
    </section>
    <section className="settings-group devday-settings" aria-label="Cloud environments">
      <header><h2>Environments</h2><p>The installed CLI browses environments interactively with <code>codex cloud</code>. It has no noninteractive environment-list command. Save an exact environment ID here for this project.</p></header>
      <div className="devday-form-row"><label>Environment ID<input aria-label="Cloud environment ID" value={environmentId} disabled={busy} onChange={(e) => { setEnvironmentId(e.target.value); setConfirmation(null); }} placeholder="Environment identifier" /></label><label>Name<input aria-label="Cloud environment name" value={environmentName} disabled={busy} onChange={(e) => setEnvironmentName(e.target.value)} placeholder="Project environment" /></label><button className="settings-action" type="button" disabled={busy || !projectId || !environmentId.trim() || !environmentName.trim()} onClick={() => run(async () => { const response = await api.cloud.saveEnvironment({ projectId, environment: { id: environmentId, name: environmentName } }); setState((s) => ({ ...s, environments: response.environments })); })}>Save environment</button></div>
      {(state?.environments ?? []).map((environment) => <div className="settings-row" key={environment.id}><div><strong>{environment.name}</strong><p>{environment.id}</p></div><div className="devday-actions"><button className="settings-action" type="button" disabled={busy} onClick={() => { setEnvironmentId(environment.id); setEnvironmentName(environment.name); setConfirmation(null); }}>Select</button><button className="settings-action" type="button" disabled={busy} onClick={() => run(async () => { const response = await api.cloud.removeEnvironment({ projectId, environmentId: environment.id }); setState((s) => ({ ...s, environments: response.environments })); })}>Remove</button></div></div>)}
    </section>
    <section className="settings-group devday-settings" aria-label="Submit Cloud task">
      <header><h2>Start a cloud task</h2><p>Submission starts real work using the environment's cloud permissions and account usage.</p></header>
      <label className="devday-input">Task prompt<textarea aria-label="Cloud task prompt" value={prompt} disabled={busy} onChange={(e) => { setPrompt(e.target.value); setConfirmation(null); }} rows={4} placeholder="Describe what Codex should do in the cloud" /></label>
      <div className="devday-form-row"><label>Branch<input aria-label="Cloud branch" value={branch} disabled={busy} onChange={(e) => { setBranch(e.target.value); setConfirmation(null); }} placeholder="Current branch" /></label><label>Attempts<select className="settings-select" aria-label="Cloud attempts" value={attempts} disabled={busy} onChange={(e) => { setAttempts(Number(e.target.value)); setConfirmation(null); }}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select></label><button type="button" className="settings-action primary" disabled={busy || !state?.available || !environmentId.trim() || !prompt.trim()} onClick={() => setConfirmation('submit')}>Review submission</button></div>
    </section>
    <section className="settings-group devday-settings" aria-label="Cloud tasks">
      <header><h2>Tasks and patches</h2><p>Refresh tasks from your Codex account, or inspect an exact task ID. Review a diff before applying it.</p></header>
      <div className="devday-form-row"><label>Attempt to review<select className="settings-select" aria-label="Cloud review attempt" value={reviewAttempt} disabled={busy} onChange={(e) => { setReviewAttempt(Number(e.target.value)); setInspection(null); setConfirmation(null); }}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select></label><p className="settings-footnote">Apply uses the exact reviewed snapshot, held for 10 minutes. It does not fetch the task's latest patch again.</p></div>
      <div className="devday-form-row"><button className="settings-action" type="button" disabled={busy || !state?.available} onClick={() => run(() => list())}>Refresh tasks</button><label>Task ID<input aria-label="Cloud task ID" value={taskId} disabled={busy} onChange={(e) => { setTaskId(e.target.value); setInspection(null); setConfirmation(null); }} /></label><button className="settings-action" type="button" disabled={busy || !taskId} onClick={() => run(() => inspect('status'))}>Check status</button><button className="settings-action" type="button" disabled={busy || !taskId} onClick={() => run(() => inspect('diff'))}>Review diff</button></div>
      {tasks.map((task) => <div className="settings-row" key={task.id}><div><strong>{task.title || task.id}</strong><p>{task.status} · {task.environment_label ?? 'Cloud'} · {task.summary?.files_changed ?? 0} files</p></div><div className="devday-actions"><button className="settings-action" type="button" disabled={busy} onClick={() => run(() => inspect('status', task.id))}>Status</button><button className="settings-action" type="button" disabled={busy} onClick={() => run(() => inspect('diff', task.id))}>Review diff</button></div></div>)}
      {cursor && <button className="settings-action" type="button" disabled={busy} onClick={() => run(() => list(cursor))}>Load more tasks</button>}
      {inspection && <div className="devday-inspection"><p>{inspection.operation === 'diff' ? `Patch, attempt ${inspection.attempt ?? reviewAttempt}` : 'Status'} for <code>{inspection.taskId}</code></p><pre tabIndex={0}>{inspection.output || 'No output returned.'}</pre>{inspection.warnings && <p className="devday-notice">{inspection.warnings}</p>}{inspection.operation === 'diff' && inspection.output && inspection.reviewId && <button className="settings-action primary" type="button" disabled={busy} onClick={() => setConfirmation('apply')}>Apply reviewed patch…</button>}</div>}
    </section>
    {confirmation && <section ref={confirmationRef} tabIndex={-1} className="devday-confirmation" role="region" aria-label={confirmation === 'submit' ? 'Confirm Cloud submission' : 'Confirm Cloud patch application'}><strong>{confirmation === 'submit' ? `Submit to ${environmentName || environmentId}?` : `Apply reviewed attempt ${inspection.attempt ?? reviewAttempt} of ${inspection.taskId} in ${project?.displayName ?? projectId}?`}</strong><p>{confirmation === 'submit' ? `${environmentId}. ${attempts} attempt${attempts === 1 ? '' : 's'} on ${branch || 'the current branch'}. This starts a remote job.` : `This applies the exact reviewed snapshot with Git in ${project?.canonicalPath ?? 'the selected project folder'}. Existing changes may conflict. Git will report apply failures.`}</p>{confirmation === 'submit' && <pre>{prompt}</pre>}<div className="devday-actions"><button className="settings-action" type="button" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button><button className="settings-action primary" type="button" disabled={busy} onClick={() => run(confirm)}>{confirmation === 'submit' ? 'Submit Cloud task' : 'Apply patch to project'}</button></div></section>}
    {busy && <p role="status" className="settings-footnote">Waiting for Codex Cloud…</p>}
    {result && <pre className="devday-output" role="status">{result}</pre>}
    {error && <p className="devday-notice" role="alert">{error}</p>}
  </>;
}

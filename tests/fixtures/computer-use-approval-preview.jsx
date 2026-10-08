import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApprovalCard } from '../../src/App.jsx';
import '../../src/styles.css';

const request = {
  id: 'preview-computer-access', provider: 'codex', requestGeneration: 1,
  method: 'mcpServer/elicitation/request', params: {
    serverName: 'computer', message: 'Allow ChatGPT to use Chrome?',
    _meta: { app_name: 'Chrome' },
    requestedSchema: { type: 'object', required: ['approval'], properties: {
      approval: { type: 'string', oneOf: [
        { const: 'once', title: 'Allow once' },
        { const: 'session', title: 'Allow for session' },
        { const: 'always', title: 'Always allow' }
      ] }
    } }
  }
};
const labels = { accept: 'Allowed once', acceptForSession: 'Allowed for session', acceptAlways: 'Always allowed', decline: 'Declined' };

function ApprovalPreview() {
  const [generation, setGeneration] = useState(1);
  const [decision, setDecision] = useState(null);
  return <div style={{ height: '100%', overflow: 'auto', padding: '80px 0', background: '#292b2e', '--canvas': '#292b2e', '--surface': '#303236', '--surface-raised': '#393c40', '--foreground': '#eeeeef', '--muted': '#afb2b8', '--quiet': '#9ea2a9', '--thread-bright': '#eeeeef', fontFamily: 'system-ui, sans-serif' }}><main style={{ width: 720, margin: '0 auto', color: 'var(--foreground)' }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 44 }}>
      <strong style={{ fontSize: 15 }}>Pixice</strong><span style={{ color: 'var(--muted)', fontSize: 13 }}>Focus · Improve composer interactions</span>
    </header>
    <p style={{ fontSize: 15, lineHeight: 1.7, marginBottom: 30 }}>I’ll open the composer preview in Chrome and check its interactions.</p>
    {decision ? <div style={{ padding: 15, borderTop: '1px solid var(--border)' }}>
      <strong style={{ fontSize: 13 }}>{labels[decision]} · Chrome</strong>
      <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 10 }}>The provider confirmed the response.</p>
      <button type="button" style={{ marginTop: 16, padding: '8px 12px', background: 'var(--surface-raised)', color: 'var(--foreground)', borderRadius: 8 }} onClick={() => { setDecision(null); setGeneration(value => value + 1); }}>Show request again</button>
    </div> : <ApprovalCard key={generation} request={{ ...request, requestGeneration: generation }} onResolve={async (_, response) => {
      await new Promise(resolve => setTimeout(resolve, 500));
      setDecision(response.decision);
      return { resolved: true };
    }} />}
    <p style={{ color: 'var(--quiet)', fontSize: 11, marginTop: 44 }}>Local preview · This uses Pixice’s real approval card with simulated provider confirmation.</p>
  </main></div>;
}
createRoot(document.getElementById('root')).render(<ApprovalPreview />);

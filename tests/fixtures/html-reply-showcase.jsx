import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MarkdownMessage } from '../../src/App.jsx';
import { HtmlReplyContext, HtmlReplyFrame } from '../../src/components/HtmlReply.jsx';
import showcase from '../../work/html-replies/showcase.html?raw';
import '../../src/styles.css';
import './html-reply-showcase.css';

// Uses the production Markdown fence parser, inline reply and Preview frame.
// The example's values and actions stay local to its sandbox.
function Showcase() {
  const [light, setLight] = useState(false);
  const [preview, setPreview] = useState(null);
  const [tab, setTab] = useState('conversation');
  const context = useMemo(() => ({ open: reply => { setPreview(reply); setTab('preview'); } }), []);
  const message = useMemo(() => 'An answer can be a calculator, a comparison, a clickable diagram or a working interface. Try the tabs below.\n\n```pixice-html\n' + JSON.stringify({ title: 'HTML answer playground', html: showcase, height: 1200 }) + '\n```', []);
  const palette = light ? { '--canvas': '#f8f8f7', '--foreground': '#222326', '--surface': '#f0f0ee', '--surface-raised': '#e8e9e7', '--muted': '#676b70', '--quiet': '#75797f', '--border': '#d9dcd9', '--primary': '#6e689e', colorScheme: 'light' } : { '--canvas': '#292b2e', '--foreground': '#eeeeef', '--surface': '#303236', '--surface-raised': '#393c40', '--muted': '#afb2b8', '--quiet': '#9ea2a9', '--border': '#4b4e54', '--primary': '#aaa5da', colorScheme: 'dark' };
  return <div className="html-showcase-shell" style={palette}>
    <header className="html-showcase-header">
      <div><strong>Pixice</strong><span>Inline HTML replies</span></div>
      <button type="button" aria-label={light ? 'Use dark appearance' : 'Use light appearance'} onClick={() => setLight(current => !current)}>{light ? 'Dark appearance' : 'Light appearance'}</button>
    </header>
    <main className="html-showcase-main">
      <div className="html-showcase-tabs" role="tablist" aria-label="Reply workspace">
        <button type="button" role="tab" aria-selected={tab === 'conversation'} onClick={() => setTab('conversation')}>Conversation</button>
        {preview && <button type="button" role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')}>{preview.title}</button>}
      </div>
      <HtmlReplyContext.Provider value={context}>
        <div hidden={tab !== 'conversation'} className="html-showcase-conversation">
          <div className="html-showcase-user">Show me what inline arbitrary HTML answers can do now.</div>
          <article className="message assistant-message"><MarkdownMessage text={message} /></article>
          <p className="html-showcase-footnote">Example data · changes stay inside this reply</p>
        </div>
        {preview && <div hidden={tab !== 'preview'} className="html-showcase-preview"><HtmlReplyFrame html={preview.html} title={preview.title} expanded /></div>}
      </HtmlReplyContext.Provider>
    </main>
  </div>;
}
createRoot(document.getElementById('root')).render(<Showcase />);

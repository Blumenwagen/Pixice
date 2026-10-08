import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MarkdownMessage } from '../../src/App.jsx';
import { HtmlReplyContext, HtmlReplyFrame } from '../../src/components/HtmlReply.jsx';
import mockup from '../../work/html-replies/composer-mockup.html?raw';
import '../../src/styles.css';
import './html-reply-showcase.css';

// A development conversation using the actual inline HTML reply renderer.
// Every composer control and submission in the authored HTML is local demo state.
function ComposerReplyPreview() {
  const [light, setLight] = useState(false);
  const [preview, setPreview] = useState(null);
  const [tab, setTab] = useState('conversation');
  const context = useMemo(() => ({ open: reply => { setPreview(reply); setTab('preview'); } }), []);
  const message = useMemo(() => 'Yes. A reply can contain a playable Pixice composer mockup. Type a prompt, switch models, add context or insert a saved prompt, then try Send.\n\n```pixice-html\n' + JSON.stringify({ title: 'Pixice composer · interactive mockup', html: mockup, height: 1200 }) + '\n```', []);
  const palette = light ? { '--canvas': '#f8f8f7', '--foreground': '#222326', '--surface': '#f0f0ee', '--surface-raised': '#e8e9e7', '--muted': '#676b70', '--quiet': '#75797f', '--border': '#d9dcd9', '--primary': '#6e689e', colorScheme: 'light' } : { '--canvas': '#292b2e', '--foreground': '#eeeeef', '--surface': '#303236', '--surface-raised': '#393c40', '--muted': '#afb2b8', '--quiet': '#9ea2a9', '--border': '#4b4e54', '--primary': '#aaa5da', colorScheme: 'dark' };
  return <div className="html-showcase-shell" style={palette}>
    <header className="html-showcase-header">
      <div><strong>Pixice</strong><span>Composer inside a reply</span></div>
      <button type="button" aria-label={light ? 'Use dark appearance' : 'Use light appearance'} onClick={() => setLight(current => !current)}>{light ? 'Dark appearance' : 'Light appearance'}</button>
    </header>
    <main className="html-showcase-main">
      <div className="html-showcase-tabs" role="tablist" aria-label="Reply workspace">
        <button type="button" role="tab" aria-selected={tab === 'conversation'} onClick={() => setTab('conversation')}>Conversation</button>
        {preview && <button type="button" role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')}>{preview.title}</button>}
      </div>
      <HtmlReplyContext.Provider value={context}>
        <div hidden={tab !== 'conversation'} className="html-showcase-conversation">
          <div className="html-showcase-user">Could you create a Pixice composer mockup right in chat?</div>
          <article className="message assistant-message"><MarkdownMessage text={message} /></article>
          <p className="html-showcase-footnote">Interactive design example · Send stays inside this reply</p>
        </div>
        {preview && <div hidden={tab !== 'preview'} className="html-showcase-preview"><HtmlReplyFrame html={preview.html} title={preview.title} expanded /></div>}
      </HtmlReplyContext.Provider>
    </main>
  </div>;
}
createRoot(document.getElementById('root')).render(<ComposerReplyPreview />);

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RemoteBrowserSurface, browserPoint } from '../src/connect/RemoteBrowserSurface.jsx';
import { browserFrameLayout, FRAME_EXPIRY_MS, nextFrameDelay } from '../src/connect/remote-browser-utils.js';
afterEach(()=>vi.restoreAllMocks());
const frame={frameId:'frame',width:800,height:600,image:'data:image/jpeg;base64,anBlZw=='};
function fixture(input=vi.fn(async()=>({ok:true})), frameResult=frame, rect={width:800,height:600}) {
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:rect.width,height:rect.height});
  const results = Array.isArray(frameResult) ? [...frameResult] : null;
  const api={browser:{frame:vi.fn(async()=>{
    const result = results ? results.shift() : frameResult;
    if (result instanceof Error) throw result;
    return typeof result === 'function' ? result() : result;
  }),input}};
  render(<RemoteBrowserSurface api={api} workspaceId="task" tabId="tab"/>);
  return api;
}
async function loadedFrame() {
  const image = await screen.findByAltText('Live preview of the host browser tab');
  fireEvent.load(document.querySelector('.connect-browser-pending-image') || image);
  await waitFor(() => expect(screen.getByRole('application')).toHaveAttribute('aria-disabled', 'false'));
  return image;
}
describe('remote browser interaction surface',()=>{
  it('maps letterboxed screenshots and rejects clicks outside the page',()=>{
    const rect={left:10,top:20,width:1000,height:600};
    expect(browserPoint(rect,frame,110,20)).toEqual({x:0,y:0});
    expect(browserPoint(rect,frame,10,20)).toBeNull();
    expect(browserPoint(rect,frame,510,320)).toEqual({x:400,y:300});
    expect(browserPoint(rect,frame,400,300,{zoom:2,scrollLeft:400,scrollTop:300})).toEqual({x:545,y:440});
    expect(browserFrameLayout({width:800,height:600},frame,2)).toMatchObject({width:1600,height:1200});
  });
  it('routes clicks, keyboard and pasted text to the observed host frame',async()=>{
    const api=fixture();await loadedFrame();
    const surface=screen.getByRole('application',{name:'Remote browser page'});
    fireEvent.click(surface,{clientX:200,clientY:100});
    await waitFor(()=>expect(api.browser.input).toHaveBeenCalledTimes(1));
    await loadedFrame();
    fireEvent.keyDown(surface,{key:'x'});
    await waitFor(()=>expect(api.browser.input).toHaveBeenCalledTimes(2));
    await loadedFrame();
    fireEvent.paste(surface,{clipboardData:{getData:()=> 'pasted text'}});
    await waitFor(()=>expect(api.browser.input).toHaveBeenCalledTimes(3));
    await waitFor(()=>expect(api.browser.frame.mock.calls.length).toBeGreaterThan(1));
    expect(api.browser.input.mock.calls.map(([args])=>args.input.type)).toEqual(['click','text','text']);
    expect(api.browser.input.mock.calls[0][0]).toMatchObject({workspaceId:'task',tabId:'tab',frameId:'frame',input:{x:200,y:100}});
    fireEvent.click(screen.getByRole('button',{name:'Pause'}));
    expect(screen.getByText('Preview paused')).toBeInTheDocument();
    expect(screen.queryByAltText('Live preview of the host browser tab')).not.toBeInTheDocument();
  });
  it('drops unsent input after an uncertain failure instead of replaying it',async()=>{
    const input=vi.fn(async()=>{throw new Error('Action may have reached the host');});
    fixture(input);await loadedFrame();
    const surface=screen.getByRole('application');
    fireEvent.keyDown(surface,{key:'a'});fireEvent.keyDown(surface,{key:'b'});fireEvent.keyDown(surface,{key:'c'});
    expect(await screen.findByRole('alert')).toHaveTextContent('may have reached');
    expect(input).toHaveBeenCalledOnce();
  });

  it.each([
    ['resolve', (release) => release({ ok: true })],
    ['reject', (release) => release(new Error('old host failed'))],
  ])('ignores an old host input %s after the surface switches lifecycle', async (_outcome, finish) => {
    let release;
    vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:800,height:600});
    const inputA = vi.fn(() => new Promise((resolve, reject) => { release = (value) => value instanceof Error ? reject(value) : resolve(value); }));
    const apiA = { browser: { frame: vi.fn(async () => ({ ...frame, frameId: 'frame-a' })), input: inputA } };
    const { rerender } = render(<RemoteBrowserSurface api={apiA} workspaceId="workspace-a" tabId="tab-a" />);
    await loadedFrame();
    fireEvent.keyDown(screen.getByRole('application'), { key: 'x' });
    await waitFor(() => expect(inputA).toHaveBeenCalledOnce());

    const inputB = vi.fn(async () => ({ ok: true }));
    const apiB = { browser: { frame: vi.fn(async () => ({ ...frame, frameId: 'frame-b' })), input: inputB } };
    rerender(<RemoteBrowserSurface api={apiB} workspaceId="workspace-b" tabId="tab-b" />);
    await loadedFrame();
    const frameCallsBeforeRelease = apiB.browser.frame.mock.calls.length;
    finish(release);
    await waitFor(() => expect(inputA).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(apiB.browser.frame).toHaveBeenCalledTimes(frameCallsBeforeRelease);
    expect(screen.getByRole('application')).toHaveAttribute('aria-disabled', 'false');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['resolve', (release) => release({ ok: true })],
    ['reject', (release) => release(new Error('old host failed'))],
  ])('does not let an old text send clear or stop the replacement lifecycle on %s', async (_outcome, finish) => {
    let releaseA;
    vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:800,height:600});
    const inputA = vi.fn(() => new Promise((resolve, reject) => { releaseA = (value) => value instanceof Error ? reject(value) : resolve(value); }));
    const apiA = { browser: { frame: vi.fn(async () => ({ ...frame, frameId: 'frame-a' })), input: inputA } };
    const { rerender } = render(<RemoteBrowserSurface api={apiA} workspaceId="workspace-a" tabId="tab-a" />);
    await loadedFrame();
    fireEvent.click(screen.getByRole('button', { name: 'Type text' }));
    fireEvent.change(screen.getByLabelText('Text to type on host page'), { target: { value: 'old text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Type', exact: true }));
    await waitFor(() => expect(inputA).toHaveBeenCalledOnce());

    let releaseB;
    const inputB = vi.fn(() => new Promise((resolve) => { releaseB = resolve; }));
    const apiB = { browser: { frame: vi.fn(async () => ({ ...frame, frameId: 'frame-b' })), input: inputB } };
    rerender(<RemoteBrowserSurface api={apiB} workspaceId="workspace-b" tabId="tab-b" />);
    await loadedFrame();
    const textBox = screen.getByLabelText('Text to type on host page');
    fireEvent.change(textBox, { target: { value: 'new text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Type', exact: true }));
    await waitFor(() => expect(inputB).toHaveBeenCalledOnce());
    finish(releaseA);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByLabelText('Text to type on host page')).toBeDisabled();
    expect(screen.getByLabelText('Text to type on host page')).toHaveValue('new text');
    releaseB({ ok: true });
    await waitFor(() => expect(screen.getByLabelText('Text to type on host page')).toHaveValue(''));
  });

  it('supports explicit text entry for mobile keyboards',async()=>{
    const api=fixture();await loadedFrame();
    fireEvent.click(screen.getByRole('button',{name:'Type text'}));
    fireEvent.change(screen.getByLabelText('Text to type on host page'),{target:{value:'こんにちは'}});
    fireEvent.click(screen.getByRole('button',{name:'Type',exact:true}));
    await waitFor(()=>expect(api.browser.input).toHaveBeenCalledWith(expect.objectContaining({input:{type:'text',text:'こんにちは'}})));
    expect(screen.getByLabelText('Text to type on host page')).toHaveValue('');
  });

  it('keeps input disabled until the current image has loaded',async()=>{
    fixture();
    const image=await screen.findByAltText('Live preview of the host browser tab');
    expect(screen.getByRole('application')).toHaveAttribute('aria-disabled','true');
    fireEvent.load(image);
    await waitFor(()=>expect(screen.getByRole('application')).toHaveAttribute('aria-disabled','false'));
  });

  it('drops queued input after the surface becomes hidden',async()=>{
    let release;
    const input=vi.fn(()=>new Promise((resolve)=>{release=resolve;}));
    const api=fixture(input);
    await loadedFrame();
    const surface=screen.getByRole('application');
    fireEvent.keyDown(surface,{key:'x'});
    await waitFor(()=>expect(input).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(surface,{key:'y'});
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
    fireEvent(document,new Event('visibilitychange'));
    release({ok:true});
    await waitFor(()=>expect(input).toHaveBeenCalledTimes(1));
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
  });

  it('drops queued input when refresh leads to a capture error',async()=>{
    let release;
    const input=vi.fn(()=>new Promise((resolve)=>{release=resolve;}));
    const api=fixture(input,[frame,new Error('capture failed')]);
    await loadedFrame();
    const surface=screen.getByRole('application');
    fireEvent.keyDown(surface,{key:'x'});
    await waitFor(()=>expect(input).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(surface,{key:'y'});
    fireEvent.click(screen.getByRole('button',{name:'Refresh',exact:true}));
    await screen.findByText('capture failed');
    release({ok:true});
    await waitFor(()=>expect(input).toHaveBeenCalledTimes(1));
    expect(api.browser.frame).toHaveBeenCalledTimes(3);
  });

  it('drops a queued dispatch when the displayed frame expires',async()=>{
    let release;
    const input=vi.fn(()=>new Promise((resolve)=>{release=resolve;}));
    const api=fixture(input);
    await loadedFrame();
    api.browser.frame.mockImplementation(()=>new Promise(()=>{}));
    const surface=screen.getByRole('application');
    fireEvent.keyDown(surface,{key:'x'});
    await waitFor(()=>expect(input).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(surface,{key:'y'});
    const currentTime=Date.now();
    vi.spyOn(Date,'now').mockReturnValue(currentTime+FRAME_EXPIRY_MS+1);
    release({ok:true});
    await waitFor(()=>expect(input).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('alert')).toHaveTextContent('fresh preview');
  });

  it('pans only from the focused wrapper and sends host surface keys',async()=>{
    const api=fixture();
    await loadedFrame();
    const surface=screen.getByRole('application');
    const wrapper=screen.getByRole('region',{name:'Scrollable remote browser viewport'});
    wrapper.scrollBy=vi.fn();
    fireEvent.click(screen.getByRole('button',{name:'200%'}));
    fireEvent.keyDown(wrapper,{key:'ArrowRight'});
    expect(wrapper.scrollBy).toHaveBeenCalled();
    const panCalls=wrapper.scrollBy.mock.calls.length;
    fireEvent.keyDown(surface,{key:'ArrowRight'});
    await waitFor(()=>expect(api.browser.input).toHaveBeenCalledTimes(1));
    await loadedFrame();
    fireEvent.keyDown(surface,{key:' '});
    await waitFor(()=>expect(api.browser.input).toHaveBeenCalledTimes(2));
    expect(wrapper.scrollBy).toHaveBeenCalledTimes(panCalls);
    expect(api.browser.input.mock.calls.map(([args])=>args.input)).toEqual([
      {type:'key',key:'ArrowRight',modifiers:[]},
      {type:'text',text:' '}
    ]);
  });

  it('ignores stale image events and preserves the displayed image after decode failure',async()=>{
    const next={frameId:'frame-2',width:800,height:600,image:'data:image/jpeg;base64,anBlZzI='};
    const api=fixture(undefined,[frame,next]);
    await loadedFrame();
    const displayed=screen.getByAltText('Live preview of the host browser tab');
    fireEvent.click(screen.getByRole('button',{name:'Refresh',exact:true}));
    await waitFor(()=>expect(api.browser.frame).toHaveBeenCalledTimes(2));
    const pending=document.querySelector('.connect-browser-pending-image');
    expect(pending).toBeInTheDocument();
    fireEvent.load(displayed);
    expect(screen.getByRole('application')).toHaveAttribute('aria-disabled','true');
    pending.decode=vi.fn(async()=>{throw new Error('decode failed');});
    fireEvent.load(pending);
    await screen.findByText(/could not be displayed/);
    expect(screen.getByAltText('Live preview of the host browser tab')).toHaveAttribute('src',frame.image);
    expect(screen.getByRole('application')).toHaveAttribute('aria-disabled','true');
  });

  it('negotiates quality after the old-contract first capture',async()=>{
    const api=fixture(undefined,{...frame,supportedOptions:['quality']});
    await loadedFrame();
    expect(api.browser.frame.mock.calls[0][0]).not.toHaveProperty('quality');
    fireEvent.click(screen.getByRole('button',{name:'Sharper'}));
    await waitFor(()=>expect(api.browser.frame.mock.calls.length).toBeGreaterThan(1));
    expect(api.browser.frame.mock.calls[1][0]).toMatchObject({quality:88});
  });

  it('keeps quality controls disabled for legacy hosts',async()=>{
    const api=fixture();
    await loadedFrame();
    expect(screen.getByRole('button',{name:'Sharper'})).toBeDisabled();
    expect(screen.getByText('Host controls quality automatically.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Sharper'}));
    expect(api.browser.frame).toHaveBeenCalledTimes(1);
  });

  it('clamps capture dimensions without shrinking the layout viewport',async()=>{
    const api=fixture(undefined,frame,{width:5000.5,height:5000.5});
    await loadedFrame();
    expect(api.browser.frame.mock.calls[0][0]).toMatchObject({width:4096,height:4096});
    expect(screen.getByRole('application')).toHaveStyle({width:'5001px',height:'3750px'});
  });

  it('keeps the last image while disabling input after a transient frame error',async()=>{
    const api=fixture(undefined,[frame,new Error('temporary network failure')]);
    await loadedFrame();
    fireEvent.click(screen.getByRole('button',{name:'Refresh',exact:true}));
    await screen.findByText('temporary network failure');
    expect(screen.getByAltText('Live preview of the host browser tab')).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Enter'})).toBeDisabled();
    expect(screen.getByRole('application')).toHaveAttribute('aria-disabled','true');
  });

  it('paces retries and stops polling when paused',async()=>{
    expect(nextFrameDelay({failureCount:2})).toBeGreaterThan(nextFrameDelay({failureCount:1}));
    const api=fixture();
    await loadedFrame();
    fireEvent.click(screen.getByRole('button',{name:'Pause'}));
    const callsAtPause=api.browser.frame.mock.calls.length;
    await new Promise((resolve)=>setTimeout(resolve,20));
    expect(api.browser.frame.mock.calls.length).toBe(callsAtPause);
    expect(screen.getByLabelText(/Preview status: Paused/)).toBeInTheDocument();
  });
});

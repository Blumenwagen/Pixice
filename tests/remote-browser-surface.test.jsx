import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RemoteBrowserSurface, browserPoint } from '../src/connect/RemoteBrowserSurface.jsx';
afterEach(()=>vi.restoreAllMocks());
const frame={frameId:'frame',width:800,height:600,image:'data:image/jpeg;base64,anBlZw=='};
function fixture(input=vi.fn(async()=>({ok:true}))) {
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:800,height:600});
  const api={browser:{frame:vi.fn(async()=>frame),input}};
  render(<RemoteBrowserSurface api={api} workspaceId="task" tabId="tab"/>);
  return api;
}
describe('remote browser interaction surface',()=>{
  it('maps letterboxed screenshots and rejects clicks outside the page',()=>{
    const rect={left:10,top:20,width:1000,height:600};
    expect(browserPoint(rect,frame,110,20)).toEqual({x:0,y:0});
    expect(browserPoint(rect,frame,10,20)).toBeNull();
    expect(browserPoint(rect,frame,510,320)).toEqual({x:400,y:300});
  });
  it('routes clicks, keyboard and pasted text to the observed host frame',async()=>{
    const api=fixture();await screen.findByAltText('Live preview of the host browser tab');
    const surface=screen.getByRole('application',{name:'Remote browser page'});
    fireEvent.click(surface,{clientX:200,clientY:100});
    fireEvent.keyDown(surface,{key:'x'});
    fireEvent.paste(surface,{clipboardData:{getData:()=> 'pasted text'}});
    await waitFor(()=>expect(api.browser.input).toHaveBeenCalledTimes(3));
    expect(api.browser.input.mock.calls.map(([args])=>args.input.type)).toEqual(['click','text','text']);
    expect(api.browser.input.mock.calls[0][0]).toMatchObject({workspaceId:'task',tabId:'tab',frameId:'frame',input:{x:200,y:100}});
    fireEvent.click(screen.getByRole('button',{name:'Pause'}));
    expect(screen.getByText('Preview paused')).toBeInTheDocument();
    expect(screen.queryByAltText('Live preview of the host browser tab')).not.toBeInTheDocument();
  });
  it('drops unsent input after an uncertain failure instead of replaying it',async()=>{
    const input=vi.fn(async()=>{throw new Error('Action may have reached the host');});
    fixture(input);await screen.findByAltText('Live preview of the host browser tab');
    const surface=screen.getByRole('application');
    fireEvent.keyDown(surface,{key:'a'});fireEvent.keyDown(surface,{key:'b'});fireEvent.keyDown(surface,{key:'c'});
    expect(await screen.findByRole('alert')).toHaveTextContent('may have reached');
    expect(input).toHaveBeenCalledOnce();
  });
  it('supports explicit text entry for mobile keyboards',async()=>{
    const api=fixture();await screen.findByAltText('Live preview of the host browser tab');
    fireEvent.click(screen.getByRole('button',{name:'Type text'}));
    fireEvent.change(screen.getByLabelText('Text to type on host page'),{target:{value:'こんにちは'}});
    fireEvent.click(screen.getByRole('button',{name:'Type',exact:true}));
    await waitFor(()=>expect(api.browser.input).toHaveBeenCalledWith(expect.objectContaining({input:{type:'text',text:'こんにちは'}})));
    expect(screen.getByLabelText('Text to type on host page')).toHaveValue('');
  });
});

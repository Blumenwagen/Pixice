import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { browserFrameSchema, DEFAULT_BROWSER_QUALITY, MAX_BROWSER_QUALITY, MIN_BROWSER_QUALITY, RemoteBrowser } from '../electron/browser/remote-browser.mjs';
function harness() {
  let time = 1000;
  let visible = false;
  let bounds = {x:20,y:30,width:900,height:600};
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.backgroundThrottling = true;
  contents.debugger = {isAttached:()=>false,attach:vi.fn(),sendCommand:vi.fn(async()=>({data:Buffer.from('jpeg').toString('base64')})),detach:vi.fn()};
  contents.capturePage = vi.fn(async()=>({isEmpty:()=>false,getSize:()=>({width:900,height:600}),toJPEG:()=>Buffer.from('jpeg')}));
  const tab = {view:{webContents:contents,getBounds:()=>bounds,setBounds:vi.fn((value)=>{bounds=value;})}};
  const browser = new RemoteBrowser({target:(workspaceId,tabId)=>{if(workspaceId!=='task'||tabId!=='tab')throw new Error('Unknown tab');return{tab,locallyVisible:()=>visible};},now:()=>time});
  const scope = {workspaceId:'task',tabId:'tab'};
  return {browser,contents,tab,scope,frame:()=>browser.frame({...scope,width:640,height:480}),expire:()=>{time+=5001;},visible:()=>{visible=true;}};
}
describe('remote host browser boundary',()=>{
  it('bounds optional screenshot quality and defaults new frames to balanced quality',async()=>{
    const h=harness();
    expect(browserFrameSchema.parse({...h.scope,width:640,height:480})).not.toHaveProperty('quality');
    expect(browserFrameSchema.parse({...h.scope,width:640,height:480,quality:MIN_BROWSER_QUALITY}).quality).toBe(MIN_BROWSER_QUALITY);
    expect(browserFrameSchema.parse({...h.scope,width:640,height:480,quality:MAX_BROWSER_QUALITY}).quality).toBe(MAX_BROWSER_QUALITY);
    await h.frame();
    expect(h.contents.debugger.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot',expect.objectContaining({quality:DEFAULT_BROWSER_QUALITY}));
    await expect(h.browser.frame({...h.scope,width:640,height:480,quality:MIN_BROWSER_QUALITY - 1})).rejects.toThrow();
    await expect(h.browser.frame({...h.scope,width:640,height:480,quality:MAX_BROWSER_QUALITY + 1})).rejects.toThrow();
  });

  it('captures detached tabs at a bounded size without moving a visible host view',async()=>{
    const h=harness();
    const frame=await h.frame();
    expect(frame).toMatchObject({width:640,height:480,image:'data:image/jpeg;base64,anBlZw==',supportedOptions:['quality']});
    expect(h.contents.debugger.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot',{format:'jpeg',quality:72,fromSurface:true,captureBeyondViewport:false});
    h.visible();h.tab.view.setBounds({x:20,y:30,width:900,height:600});h.tab.view.setBounds.mockClear();
    expect(await h.frame()).toMatchObject({width:900,height:600});
    expect(h.tab.view.setBounds).not.toHaveBeenCalled();
  });
  it('rejects navigation, resize, expired and mismatched frames before sending input',async()=>{
    const h=harness();const action={type:'click',x:20,y:20};
    const first=await h.frame();
    h.contents.emit('did-start-navigation');
    await expect(h.browser.input({...h.scope,frameId:first.frameId,input:action})).rejects.toThrow('changed or expired');
    const second=await h.frame();h.tab.view.setBounds({x:0,y:0,width:800,height:500});
    await expect(h.browser.input({...h.scope,frameId:second.frameId,input:action})).rejects.toThrow('changed or expired');
    const third=await h.frame();h.expire();
    await expect(h.browser.input({...h.scope,frameId:third.frameId,input:action})).rejects.toThrow('changed or expired');
    await expect(h.browser.input({...h.scope,tabId:'other',frameId:third.frameId,input:action})).rejects.toThrow('Unknown tab');
    expect(h.contents.debugger.sendCommand.mock.calls.some(([method])=>method.startsWith('Input.'))).toBe(false);
  });
  it('accepts only fixed input actions, bounds coordinates, and preserves text literally',async()=>{
    const h=harness();const frame=await h.frame();
    const invoke=(input)=>h.browser.input({...h.scope,frameId:frame.frameId,input});
    await expect(invoke({type:'click',x:640,y:20})).rejects.toThrow('outside');
    await expect(invoke({type:'script',text:'document.cookie'})).rejects.toThrow();
    await expect(invoke({type:'text',text:'safe',method:'Runtime.evaluate'})).rejects.toThrow();
    const text='Quotes "; document.cookie; — こんにちは';
    await invoke({type:'text',text});
    expect(h.contents.debugger.sendCommand).toHaveBeenCalledWith('Input.insertText',{text});
    await invoke({type:'click',x:20,y:30});
    expect(h.contents.debugger.sendCommand.mock.calls.slice(-2).map(([,args])=>args.type)).toEqual(['mousePressed','mouseReleased']);
    await invoke({type:'key',key:'a',modifiers:['meta']});
    expect(h.contents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchKeyEvent',expect.objectContaining({type:'keyDown',commands:['selectAll']}));
  });
  it('restores normal background rendering after the viewer stops requesting frames', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.contents.debugger.isAttached = () => true;
      await h.frame();
      expect(h.contents.backgroundThrottling).toBe(false);
      await vi.advanceTimersByTimeAsync(5100);
      expect(h.contents.backgroundThrottling).toBe(true);
      expect(h.contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setFocusEmulationEnabled', { enabled: false });
    } finally { vi.useRealTimers(); }
  });
  it('discards a screenshot that races a navigation',async()=>{
    const h=harness();const original=h.contents.debugger.sendCommand.getMockImplementation();
    h.contents.debugger.sendCommand.mockImplementation(async()=>{h.contents.emit('did-navigate');return original();});
    await expect(h.frame()).rejects.toThrow('changed while capturing');
    expect(h.browser.frames.size).toBe(0);
  });
});

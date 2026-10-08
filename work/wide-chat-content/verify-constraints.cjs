const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
app.setPath('userData','/tmp/pixice-wide-chat-constraints');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1920,height:1200,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const rows=[];
 win.webContents.on('console-message',(_event,_level,message)=>console.log('renderer:',message));
 try {
  for(const scenario of (process.argv[2] ? process.argv[2].split(',') : ['focus-widgets','task-inspector','focus-narrow','task-narrow'])) {
   console.log('scenario',scenario);
   win.setSize(scenario.includes('narrow')?390:1920,scenario.includes('narrow')?860:1200);
   const mode=scenario.startsWith('focus')?'focus':'task';
   await win.loadURL(`http://127.0.0.1:5183/work/wide-chat-content/preview.html?mode=${mode}${scenario.includes('narrow')?'':'&rails'}`);
   for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript("Boolean(document.querySelector('.inline-visualization'))")) break;await wait(100);}
   await win.webContents.executeJavaScript('document.fonts.ready');
   await wait(400);
   if(scenario==='task-narrow') { await win.webContents.executeJavaScript(`document.querySelector('.rail-toggle').click()`); await wait(400); }
   if(scenario==='task-inspector') {
    await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Toggle task inspector"]').click()`);
    await wait(500);
   }
   await win.webContents.executeJavaScript(`(()=>{const scroll=document.querySelector('.focus-conversation-scroll,.conversation-scroll');scroll.scrollTop=0;})()`);
   await wait(150);
   const row=await win.webContents.executeJavaScript(`(()=>{
    const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,top:r.top,bottom:r.bottom}};
    const scroll=document.querySelector('.focus-conversation-scroll,.conversation-scroll');
    const rich=[...document.querySelectorAll('.message-rich-block')].map(rect);
    const overlays=[...document.querySelectorAll('.focus-task-rail,.widget-shelf,.inspector.open,[data-prompt-preview-rail]')].filter(el=>el.getBoundingClientRect().width).map(el=>({kind:el.className,...rect(el)}));
    const canvas=rect(scroll);
    return {viewport:{width:innerWidth,height:innerHeight},canvas,rich,overlays,pageOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,canvasOverflow:scroll.scrollWidth-scroll.clientWidth,widgets:[...document.querySelectorAll('.widget-shelf-widget')].map(rect),prose:rect(document.querySelector('.assistant-message .markdown-body > p'))};
   })()`);
   console.log(JSON.stringify({scenario,...row}));
   if(row.pageOverflow||row.canvasOverflow)throw new Error('Overflow '+scenario);
   for(const rich of row.rich){
    if(rich.left<row.canvas.left-1||rich.right>row.canvas.right+1)throw new Error('Rich outside canvas '+scenario);
    for(const rail of row.overlays) if(rich.right>rail.left && rich.left<rail.right)throw new Error('Rich beneath '+rail.kind);
   }
   if(scenario==='focus-widgets'&&!row.widgets.length)throw new Error('Missing widget shelf');
   if(scenario==='task-inspector'&&!row.overlays.some(o=>o.kind.includes('inspector')))throw new Error('Missing inspector');
   rows.push({scenario,...row});
   fs.writeFileSync(`${__dirname}/after-${scenario}.png`,(await win.webContents.capturePage()).toPNG());
   if(scenario==='task-narrow') { await win.webContents.executeJavaScript(`document.querySelector('.rail-toggle').click()`); await wait(400); }
   if(scenario==='task-inspector') {
    await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Toggle task inspector"]').click()`);
    await wait(450);
    await win.webContents.executeJavaScript(`document.querySelector('[data-prompt-preview-rail] button').dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}))`);
    await wait(300);
    const clearance=await win.webContents.executeJavaScript(`(()=>{const rich=document.querySelector('.message-rich-block').getBoundingClientRect(),tip=document.querySelector('[data-prompt-preview-rail] div[aria-hidden="true"]').getBoundingClientRect();return {richLeft:rich.left,tipRight:tip.right};})()`);
    if(!clearance.tipRight || clearance.richLeft<clearance.tipRight+11)throw new Error('Prompt preview covers rich content');
    rows.at(-1).promptTooltipClearance=clearance;
    fs.writeFileSync(`${__dirname}/after-task-prompt-rail.png`,(await win.webContents.capturePage()).toPNG());
   }
   await win.webContents.executeJavaScript(`document.querySelector('.inline-viz-timeline-item').click()`);
   const detail=await win.webContents.executeJavaScript(`Boolean(document.querySelector('.inline-viz-temporal-detail'))`);
   if(!detail)throw new Error('Timeline selection failed');
   await win.webContents.executeJavaScript(`(()=>{const calendar=document.querySelector('.inline-viz-calendar');[...calendar.querySelectorAll('button')].find(b=>b.textContent==='Agenda').click()})()`);
   await wait(50);
   await win.webContents.executeJavaScript(`document.querySelector('.inline-viz-agenda-row').click()`);
   const calendarDetail=await win.webContents.executeJavaScript(`document.querySelectorAll('.inline-viz-temporal-detail').length`);
   if(calendarDetail!==2)throw new Error('Calendar selection failed');
   rows.at(-1).temporalInteraction='Timeline details and calendar agenda/details passed';
  }
  const existing=fs.existsSync(`${__dirname}/constraints.json`)?JSON.parse(fs.readFileSync(`${__dirname}/constraints.json`)):[];
  fs.writeFileSync(`${__dirname}/constraints.json`,JSON.stringify([...existing.filter(r=>!rows.some(n=>n.scenario===r.scenario)),...rows],null,2)+'\n');
  console.log(JSON.stringify(rows,null,2));
 }finally{win.destroy();app.quit();}
}).catch(e=>{console.error(e);app.exit(1)});

const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
app.setPath('userData','/tmp/pixice-wide-chat-evidence');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const phase=process.argv[2]||'before';
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1920,height:1200,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const results=[];
 win.webContents.on('console-message',(_event,_level,message)=>console.log('renderer:',message));
 try {
  for (const mode of ['focus','task']) {
   console.log('capturing',phase,mode);
   await win.loadURL(`http://127.0.0.1:5183/work/wide-chat-content/preview.html?mode=${mode}`);
   for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript("Boolean(document.querySelector('.inline-visualization'))")) break;await wait(100);}
   await win.webContents.executeJavaScript('document.fonts.ready');
   await wait(400);
   for(const layout of ['desktop','preview']){
    console.log('layout',layout);
    if(layout==='preview') await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Open preview workspace"]').click()`);
    await wait(450);
    await win.webContents.executeJavaScript(`document.querySelector('.focus-conversation-scroll, .conversation-scroll').scrollTop=0`);
    await wait(100);
    const measurements=await win.webContents.executeJavaScript(`(()=>{
     const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right}};
     const pick=s=>{const el=document.querySelector(s);return el?rect(el):null};
     const scroll=document.querySelector('.focus-conversation-scroll, .conversation-scroll');
     const table=document.querySelector('.message-table-wrap');
     const edges=[table.getBoundingClientRect().left+4,table.getBoundingClientRect().right-4].map(x=>Boolean(document.elementFromPoint(x,table.getBoundingClientRect().top+40)?.closest('.message-table-wrap')));
     return {viewport:{width:innerWidth,height:innerHeight},canvas:rect(scroll),prose:pick('.assistant-message .markdown-body > p'),header:pick('.assistant-message h2'),table:rect(table),visuals:[...document.querySelectorAll('.inline-visualization')].map(rect),user:pick('.user-message'),composer:pick('.composer'),scrollOverflow:scroll.scrollWidth-scroll.clientWidth,pageOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,tableScrollWidth:table.scrollWidth,tableClientWidth:table.clientWidth,edgesVisible:edges,overlays:[...document.querySelectorAll('.focus-task-rail,.widget-shelf,.inspector.open,[data-prompt-preview-rail]')].filter(el=>el.getBoundingClientRect().width).map(el=>({kind:el.className,...rect(el)})),containment:getComputedStyle(document.querySelector('.conversation-turn')).contentVisibility};
    })()`);
    const name=`${phase}-${mode}-${layout}`;
    fs.writeFileSync(`${__dirname}/${name}.png`,(await win.webContents.capturePage()).toPNG());
    results.push({name,...measurements});
    if(phase==='after') {
     if(measurements.pageOverflow || measurements.scrollOverflow || measurements.edgesVisible.some(v=>!v)) throw new Error('Overflow or painted edge failure: '+name);
     const baseline=JSON.parse(fs.readFileSync(`${__dirname}/before-measurements.json`)).find(row=>row.name===name.replace('after','before'));
     for(const key of ['prose','header','user','composer']) for(const axis of ['x','width']) {
      if(Math.abs(measurements[key][axis]-baseline[key][axis])>1) throw new Error(`${name} moved ${key}.${axis}`);
     }
     if(layout==='desktop' && measurements.table.width<=measurements.prose.width) throw new Error('Rich block did not widen');
     await win.webContents.executeJavaScript(`document.querySelector('.focus-conversation-scroll, .conversation-scroll').scrollTop=220`);
     await wait(120);
     fs.writeFileSync(`${__dirname}/${name}-chart.png`,(await win.webContents.capturePage()).toPNG());
     await win.webContents.executeJavaScript(`document.querySelector('.inline-viz-range input').focus()`);
     win.webContents.sendInputEvent({type:'keyDown',keyCode:'End'});
     win.webContents.sendInputEvent({type:'keyUp',keyCode:'End'});
     await wait(120);
     const metric=await win.webContents.executeJavaScript(`document.querySelector('.inline-viz-metrics article').textContent`);
     if(!metric.includes('100')) throw new Error('Range did not update: '+metric);
     results.at(-1).interaction={metric};
     await win.webContents.executeJavaScript(`document.querySelector('.message-table-wrap').focus()`);
     win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});
     win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});
     await wait(200);
     const localScroll=await win.webContents.executeJavaScript(`document.querySelector('.message-table-wrap').scrollLeft`);
     if(layout==='preview' && localScroll===0) throw new Error('Table keyboard scroll failed');
     results.at(-1).tableKeyboardScroll=localScroll;
     if(mode==='focus') for (const [index,kind] of [[1,'timeline'],[2,'calendar']]) {
      await win.webContents.executeJavaScript(`(()=>{const el=document.querySelectorAll('.inline-visualization')[${index}], scroll=document.querySelector('.focus-conversation-scroll');scroll.scrollTop+=el.getBoundingClientRect().top-scroll.getBoundingClientRect().top-24})()`);
      await wait(120);
      fs.writeFileSync(`${__dirname}/${name}-${kind}.png`,(await win.webContents.capturePage()).toPNG());
     }
    }
   }
  }
  fs.writeFileSync(`${__dirname}/${phase}-measurements.json`,JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify(results,null,2));
 }finally{win.destroy();app.quit();}
}).catch(e=>{console.error(e);app.exit(1)});

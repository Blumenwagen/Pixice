import React from "react";
import { createRoot } from "react-dom/client";
import { createTaskProgressPreviewApi } from "/src/task-progress-preview.js";
import { createWorkspaceStorage } from "/src/connect/execution-storage.js";
import { ConnectRoot } from "/src/connect/ConnectRoot.jsx";
import { App } from "/src/App.jsx";
import { WorkflowHost } from "/src/components/workflows/WorkflowHost.jsx";
import { TaskPreviewHost } from "/src/components/TaskPreviewHost.jsx";
import "/src/styles.css";
import "/src/components/workflows/WorkflowHost.css";
// Actual App, isolated synthetic mixed assistant message. No production thread mutations.
const params = new URLSearchParams(location.search);
const focus = params.get('mode') !== 'task';
window.pixice = createTaskProgressPreviewApi({ focusPreview: focus, focusV2Preview: focus });
createWorkspaceStorage("local").setItem("pixice.surfaceMode", focus ? "focus" : "workspace");
if (!params.has('rails')) {
  window.pixice.widgets.list = async () => ({ data: [] });
  window.pixice.threads.children = async () => ({ data: [], nextCursor: null });
}
const chart = {
  version: 1, title: "Delivery by month", description: "Adjust the forecast to compare capacity.",
  controls: [{id:"capacity", type:"range", label:"Capacity", min:0, max:100, step:5, value:50}],
  metrics: [{label:"Forecast", value:{base:40,add:{capacity:0.6}}}],
  chart: {type:"bar", height:160, data:[{label:"July",actual:42,forecast:55},{label:"August",actual:61,forecast:70},{label:"September",actual:75,forecast:{base:50,add:{capacity:0.6}}}],series:[{key:"actual",label:"Actual",color:"blue"},{key:"forecast",label:"Forecast",color:"green"}]}
};
const timeline = {version:1,title:"Release schedule",timeline:{start:"2026-09-01",end:"2026-10-15",today:"2026-09-30",items:[{id:"build",label:"Desktop delivery",start:"2026-09-10",end:"2026-10-02",status:"active",progress:80},{id:"release",label:"Release",start:"2026-10-05",type:"milestone",dependsOn:["build"]}]}};
const calendar = {version:1,title:"Review calendar",calendar:{date:"2026-09-30",today:"2026-09-30",events:[{id:"review",title:"Delivery review",start:"2026-09-30T09:00:00Z",detail:"Inspect the release candidate."}]}};
const text = [
  "## Delivery review",
  "This paragraph keeps the same readable text width. The table and interactive chart in this same response can use the available canvas. Headers, timestamps, user messages and the composer stay in place.",
  "| Workstream | Owner | Current milestone | Target date | Capacity | Status |" + "\n" +
  "| --- | --- | --- | --- | --- | --- |" + "\n" +
  "| Desktop delivery | Platform team | Complete shared renderer integration | 02 October 2026 | 48 engineer hours | Ready for review |" + "\n" +
  "| Browser preview | Interface team | Verify split canvas and local scrolling | 06 October 2026 | 32 engineer hours | In progress |" + "\n" +
  "| Calendar and timeline | Product team | Check interactive detail selection | 09 October 2026 | 24 engineer hours | Planned |",
  "The forecast below is interactive. Move Capacity to change the metric and the September forecast.",
  "```pixice-visualization\n" + JSON.stringify(chart) + "\n```",
  "Ordinary prose resumes at its original position after the wider visualization.",
  "```pixice-visualization\n" + JSON.stringify(timeline) + "\n```",
  "```pixice-visualization\n" + JSON.stringify(calendar) + "\n```"
].join("\n\n");
const { thread } = await window.pixice.threads.read({ threadId: focus ? "preview-focus" : "preview-task" });
thread.status = {type:"idle"};
thread.turns = [{ id:"wide-review",status:"completed",startedAt:"2026-09-30T11:00:00Z",completedAt:"2026-09-30T11:02:00Z",items:[
  {id:"prompt",type:"userMessage",content:[{type:"text",text:"Show the delivery data and forecast."}]},
  {id:"answer",type:"agentMessage",phase:"final_answer",text}
]}];
if (!focus && params.has('rails')) thread.turns.unshift({id:'earlier-turn',status:'completed',items:[
  {id:'earlier-prompt',type:'userMessage',content:[{type:'text',text:'Keep the delivery overview readable.'}]},
  {id:'earlier-answer',type:'agentMessage',phase:'final_answer',text:'The overview uses the standard text column.'}
]});
const read = window.pixice.threads.read;
window.pixice.threads.read = async args => args.threadId === thread.id ? {thread,plan:[]} : read(args);
createRoot(document.getElementById("root")).render(<ConnectRoot><WorkflowHost><TaskPreviewHost><App /></TaskPreviewHost></WorkflowHost></ConnectRoot>);

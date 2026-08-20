import {
  ArrowClockwise,
  Bell,
  Brain,
  Code,
  File,
  Gauge,
  GitBranch,
  Globe,
  Lightning,
  List,
  PlugsConnected,
  Sparkle,
  Stack,
  TreeStructure
} from "../icons/index.jsx";

export function WorkflowNodeIcon({ type, size = 19 }) {
  if (type === "manualTrigger") return <Lightning size={size} />;
  if (type === "scheduleTrigger") return <Gauge size={size} />;
  if (type === "webhookTrigger") return <PlugsConnected size={size} />;
  if (type === "loomAgent") return <Brain size={size} />;
  if (type === "httpRequest") return <Globe size={size} />;
  if (type === "transform") return <Sparkle size={size} />;
  if (type === "aggregate") return <Stack size={size} />;
  if (type === "condition") return <GitBranch size={size} />;
  if (type === "switch") return <TreeStructure size={size} />;
  if (type === "merge") return <Stack size={size} />;
  if (type === "delay") return <Gauge size={size} />;
  if (type === "loop") return <ArrowClockwise size={size} />;
  if (type === "file") return <File size={size} />;
  if (type === "git") return <GitBranch size={size} />;
  if (type === "database") return <Stack size={size} />;
  if (type === "executeWorkflow") return <TreeStructure size={size} />;
  if (type === "notification") return <Bell size={size} />;
  if (type === "board") return <List size={size} />;
  return <Code size={size} />;
}

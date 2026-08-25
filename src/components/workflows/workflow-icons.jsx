import {
  ArrowClockwise,
  Bell,
  Brain,
  CaretRight,
  Code,
  File,
  Files,
  Gauge,
  GitBranch,
  Globe,
  List,
  PaperPlaneTilt,
  Pause,
  PlugsConnected,
  Sparkle,
  Stack,
  TerminalWindow,
  TreeStructure
} from "../icons/index.jsx";

export const WORKFLOW_ICONS = Object.freeze({
  manualTrigger: CaretRight,
  scheduleTrigger: Gauge,
  taskEventTrigger: Gauge,
  webhookTrigger: PlugsConnected,
  useSkill: Sparkle,
  pixiceAgent: Brain,
  httpRequest: Globe,
  transform: Code,
  aggregate: Files,
  condition: GitBranch,
  switch: TreeStructure,
  merge: PlugsConnected,
  delay: Pause,
  loop: ArrowClockwise,
  file: File,
  command: TerminalWindow,
  git: GitBranch,
  database: Stack,
  executeWorkflow: TreeStructure,
  notification: Bell,
  planWork: Gauge,
  board: List,
  output: PaperPlaneTilt
});

export function WorkflowNodeIcon({ type, size = 19 }) {
  const Icon = WORKFLOW_ICONS[type] ?? Code;
  return <Icon size={size} />;
}

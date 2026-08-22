import {
  Bell,
  ChartLineUp,
  Eye,
  GitDiff,
  Globe,
  Lightning,
  List,
  PaperPlaneTilt,
  PencilSimple,
  TreeStructure
} from "./index.jsx";

// Product-level meanings live here so the same glyph does not quietly acquire
// a second, unrelated job in another part of Loom.
export const APP_ICONS = Object.freeze({
  newTask: PencilSimple,
  board: List,
  attention: Bell,
  review: GitDiff,
  preview: Globe,
  taskMap: TreeStructure,
  taskProgress: ChartLineUp,
  fastMode: Lightning,
  autoReview: Eye,
  startTask: PaperPlaneTilt
});

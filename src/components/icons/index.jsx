import { forwardRef, useEffect, useId, useImperativeHandle, useRef } from "react";
import { BadgeAlertIcon } from "./badge-alert";
import { BellIcon } from "./bell";
import { BrainIcon } from "./brain";
import { ChartLineIcon } from "./chart-line";
import { CheckIcon } from "./check";
import { ChevronDownIcon } from "./chevron-down";
import { ChevronLeftIcon } from "./chevron-left";
import { ChevronRightIcon } from "./chevron-right";
import { CircleCheckIcon } from "./circle-check";
import { CircleDashedIcon } from "./circle-dashed";
import { CircleHelpIcon } from "./circle-help";
import { ConnectIcon } from "./connect";
import { DeleteIcon } from "./delete";
import { EarthIcon } from "./earth";
import { EyeIcon } from "./eye";
import { FileStackIcon } from "./file-stack";
import { FileTextIcon } from "./file-text";
import { FolderCodeIcon } from "./folder-code";
import { FolderDotIcon } from "./folder-dot";
import { FolderOpenIcon } from "./folder-open";
import { GalleryThumbnailsIcon } from "./gallery-thumbnails";
import { GaugeIcon } from "./gauge";
import { GitBranchIcon } from "./git-branch";
import { GitCompareArrowsIcon } from "./git-compare-arrows";
import { LayersIcon } from "./layers";
import { LoaderCircleIcon } from "./loader-circle";
import { LockKeyholeIcon } from "./lock-keyhole";
import { MenuIcon } from "./menu";
import { MonitorCogIcon } from "./monitor-cog";
import { PauseIcon } from "./pause";
import { PlusIcon } from "./plus";
import { RefreshCWIcon } from "./refresh-cw";
import { SearchIcon } from "./search";
import { SendIcon } from "./send";
import { SettingsIcon } from "./settings";
import { ShieldCheckIcon } from "./shield-check";
import { SparklesIcon } from "./sparkles";
import { SquarePenIcon } from "./square-pen";
import { TerminalIcon } from "./terminal";
import { WorkflowIcon } from "./workflow";
import { XIcon } from "./x";
import { ZapIcon } from "./zap";

function loomIcon(Icon, displayName) {
  const PixiceIcon = forwardRef(({ weight: _weight, mirrored: _mirrored, className = "", "aria-label": ariaLabel, onMouseEnter, onMouseLeave, ...props }, ref) => {
    const animationRef = useRef(null);
    const iconId = useId();

    useImperativeHandle(ref, () => ({
      startAnimation: () => animationRef.current?.startAnimation(),
      stopAnimation: () => animationRef.current?.stopAnimation(),
    }));

    useEffect(() => {
      const root = document.querySelector(`[data-loom-icon="${iconId}"]`);
      if (!root) return undefined;
      const target = root.closest("button, a, label, [role='button'], [role='tab']") ?? root;
      const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
        || Boolean(root.closest('[data-reduce-motion="true"]'));
      const start = (event) => {
        if (!reduceMotion()) animationRef.current?.startAnimation();
        onMouseEnter?.(event);
      };
      const stop = (event) => {
        animationRef.current?.stopAnimation();
        onMouseLeave?.(event);
      };
      target.addEventListener("mouseenter", start);
      target.addEventListener("mouseleave", stop);
      return () => {
        target.removeEventListener("mouseenter", start);
        target.removeEventListener("mouseleave", stop);
      };
    }, [iconId, onMouseEnter, onMouseLeave]);

    return (
      <Icon
        ref={animationRef}
        className={`animated-icon ${className}`.trim()}
        data-loom-icon={iconId}
        aria-hidden={ariaLabel ? undefined : true}
        aria-label={ariaLabel}
        {...props}
      />
    );
  });
  PixiceIcon.displayName = displayName;
  return PixiceIcon;
}

export const ArrowClockwise = loomIcon(RefreshCWIcon, "ArrowClockwise");
export const Bell = loomIcon(BellIcon, "Bell");
export const Brain = loomIcon(BrainIcon, "Brain");
export const CaretDown = loomIcon(ChevronDownIcon, "CaretDown");
export const CaretLeft = loomIcon(ChevronLeftIcon, "CaretLeft");
export const CaretRight = loomIcon(ChevronRightIcon, "CaretRight");
export const ChartLineUp = loomIcon(ChartLineIcon, "ChartLineUp");
export const Check = loomIcon(CheckIcon, "Check");
export const CheckCircle = loomIcon(CircleCheckIcon, "CheckCircle");
export const Circle = loomIcon(CircleDashedIcon, "Circle");
export const Code = loomIcon(FolderCodeIcon, "Code");
export const Desktop = loomIcon(MonitorCogIcon, "Desktop");
export const Eye = loomIcon(EyeIcon, "Eye");
export const File = loomIcon(FileTextIcon, "File");
export const Files = loomIcon(FileStackIcon, "Files");
export const Folder = loomIcon(FolderDotIcon, "Folder");
export const FolderOpen = loomIcon(FolderOpenIcon, "FolderOpen");
export const Gauge = loomIcon(GaugeIcon, "Gauge");
export const Gear = loomIcon(SettingsIcon, "Gear");
export const GitBranch = loomIcon(GitBranchIcon, "GitBranch");
export const GitDiff = loomIcon(GitCompareArrowsIcon, "GitDiff");
export const Globe = loomIcon(EarthIcon, "Globe");
export const ImageSquare = loomIcon(GalleryThumbnailsIcon, "ImageSquare");
export const Info = loomIcon(CircleHelpIcon, "Info");
export const Lightning = loomIcon(ZapIcon, "Lightning");
export const List = loomIcon(MenuIcon, "List");
export const LockKey = loomIcon(LockKeyholeIcon, "LockKey");
export const MagnifyingGlass = loomIcon(SearchIcon, "MagnifyingGlass");
export const PaperPlaneTilt = loomIcon(SendIcon, "PaperPlaneTilt");
export const Pause = loomIcon(PauseIcon, "Pause");
export const PencilSimple = loomIcon(SquarePenIcon, "PencilSimple");
export const PlugsConnected = loomIcon(ConnectIcon, "PlugsConnected");
export const Plus = loomIcon(PlusIcon, "Plus");
export const ShieldCheck = loomIcon(ShieldCheckIcon, "ShieldCheck");
export const Sparkle = loomIcon(SparklesIcon, "Sparkle");
export const SpinnerGap = loomIcon(LoaderCircleIcon, "SpinnerGap");
export const Stack = loomIcon(LayersIcon, "Stack");
export const TerminalWindow = loomIcon(TerminalIcon, "TerminalWindow");
export const Trash = loomIcon(DeleteIcon, "Trash");
export const TreeStructure = loomIcon(WorkflowIcon, "TreeStructure");
export const Warning = loomIcon(BadgeAlertIcon, "Warning");
export const X = loomIcon(XIcon, "X");

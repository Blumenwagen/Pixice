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

function pixiceIcon(Icon, displayName) {
  const PixiceIcon = forwardRef(({ weight: _weight, mirrored: _mirrored, className = "", "aria-label": ariaLabel, onMouseEnter, onMouseLeave, ...props }, ref) => {
    const animationRef = useRef(null);
    const iconId = useId();

    useImperativeHandle(ref, () => ({
      startAnimation: () => animationRef.current?.startAnimation(),
      stopAnimation: () => animationRef.current?.stopAnimation(),
    }));

    useEffect(() => {
      const root = document.querySelector(`[data-pixice-icon="${iconId}"]`);
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
        data-pixice-icon={iconId}
        aria-hidden={ariaLabel ? undefined : true}
        aria-label={ariaLabel}
        {...props}
      />
    );
  });
  PixiceIcon.displayName = displayName;
  return PixiceIcon;
}

export const ArrowClockwise = pixiceIcon(RefreshCWIcon, "ArrowClockwise");
export const Bell = pixiceIcon(BellIcon, "Bell");
export const Brain = pixiceIcon(BrainIcon, "Brain");
export const CaretDown = pixiceIcon(ChevronDownIcon, "CaretDown");
export const CaretLeft = pixiceIcon(ChevronLeftIcon, "CaretLeft");
export const CaretRight = pixiceIcon(ChevronRightIcon, "CaretRight");
export const ChartLineUp = pixiceIcon(ChartLineIcon, "ChartLineUp");
export const Check = pixiceIcon(CheckIcon, "Check");
export const CheckCircle = pixiceIcon(CircleCheckIcon, "CheckCircle");
export const Circle = pixiceIcon(CircleDashedIcon, "Circle");
export const Code = pixiceIcon(FolderCodeIcon, "Code");
export const Desktop = pixiceIcon(MonitorCogIcon, "Desktop");
export const Eye = pixiceIcon(EyeIcon, "Eye");
export const File = pixiceIcon(FileTextIcon, "File");
export const Files = pixiceIcon(FileStackIcon, "Files");
export const Folder = pixiceIcon(FolderDotIcon, "Folder");
export const FolderOpen = pixiceIcon(FolderOpenIcon, "FolderOpen");
export const Gauge = pixiceIcon(GaugeIcon, "Gauge");
export const Gear = pixiceIcon(SettingsIcon, "Gear");
export const GitBranch = pixiceIcon(GitBranchIcon, "GitBranch");
export const GitDiff = pixiceIcon(GitCompareArrowsIcon, "GitDiff");
export const Globe = pixiceIcon(EarthIcon, "Globe");
export const ImageSquare = pixiceIcon(GalleryThumbnailsIcon, "ImageSquare");
export const Info = pixiceIcon(CircleHelpIcon, "Info");
export const Lightning = pixiceIcon(ZapIcon, "Lightning");
export const List = pixiceIcon(MenuIcon, "List");
export const LockKey = pixiceIcon(LockKeyholeIcon, "LockKey");
export const MagnifyingGlass = pixiceIcon(SearchIcon, "MagnifyingGlass");
export const PaperPlaneTilt = pixiceIcon(SendIcon, "PaperPlaneTilt");
export const Pause = pixiceIcon(PauseIcon, "Pause");
export const PencilSimple = pixiceIcon(SquarePenIcon, "PencilSimple");
export const PlugsConnected = pixiceIcon(ConnectIcon, "PlugsConnected");
export const Plus = pixiceIcon(PlusIcon, "Plus");
export const ShieldCheck = pixiceIcon(ShieldCheckIcon, "ShieldCheck");
export const Sparkle = pixiceIcon(SparklesIcon, "Sparkle");
export const SpinnerGap = pixiceIcon(LoaderCircleIcon, "SpinnerGap");
export const Stack = pixiceIcon(LayersIcon, "Stack");
export const TerminalWindow = pixiceIcon(TerminalIcon, "TerminalWindow");
export const Trash = pixiceIcon(DeleteIcon, "Trash");
export const TreeStructure = pixiceIcon(WorkflowIcon, "TreeStructure");
export const Warning = pixiceIcon(BadgeAlertIcon, "Warning");
export const X = pixiceIcon(XIcon, "X");

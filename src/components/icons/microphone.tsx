"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";

export interface MicrophoneIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface MicrophoneIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

// The capsule lifts slightly out of its stand on hover. The stand stays put so
// the glyph still reads as a microphone mid-animation.
const CAPSULE_VARIANTS: Variants = {
  normal: { y: 0 },
  animate: {
    y: [0, -1.5, 0],
    transition: { duration: 0.5, ease: "easeInOut" },
  },
};

const MicrophoneIcon = forwardRef<MicrophoneIconHandle, MicrophoneIconProps>(
  ({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
    const controls = useAnimation();
    const isControlledRef = useRef(false);

    useImperativeHandle(ref, () => {
      isControlledRef.current = true;

      return {
        startAnimation: () => controls.start("animate"),
        stopAnimation: () => controls.start("normal"),
      };
    });

    const handleMouseEnter = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) {
          onMouseEnter?.(e);
        } else {
          controls.start("animate");
        }
      },
      [controls, onMouseEnter]
    );

    const handleMouseLeave = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) {
          onMouseLeave?.(e);
        } else {
          controls.start("normal");
        }
      },
      [controls, onMouseLeave]
    );

    return (
      <div
        className={cn(className)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        {...props}
      >
        <svg
          fill="none"
          height={size}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
        >
          <motion.rect
            animate={controls}
            height="13"
            rx="4"
            variants={CAPSULE_VARIANTS}
            width="8"
            x="8"
            y="2"
          />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <path d="M12 19v3" />
        </svg>
      </div>
    );
  }
);

MicrophoneIcon.displayName = "MicrophoneIcon";

export { MicrophoneIcon };

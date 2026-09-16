import { useReducedMotion } from "motion/react";
import { TextMorph } from "torph/react";

const MORPH_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

function textValue(value) {
  if (value === null || value === undefined || typeof value === "boolean") return "";
  return typeof value === "number" ? value : String(value);
}

export function MorphText({
  value,
  children,
  as = "span",
  className,
  duration = 320,
  ease = MORPH_EASE,
  numbers = true,
  scale = false,
  disabled = false,
  ...props
}) {
  const systemReducedMotion = useReducedMotion();
  const motionMediaAvailable = typeof window === "undefined" || typeof window.matchMedia === "function";
  const webAnimationsAvailable = typeof Element === "undefined"
    || (typeof Element.prototype.animate === "function" && typeof Element.prototype.getAnimations === "function");
  const appReducedMotion = typeof document !== "undefined"
    && document.querySelector('.pixice-app[data-reduce-motion="true"]');
  const text = textValue(value ?? children);

  if (!motionMediaAvailable || !webAnimationsAvailable) {
    const ElementType = as;
    return <ElementType className={className}>{text}</ElementType>;
  }

  return (
    <TextMorph
      as={as}
      className={className}
      duration={duration}
      ease={ease}
      numbers={numbers}
      scale={scale}
      disabled={Boolean(disabled || systemReducedMotion || appReducedMotion)}
      respectReducedMotion={motionMediaAvailable}
      {...props}
    >
      {text}
    </TextMorph>
  );
}

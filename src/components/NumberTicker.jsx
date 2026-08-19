import { useEffect, useMemo, useRef, useState } from "react";

const DIGIT_HEIGHT_EM = 1.1;
const DIGITS = Array.from({ length: 10 }, (_, number) => number);

export function NumberTicker({
  value,
  pad,
  duration = 0.9,
  stagger = 0.04,
  startOnView = true,
  prefix,
  suffix,
  blur = false,
  className = "",
  digitClassName = "",
  locale,
  format
}) {
  const containerRef = useRef(null);
  const [armed, setArmed] = useState(!startOnView);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (!startOnView) {
      setArmed(true);
      return undefined;
    }

    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setArmed(true);
      return undefined;
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setArmed(true);
      observer.disconnect();
    }, { threshold: 0.6 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [startOnView]);

  const text = useMemo(() => {
    const rounded = Math.round(Number(value) || 0);
    const formatted = format
      ? format(rounded)
      : locale
        ? rounded.toLocaleString()
        : rounded.toString();
    return pad ? formatted.padStart(pad, "0") : formatted;
  }, [value, pad, format, locale]);

  const glyphs = useMemo(() => {
    const chars = text.split("");
    return chars.map((char, index) => ({ char, id: `g-${chars.length - 1 - index}` }));
  }, [text]);

  useEffect(() => {
    if (!armed || entered) return undefined;
    const timeout = window.setTimeout(
      () => setEntered(true),
      (duration + glyphs.length * stagger) * 1000
    );
    return () => window.clearTimeout(timeout);
  }, [armed, entered, duration, stagger, glyphs.length]);

  const readableText = `${prefix ?? ""}${text}${suffix ?? ""}`;

  return (
    <span ref={containerRef} className={`number-ticker ${className}`.trim()} aria-label={readableText}>
      <span className="sr-only">{readableText}</span>
      <span aria-hidden="true" className="number-ticker-glyphs">
        {prefix ? <span>{prefix}</span> : null}
        {glyphs.map(({ char, id }, index) => {
          if (!/\d/.test(char)) return <span key={id}>{char}</span>;
          return (
            <Digit
              key={id}
              digit={armed ? Number(char) : 0}
              delay={entered ? 0 : index * stagger}
              duration={duration}
              blur={blur}
              className={digitClassName}
            />
          );
        })}
        {suffix ? <span>{suffix}</span> : null}
      </span>
    </span>
  );
}

function Digit({ digit, delay, duration, blur, className }) {
  const columnRef = useRef(null);
  const delayRef = useRef(delay);
  delayRef.current = delay;

  useEffect(() => {
    const node = columnRef.current;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
      || node?.closest('[data-reduce-motion="true"]');
    if (!blur || !node?.animate || reduceMotion || !Number.isFinite(digit)) return undefined;

    const animation = node.animate(
      { filter: ["blur(10px)", "blur(0px)"] },
      {
        duration: Math.min(duration * 750, 320),
        delay: delayRef.current * 1000,
        easing: "cubic-bezier(.16, 1, .3, 1)"
      }
    );
    return () => {
      animation.cancel();
      node.style.filter = "blur(0px)";
    };
  }, [blur, digit, duration]);

  return (
    <span
      className={`number-ticker-digit ${className}`.trim()}
      style={{ height: `${DIGIT_HEIGHT_EM}em`, width: "1ch" }}
    >
      <span
        ref={columnRef}
        className="number-ticker-column"
        style={{
          transform: `translateY(-${digit * DIGIT_HEIGHT_EM}em)`,
          transitionDelay: `${delay}s`,
          transitionDuration: `${duration}s`
        }}
      >
        {DIGITS.map((number) => (
          <span key={number}>{number}</span>
        ))}
      </span>
    </span>
  );
}

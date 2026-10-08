import { Children, Fragment, cloneElement, isValidElement, useLayoutEffect, useRef } from "react";
import styles from "./StreamingTextVariants.module.css";

function CascadeWord({ word, animate, ordinal }) {
  // Keep the entrance assigned at mount. Appending to a partial word must not
  // restart its animation, and finishing a turn must not remount its text.
  const entrance = useRef({ animate, delay: ordinal % 4 * 24 });
  return entrance.current.animate
    ? <span className={styles.cascadeWord} style={{ "--word-stagger": `${entrance.current.delay}ms` }}>{word}</span>
    : word;
}

export function GentleCascade({ children, text, active = false }) {
  const previous = useRef({ text: "", words: 0, streamed: false });
  const continuing = text.startsWith(previous.current.text);
  const revealFrom = active && continuing ? previous.current.words : Infinity;
  let words = 0;

  function decorate(nodes) {
    return Children.map(nodes, (node) => {
      if (typeof node === "string") {
        return node.split(/(\s+)/).map((word, index) => {
          if (!word || /^\s+$/.test(word)) return <Fragment key={index}>{word}</Fragment>;
          const ordinal = words++;
          // Large catch-up snapshots should stay cheap and immediately readable.
          const animate = ordinal >= revealFrom && ordinal < revealFrom + 128;
          return <CascadeWord word={word} animate={animate} ordinal={ordinal} key={index} />;
        });
      }
      // Code, embedded tools, and links retain their own rendering and behavior.
      if (!isValidElement(node) || typeof node.type !== "string" || ["pre", "code"].includes(node.type)) return node;
      return cloneElement(node, undefined, decorate(node.props.children));
    });
  }

  const shouldDecorate = active || previous.current.streamed;
  if (!shouldDecorate) {
    const count = (nodes) => Children.forEach(nodes, (node) => {
      if (typeof node === "string") words += (node.match(/\S+/g) ?? []).length;
      else if (isValidElement(node) && typeof node.type === "string" && !["pre", "code"].includes(node.type)) count(node.props.children);
    });
    count(children);
  }
  const rendered = shouldDecorate ? decorate(children) : children;
  useLayoutEffect(() => {
    previous.current = { text, words, streamed: shouldDecorate };
  });
  return rendered;
}

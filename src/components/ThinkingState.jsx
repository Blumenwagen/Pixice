"use client";

import styles from "./ThinkingState.module.css";

export function ThinkingState({ children = "Thinking" }) {
  return <span className={styles.shimmer} data-shimmer-label="">{children}</span>;
}

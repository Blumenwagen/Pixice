import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownMessage, WorkingTrace } from "../src/App.jsx";
import styles from "../src/components/StreamingTextVariants.module.css";

const revealing = (container) => [...container.querySelectorAll(`.${styles.cascadeWord}`)];

describe("Gentle cascade in assistant Markdown", () => {
  it("leaves completed history unanimated", () => {
    const { container } = render(<MarkdownMessage text="A completed answer with **formatting**." />);
    expect(revealing(container)).toHaveLength(0);
    expect(container.querySelector("strong")).toHaveTextContent("formatting");
  });

  it("keeps existing words mounted through chunks, line breaks, and completion", () => {
    const { container, rerender } = render(<MarkdownMessage text="The first wo" streaming />);
    const initial = revealing(container);
    expect(initial.map((word) => word.textContent)).toEqual(["The", "first", "wo"]);
    rerender(<MarkdownMessage text="The first word\ncontinues here.\n\nA new paragraph." streaming />);
    initial.forEach((word, index) => expect(revealing(container)[index]).toBe(word));
    const beforeCompletion = revealing(container);
    rerender(<MarkdownMessage text="The first word\ncontinues here.\n\nA new paragraph." />);
    beforeCompletion.forEach((word, index) => expect(revealing(container)[index]).toBe(word));
  });

  it("animates only new words when an existing snapshot resumes streaming", () => {
    const { container, rerender } = render(<MarkdownMessage text="Already read." />);
    rerender(<MarkdownMessage text="Already read. New words." streaming />);
    expect(revealing(container).map((word) => word.textContent)).toEqual(["New", "words."]);
  });

  it("preserves heading, list, link, and code semantics", () => {
    const text = "## Result\n\n- Keep **existing words** steady\n- Open [the file](/src/App.jsx)\n\nRun `pnpm test`.\n\n```js\nconst ready = true;\n```";
    const { container, rerender } = render(<MarkdownMessage text={text} streaming />);
    expect(screen.getByRole("heading", { name: "Result" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "the file" })).toHaveAttribute("href", "/src/App.jsx");
    expect(container.querySelector("strong")).toHaveTextContent("existing words");
    expect(container.querySelector("pre code")).toHaveTextContent("const ready = true;");
    expect(container.querySelector("pre span")).toBeNull();
    const firstListWord = container.querySelector("li span");
    rerender(<MarkdownMessage text={text.replace("\n\nRun", "\n- One more item\n\nRun")} streaming />);
    expect(container.querySelector("li span")).toBe(firstListWord);
  });

  it("does not replay existing text when Markdown formatting resolves", () => {
    const { container, rerender } = render(<MarkdownMessage text="Read **these words" streaming />);
    rerender(<MarkdownMessage text="Read **these words** then continue." streaming />);
    expect(container.querySelector("strong")).toHaveTextContent("these words");
    expect(container.querySelector("strong span")).toBeNull();
    expect(revealing(container).map((word) => word.textContent)).toContain("continue.");
  });

  it("limits simultaneous word animations for large catch-up chunks", () => {
    const text = "word ".repeat(1000);
    const { container } = render(<MarkdownMessage text={text} streaming />);
    expect(revealing(container)).toHaveLength(128);
    expect(container.textContent.trim()).toBe(text.trim());
  });

  it("uses the cascade on live commentary and keeps completed traces still", () => {
    const items = [{ id: "comment", type: "agentMessage", text: "Checking the current implementation." }];
    const { container, rerender } = render(<WorkingTrace items={items} running settled={false} />);
    expect(revealing(container).length).toBeGreaterThan(0);
    rerender(<WorkingTrace items={items} running={false} settled defaultDisclosure="expanded" />);
    expect(revealing(container)).toHaveLength(0);
  });
});

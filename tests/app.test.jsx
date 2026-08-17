import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App.jsx";

describe("Loom app shell", () => {
  it("moves between task, review, and extensions workspaces", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Refactor authentication flow" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Review/ }));
    expect(screen.getByText("Review workspace")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Extensions" }));
    expect(screen.getByRole("heading", { name: "Capabilities" })).toBeInTheDocument();
  });
  it("resolves an approval in the agent inspector", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    expect(screen.getByText("Approved")).toBeInTheDocument();
  });
});

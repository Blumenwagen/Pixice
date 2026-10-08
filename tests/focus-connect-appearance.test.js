import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("shows the selected Focus image across the Connect shell", () => {
  const stylesheet = document.createElement("style");
  stylesheet.textContent = readFileSync("src/connect/connect.css", "utf8");
  const shell = document.createElement("div");
  shell.className = "connect-root";
  shell.style.setProperty("--focus-background-image", "url(selected-scene.jpg)");
  shell.style.setProperty("--focus-background-blur", "12px");
  shell.innerHTML = '<div class="pixice-app" data-surface-mode="focus"><main class="focus-workspace" style="--focus-background-image: url(selected-scene.jpg); --focus-background-blur: 12px"><div class="focus-atmosphere"></div></main></div>';
  document.head.append(stylesheet);
  document.body.append(shell);
  try {
    const atmosphere = shell.querySelector(".focus-atmosphere");
    expect(getComputedStyle(atmosphere).display).toBe("none");
    expect(shell.style.getPropertyValue("--focus-background-image")).toContain("selected-scene.jpg");
  } finally {
    shell.remove();
    stylesheet.remove();
  }
});

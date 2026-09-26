import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("shows the selected Focus atmosphere inside the Connect shell", () => {
  const stylesheet = document.createElement("style");
  stylesheet.textContent = readFileSync("src/connect/connect.css", "utf8");
  const shell = document.createElement("div");
  shell.className = "connect-root";
  shell.innerHTML = '<div class="pixice-app" data-surface-mode="focus"><main class="focus-workspace" style="--focus-background-image: url(selected-scene.jpg); --focus-background-blur: 12px"><div class="focus-atmosphere"></div></main></div>';
  document.head.append(stylesheet);
  document.body.append(shell);
  try {
    const atmosphere = shell.querySelector(".focus-atmosphere");
    expect(getComputedStyle(atmosphere).display).not.toBe("none");
    expect(atmosphere.closest(".focus-workspace").style.getPropertyValue("--focus-background-image")).toContain("selected-scene.jpg");
  } finally {
    shell.remove();
    stylesheet.remove();
  }
});

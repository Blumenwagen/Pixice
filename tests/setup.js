import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom intentionally omits a canvas renderer. Returning null keeps component
// tests focused on DOM behavior; canvas-specific tests replace this with a
// lightweight drawing-context spy.
HTMLCanvasElement.prototype.getContext = () => null;

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(callback) { this.callback = callback; }
    observe(target) { this.callback([{ target, contentRect: target.getBoundingClientRect() }], this); }
    unobserve() {}
    disconnect() {}
  };
}

if (typeof globalThis.DOMMatrixReadOnly === "undefined") {
  globalThis.DOMMatrixReadOnly = class DOMMatrixReadOnly {
    constructor() {
      this.m11 = 1;
      this.m22 = 1;
      this.m41 = 0;
      this.m42 = 0;
    }
  };
}

const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
  if (this.classList?.contains("react-flow")) {
    return { x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 700, width: 1000, height: 700, toJSON() {} };
  }
  if (this.classList?.contains("react-flow__node")) {
    return { x: 0, y: 0, top: 0, left: 0, right: 252, bottom: 92, width: 252, height: 92, toJSON() {} };
  }
  return originalGetBoundingClientRect.call(this);
};

for (const [property, flowSize, nodeSize] of [
  ["clientWidth", 1000, 252],
  ["clientHeight", 700, 92],
  ["offsetWidth", 1000, 252],
  ["offsetHeight", 700, 92]
]) {
  Object.defineProperty(HTMLElement.prototype, property, {
    configurable: true,
    get() {
      if (this.classList?.contains("react-flow")) return flowSize;
      if (this.classList?.contains("react-flow__node")) return nodeSize;
      return 0;
    }
  });
}

afterEach(cleanup);

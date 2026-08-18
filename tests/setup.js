import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom intentionally omits a canvas renderer. Returning null keeps component
// tests focused on DOM behavior; canvas-specific tests replace this with a
// lightweight drawing-context spy.
HTMLCanvasElement.prototype.getContext = () => null;

afterEach(cleanup);

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceOrb } from '../src/components/VoiceOrb.jsx';

let pending, gl, hidden, resize, intersection;
function fakeGL() {
  return Object.fromEntries([
    ...['createShader', 'createProgram', 'createBuffer'].map(name => [name, vi.fn(() => ({}))]),
    ...['getShaderParameter', 'getProgramParameter'].map(name => [name, vi.fn(() => true)]),
    ['getUniformLocation', vi.fn((_program, name) => name)], ['getAttribLocation', vi.fn(() => 0)],
    ...['shaderSource', 'compileShader', 'attachShader', 'linkProgram', 'useProgram', 'bindBuffer', 'bufferData', 'enableVertexAttribArray', 'vertexAttribPointer', 'uniform1f', 'uniform1i', 'uniform2f', 'uniform3f', 'uniform3fv', 'viewport', 'drawArrays', 'deleteShader', 'deleteProgram', 'deleteBuffer'].map(name => [name, vi.fn()]),
  ]);
}
function tick(now) { act(() => { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(callback => callback(now)); }); }
beforeEach(() => {
  pending = new Map(); let id = 0; hidden = false;
  gl = fakeGL();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(type => type === 'webgl' ? gl : null);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 160, height: 160 });
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.stubGlobal('requestAnimationFrame', vi.fn(callback => { pending.set(++id, callback); return id; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn(id => pending.delete(id)));
  vi.stubGlobal('devicePixelRatio', 3);
  vi.stubGlobal('ResizeObserver', class { constructor(callback) { resize = callback; } observe() {} disconnect = vi.fn(); });
  vi.stubGlobal('IntersectionObserver', class { constructor(callback) { intersection = callback; } observe() {} disconnect = vi.fn(); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('VoiceOrb presentation and renderer lifetime', () => {
  it('keeps the contract accessible and gives errors precedence over mute', () => {
    const { rerender } = render(<VoiceOrb phase="listening" muted accent="blue" />);
    expect(screen.getByRole('img', { name: 'Voice muted' })).toHaveAttribute('data-phase', 'muted');
    rerender(<VoiceOrb phase="error" muted />);
    expect(screen.getByRole('img', { name: 'Voice error' })).toHaveAttribute('data-phase', 'error');
  });
  it('clamps audio, uses the speaking level, caps DPR and reuses its GPU resources', () => {
    const { container, rerender } = render(<VoiceOrb phase="speaking" speakerLevel={99} micLevel={NaN} />);
    expect(container.querySelector('canvas').width).toBe(240);
    tick(40); tick(80);
    const intensities = gl.uniform1f.mock.calls.filter(([name]) => name === 'intensity').map(([, value]) => value);
    expect(intensities.at(-1)).toBeGreaterThan(3.1);
    expect(intensities.at(-1)).toBeLessThanOrEqual(4.9);
    rerender(<VoiceOrb phase="listening" micLevel={Infinity} speakerLevel={99} />);
    tick(120);
    expect(gl.createProgram).toHaveBeenCalledTimes(1);
    expect(gl.uniform1f.mock.calls.every(([, value]) => Number.isFinite(value))).toBe(true);
  });
  it('stops frames while hidden, offscreen or zero-sized, then resumes without jumping', () => {
    render(<VoiceOrb />);
    expect(pending.size).toBe(1);
    hidden = true; fireEvent(document, new Event('visibilitychange'));
    expect(pending.size).toBe(0);
    hidden = false; fireEvent(document, new Event('visibilitychange'));
    expect(pending.size).toBe(1);
    act(() => intersection([{ isIntersecting: false }]));
    expect(pending.size).toBe(0);
    act(() => intersection([{ isIntersecting: true }]));
    expect(pending.size).toBe(1);
    HTMLElement.prototype.getBoundingClientRect.mockReturnValue({ width: 0, height: 0 });
    act(() => resize()); expect(pending.size).toBe(0);
  });
  it('draws static reduced-motion frames, ignores audio updates and resumes animation on request', () => {
    const { rerender } = render(<VoiceOrb reducedMotion phase="speaking" speakerLevel={0.3} />);
    expect(pending.size).toBe(0);
    const count = gl.drawArrays.mock.calls.length;
    rerender(<VoiceOrb reducedMotion phase="speaking" speakerLevel={0.9} />);
    expect(gl.drawArrays).toHaveBeenCalledTimes(count);
    rerender(<VoiceOrb reducedMotion={false} phase="speaking" />);
    expect(pending.size).toBe(1);
  });
  it('falls back on context loss, restores once, and disposes every allocation on unmount', () => {
    const { container, unmount } = render(<VoiceOrb />);
    const canvas = container.querySelector('canvas');
    const event = new Event('webglcontextlost', { cancelable: true });
    fireEvent(canvas, event);
    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector('.voice-orb')).toHaveAttribute('data-renderer', 'fallback');
    expect(pending.size).toBe(0);
    fireEvent(canvas, new Event('webglcontextrestored'));
    expect(container.querySelector('.voice-orb')).toHaveAttribute('data-renderer', 'webgl');
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    unmount();
    expect(pending.size).toBe(0);
    expect(gl.deleteProgram).toHaveBeenCalledTimes(2);
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(2);
    expect(gl.deleteShader).toHaveBeenCalledTimes(4);
    fireEvent(canvas, new Event('webglcontextrestored'));
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
  });
  it('releases partial allocations on compilation failure and uses a distinct 2D still', () => {
    gl.getShaderParameter.mockReturnValue(false); gl.getShaderInfoLog = vi.fn(() => 'unsupported precision');
    const context = { createImageData: vi.fn((w, h) => ({ data: new Uint8ClampedArray(w * h * 4) })), putImageData: vi.fn() };
    HTMLCanvasElement.prototype.getContext.mockImplementation(type => type === 'webgl' ? gl : context);
    const { container } = render(<VoiceOrb />);
    expect(container.querySelector('.voice-orb')).toHaveAttribute('data-renderer', 'fallback');
    expect(gl.deleteShader).toHaveBeenCalledOnce();
    expect(context.putImageData).toHaveBeenCalled();
    expect(container.querySelectorAll('canvas')[1].width).toBe(144);
    expect(pending.size).toBe(0);
  });
});

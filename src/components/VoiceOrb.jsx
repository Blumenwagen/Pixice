import { useEffect, useRef } from 'react';
import { fragmentShader } from '../voice/plasma-shader.js';
import './voice-orb.css';

const accents = { coral: '#ff5364', blue: '#6f95ff', rose: '#e56f9d', amber: '#dca650', green: '#55b96f', violet: '#9a7cf6', teal: '#4eb9aa', graphite: '#a4a4aa' };
const phases = {
  idle: { intensity: 1.65, speed: 0.32, rings: 1, visibility: 0.12, amplitude: 0.005, scale: 0.98 },
  connecting: { intensity: 2.1, speed: 0.7, rings: 3, visibility: 0.35, amplitude: 0.012, scale: 0.94 },
  listening: { intensity: 2.4, speed: 0.62, rings: 2, visibility: 0.24, amplitude: 0.012, scale: 1.02 },
  speaking: { intensity: 3.1, speed: 0.92, rings: 3, visibility: 0.48, amplitude: 0.024, scale: 1.04 },
  muted: { intensity: 1.1, speed: 0.16, rings: 1, visibility: 0.2, amplitude: 0.002, scale: 0.92 },
  error: { intensity: 1.9, speed: 0.22, rings: 2, visibility: 0.48, amplitude: 0.003, scale: 0.96 },
};
const clampLevel = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const mix = (a, b, amount) => a.map((value, i) => value + (b[i] - value) * amount);

function palette(element, phase) {
  const rgb = getComputedStyle(element).color.match(/[\d.]+/g)?.slice(0, 3).map(v => Number(v) / 255) || [1, 0.326, 0.392];
  if (phase === 'error') return [[1, 0.22, 0.16], [1, 0.62, 0.28], [0.65, 0.15, 0.23]];
  if (phase === 'muted') return [mix(rgb, [0.45, 0.49, 0.56], 0.8), [0.52, 0.56, 0.63], [0.35, 0.39, 0.46]];
  // Keep the selected accent dominant, with a cool complementary edge and a warm highlight.
  return [rgb, mix(rgb, [1, 0.89, 0.78], 0.5), mix(rgb.map(v => 1 - v), [0.45, 0.73, 0.85], 0.5)];
}

function createRenderer(canvas) {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
  if (!gl) throw new Error('WebGL unavailable');
  const shaders = [];
  let program, buffer;
  const dispose = () => {
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    shaders.forEach(shader => gl.deleteShader(shader));
  };
  try {
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Shader allocation failed');
      shaders.push(shader);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, 'attribute vec2 position; varying vec2 vUv; void main(){vUv=position*0.5+0.5; gl_Position=vec4(position,0.0,1.0);}');
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentShader);
    program = gl.createProgram();
    if (!program) throw new Error('Program allocation failed');
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    buffer = gl.createBuffer();
    if (!buffer) throw new Error('Buffer allocation failed');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const locations = Object.fromEntries([...fragmentShader.matchAll(/uniform \w+ (\w+);/g)].map(([, name]) => [name, gl.getUniformLocation(program, name)]));
    const f = (name, value) => gl.uniform1f(locations[name], value);
    gl.uniform1i(locations.blendMode, 1); gl.uniform1i(locations.useCustomColors, 1);
    gl.uniform2f(locations.effectCenter, 0, 0); gl.uniform3f(locations.backgroundColor, 0, 0, 0);
    for (const [name, value] of Object.entries({ radius: 1.5, colorCycleSpeed: 0.28, ringDistance: 0.012, ringSpread: 0.11, ringBounce: 0, ringThickness: 1.8, ringVariance: 0.72, ringSharpness: 0, ringSegments: 5, ringColorInheritance: 0.9, rayLength: 1.5, glowFalloff: 1.1, glowThreshold: 0.012 })) f(name, value);
    return {
      dispose,
      draw(time, config, colors, level) {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform2f(locations.iResolution, canvas.width, canvas.height);
        colors.forEach((color, i) => gl.uniform3fv(locations[`color${i + 1}`], color));
        for (const [name, value] of Object.entries({ iTime: time, intensity: config.intensity + level * 1.8, effectScale: config.scale + level * 0.07, plasmaSpeed: config.speed, ringCount: config.rings, ringVisibility: config.visibility + level * 0.17, ringAmplitude: config.amplitude + level * 0.035, ringSpeed: config.speed * 1.3 })) f(name, value);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      },
    };
  } catch (error) { dispose(); throw error; }
}

// A still, low-resolution procedural field when WebGL is unavailable or lost.
// Separate canvas: a WebGL canvas cannot be switched to a 2D context.
function drawFallback(canvas, config, colors) {
  const context = canvas.getContext('2d');
  if (!context) return;
  canvas.width = canvas.height = 144;
  const frame = context.createImageData(144, 144);
  for (let y = 0; y < 144; y++) for (let x = 0; x < 144; x++) {
    const u = (x - 71.5) / 144 / config.scale, v = (y - 71.5) / 144 / config.scale;
    const r = Math.hypot(u, v), angle = Math.atan2(v, u);
    const turbulence = Math.sin(u * 23 + Math.sin(v * 17)) * Math.cos(v * 21 - Math.sin(u * 13));
    const band = Math.exp(-Math.pow((r - 0.29 - turbulence * 0.021) / 0.053, 2));
    let strength = band * config.intensity * 0.26 * (0.7 + turbulence * 0.3);
    for (let i = 0; i < config.rings; i++) strength += Math.exp(-Math.pow((r - 0.312 - i * 0.022 - Math.sin(angle * 5 + i) * config.amplitude) / 0.004, 2)) * config.visibility * 0.4;
    const color = mix(colors[0], colors[2], (Math.sin(angle + r * 8) + 1) * 0.32);
    const index = (y * 144 + x) * 4;
    color.forEach((value, i) => { frame.data[index + i] = Math.round(value * 255); });
    frame.data[index + 3] = Math.round(Math.min(1, strength) * 255);
  }
  context.putImageData(frame, 0, 0);
}

/** Presentation only. Levels are finite normalized 0..1 values supplied by the media owner. */
export function VoiceOrb({ phase = 'idle', micLevel = 0, speakerLevel = 0, muted = false, accent, size = 160, reducedMotion }) {
  const host = useRef(null), canvas = useRef(null), fallback = useRef(null), runtime = useRef(null);
  const current = useRef(null);
  const effectivePhase = phase === 'error' ? 'error' : muted || phase === 'muted' ? 'muted' : phases[phase] ? phase : 'idle';
  current.current = { phase: effectivePhase, micLevel: clampLevel(micLevel), speakerLevel: clampLevel(speakerLevel), reducedMotion };

  useEffect(() => {
    const element = host.current, surface = canvas.current, still = fallback.current;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let renderer = null, frame = 0, disposed = false, lost = false, intersecting = true, measured = false;
    let time = 3.8, previous = 0, lastDraw = 0, level = 0, colors = palette(element, current.current.phase);
    let config = { ...phases[current.current.phase] };
    const reduced = () => current.current.reducedMotion ?? motion.matches;
    const visible = () => !disposed && !document.hidden && intersecting && measured;
    const stop = () => { if (frame) cancelAnimationFrame(frame); frame = 0; previous = 0; lastDraw = 0; };
    const paintStill = () => {
      config = { ...phases[current.current.phase] };
      colors = palette(element, current.current.phase);
      if (renderer) renderer.draw(time, config, colors, 0);
      else drawFallback(still, config, colors);
    };
    const draw = now => {
      frame = 0;
      if (!visible() || reduced() || !renderer) return;
      // 30fps is enough for the small companion and halves fragment workload.
      if (now - lastDraw >= 1000 / 30 - 1) {
        const delta = previous ? Math.min((now - previous) / 1000, 0.1) : 1 / 30;
        previous = now; lastDraw = now; time += delta;
        const props = current.current, target = phases[props.phase];
        const amount = 1 - Math.exp(-delta * 7);
        for (const key of Object.keys(target)) config[key] += (target[key] - config[key]) * amount;
        const audio = props.phase === 'speaking' ? props.speakerLevel : props.phase === 'listening' ? props.micLevel : 0;
        level += (audio - level) * (1 - Math.exp(-delta * (audio > level ? 14 : 5)));
        renderer.draw(time, config, colors, level);
      }
      frame = requestAnimationFrame(draw);
    };
    const sync = () => {
      if (!visible()) { stop(); return; }
      if (reduced() || !renderer) { stop(); paintStill(); }
      else if (!frame) frame = requestAnimationFrame(draw);
    };
    const resize = () => {
      const rect = element.getBoundingClientRect();
      measured = rect.width > 0 && rect.height > 0;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      // Also cap the framebuffer for consumers passing unusually large sizes.
      const width = Math.max(1, Math.min(768, Math.round(rect.width * dpr)));
      const height = Math.max(1, Math.min(768, Math.round(rect.height * dpr)));
      if (surface.width !== width || surface.height !== height) { surface.width = width; surface.height = height; }
      sync();
      if (visible()) paintStill();
    };
    const initialize = () => {
      try { renderer = createRenderer(surface); element.dataset.renderer = 'webgl'; }
      catch { renderer = null; element.dataset.renderer = 'fallback'; }
      resize();
    };
    const onLoss = event => {
      event.preventDefault(); lost = true; stop(); renderer?.dispose(); renderer = null;
      element.dataset.renderer = 'fallback';
      if (visible()) paintStill();
    };
    const onRestore = () => { if (!disposed && lost) { lost = false; initialize(); } };
    surface.addEventListener('webglcontextlost', onLoss);
    surface.addEventListener('webglcontextrestored', onRestore);
    document.addEventListener('visibilitychange', sync);
    motion.addEventListener('change', sync);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    observer?.observe(element);
    const intersection = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
      intersecting = entries[0]?.isIntersecting ?? true; sync();
    }) : null;
    intersection?.observe(element);
    window.addEventListener('resize', resize);
    runtime.current = { update() { colors = palette(element, current.current.phase); sync(); } };
    initialize();
    return () => {
      disposed = true; runtime.current = null; stop(); observer?.disconnect(); intersection?.disconnect();
      surface.removeEventListener('webglcontextlost', onLoss); surface.removeEventListener('webglcontextrestored', onRestore);
      document.removeEventListener('visibilitychange', sync); motion.removeEventListener('change', sync); window.removeEventListener('resize', resize);
      renderer?.dispose(); renderer = null;
      // Release the backing stores. A StrictMode remount can reuse this canvas.
      surface.width = surface.height = 1; still.width = still.height = 1;
    };
  }, []);

  useEffect(() => { runtime.current?.update(); }, [effectivePhase, accent, reducedMotion]);

  return <span ref={host} className="voice-orb" data-phase={effectivePhase} role="img" aria-label={`Voice ${effectivePhase}`} style={{ width: size, '--voice-orb-accent': accents[accent] || accent || 'var(--primary, #ff5364)' }}>
    <canvas ref={canvas} className="voice-orb__plasma" aria-hidden="true" />
    <canvas ref={fallback} className="voice-orb__still" aria-hidden="true" />
  </span>;
}

export default VoiceOrb;

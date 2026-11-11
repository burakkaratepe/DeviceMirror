// iOS touch input in the mirror window. The device-side XCTest daemon takes
// one event at a time (~260 ms each), so input is sent as whole gestures:
//   click → tap, press-and-hold → long press, drag → one swipe path with its
//   real timing (sent on release), wheel → short swipe, keys → typed text.
// A ripple is drawn at once where the user clicked, so the click feels
// acknowledged before the device reacts.

import type { MirrorWindowApi } from '../shared/types';

type FramePoint = { x: number; y: number; inside: boolean };

const TAP_SLOP = 0.015; // normalized; below this a press is a tap, not a drag
const LONG_PRESS_MS = 450;
/**
 * A mouse drag is slower than a finger flick, so iOS often reads it as a
 * slow pan and does not change page. Drags are replayed this much faster.
 */
const SWIPE_SPEEDUP = 1.3;

export function initIosTouch(
  api: MirrorWindowApi,
  canvas: HTMLCanvasElement,
  stage: HTMLElement,
  toFrame: (e: { clientX: number; clientY: number }) => FramePoint | undefined,
  frameSize: () => { w: number; h: number },
) {
  let enabled = false;
  let points: { x: number; y: number; t: number }[] = [];
  let startTime = 0;
  let pointerId: number | undefined;
  let lastMove = 0;

  const norm = (p: FramePoint) => { const { w, h } = frameSize(); return { x: p.x / w, y: p.y / h }; };
  const portrait = () => { const { w, h } = frameSize(); return h >= w; };

  function ripple(clientX: number, clientY: number, long = false) {
    const r = document.createElement('span');
    r.className = long ? 'tap-ripple long' : 'tap-ripple';
    const box = stage.getBoundingClientRect();
    r.style.left = `${clientX - box.left}px`;
    r.style.top = `${clientY - box.top}px`;
    stage.append(r);
    r.addEventListener('animationend', () => r.remove());
  }

  // ---- drag trail ------------------------------------------------------
  // The device only gets a drag once it is released, so draw the finger's
  // path live in the window, then replay a dot along it with the same timing
  // the device uses — the user sees the drag immediately and knows it is
  // being performed.
  const SVG = 'http://www.w3.org/2000/svg';
  let trail: { svg: SVGSVGElement; path: SVGPathElement; pts: { x: number; y: number; t: number }[] } | undefined;

  function stagePoint(e: { clientX: number; clientY: number }) {
    const box = stage.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  }

  function startTrail(e: PointerEvent) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'drag-trail');
    const path = document.createElementNS(SVG, 'path');
    svg.append(path);
    stage.append(svg);
    trail = { svg, path, pts: [{ ...stagePoint(e), t: 0 }] };
  }

  function extendTrail(e: PointerEvent, t: number) {
    if (!trail) return;
    trail.pts.push({ ...stagePoint(e), t });
    trail.path.setAttribute('d', trail.pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' '));
    trail.svg.classList.add('visible');
  }

  /** Moves a dot along the trail with the gesture's own timing, then fades the trail out. */
  function replayTrail() {
    const t = trail;
    trail = undefined;
    if (!t) return;
    if (!t.svg.classList.contains('visible')) { t.svg.remove(); return; }
    const dot = document.createElementNS(SVG, 'circle');
    dot.setAttribute('r', '9');
    t.svg.append(dot);
    const total = t.pts[t.pts.length - 1].t; // in recorded time; the clock below runs SWIPE_SPEEDUP× faster
    const start = performance.now();
    const frame = () => {
      const el = ((performance.now() - start) / 1000) * SWIPE_SPEEDUP; // same pace as the device
      let i = t.pts.findIndex((p) => p.t >= el);
      if (i < 0) i = t.pts.length - 1;
      const a = t.pts[Math.max(0, i - 1)], b = t.pts[i];
      const k = b.t > a.t ? Math.min(1, (el - a.t) / (b.t - a.t)) : 1;
      dot.setAttribute('cx', String(a.x + (b.x - a.x) * k));
      dot.setAttribute('cy', String(a.y + (b.y - a.y) * k));
      if (el < total) requestAnimationFrame(frame);
      else { t.svg.classList.add('done'); setTimeout(() => t.svg.remove(), 400); }
    };
    requestAnimationFrame(frame);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!enabled || e.button !== 0 || pointerId !== undefined) return;
    const p = toFrame(e);
    if (!p?.inside) return;
    if (!portrait()) { api.notice?.('Touch control works in portrait for now.'); return; }
    pointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    startTime = performance.now();
    lastMove = startTime;
    points = [{ ...norm(p), t: 0 }];
    ripple(e.clientX, e.clientY);
    startTrail(e);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    const now = performance.now();
    if (now - lastMove < 12) return; // ~80 samples per second is plenty
    lastMove = now;
    const p = toFrame(e);
    if (!p) return;
    const t = (now - startTime) / 1000;
    points.push({ ...norm(p), t });
    // Only draw once it is clearly a drag, so taps stay a clean ripple.
    if (Math.hypot(points[points.length - 1].x - points[0].x, points[points.length - 1].y - points[0].y) > TAP_SLOP || trail?.svg.classList.contains('visible')) extendTrail(e, t);
  });

  const finish = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    pointerId = undefined;
    const p = toFrame(e);
    const now = performance.now();
    if (p) points.push({ ...norm(p), t: (now - startTime) / 1000 });
    const first = points[0];
    const far = points.some((q) => Math.hypot(q.x - first.x, q.y - first.y) > TAP_SLOP);
    const held = now - startTime;
    if (!far) {
      trail?.svg.remove();
      trail = undefined;
      if (held >= LONG_PRESS_MS) ripple(e.clientX, e.clientY, true);
      api.iosTap(first.x, first.y, held >= LONG_PRESS_MS ? held / 1000 : 0.03);
    } else {
      extendTrail(e, (now - startTime) / 1000);
      api.iosGesture(points.map((q) => ({ ...q, t: q.t / SWIPE_SPEEDUP })));
      replayTrail();
    }
    points = [];
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  // Wheel / trackpad: collect a burst, then send one swipe in that direction.
  let wheelY = 0;
  let wheelAt: FramePoint | undefined;
  let wheelTimer: number | undefined;
  canvas.addEventListener('wheel', (e) => {
    if (!enabled) return;
    e.preventDefault();
    const p = toFrame(e);
    if (!p?.inside) return;
    wheelAt ??= p;
    wheelY += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    clearTimeout(wheelTimer);
    wheelTimer = window.setTimeout(() => {
      const start = norm(wheelAt!);
      const dist = Math.max(-0.45, Math.min(0.45, -wheelY / 1200));
      const endY = Math.max(0.02, Math.min(0.98, start.y + dist));
      if (Math.abs(endY - start.y) > 0.02) api.iosGesture([{ ...start, t: 0 }, { x: start.x, y: (start.y + endY) / 2, t: 0.08 }, { x: start.x, y: endY, t: 0.16 }]);
      wheelY = 0;
      wheelAt = undefined;
    }, 120);
  }, { passive: false });

  // Keyboard: batch typed characters briefly so a burst becomes one event.
  let pending = '';
  let keyTimer: number | undefined;
  const flush = () => { if (pending) api.iosText(pending); pending = ''; };
  window.addEventListener('keydown', (e) => {
    if (!enabled || (e.target as HTMLElement).closest?.('dialog, input, #overlay button')) return;
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyV') { e.preventDefault(); flush(); api.paste(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey && e.key.length !== 1) return;
    const special: Record<string, string> = { Enter: '\n', Backspace: '\b', Tab: '\t' };
    const ch = special[e.key] ?? ([...e.key].length === 1 ? e.key : '');
    if (!ch) return;
    e.preventDefault();
    pending += ch;
    clearTimeout(keyTimer);
    keyTimer = window.setTimeout(flush, 60);
  });

  return {
    setEnabled(on: boolean) {
      enabled = on;
      canvas.style.cursor = on ? 'pointer' : 'default';
    },
    get enabled() { return enabled; },
  };
}

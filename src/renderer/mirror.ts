// Mirror window: decodes the H.264 stream with WebCodecs, draws the newest
// frame on a canvas, and turns pointer input into device touch events.

import type { MirrorStatus, MirrorVideo, MirrorWindowApi, Quality } from '../shared/types';

declare global {
  interface Window { mirror: MirrorWindowApi }
}

const api = window.mirror;
const canvas = document.getElementById('screen') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })!;
const overlay = document.getElementById('overlay') as HTMLDivElement;
const overlayText = document.getElementById('overlay-text') as HTMLParagraphElement;
const retryBtn = document.getElementById('retry') as HTMLButtonElement;
const live = document.getElementById('live') as HTMLSpanElement;
const liveText = document.getElementById('live-text') as HTMLSpanElement;

let deviceName = 'device';
let decoder: VideoDecoder | undefined;
let waitingForKey = true;
let pending: VideoFrame | undefined; // newest decoded frame not yet painted
let frameW = 0;
let frameH = 0;

// ---- video -------------------------------------------------------------

function paint() {
  const f = pending;
  pending = undefined;
  if (!f) return;
  if (canvas.width !== f.displayWidth || canvas.height !== f.displayHeight) {
    canvas.width = f.displayWidth;
    canvas.height = f.displayHeight;
  }
  ctx.drawImage(f, 0, 0);
  f.close();
}

function onFrame(f: VideoFrame) {
  pending?.close(); // drop frames we could not paint in time: lowest latency wins
  const first = !pending && canvas.width === 0;
  pending = f;
  requestAnimationFrame(paint);
  if (first) paint();
}

function resetDecoder(codec: string) {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = new VideoDecoder({
    output: onFrame,
    error: (e) => showStatus({ state: 'error', message: `Video decoding failed: ${e.message}` }),
  });
  decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
  waitingForKey = true;
}

api.onVideo((v: MirrorVideo) => {
  switch (v.type) {
    case 'codec':
      resetDecoder(v.codec);
      break;
    case 'size':
      frameW = v.width;
      frameH = v.height;
      break;
    case 'packet':
      if (!decoder || decoder.state !== 'configured') return;
      if (waitingForKey && !v.key) return;
      waitingForKey = false;
      decoder.decode(new EncodedVideoChunk({ type: v.key ? 'key' : 'delta', timestamp: v.pts, data: v.data }));
      break;
  }
});

// ---- status ------------------------------------------------------------

function showStatus(s: MirrorStatus) {
  live.classList.toggle('on', s.state === 'live');
  live.classList.toggle('error', s.state === 'error');
  liveText.textContent = s.state === 'live' ? 'Live' : s.state === 'error' ? 'Stopped' : 'Connecting';
  overlay.classList.toggle('hidden', s.state === 'live');
  overlay.classList.toggle('error', s.state === 'error');
  retryBtn.hidden = s.state !== 'error';
  overlayText.textContent = s.state === 'error' ? s.message : `Connecting to ${deviceName}…`;
}
api.onStatus(showStatus);
retryBtn.addEventListener('click', () => api.retry());

// ---- quality -----------------------------------------------------------

const segButtons = [...document.querySelectorAll<HTMLButtonElement>('.seg button')];
function showQuality(q: Quality) {
  for (const b of segButtons) b.setAttribute('aria-checked', String(b.dataset.q === q));
}
for (const b of segButtons) {
  b.addEventListener('click', () => {
    if (b.getAttribute('aria-checked') === 'true') return;
    showQuality(b.dataset.q as Quality);
    api.setQuality(b.dataset.q as Quality);
  });
}

function applyInfo(i: { name: string; quality: Quality }) {
  deviceName = i.name;
  document.title = i.name;
  showQuality(i.quality);
}
api.onInfo(applyInfo);
void api.info().then((i) => { if (i) { applyInfo(i); showStatus({ state: 'connecting' }); } });

// ---- navigation keys ---------------------------------------------------

for (const b of document.querySelectorAll<HTMLButtonElement>('.nav-keys button')) {
  b.addEventListener('click', () => api.key(Number(b.dataset.key)));
}

// ---- touch input -------------------------------------------------------

/** Maps a pointer position to frame pixels (canvas uses object-fit: contain). */
function toFrame(e: { clientX: number; clientY: number }): { x: number; y: number; inside: boolean } | undefined {
  if (!frameW || !frameH) return undefined;
  const r = canvas.getBoundingClientRect();
  const scale = Math.min(r.width / frameW, r.height / frameH);
  const w = frameW * scale;
  const h = frameH * scale;
  const left = r.left + (r.width - w) / 2;
  const top = r.top + (r.height - h) / 2;
  const x = (e.clientX - left) / scale;
  const y = (e.clientY - top) / scale;
  const inside = x >= 0 && y >= 0 && x < frameW && y < frameH;
  return { x: Math.max(0, Math.min(frameW - 1, x)), y: Math.max(0, Math.min(frameH - 1, y)), inside };
}

let activePointer: number | undefined;

canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 2) { api.key(4); return; } // right click = Back
  if (e.button !== 0 || activePointer !== undefined) return;
  const p = toFrame(e);
  if (!p?.inside) return;
  activePointer = e.pointerId;
  canvas.setPointerCapture(e.pointerId);
  api.touch(0, p.x, p.y);
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== activePointer) return;
  const p = toFrame(e);
  if (p) api.touch(2, p.x, p.y);
});
const release = (e: PointerEvent) => {
  if (e.pointerId !== activePointer) return;
  activePointer = undefined;
  const p = toFrame(e);
  if (p) api.touch(1, p.x, p.y);
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = toFrame(e);
  if (!p?.inside) return;
  const unit = e.deltaMode === 1 ? 1 : 1 / 40; // lines vs pixels → scroll "clicks"
  api.scroll(p.x, p.y, -e.deltaX * unit, -e.deltaY * unit);
}, { passive: false });

// Mirror window: decodes the H.264 stream with WebCodecs, draws the newest
// frame on a canvas, and turns pointer input into device touch events.

import type { MirrorStatus, MirrorVideo, MirrorWindowApi, Quality } from '../shared/types';
import { HidKeyboard } from './hidKeyboard';
import { initTouchSetup } from './touchSetupUi';
import { initIosTouch } from './iosTouchUi';

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
let serial = '';
const touchSetup = initTouchSetup(api, () => serial);
let isLive = false;
// Status and device info arrive independently; invite once both say "live iOS".
const maybeInvite = () => { if (isLive && platform === 'ios') touchSetup.onLive(); };
api.onStatus((s) => {
  showStatus(s);
  isLive = s.state === 'live';
  maybeInvite();
});
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

let platform: 'android' | 'ios' = 'android';
/** iOS windows are view-only until touch control is enabled (Phase 4/5). */
const controllable = () => platform === 'android';

function applyInfo(i: { name: string; serial: string; platform: 'android' | 'ios'; quality: Quality }) {
  deviceName = i.name;
  platform = i.platform;
  serial = i.serial;
  maybeInvite();
  document.body.classList.toggle('platform-ios', i.platform === 'ios');
  document.title = i.name;
  showQuality(i.quality);
}
api.onInfo(applyInfo);
void api.info().then((i) => { if (i) { applyInfo(i); if (!isLive) showStatus({ state: 'connecting' }); } });

// ---- navigation keys ---------------------------------------------------

for (const b of document.querySelectorAll<HTMLButtonElement>('.nav-keys button')) {
  b.addEventListener('click', () => {
    if (platform === 'ios') { if (b.dataset.key === '3') api.iosHome(); return; }
    api.key(Number(b.dataset.key));
  });
}

// Toolbar buttons must not keep keyboard focus, or Space/Enter would press
// them instead of reaching the device.
for (const b of document.querySelectorAll<HTMLButtonElement>('#toolbar button')) {
  b.addEventListener('mousedown', (e) => e.preventDefault());
}

// ---- keyboard ----------------------------------------------------------

// Physical keys go to a virtual hardware keyboard on the device (see
// hidKeyboard.ts); the device's layout setting turns them into characters,
// so Turkish and other non-ASCII letters work in every app.
let layoutChecked = false;
const keyboard = new HidKeyboard((r) => {
  api.hid(r);
  if (!layoutChecked) { layoutChecked = true; setTimeout(() => void checkLayout(), 1200); } // keyboard registers on first report
});

// ---- keyboard layout hint ------------------------------------------------
//
// Android gives a new hardware keyboard the English (US) layout. When this
// computer uses another layout (e.g. Turkish Q), point the user to the
// device setting once; Android remembers the choice for this keyboard.

const layoutBar = document.getElementById('layout-bar') as HTMLDivElement;
const layoutText = document.getElementById('layout-text') as HTMLSpanElement;
let layoutDismissed = false;

async function hostLayoutHint(): Promise<{ isUS: boolean; suggestion: string }> {
  const kb = (navigator as Navigator & { keyboard?: { getLayoutMap(): Promise<Map<string, string>> } }).keyboard;
  if (!kb) return { isUS: true, suggestion: '' };
  const map = await kb.getLayoutMap();
  const isUS = map.get('KeyQ') === 'q' && map.get('Semicolon') === ';' && map.get('Quote') === "'" && map.get('BracketLeft') === '[';
  const suggestion = map.get('Semicolon') === 'ş' ? 'Turkish Q' : map.get('KeyF') === 'ı' ? 'Turkish F' : 'the same layout as this computer';
  return { isUS, suggestion };
}

async function checkLayout() {
  if (layoutDismissed) return;
  const [device, host] = await Promise.all([api.keyboardLayout(), hostLayoutHint()]);
  const mismatch = !!device && !host.isUS && device.id === 'keyboard_layout_english_us';
  layoutText.textContent = mismatch ? `Phone keyboard layout is ${device!.label}. Set it to ${host.suggestion} to type every character.` : '';
  layoutBar.hidden = !mismatch;
}
document.getElementById('layout-open')!.addEventListener('click', () => api.keyboardSettings());
document.getElementById('layout-close')!.addEventListener('click', () => { layoutDismissed = true; layoutBar.hidden = true; });
window.addEventListener('focus', () => { if (!layoutBar.hidden) void checkLayout(); });

window.addEventListener('keydown', (e) => {
  if (!controllable() || (e.target as HTMLElement).closest?.('#overlay button')) return;
  // ⌘V / Ctrl+V pastes the computer's clipboard instead of the device's.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.code === 'KeyV') {
    e.preventDefault();
    api.paste();
    return;
  }
  if (keyboard.handle(e, true)) e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  if (controllable() && keyboard.handle(e, false)) e.preventDefault();
});
window.addEventListener('blur', () => keyboard.releaseAll());

document.getElementById('kbd-layout')!.addEventListener('click', () => api.keyboardSettings());

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
  if (!controllable()) return;
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
  if (!controllable()) return;
  const p = toFrame(e);
  if (!p?.inside) return;
  const unit = e.deltaMode === 1 ? 1 : 1 / 40; // lines vs pixels → scroll "clicks"
  api.scroll(p.x, p.y, -e.deltaX * unit, -e.deltaY * unit);
}, { passive: false });

// ---- iOS touch control -------------------------------------------------

const stage = document.getElementById('stage') as HTMLDivElement;
const iosTouch = initIosTouch(api, canvas, stage, toFrame, () => ({ w: frameW, h: frameH }));
api.onTouch((on) => {
  iosTouch.setEnabled(on && platform === 'ios');
  document.body.classList.toggle('touch-on', on);
  const btn = document.getElementById('touch-enable') as HTMLButtonElement;
  btn.title = on ? 'Touch control is on' : 'Enable touch control';
  if (on) (document.getElementById('invite') as HTMLDivElement).hidden = true;
});

// ---- device frame and side buttons -----------------------------------------
//
// A thin phone frame drawn around the video, with power and volume buttons
// that really work (Android: key events; iOS: through the touch runner).

const bezel = document.getElementById('bezel') as HTMLDivElement;
const sideButtons = [...bezel.querySelectorAll<HTMLButtonElement>('.side-btn')];

/** Button placement per platform, as fractions of the frame height. */
const BUTTON_LAYOUT: Record<'android' | 'ios', Record<string, { side: 'left' | 'right'; top: number; height: number }>> = {
  ios: { volumeUp: { side: 'left', top: 0.25, height: 0.075 }, volumeDown: { side: 'left', top: 0.345, height: 0.075 }, power: { side: 'right', top: 0.28, height: 0.11 } },
  android: { volumeUp: { side: 'right', top: 0.19, height: 0.06 }, volumeDown: { side: 'right', top: 0.26, height: 0.06 }, power: { side: 'right', top: 0.36, height: 0.075 } },
};

function layoutFrame() {
  if (!frameW || !frameH) { bezel.hidden = true; return; }
  const box = canvas.getBoundingClientRect();
  const st = stage.getBoundingClientRect();
  const scale = Math.min(box.width / frameW, box.height / frameH);
  const vw = frameW * scale, vh = frameH * scale;
  const left = box.left - st.left + (box.width - vw) / 2;
  const top = box.top - st.top + (box.height - vh) / 2;
  const portrait = vh >= vw;
  // Rounded screen corners like the real panel; older home-button iPhones are square.
  const homeButtonIphone = platform === 'ios' && frameH / frameW < 1.9 && portrait;
  const radius = Math.min(vw, vh) * (platform === 'ios' ? (homeButtonIphone ? 0.015 : 0.12) : 0.075);
  const border = Math.max(5, Math.min(vw, vh) * 0.028);
  const cl = left - (box.left - st.left), ct = top - (box.top - st.top);
  canvas.style.clipPath = `inset(${ct}px ${box.width - cl - vw}px ${box.height - ct - vh}px ${cl}px round ${radius}px)`;
  Object.assign(bezel.style, {
    left: `${left - border}px`, top: `${top - border}px`, width: `${vw + 2 * border}px`, height: `${vh + 2 * border}px`,
    borderRadius: `${radius + border}px`,
  });
  bezel.hidden = false;
  const layout = BUTTON_LAYOUT[platform];
  for (const b of sideButtons) {
    const spec = layout[b.dataset.btn!];
    b.hidden = !portrait; // the frame turns with the device; buttons are only placed for portrait
    b.className = `side-btn ${spec.side}`;
    b.style.top = `${spec.top * (vh + 2 * border)}px`;
    b.style.height = `${spec.height * (vh + 2 * border)}px`;
    const locked = platform === 'ios' && !document.body.classList.contains('touch-on');
    b.classList.toggle('locked', locked);
    b.title = locked ? 'Enable touch control to use the buttons' : b.getAttribute('aria-label')!;
  }
}
new ResizeObserver(layoutFrame).observe(stage);
api.onVideo((v) => { if (v.type === 'size') requestAnimationFrame(layoutFrame); });
api.onTouch(() => layoutFrame());

const ANDROID_KEYS: Record<string, number> = { power: 26, volumeUp: 24, volumeDown: 25 };
for (const b of sideButtons) {
  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep keyboard focus on the device
  b.addEventListener('click', () => {
    if (b.classList.contains('locked')) return;
    const which = b.dataset.btn!;
    if (platform === 'android') api.key(ANDROID_KEYS[which]);
    else api.iosButton(which === 'power' ? 'lock' : (which as 'volumeUp' | 'volumeDown'));
    // Keyboard / fast clicks still show the press.
    b.classList.add('pressed');
    setTimeout(() => b.classList.remove('pressed'), 110);
  });
}

// Mirror window: decodes the H.264 stream with WebCodecs, draws the newest
// frame on a canvas, and turns pointer input into device touch events.

import type { MirrorStatus, MirrorVideo, MirrorWindowApi, Quality } from '../shared/types';
import { HidKeyboard } from './hidKeyboard';
import { initTouchSetup } from './touchSetupUi';
import { initIosTouch } from './iosTouchUi';
import { initCaptures } from './captureUi';
import { initTooltips } from './tooltips';
import { displaySize, frameToPortrait, orientationFor, placeKey, viewToFrame, type Orientation, type QuarterTurns } from './rotation';

declare global {
  interface Window { mirror: MirrorWindowApi }
}

const api = window.mirror;

// Short toast over the picture for things worth a word (touch stopped, …).
const toast = document.getElementById('toast') as HTMLDivElement;
let toastTimer: number | undefined;
function showToast(text: string) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 5000);
}
api.onNotice(showToast);
initTooltips(document.getElementById('toolbar') as HTMLElement, document.getElementById('tip') as HTMLElement);
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
  // Until the first frame the canvas is an empty 300x150 box: keep it hidden.
  if (!canvas.classList.contains('has-frame')) canvas.classList.add('has-frame');
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
  liveText.textContent = s.state === 'live' ? 'Live' : s.state === 'error' ? 'Stopped' : s.state === 'waiting' ? 'Waiting for the screen' : 'Connecting';
  live.title = liveText.textContent;
  overlay.classList.toggle('hidden', s.state === 'live');
  overlay.classList.toggle('error', s.state === 'error');
  retryBtn.hidden = s.state !== 'error';
  overlayText.textContent = s.state === 'error' || s.state === 'waiting' ? s.message : `Connecting to ${deviceName}…`;
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


// ---- touch input -------------------------------------------------------

// ---- rotation & layout state ---------------------------------------------

/** Quarter turns counter-clockwise the user applied with the rotate button. */
let turns: QuarterTurns = 0;
let orient: Orientation = orientationFor(0, 1, 2);
/** The picture on screen, relative to the stage, and its scale (set by layoutFrame). */
let view = { left: 0, top: 0, w: 0, h: 0, s: 1 };

/** Maps a pointer position to frame pixels, whatever way the picture is turned. */
function toFrame(e: { clientX: number; clientY: number }): { x: number; y: number; inside: boolean } | undefined {
  if (!frameW || !frameH || !view.w) return undefined;
  const st = stage.getBoundingClientRect();
  const px = e.clientX - st.left - view.left;
  const py = e.clientY - st.top - view.top;
  const inside = px >= 0 && py >= 0 && px < view.w && py < view.h;
  const p = viewToFrame(px, py, view.s, orient.contentRot, frameW, frameH);
  return { x: Math.max(0, Math.min(frameW - 1, p.x)), y: Math.max(0, Math.min(frameH - 1, p.y)), inside };
}

let activePointer: number | undefined;

canvas.addEventListener('pointerdown', (e) => {
  if (!controllable()) return;
  if (e.button === 2) { api.key(4); return; } // right click = Back
  if (e.button !== 0 || activePointer !== undefined) return;
  const p = toFrame(e);
  if (!p?.inside) return;
  endHover(e); // a press ends the hover
  activePointer = e.pointerId;
  canvas.setPointerCapture(e.pointerId);
  api.touch(0, p.x, p.y);
});
// Android: moving the mouse over the picture without pressing is sent as
// hover, like scrcpy does (hover highlights, tooltips, …). At most once per
// frame.
let hovering = false;
let hoverAt: { x: number; y: number } | undefined;
let hoverFrame = 0;
const hoverOn = () => platform === 'android' && controllable();
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId === activePointer) {
    const p = toFrame(e);
    if (p) api.touch(2, p.x, p.y);
    return;
  }
  if (activePointer !== undefined || e.buttons || !hoverOn()) return;
  const p = toFrame(e);
  if (!p?.inside) { endHover(e); return; }
  if (!hovering) { hovering = true; api.touch(9, p.x, p.y); }
  hoverAt = p;
  hoverFrame ||= requestAnimationFrame(() => {
    hoverFrame = 0;
    if (hovering && hoverAt) api.touch(7, hoverAt.x, hoverAt.y);
  });
});
function endHover(e: { clientX: number; clientY: number }) {
  if (!hovering) return;
  hovering = false;
  const p = toFrame(e) ?? hoverAt;
  if (p) api.touch(10, p.x, p.y);
}
canvas.addEventListener('pointerleave', (e) => { if (activePointer === undefined) endHover(e); });
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
  // Scroll along the picture as it is shown: turn the wheel vector with it.
  const h = -e.deltaX * unit, v = -e.deltaY * unit;
  const [fh, fv] = [[h, v], [-v, h], [-h, -v], [v, -h]][orient.contentRot];
  api.scroll(p.x, p.y, fh, fv);
}, { passive: false });

// ---- iOS touch control -------------------------------------------------

const stage = document.getElementById('stage') as HTMLDivElement;
const iosTouch = initIosTouch({ ...api, notice: showToast }, canvas, stage, toFrame, () => ({ w: frameW, h: frameH }),
  (x, y) => frameToPortrait(x, y, orient.deviceRot), () => orient.keysShown);
api.onTouch((on) => {
  iosTouch.setEnabled(on && platform === 'ios');
  document.body.classList.toggle('touch-on', on);
  touchSetup.setTouch(on);
  if (on) (document.getElementById('invite') as HTMLDivElement).hidden = true;
});

// ---- device frame and side buttons -----------------------------------------
//
// A thin phone frame drawn around the video, with power and volume buttons
// that really work (Android: key events; iOS: through the touch runner).

const bezel = document.getElementById('bezel') as HTMLDivElement;
const keys = document.getElementById('keys') as HTMLDivElement;
const fx = document.getElementById('fx') as HTMLDivElement;
initCaptures({
  api, canvas, fx, notify: showToast, isLive: () => isLive,
  shotButton: document.getElementById('shot') as HTMLButtonElement,
  recButton: document.getElementById('rec') as HTMLButtonElement,
});
const sideButtons = [...keys.querySelectorAll<HTMLButtonElement>('.side-btn')];

/** Button placement per platform, as fractions of the frame height. */
const BUTTON_LAYOUT: Record<'android' | 'ios', Record<string, { side: 'left' | 'right'; top: number; height: number }>> = {
  ios: { volumeUp: { side: 'left', top: 0.25, height: 0.075 }, volumeDown: { side: 'left', top: 0.345, height: 0.075 }, power: { side: 'right', top: 0.28, height: 0.11 } },
  android: { volumeUp: { side: 'right', top: 0.19, height: 0.06 }, volumeDown: { side: 'right', top: 0.26, height: 0.06 }, power: { side: 'right', top: 0.36, height: 0.075 } },
};

/** Room around the picture for the frame and side keys; keep in sync with FRAME_PAD_X / FRAME_PAD_Y in mirrorManager.ts. */
const PAD_X = 30, PAD_Y = 14;
let lastDisplay = '';

function layoutFrame() {
  if (!frameW || !frameH) { bezel.hidden = true; keys.hidden = true; fx.hidden = true; return; }
  orient = orientationFor(turns, frameW, frameH);
  const disp = displaySize(frameW, frameH, orient.contentRot);
  // Tell the window its picture's shape so it can take that aspect ratio.
  const shape = `${disp.w}x${disp.h}`;
  if (shape !== lastDisplay) { lastDisplay = shape; api.displaySize(disp.w, disp.h); }
  const st = stage.getBoundingClientRect();
  const availW = Math.max(1, st.width - 2 * PAD_X), availH = Math.max(1, st.height - 2 * PAD_Y);
  const s = Math.min(availW / disp.w, availH / disp.h);
  const vw = disp.w * s, vh = disp.h * s;
  const left = PAD_X + (availW - vw) / 2, top = PAD_Y + (availH - vh) / 2;
  view = { left, top, w: vw, h: vh, s };
  // Rounded screen corners like the real panel; older home-button iPhones are square.
  const homeButtonIphone = platform === 'ios' && Math.max(frameW, frameH) / Math.min(frameW, frameH) < 1.9;
  const radius = Math.min(vw, vh) * (platform === 'ios' ? (homeButtonIphone ? 0.015 : 0.12) : 0.075);
  const border = Math.max(5, Math.min(vw, vh) * 0.028);
  // The canvas keeps the frame's own shape and is turned around the centre.
  const cw = frameW * s, ch = frameH * s;
  Object.assign(canvas.style, {
    left: `${left + vw / 2 - cw / 2}px`, top: `${top + vh / 2 - ch / 2}px`, width: `${cw}px`, height: `${ch}px`,
    transform: orient.contentRot ? `rotate(${-90 * orient.contentRot}deg)` : '', borderRadius: `${radius}px`, clipPath: '',
  });
  Object.assign(bezel.style, {
    left: `${left - border}px`, top: `${top - border}px`, width: `${vw + 2 * border}px`, height: `${vh + 2 * border}px`,
    borderRadius: `${radius + border}px`,
  });
  bezel.hidden = false;
  Object.assign(keys.style, { left: bezel.style.left, top: bezel.style.top, width: bezel.style.width, height: bezel.style.height });
  Object.assign(fx.style, { left: `${left}px`, top: `${top}px`, width: `${vw}px`, height: `${vh}px`, borderRadius: `${radius}px` });
  fx.hidden = false;
  keys.hidden = false;
  const bw = vw + 2 * border, bh = vh + 2 * border;
  const layout = BUTTON_LAYOUT[platform];
  for (const b of sideButtons) {
    const spec = layout[b.dataset.btn!];
    b.hidden = !orient.keysShown;
    const { edge, start } = placeKey(spec.side, spec.top, spec.height, turns);
    // The keys' length runs along the body's long side, whichever way it lies.
    const along = edge === 'left' || edge === 'right' ? bh : bw;
    b.className = `side-btn ${edge}`;
    b.style.top = edge === 'left' || edge === 'right' ? `${start * along}px` : '';
    b.style.height = edge === 'left' || edge === 'right' ? `${spec.height * along}px` : '';
    b.style.left = edge === 'top' || edge === 'bottom' ? `${start * along}px` : '';
    b.style.width = edge === 'top' || edge === 'bottom' ? `${spec.height * along}px` : '';
    const locked = platform === 'ios' && !document.body.classList.contains('touch-on');
    b.classList.toggle('locked', locked);
    b.title = locked ? 'Enable touch control to use the buttons' : b.getAttribute('aria-label')!;
  }
}
new ResizeObserver(layoutFrame).observe(stage);

// ---- rotate button ---------------------------------------------------------
// Each press turns the phone a quarter turn counter-clockwise: the picture
// swings round, the window takes the new shape, and the device is told so
// apps that support the orientation redraw for it.
const rotateBtn = document.getElementById('rotate') as HTMLButtonElement;
let rotating = false;
rotateBtn.addEventListener('click', () => {
  if (rotating || !frameW) return;
  rotating = true;
  const st = stage.getBoundingClientRect();
  // Shrink while turning so the sideways phone still fits until the window reshapes.
  const fit = Math.min(1, (st.width - 2 * PAD_X) / view.h, (st.height - 2 * PAD_Y) / view.w);
  stage.style.transformOrigin = `${view.left + view.w / 2}px ${view.top + view.h / 2}px`;
  const anim = stage.animate([{ transform: 'rotate(0deg) scale(1)' }, { transform: `rotate(-90deg) scale(${fit})` }], { duration: 320, easing: 'cubic-bezier(.3,.7,.3,1)' });
  const done = () => {
    turns = ((turns + 1) % 4) as QuarterTurns;
    api.rotate(turns);
    layoutFrame();
    anim.cancel();
    rotating = false;
  };
  anim.onfinish = done;
  anim.oncancel = () => { rotating = false; };
});
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

// ---- window controls (the window has no system frame) ----------------------
document.getElementById('win-close')!.addEventListener('click', () => api.windowAction('close'));
document.getElementById('win-min')!.addEventListener('click', () => api.windowAction('minimize'));

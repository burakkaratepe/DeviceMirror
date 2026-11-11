// Screenshot and screen-recording buttons in the mirror window.
//
// Screenshot: the current frame as PNG, with the iPhone-style effect on the
// mirrored screen (white flash, then the shot shrinks into a thumbnail in the
// corner; clicking it opens the captures in the main window).
// Recording: 3-2-1 countdown on the screen, then MediaRecorder on the canvas;
// chunks stream to the main process while recording, so stopping only takes
// a moment (the button shows a spinner meanwhile and nothing is blocked).

import type { MirrorWindowApi } from '../shared/types';

type RecState = 'idle' | 'countdown' | 'recording' | 'saving';

const MIME_CANDIDATES = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];

export function initCaptures(opts: {
  api: MirrorWindowApi;
  canvas: HTMLCanvasElement;
  fx: HTMLElement;
  shotButton: HTMLButtonElement;
  recButton: HTMLButtonElement;
  notify: (text: string) => void;
  /** True while the picture is live (not connecting or failed). */
  isLive: () => boolean;
}) {
  const { api, canvas, fx, shotButton, recButton, notify } = opts;
  const hasPicture = () => opts.isLive() && canvas.width > 0 && canvas.height > 0;
  /**
   * Compression uses Chromium's own encoders (no extra library): WebP at 0.9
   * looks the same as the PNG for screen content at a fraction of the size.
   */
  const SHOT_TYPE = 'image/webp', SHOT_QUALITY = 0.9;
  const encode = () => new Promise<Blob | null>((r) => canvas.toBlob(r, SHOT_TYPE, SHOT_QUALITY));
  /** 360 px wide JPEG for the captures grid. */
  const thumbnail = async (): Promise<Blob | null> => {
    const w = 360, h = Math.round((canvas.height / canvas.width) * w);
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(canvas, 0, 0, w, h);
    return c.convertToBlob({ type: 'image/jpeg', quality: 0.82 }).catch(() => null);
  };
  const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

  // ---- screenshot ------------------------------------------------------

  let shotBusy = false;
  async function screenshot() {
    if (!hasPicture() || shotBusy) return;
    shotBusy = true;
    try {
      const w = canvas.width, h = canvas.height;
      const [blob, thumb] = await Promise.all([encode(), thumbnail()]);
      if (!blob) return;
      shotEffect(blob);
      const ext = blob.type === 'image/webp' ? 'webp' : 'png'; // toBlob falls back to PNG if WebP is unavailable
      const saved = await api.saveScreenshot(await bytes(blob), ext, thumb ? await bytes(thumb) : undefined, w, h);
      if (!saved) notify('Could not save the screenshot.');
    } finally {
      shotBusy = false;
    }
  }

  function shotEffect(blob: Blob) {
    const flash = document.createElement('div');
    flash.className = 'fx-flash';
    fx.append(flash);
    flash.addEventListener('animationend', () => flash.remove());

    fx.querySelector('.fx-thumb')?.remove();
    const url = URL.createObjectURL(blob);
    const img = document.createElement('img');
    img.className = 'fx-thumb';
    img.src = url;
    img.alt = 'Screenshot — open in Device Mirror';
    img.title = 'Saved to Captures — click to open';
    img.addEventListener('click', () => api.showCaptures());
    fx.append(img);
    const r = fx.getBoundingClientRect();
    const tw = r.width * 0.3;
    const th = tw * (r.height / r.width);
    const shrink = img.animate([
      { left: '0px', top: '0px', width: `${r.width}px`, height: `${r.height}px`, borderRadius: '0px' },
      { left: `${r.width * 0.05}px`, top: `${r.height - th - r.width * 0.05}px`, width: `${tw}px`, height: `${th}px`, borderRadius: '10px' },
    ], { duration: 420, delay: 140, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
    void shrink.finished.then(() => {
      const out = img.animate([{ transform: 'translateX(0)', opacity: 1 }, { transform: `translateX(-${tw + r.width * 0.1}px)`, opacity: 0.6 }],
        { duration: 320, delay: 2400, easing: 'ease-in', fill: 'forwards' });
      return out.finished;
    }).catch(() => undefined).finally(() => { img.remove(); URL.revokeObjectURL(url); });
  }

  shotButton.addEventListener('click', () => void screenshot());

  // ---- recording -------------------------------------------------------

  let state: RecState = 'idle';
  let countdownTimer: number | undefined;
  let countdownEl: HTMLElement | undefined;
  let recorder: MediaRecorder | undefined;
  let recId: string | undefined;
  let startedAt = 0;
  let poster: Blob | null = null;
  let sendChain: Promise<void> = Promise.resolve();
  let badge: HTMLElement | undefined;
  let keepAlive: number | undefined;
  let badgeTimer: number | undefined;

  const setState = (next: RecState) => {
    state = next;
    recButton.dataset.state = next;
    const label = {
      idle: 'Record the screen', countdown: 'Cancel recording', recording: 'Stop recording', saving: 'Saving the recording…',
    }[next];
    recButton.title = label;
    recButton.setAttribute('aria-label', label);
    recButton.setAttribute('aria-pressed', String(next === 'recording'));
  };
  setState('idle');

  function startCountdown() {
    if (!hasPicture()) return;
    setState('countdown');
    let n = 3;
    countdownEl = document.createElement('div');
    countdownEl.className = 'fx-countdown';
    fx.append(countdownEl);
    const show = () => {
      countdownEl!.textContent = String(n);
      countdownEl!.classList.remove('tick');
      void countdownEl!.offsetWidth; // restart the animation
      countdownEl!.classList.add('tick');
    };
    show();
    countdownTimer = window.setInterval(() => {
      n -= 1;
      if (n > 0) { show(); return; }
      endCountdown();
      void startRecording();
    }, 1000);
  }

  function endCountdown() {
    clearInterval(countdownTimer);
    countdownEl?.remove();
    countdownEl = undefined;
  }

  async function startRecording() {
    const mime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) { notify('Screen recording is not supported here.'); setState('idle'); return; }
    poster = await thumbnail();
    const id = await api.recStart(mime, canvas.width, canvas.height);
    if (!id) { notify('Could not start the recording.'); setState('idle'); return; }
    recId = id;
    const stream = canvas.captureStream(60);
    // H.264 at about 2.5 bits per pixel per second: plenty for screen content
    // (sharp text, mostly still), a few MB per minute at 1080p.
    const bitrate = Math.min(8_000_000, Math.max(2_500_000, Math.round(canvas.width * canvas.height * 2.5)));
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
    sendChain = Promise.resolve();
    recorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      // Keep chunks in order even though reading each one is async.
      sendChain = sendChain.then(async () => api.recChunk(id, await bytes(e.data)));
    };
    recorder.onstop = () => void finish(stream);
    recorder.onerror = () => { notify('The recording stopped because of an error.'); };
    recorder.start(1000);
    // The canvas only yields a frame when it is painted, and a still screen is
    // not repainted, so a still ending would be cut off. Repaint the same
    // picture a few times a second while recording to keep frames coming.
    const g = canvas.getContext('2d')!;
    keepAlive = window.setInterval(() => g.drawImage(canvas, 0, 0), 100);
    startedAt = performance.now();
    setState('recording');
    showBadge();
  }

  function showBadge() {
    badge = document.createElement('div');
    badge.className = 'fx-rec';
    fx.append(badge);
    const tick = () => {
      const s = Math.floor((performance.now() - startedAt) / 1000);
      badge!.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    badgeTimer = window.setInterval(tick, 500);
  }

  async function finish(stream: MediaStream) {
    clearInterval(keepAlive);
    clearInterval(badgeTimer);
    badge?.remove();
    for (const t of stream.getTracks()) t.stop();
    const id = recId!;
    const duration = performance.now() - startedAt;
    recorder = undefined;
    recId = undefined;
    setState('saving');
    try {
      await sendChain;
      const saved = await api.recStop(id, duration, poster ? await bytes(poster) : undefined);
      notify(saved ? 'Recording saved to Captures.' : 'The recording was empty, nothing was saved.');
    } catch {
      notify('Could not save the recording.');
    } finally {
      poster = null;
      setState('idle');
    }
  }

  recButton.addEventListener('click', () => {
    if (state === 'idle') startCountdown();
    else if (state === 'countdown') { endCountdown(); setState('idle'); }
    else if (state === 'recording') recorder?.stop();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state === 'countdown') { endCountdown(); setState('idle'); }
  });
}

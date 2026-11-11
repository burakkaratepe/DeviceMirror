// "Captures" page of the main window: screenshots and recordings taken from
// mirror windows, filtered by chips (All / Screenshots / Videos). Clicking a
// capture opens it large; "Download" saves a copy wherever the user picks.

import type { Capture, CaptureKind, DeviceMirrorApi } from '../shared/types';

type Filter = 'all' | CaptureKind;

const DOWNLOAD_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.2m0 0L5.2 6.9M8 9.7l2.8-2.8M3 11.5v1a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PLAY_BADGE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.4v9.2a.6.6 0 0 0 .92.5l7.1-4.6a.6.6 0 0 0 0-1L5.92 2.9A.6.6 0 0 0 5 3.4z" fill="currentColor"/></svg>';

const CAMERA_ICON = '<svg viewBox="0 0 24 24"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.2-1.6A1 1 0 0 1 10.1 4h3.8a1 1 0 0 1 .8.4L15.9 6h1.6A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="12.3" r="3.3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const VIDEO_ICON = '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16 10.5 5-3v9l-5-3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
const REVEAL_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const url = (file: string) => `dm-capture://files/${encodeURIComponent(file)}`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const size = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
const duration = (ms = 0) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function initCapturesView(api: DeviceMirrorApi, notify: (text: string) => void) {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const grid = $<HTMLElement>('cap-grid');
  const empty = $<HTMLDivElement>('cap-empty');
  const emptyTitle = $<HTMLParagraphElement>('cap-empty-title');
  const chips = $<HTMLDivElement>('cap-chips');
  const count = $<HTMLSpanElement>('cap-count');
  const navCount = $<HTMLSpanElement>('nav-cap-count');
  const viewer = $<HTMLDialogElement>('cap-viewer');
  const viewerBody = $<HTMLDivElement>('cap-viewer-body');
  const viewerTitle = $<HTMLHeadingElement>('cap-viewer-title');
  const viewerMeta = $<HTMLParagraphElement>('cap-viewer-meta');

  const revealLabel = api.platform === 'darwin' ? 'Show in Finder' : api.platform === 'win32' ? 'Show in File Explorer' : 'Show in folder';
  let items: Capture[] = [];
  let filter: Filter = 'all';
  /** Device.id to show only that device's captures; undefined = all devices. */
  let deviceFilter: string | undefined;
  const devChips = $<HTMLDivElement>('cap-device-chips');
  const listeners = new Set<() => void>();
  let current: Capture | undefined;

  async function download(c: Capture) {
    if (await api.downloadCapture(c.id)) notify('Saved a copy.');
  }

  function card(c: Capture): HTMLElement {
    const a = el('article', 'cap-card');
    const thumb = el('button', 'cap-thumb');
    thumb.type = 'button';
    thumb.title = 'Open';
    thumb.setAttribute('aria-label', `Open ${c.kind === 'video' ? 'recording' : 'screenshot'} from ${c.deviceName}`);
    if (c.thumb) {
      const img = el('img');
      img.src = url(c.thumb);
      img.alt = '';
      img.loading = 'lazy';
      thumb.append(img);
    }
    if (c.kind === 'video') {
      const b = el('span', 'cap-badge');
      b.innerHTML = PLAY_BADGE;
      b.append(document.createTextNode(duration(c.durationMs)));
      thumb.append(b);
    }
    thumb.addEventListener('click', () => open(c));
    // On hover: open the file's folder with the file selected.
    const reveal = el('button', 'cap-reveal');
    reveal.type = 'button';
    reveal.innerHTML = REVEAL_ICON;
    reveal.title = revealLabel;
    reveal.setAttribute('aria-label', revealLabel);
    reveal.addEventListener('click', () => api.revealCapture(c.id));
    const body = el('div', 'cap-body');
    const name = el('p', 'cap-name', c.deviceName);
    name.title = `${c.platform === 'ios' ? 'UDID' : 'Serial'}: ${c.serial}`;
    body.append(name, el('p', 'cap-meta', `${when(c.createdAt)} · ${size(c.size)}`));
    const actions = el('div', 'cap-actions');
    const dl = el('button', 'cap-btn');
    dl.type = 'button';
    dl.innerHTML = `${DOWNLOAD_ICON}<span>Download</span>`;
    dl.title = 'Save a copy to another folder';
    dl.addEventListener('click', () => void download(c));
    const del = el('button', 'cap-btn icon');
    del.type = 'button';
    del.innerHTML = TRASH_ICON;
    del.title = 'Delete';
    del.setAttribute('aria-label', 'Delete');
    del.addEventListener('click', () => { if (confirm(`Delete this ${c.kind === 'video' ? 'recording' : 'screenshot'}? This cannot be undone.`)) void api.deleteCapture(c.id); });
    actions.append(dl, del);
    a.append(thumb, reveal, body, actions);
    return a;
  }

  function render() {
    const shots = items.filter((c) => c.kind === 'screenshot').length;
    const videos = items.length - shots;
    const labels: [Filter, string, number][] = [['all', 'All', items.length], ['screenshot', 'Screenshots', shots], ['video', 'Videos', videos]];
    for (const l of listeners) l();
    chips.replaceChildren(...labels.map(([f, label, n]) => {
      const b = el('button', 'chip');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(f === filter));
      b.append(document.createTextNode(label), el('span', 'chip-count', String(n)));
      b.addEventListener('click', () => { filter = f; render(); });
      return b;
    }));
    // Second row: one chip per device that has captures (UDID / serial on hover).
    const devices = [...new Map(items.map((c) => [c.deviceId, c])).values()];
    if (deviceFilter && !devices.some((c) => c.deviceId === deviceFilter)) deviceFilter = undefined;
    devChips.hidden = devices.length < 2 && !deviceFilter;
    const devChip = (id: string | undefined, label: string, n: number, title?: string) => {
      const b = el('button', 'chip small');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(id === deviceFilter));
      if (title) b.title = title;
      b.append(document.createTextNode(label), el('span', 'chip-count', String(n)));
      b.addEventListener('click', () => { deviceFilter = id; render(); });
      return b;
    };
    devChips.replaceChildren(
      devChip(undefined, 'All devices', items.length),
      ...devices.map((c) => devChip(c.deviceId, c.deviceName, items.filter((x) => x.deviceId === c.deviceId).length, `${c.platform === 'ios' ? 'UDID' : 'Serial'}: ${c.serial}`)),
    );
    const shown = items.filter((c) => (filter === 'all' || c.kind === filter) && (!deviceFilter || c.deviceId === deviceFilter));
    grid.replaceChildren(...shown.map(card));
    empty.hidden = shown.length > 0;
    emptyTitle.textContent = filter === 'video' ? 'No recordings yet' : filter === 'screenshot' ? 'No screenshots yet' : 'Nothing captured yet';
    count.textContent = items.length ? String(items.length) : '';
    clearBtn.hidden = items.length === 0;
    navCount.textContent = items.length ? String(items.length) : '';
  }

  function open(c: Capture) {
    current = c;
    viewerTitle.textContent = c.deviceName;
    viewerMeta.textContent = `${c.kind === 'video' ? `Recording · ${duration(c.durationMs)}` : 'Screenshot'} · ${c.width}×${c.height} · ${size(c.size)} · ${when(c.createdAt)} · ${c.platform === 'ios' ? 'UDID' : 'Serial'} ${c.serial}`;
    if (c.kind === 'video') {
      const v = el('video');
      v.src = url(c.file);
      v.controls = true;
      v.autoplay = true;
      viewerBody.replaceChildren(v);
    } else {
      const img = el('img');
      img.src = url(c.file);
      img.alt = `Screenshot from ${c.deviceName}`;
      viewerBody.replaceChildren(img);
    }
    viewer.showModal();
  }
  viewer.addEventListener('close', () => { viewerBody.replaceChildren(); current = undefined; });
  viewer.addEventListener('click', (e) => { if (e.target === viewer) viewer.close(); });
  $<HTMLButtonElement>('cap-viewer-close').addEventListener('click', () => viewer.close());
  $<HTMLButtonElement>('cap-viewer-download').addEventListener('click', () => { if (current) void download(current); });

  // A new capture: its icon pops up next to "Captures" in the sidebar for 1.5 s.
  const flash = $<HTMLSpanElement>('nav-cap-flash');
  let known: Set<string> | undefined;
  let flashTimer: number | undefined;
  function announce(c: Capture) {
    flash.innerHTML = c.kind === 'video' ? VIDEO_ICON : CAMERA_ICON;
    flash.classList.remove('show');
    void flash.offsetWidth; // restart the animation
    flash.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => flash.classList.remove('show'), 1500);
  }

  async function refresh() {
    items = await api.listCaptures();
    const fresh = known ? items.filter((c) => !known!.has(c.id)) : [];
    known = new Set(items.map((c) => c.id));
    if (fresh.length) announce(fresh[0]);
    if (current && !items.some((c) => c.id === current!.id)) viewer.close();
    render();
  }
  // ---- delete all ----------------------------------------------------
  const clearBtn = $<HTMLButtonElement>('cap-clear');
  const clearDialog = $<HTMLDialogElement>('cap-clear-dialog');
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  clearBtn.addEventListener('click', () => {
    const shots = items.filter((c) => c.kind === 'screenshot').length;
    const parts = [shots && plural(shots, 'screenshot', 'screenshots'), items.length - shots && plural(items.length - shots, 'recording', 'recordings')].filter(Boolean);
    $<HTMLParagraphElement>('cap-clear-text').textContent =
      `This permanently deletes ${parts.join(' and ')} from all devices on this computer. Copies you downloaded elsewhere are kept. This cannot be undone.`;
    clearDialog.showModal();
    $<HTMLButtonElement>('cap-clear-cancel').focus(); // the safe choice is the default
  });
  $<HTMLButtonElement>('cap-clear-cancel').addEventListener('click', () => clearDialog.close());
  $<HTMLButtonElement>('cap-clear-confirm').addEventListener('click', async () => {
    clearDialog.close();
    await api.deleteAllCaptures();
    notify('All captures were deleted.');
  });

  api.onCapturesChanged(() => void refresh());
  void refresh();

  return {
    /** Number of captures from a device (for the device cards). */
    countFor: (deviceId: string) => items.filter((c) => c.deviceId === deviceId).length,
    /** Shows only this device's captures (or all with undefined). */
    showDevice(deviceId: string | undefined) { deviceFilter = deviceId; filter = 'all'; render(); },
    onChange(cb: () => void) { listeners.add(cb); },
  };
}

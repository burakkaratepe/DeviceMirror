import type { Device, DeviceMirrorApi, DeviceSnapshot, ServiceStatus } from '../shared/types';
import { mockupSvg } from './mockups';
import { focusOpenMenu, installOutsideClose, qualityPicker, type PickerHooks, type PickerState } from './qualityPicker';
import { strings } from './strings';
import { initCapturesView } from './capturesView';

declare global {
  interface Window { deviceMirror: DeviceMirrorApi }
}

const api = window.deviceMirror;
const capturesView = initCapturesView(api, (t) => showToast(t));
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const grid = $<HTMLElement>('grid');
const empty = $<HTMLDivElement>('empty');
const count = $<HTMLSpanElement>('count');
const notices = $<HTMLDivElement>('notices');

let last: DeviceSnapshot = { devices: [], services: { android: { ok: true }, ios: { ok: true } } };
const picker: PickerState = { activeIndex: 1 };
const pickerHooks: PickerHooks = {
  state: picker,
  refresh: () => render(last),
  select: (deviceId, q) => {
    picker.openFor = undefined;
    // Optimistic update so the menu closes on the new value immediately.
    render({ ...last, devices: last.devices.map((d) => (d.id === deviceId ? { ...d, quality: q } : d)) });
    (grid.querySelector(`.card[data-id="${CSS.escape(deviceId)}"] .q-trigger`) as HTMLElement | null)?.focus();
    void api.setQuality(deviceId, q);
  },
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const PLAY_ICON = '<svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.4v9.2a.6.6 0 0 0 .92.5l7.1-4.6a.6.6 0 0 0 0-1L5.92 2.9A.6.6 0 0 0 5 3.4z" fill="currentColor"/></svg>';

function card(d: Device, index: number): HTMLElement {
  const c = el('article', `card state-${d.state}`);
  c.dataset.id = d.id;

  const preview = el('div', 'preview');
  preview.innerHTML = mockupSvg(d, String(index));
  const dot = el('span', 'status-dot');
  dot.title = strings.state[d.state];
  preview.append(dot);
  const badge = el('span', `platform-badge ${d.platform}`, strings.platform[d.platform]);
  preview.append(badge);
  if (d.screenOff) preview.append(el('span', 'screen-off', strings.screenOff));
  const shots = capturesView.countFor(d.id);
  if (shots) {
    const link = el('button', 'captures-link');
    link.type = 'button';
    link.title = `Screenshots and recordings from ${d.name}`;
    link.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8" /><circle cx="9" cy="10" r="1.6" fill="currentColor" /><path d="m4.5 17 4.8-4.6 3.2 3 2.6-2.4 4.4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /></svg>';
    link.append(document.createTextNode(String(shots)));
    link.addEventListener('click', () => { capturesView.showDevice(d.id); showView('captures'); });
    preview.append(link);
  }

  const body = el('div', 'card-body');
  body.append(el('h2', 'name', d.name));
  // Second detail: the retail name when the title is a user-chosen device name
  // (iOS), otherwise the model code (useful for testers).
  const model = d.marketingName && d.marketingName !== d.name ? d.marketingName
    : d.platform === 'android' && d.model && d.model !== d.name ? d.model : undefined;
  body.append(el('p', 'meta', [d.osVersion, model].filter(Boolean).join(' · ') || ' '));
  const hint = el('p', 'hint');
  if (d.state !== 'ready') hint.textContent = strings.state[d.state];
  body.append(hint);

  const actions = el('div', 'actions');
  const qWrap = qualityPicker(d.id, d.name, d.quality, pickerHooks);

  const mirror = el('button', d.mirroring ? 'btn-primary is-mirroring' : 'btn-primary', d.mirroring ? strings.mirroring : strings.mirror);
  mirror.type = 'button';
  if (!d.mirroring) mirror.insertAdjacentHTML('beforeend', PLAY_ICON);
  mirror.disabled = !d.mirroring && !!d.mirrorUnavailableReason;
  mirror.addEventListener('click', () => void startMirror(d.id));
  const mWrap = el('span', 'mirror-wrap');
  mWrap.title = d.mirrorUnavailableReason ?? '';
  mWrap.append(mirror);

  actions.append(qWrap, mWrap);
  body.append(actions);
  c.append(preview, body);
  return c;
}

// ---- mirroring -----------------------------------------------------------

const limitDialog = $<HTMLDialogElement>('limit-dialog');
const limitList = $<HTMLDivElement>('limit-list');
const toast = $<HTMLDivElement>('toast');
let toastTimer: number | undefined;

function showToast(text: string) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 4000);
}

async function startMirror(deviceId: string, replaceId?: string) {
  const res = await api.mirror(deviceId, replaceId);
  if (res.ok) return;
  if (res.reason === 'error') { showToast(res.message); return; }
  // Limit reached: offer to stop one of the running mirrors.
  limitList.replaceChildren(
    ...res.active.map((a) => {
      const b = el('button', 'limit-option');
      b.type = 'button';
      b.append(el('span', 'limit-name', a.name), el('span', 'limit-action', strings.stopAndMirror));
      b.addEventListener('click', () => { limitDialog.close(); void startMirror(deviceId, a.id); });
      return b;
    }),
  );
  limitDialog.showModal();
}
$<HTMLButtonElement>('limit-cancel').addEventListener('click', () => limitDialog.close());

function renderService(id: string, s: ServiceStatus) {
  const node = $<HTMLDivElement>(id);
  node.classList.toggle('down', !s.ok);
  (node.querySelector('.svc-detail') as HTMLElement).textContent = s.ok ? strings.serviceOk : strings.serviceDown;
  node.title = s.message ?? '';
}

function render(s: DeviceSnapshot) {
  last = s;
  if (picker.openFor && !s.devices.some((d) => d.id === picker.openFor)) picker.openFor = undefined; // device unplugged
  const focused = document.activeElement as HTMLElement | null;
  const focusedId = (focused?.closest('.card') as HTMLElement | null)?.dataset.id;
  const focusedClass = focused?.classList.contains('btn-primary') ? '.btn-primary' : '.q-trigger';
  grid.replaceChildren(...s.devices.map(card));
  if (picker.openFor) focusOpenMenu(picker);
  else if (focusedId) (grid.querySelector(`.card[data-id="${CSS.escape(focusedId)}"] ${focusedClass}`) as HTMLElement | null)?.focus();

  empty.hidden = s.devices.length > 0;
  count.textContent = s.devices.length ? String(s.devices.length) : '';

  renderService('svc-android', s.services.android);
  renderService('svc-ios', s.services.ios);
  notices.replaceChildren();
  for (const [label, svc] of [[strings.platform.android, s.services.android], [strings.platform.ios, s.services.ios]] as const) {
    if (svc.ok) continue;
    const n = el('div', 'notice');
    n.append(el('strong', undefined, `${label}: `), document.createTextNode(svc.message ?? strings.serviceDown));
    notices.append(n);
  }
}

// ---- pages ---------------------------------------------------------------

function showView(view: 'devices' | 'captures') {
  $<HTMLDivElement>('view-devices').hidden = view !== 'devices';
  $<HTMLDivElement>('view-captures').hidden = view !== 'captures';
  api.setDevicesPageShown(view === 'devices');
  for (const b of document.querySelectorAll<HTMLButtonElement>('.nav-item')) {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.nav-item')) {
  b.addEventListener('click', () => showView(b.dataset.view as 'devices' | 'captures'));
}
api.onShowCaptures(() => showView('captures'));
capturesView.onChange(() => render(last));

installOutsideClose(picker, () => render(last));
api.onSnapshot(render);
void api.getSnapshot().then(render);

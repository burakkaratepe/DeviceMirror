import type { Device, DeviceMirrorApi, DeviceSnapshot, ServiceStatus } from '../shared/types';
import { mockupSvg } from './mockups';
import { focusOpenMenu, installOutsideClose, qualityPicker, type PickerHooks, type PickerState } from './qualityPicker';
import { strings } from './strings';

declare global {
  interface Window { deviceMirror: DeviceMirrorApi }
}

const api = window.deviceMirror;
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

  const body = el('div', 'card-body');
  body.append(el('h2', 'name', d.name));
  const model = d.model && d.model !== d.name ? d.model : undefined;
  body.append(el('p', 'meta', [d.osVersion, model].filter(Boolean).join(' · ') || ' '));
  const hint = el('p', 'hint');
  if (d.state !== 'ready') hint.textContent = strings.state[d.state];
  body.append(hint);

  const actions = el('div', 'actions');
  const qWrap = qualityPicker(d.id, d.name, d.quality, pickerHooks);

  const mirror = el('button', d.mirroring ? 'btn-primary is-mirroring' : 'btn-primary', d.mirroring ? strings.mirroring : strings.mirror);
  mirror.type = 'button';
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

installOutsideClose(picker, () => render(last));
api.onSnapshot(render);
void api.getSnapshot().then(render);

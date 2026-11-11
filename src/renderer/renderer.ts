import type { Device, DeviceMirrorApi, DeviceSnapshot, Quality, ServiceStatus } from '../shared/types';
import { mockupSvg } from './mockups';
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
  const qWrap = el('label', 'quality');
  const select = el('select');
  select.title = strings.qualityLabel;
  select.setAttribute('aria-label', `${strings.qualityLabel} for ${d.name}`);
  for (const q of ['low', 'medium', 'high'] as Quality[]) {
    const o = el('option', undefined, strings.quality[q]);
    o.value = q;
    o.selected = q === d.quality;
    select.append(o);
  }
  select.addEventListener('change', () => void api.setQuality(d.id, select.value as Quality));
  qWrap.append(select);

  const mirror = el('button', 'btn-primary', strings.mirror);
  mirror.type = 'button';
  mirror.disabled = !!d.mirrorUnavailableReason;
  mirror.addEventListener('click', () => void api.mirror(d.id));
  const mWrap = el('span', 'mirror-wrap');
  mWrap.title = d.mirrorUnavailableReason ?? '';
  mWrap.append(mirror);

  actions.append(qWrap, mWrap);
  body.append(actions);
  c.append(preview, body);
  return c;
}

function renderService(id: string, s: ServiceStatus) {
  const node = $<HTMLDivElement>(id);
  node.classList.toggle('down', !s.ok);
  (node.querySelector('.svc-detail') as HTMLElement).textContent = s.ok ? strings.serviceOk : strings.serviceDown;
  node.title = s.message ?? '';
}

function render(s: DeviceSnapshot) {
  const focusedId = (document.activeElement?.closest('.card') as HTMLElement | null)?.dataset.id;
  grid.replaceChildren(...s.devices.map(card));
  if (focusedId) (grid.querySelector(`.card[data-id="${CSS.escape(focusedId)}"] select`) as HTMLElement | null)?.focus();

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

api.onSnapshot(render);
void api.getSnapshot().then(render);

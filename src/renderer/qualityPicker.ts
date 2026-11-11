// Custom quality dropdown (replaces the native <select>, whose popup is drawn
// by the OS and cannot be styled). Listbox pattern: button + popup list,
// arrow keys / Enter / Space / Escape, closes on outside click.

import type { Quality } from '../shared/types';
import { strings } from './strings';

const QUALITIES: Quality[] = ['low', 'medium', 'high'];

export interface PickerState {
  /** Device whose menu is open, if any. */
  openFor?: string;
  /** Option index that has keyboard focus inside the open menu. */
  activeIndex: number;
}

export interface PickerHooks {
  state: PickerState;
  /** Re-render the device grid (state is read again from `state`). */
  refresh(): void;
  select(deviceId: string, q: Quality): void;
}

const CHEVRON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const BARS: Record<Quality, number> = { low: 1, medium: 2, high: 3 };

/** Three small signal bars, `n` of them filled. */
function bars(n: number): string {
  return `<svg class="q-bars" viewBox="0 0 14 12" aria-hidden="true">${[0, 1, 2]
    .map((i) => `<rect x="${i * 5}" y="${8 - i * 4}" width="3.4" height="${4 + i * 4}" rx="1" class="${i < n ? 'on' : ''}"/>`)
    .join('')}</svg>`;
}

export function qualityPicker(deviceId: string, deviceName: string, current: Quality, hooks: PickerHooks): HTMLElement {
  const { state } = hooks;
  const open = state.openFor === deviceId;
  const listId = `q-list-${deviceId.replace(/[^a-z0-9]/gi, '-')}`;

  const root = document.createElement('div');
  root.className = `qpicker${open ? ' open' : ''}`;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'q-trigger';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', String(open));
  btn.setAttribute('aria-controls', listId);
  btn.setAttribute('aria-label', `${strings.qualityLabel} for ${deviceName}: ${strings.quality[current]}`);
  btn.innerHTML = `${bars(BARS[current])}<span class="q-value"></span><span class="q-chevron">${CHEVRON}</span>`;
  (btn.querySelector('.q-value') as HTMLElement).textContent = strings.quality[current];

  const openMenu = (index = QUALITIES.indexOf(current)) => {
    state.openFor = deviceId;
    state.activeIndex = index;
    hooks.refresh();
  };
  btn.addEventListener('click', () => {
    if (open) { state.openFor = undefined; hooks.refresh(); } else openMenu();
  });
  btn.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key) && !open) {
      e.preventDefault();
      openMenu();
    }
  });
  root.append(btn);

  if (open) {
    const list = document.createElement('ul');
    list.className = 'q-menu';
    list.id = listId;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', strings.qualityLabel);
    const head = document.createElement('li');
    head.className = 'q-head';
    head.setAttribute('role', 'presentation');
    head.textContent = strings.qualityLabel;
    list.append(head);

    QUALITIES.forEach((q, i) => {
      const li = document.createElement('li');
      li.className = `q-option${q === current ? ' selected' : ''}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(q === current));
      li.tabIndex = -1;
      li.dataset.index = String(i);
      li.innerHTML = `${bars(BARS[q])}<span class="q-text"><span class="q-name"></span><span class="q-desc"></span></span><span class="q-check">${q === current ? CHECK : ''}</span>`;
      (li.querySelector('.q-name') as HTMLElement).textContent = strings.quality[q];
      (li.querySelector('.q-desc') as HTMLElement).textContent = strings.qualityDetail[q];
      li.addEventListener('click', () => hooks.select(deviceId, q));
      li.addEventListener('mousemove', () => {
        if (state.activeIndex !== i) { state.activeIndex = i; li.focus(); }
      });
      list.append(li);
    });

    list.addEventListener('keydown', (e) => {
      const move = (delta: number) => {
        state.activeIndex = (state.activeIndex + delta + QUALITIES.length) % QUALITIES.length;
        (list.querySelector(`[data-index="${state.activeIndex}"]`) as HTMLElement).focus();
      };
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); move(1); break;
        case 'ArrowUp': e.preventDefault(); move(-1); break;
        case 'Home': e.preventDefault(); move(-state.activeIndex); break;
        case 'End': e.preventDefault(); move(QUALITIES.length - 1 - state.activeIndex); break;
        case 'Enter':
        case ' ': e.preventDefault(); hooks.select(deviceId, QUALITIES[state.activeIndex]); break;
        case 'Escape':
          e.preventDefault();
          state.openFor = undefined;
          hooks.refresh();
          (document.querySelector(`.card[data-id="${CSS.escape(deviceId)}"] .q-trigger`) as HTMLElement | null)?.focus();
          break;
        case 'Tab': state.openFor = undefined; hooks.refresh(); break;
      }
    });
    root.append(list);
  }
  return root;
}

/** After a render, put keyboard focus back on the active option of the open menu. */
export function focusOpenMenu(state: PickerState) {
  if (!state.openFor) return;
  (document.querySelector(`.qpicker.open .q-option[data-index="${state.activeIndex}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
}

/** Closes the open menu when the user clicks anywhere outside a picker. */
export function installOutsideClose(state: PickerState, refresh: () => void) {
  document.addEventListener('pointerdown', (e) => {
    if (state.openFor && !(e.target as Element).closest('.qpicker')) {
      state.openFor = undefined;
      refresh();
    }
  });
  window.addEventListener('blur', () => {
    if (state.openFor) { state.openFor = undefined; refresh(); }
  });
}

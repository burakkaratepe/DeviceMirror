// Floating tooltips for the mirror window's control rail. The native title
// tooltip is slow and easy to miss; this one shows quickly to the left of the
// rail. Titles keep working as the source: whenever code sets an element's
// title (labels change with state), it is moved to data-tip so the native
// tooltip does not show as well.

const SHOW_DELAY_MS = 350;

export function initTooltips(root: HTMLElement, tip: HTMLElement) {
  let current: HTMLElement | undefined;
  let timer: number | undefined;

  const adopt = (el: Element) => {
    const t = el.getAttribute('title');
    if (t === null) return;
    (el as HTMLElement).dataset.tip = t;
    el.removeAttribute('title');
    if (el === current) place(el as HTMLElement); // label changed while shown
  };
  root.querySelectorAll('[title]').forEach(adopt);
  new MutationObserver((list) => { for (const m of list) adopt(m.target as Element); })
    .observe(root, { attributes: true, attributeFilter: ['title'], subtree: true });

  function place(el: HTMLElement) {
    const text = el.dataset.tip;
    if (!text) { hide(); return; }
    tip.textContent = text;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const left = Math.max(6, r.left - t.width - 10);
    const top = Math.min(window.innerHeight - t.height - 6, Math.max(6, r.top + r.height / 2 - t.height / 2));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.classList.add('show');
  }
  function show(el: HTMLElement, now = false) {
    clearTimeout(timer);
    current = el;
    // Moving between buttons keeps the tooltip up and just moves it.
    if (now || tip.classList.contains('show')) place(el);
    else timer = window.setTimeout(() => { if (current === el) place(el); }, SHOW_DELAY_MS);
  }
  function hide() {
    clearTimeout(timer);
    current = undefined;
    tip.classList.remove('show');
    tip.hidden = true;
  }

  const target = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
  root.addEventListener('pointerover', (e) => { const el = target(e); if (el && root.contains(el)) show(el); });
  root.addEventListener('pointerout', (e) => {
    const to = (e as PointerEvent).relatedTarget as HTMLElement | null;
    if (!to || !to.closest?.('[data-tip]') || !root.contains(to)) hide();
  });
  root.addEventListener('pointerdown', hide); // clicking: get out of the way
  root.addEventListener('focusin', (e) => { const el = target(e); if (el && (el as HTMLElement).matches(':focus-visible')) show(el, true); });
  root.addEventListener('focusout', hide);
  window.addEventListener('blur', hide);
}

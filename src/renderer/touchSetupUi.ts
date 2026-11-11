// iOS "Enable touch control" flow in the mirror window:
//   invite overlay → (saved identity? skip) → signing dialog → setup checklist.

import type { MirrorWindowApi, SetupStep, StoredIdentitySummary } from '../shared/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function initTouchSetup(api: MirrorWindowApi, getSerial: () => string) {
  const invite = $<HTMLDivElement>('invite');
  const signing = $<HTMLDialogElement>('signing');
  const setup = $<HTMLDialogElement>('setup');
  const p12Name = $<HTMLSpanElement>('p12-name');
  const profileName = $<HTMLSpanElement>('profile-name');
  const password = $<HTMLInputElement>('p12-password');
  const problems = $<HTMLUListElement>('signing-problems');
  const continueBtn = $<HTMLButtonElement>('signing-continue');
  let p12Path: string | undefined;
  let profilePath: string | undefined;
  let invited = false;

  // ---- invite overlay --------------------------------------------------
  // Shown once per window when the iOS picture first arrives. A click outside
  // the card dismisses it; the toolbar button reopens the flow at any time.

  const toolbarButton = $<HTMLButtonElement>('touch-enable');
  /** While the invite is up, the toolbar's hand icon gently bounces to show where the flow lives later. */
  const setInvite = (visible: boolean) => {
    invite.hidden = !visible;
    toolbarButton.classList.toggle('nudge', visible);
  };
  const showInvite = () => { setInvite(true); $<HTMLButtonElement>('invite-enable').focus(); };
  invite.addEventListener('pointerdown', (e) => {
    if (!(e.target as HTMLElement).closest('.invite-card')) setInvite(false);
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !invite.hidden) setInvite(false); });

  async function start() {
    setInvite(false);
    const saved = await api.savedIdentity();
    if (saved) runSetup(saved);
    else openSigning();
  }
  $<HTMLButtonElement>('invite-enable').addEventListener('click', () => void start());
  toolbarButton.addEventListener('click', () => void start());

  // ---- signing dialog --------------------------------------------------

  const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
  const refresh = () => { continueBtn.disabled = !p12Path || !profilePath || !password.value; };

  function openSigning() {
    $<HTMLElement>('udid').textContent = getSerial();
    problems.hidden = true;
    refresh();
    signing.showModal();
  }

  async function pick(kind: 'p12' | 'profile') {
    const p = await api.pickFile(kind);
    if (!p) return;
    const label = kind === 'p12' ? p12Name : profileName;
    label.textContent = fileName(p);
    label.classList.add('chosen');
    label.title = p;
    if (kind === 'p12') { p12Path = p; password.focus(); } else profilePath = p;
    problems.hidden = true;
    refresh();
  }
  $<HTMLButtonElement>('p12-pick').addEventListener('click', () => void pick('p12'));
  $<HTMLButtonElement>('profile-pick').addEventListener('click', () => void pick('profile'));
  password.addEventListener('input', refresh);
  password.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !continueBtn.disabled) continueBtn.click(); });
  $<HTMLButtonElement>('udid-copy').addEventListener('click', (e) => {
    api.copyText(getSerial());
    const b = e.currentTarget as HTMLButtonElement;
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = 'Copy'; }, 1200);
  });
  $<HTMLButtonElement>('signing-cancel').addEventListener('click', () => signing.close());

  continueBtn.addEventListener('click', async () => {
    if (!p12Path || !profilePath) return;
    continueBtn.disabled = true;
    continueBtn.textContent = 'Checking…';
    const res = await api.checkSigning(p12Path, password.value, profilePath);
    continueBtn.textContent = 'Continue';
    refresh();
    if (!res.ok) {
      problems.replaceChildren(...res.problems.map((m) => Object.assign(document.createElement('li'), { textContent: m })));
      problems.hidden = false;
      return;
    }
    password.value = '';
    signing.close();
    runSetup(res.identity);
  });

  // ---- setup checklist -------------------------------------------------

  function runSetup(identity?: StoredIdentitySummary) {
    $<HTMLElement>('setup-identity').textContent = identity
      ? `${identity.certificate} · ${identity.team} · valid until ${identity.expires}`
      : '';
    for (const li of setup.querySelectorAll<HTMLLIElement>('.steps li')) {
      li.dataset.state = 'pending';
      (li.querySelector('small') as HTMLElement).textContent = '';
    }
    setup.showModal();
    void api.runSetup();
  }
  api.onSetupStep((s: SetupStep) => {
    const li = setup.querySelector<HTMLLIElement>(`.steps li[data-step="${s.id}"]`);
    if (!li) return;
    li.dataset.state = s.state;
    (li.querySelector('small') as HTMLElement).textContent = s.detail ?? '';
  });
  $<HTMLButtonElement>('setup-close').addEventListener('click', () => setup.close());
  $<HTMLButtonElement>('setup-change').addEventListener('click', () => { setup.close(); openSigning(); });

  return {
    /** Call when the iOS picture first appears. */
    onLive() {
      if (invited) return;
      invited = true;
      showInvite();
    },
  };
}

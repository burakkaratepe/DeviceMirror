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

  // ---- toolbar toggle --------------------------------------------------
  // Grey = off, green = on, spinner = starting. Clicking while on switches
  // touch off (the runner keeps running on the device, so switching back on
  // is instant). Starting runs quietly; the checklist only opens when there is
  // real work to watch (signing, installing) or something needs the user.

  type TouchState = 'off' | 'starting' | 'on';
  let state: TouchState = 'off';
  let quiet = false;
  const setState = (next: TouchState) => {
    state = next;
    toolbarButton.dataset.state = next;
    const label = next === 'on' ? 'Touch control is on — click to turn off' : next === 'starting' ? 'Starting touch control…' : 'Turn on touch control';
    toolbarButton.title = label;
    toolbarButton.setAttribute('aria-label', label);
    toolbarButton.setAttribute('aria-pressed', String(next === 'on'));
  };
  setState('off');

  async function start() {
    setInvite(false);
    if (state !== 'off') return;
    const saved = await api.savedIdentity();
    if (saved) runSetup(saved, true);
    else openSigning();
  }
  $<HTMLButtonElement>('invite-enable').addEventListener('click', () => void start());
  toolbarButton.addEventListener('click', () => {
    if (state === 'on') { setState('off'); api.iosTouchOff(); }
    else if (state === 'off') void start();
  });

  // ---- signing dialog --------------------------------------------------
  // Profile first. On macOS, when the profile's certificate is already in the
  // keychain (Xcode installs it), no .p12 is asked for. A profile on this Mac
  // that already fits the device is filled in automatically.

  const certKeychain = $<HTMLDivElement>('cert-keychain');
  const certP12 = $<HTMLDivElement>('cert-p12');
  let keychainCert: string | undefined;
  let forceP12 = false;

  const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
  const useKeychain = () => !!keychainCert && !forceP12;
  const refresh = () => {
    certKeychain.hidden = !useKeychain();
    certP12.hidden = useKeychain() || !profilePath;
    $<HTMLSpanElement>('p12-why').hidden = !profilePath || !!keychainCert;
    continueBtn.disabled = !profilePath || (!useKeychain() && (!p12Path || !password.value));
  };

  function setFileLabel(label: HTMLSpanElement, p: string | undefined, text?: string) {
    label.textContent = p ? (text ?? fileName(p)) : 'No file chosen';
    label.classList.toggle('chosen', !!p);
    label.title = p ?? '';
  }

  async function setProfile(p: string, found = false) {
    const info = await api.inspectProfile(p);
    problems.hidden = true;
    if ('error' in info) {
      showProblems([info.error]);
      return;
    }
    profilePath = p;
    keychainCert = info.keychainCertificate;
    forceP12 = false;
    setFileLabel(profileName, p, info.name);
    $<HTMLSpanElement>('keychain-name').textContent = keychainCert ?? '';
    $<HTMLSpanElement>('profile-found').hidden = !found;
    refresh();
  }

  async function openSigning() {
    $<HTMLElement>('udid').textContent = getSerial();
    problems.hidden = true;
    refresh();
    signing.showModal();
    if (!profilePath) {
      const suggestion = await api.suggestProfile();
      if (suggestion && !profilePath) await setProfile(suggestion.path, true);
    }
  }

  function showProblems(list: string[]) {
    problems.replaceChildren(...list.map((m) => Object.assign(document.createElement('li'), { textContent: m })));
    problems.hidden = false;
  }

  $<HTMLButtonElement>('profile-pick').addEventListener('click', async () => {
    const p = await api.pickFile('profile');
    if (p) await setProfile(p);
  });
  $<HTMLButtonElement>('p12-pick').addEventListener('click', async () => {
    const p = await api.pickFile('p12');
    if (!p) return;
    p12Path = p;
    setFileLabel(p12Name, p);
    problems.hidden = true;
    password.focus();
    refresh();
  });
  $<HTMLButtonElement>('use-p12').addEventListener('click', () => { forceP12 = true; refresh(); });
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
    if (!profilePath) return;
    continueBtn.disabled = true;
    continueBtn.textContent = 'Checking…';
    const res = useKeychain()
      ? await api.checkSigning(profilePath)
      : await api.checkSigning(profilePath, p12Path, password.value);
    continueBtn.textContent = 'Continue';
    refresh();
    if (!res.ok) { showProblems(res.problems); return; }
    password.value = '';
    signing.close();
    runSetup(res.identity);
  });

  // ---- setup checklist -------------------------------------------------

  function runSetup(identity: StoredIdentitySummary | undefined, background = false) {
    $<HTMLElement>('setup-identity').textContent = identity
      ? `${identity.certificate} · ${identity.team} · valid until ${identity.expires}`
      : '';
    for (const li of setup.querySelectorAll<HTMLLIElement>('.steps li')) {
      li.dataset.state = 'pending';
      (li.querySelector('small') as HTMLElement).textContent = '';
    }
    quiet = background;
    if (!background && !setup.open) setup.showModal();
    setState('starting');
    void api.runSetup().finally(() => {
      quiet = false;
      if (state === 'starting') setState('off'); // failed or cancelled
    });
  }
  api.onSetupStep((s: SetupStep) => {
    const li = setup.querySelector<HTMLLIElement>(`.steps li[data-step="${s.id}"]`);
    if (!li) return;
    li.dataset.state = s.state;
    (li.querySelector('small') as HTMLElement).textContent = s.detail ?? '';
    // Quiet start: show the checklist once there is real work or a problem.
    const work = s.state === 'running' && (s.id === 'sign' || s.id === 'install');
    if (quiet && (work || s.state === 'error') && !setup.open) setup.showModal();
    // Everything went through: close the checklist on its own shortly after.
    if (s.id === 'launch' && s.state === 'done' && setup.open) setTimeout(() => setup.close(), 900);
  });
  $<HTMLButtonElement>('setup-close').addEventListener('click', () => setup.close());
  $<HTMLButtonElement>('setup-change').addEventListener('click', () => { setup.close(); openSigning(); });

  return {
    /** The runner connected (true) or dropped / was switched off (false). */
    setTouch(on: boolean) {
      if (on) setState('on');
      else if (state === 'on') setState('off');
    },
    /** Call when the iOS picture first appears. */
    onLive() {
      if (invited) return;
      invited = true;
      showInvite();
    },
  };
}

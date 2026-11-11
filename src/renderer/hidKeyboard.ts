// Turns DOM keyboard events into 8-byte HID keyboard reports. KeyboardEvent.code
// names the physical key (independent of the computer's layout); the device
// applies its own layout setting, so it must match the computer's (e.g. Turkish Q).

/** KeyboardEvent.code → HID usage ID (USB HID Usage Tables, page 0x07). */
const USAGE: Record<string, number> = {
  Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c,
  Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31,
  Semicolon: 0x33, Quote: 0x34, Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38,
  CapsLock: 0x39, PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48,
  Insert: 0x49, Home: 0x4a, PageUp: 0x4b, Delete: 0x4c, End: 0x4d, PageDown: 0x4e,
  ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
  NumLock: 0x53, NumpadDivide: 0x54, NumpadMultiply: 0x55, NumpadSubtract: 0x56, NumpadAdd: 0x57,
  NumpadEnter: 0x58, NumpadDecimal: 0x63, IntlBackslash: 0x64, ContextMenu: 0x65,
};
for (let i = 0; i < 26; i++) USAGE[`Key${String.fromCharCode(65 + i)}`] = 0x04 + i;
for (let i = 1; i <= 9; i++) USAGE[`Digit${i}`] = 0x1d + i;
USAGE.Digit0 = 0x27;
for (let i = 1; i <= 12; i++) USAGE[`F${i}`] = 0x39 + i;
for (let i = 1; i <= 9; i++) USAGE[`Numpad${i}`] = 0x58 + i;
USAGE.Numpad0 = 0x62;

const CTRL = 1 << 0, SHIFT = 1 << 1, RCTRL = 1 << 4, RSHIFT = 1 << 5, ALTGR = 1 << 6;

/**
 * Modifier bits. ⌘ becomes Ctrl so macOS habits (⌘A/⌘C/⌘X/⌘Z) map to
 * Android's Ctrl shortcuts. Both Alt/Option keys act as AltGr, which is how
 * layouts like Turkish Q reach @, €, etc. on Android.
 */
const MODIFIER: Record<string, number> = {
  ControlLeft: CTRL, ControlRight: RCTRL, MetaLeft: CTRL, MetaRight: RCTRL,
  ShiftLeft: SHIFT, ShiftRight: RSHIFT, AltLeft: ALTGR, AltRight: ALTGR,
};

export class HidKeyboard {
  private mods = new Map<string, number>(); // code → bit
  private keys: number[] = []; // pressed usages in press order

  constructor(private send: (report: Uint8Array) => void) {}

  /** Returns true when the event was consumed. */
  handle(e: KeyboardEvent, down: boolean): boolean {
    const mod = MODIFIER[e.code];
    if (mod !== undefined) {
      if (down) this.mods.set(e.code, mod); else this.mods.delete(e.code);
      this.flush();
      return true;
    }
    const usage = USAGE[e.code];
    if (usage === undefined) return false;
    if (down) {
      if (e.repeat || this.keys.includes(usage)) return true; // Android repeats held keys itself
      this.keys.push(usage);
    } else {
      this.keys = this.keys.filter((k) => k !== usage);
    }
    this.flush();
    return true;
  }

  /** Releases everything (window lost focus, mirror restarted). */
  releaseAll() {
    if (!this.keys.length && !this.mods.size) return;
    this.keys = [];
    this.mods.clear();
    this.flush();
  }

  private flush() {
    const r = new Uint8Array(8);
    for (const bit of this.mods.values()) r[0] |= bit;
    if (this.keys.length > 6) r.fill(0x01, 2); // rollover error
    else this.keys.forEach((k, i) => { r[2 + i] = k; });
    this.send(r);
  }
}

/**
 * Finds the layout Android assigned to our virtual keyboard in `dumpsys input`,
 * e.g. "keyboard_layout_english_us" → { id, label: "English Us" }. Returns
 * undefined when the keyboard is not registered (yet).
 */
export function parseKeyboardLayout(dump: string): { id: string; label: string } | undefined {
  const start = dump.indexOf(': Device Mirror Keyboard');
  if (start < 0) return undefined;
  // Our device's block ends where the next "  <n>: <name>" device header starts.
  const rest = dump.slice(start + 1, start + 2000);
  const end = rest.search(/\n\s{2,6}\d+: /);
  const block = end > 0 ? rest.slice(0, end) : rest;
  const m = /Overlay KeyCharacterMapFile:\s*\S*?\/(keyboard_layout_[A-Za-z0-9_]+)/.exec(block);
  const id = m ? m[1] : 'keyboard_layout_english_us'; // no overlay = generic US map
  const known: Record<string, string> = {
    keyboard_layout_english_us: 'English (US)',
    keyboard_layout_english_uk: 'English (UK)',
    keyboard_layout_turkish: 'Turkish Q',
    keyboard_layout_turkish_f: 'Turkish F',
  };
  const label = known[id] ?? id.replace(/^keyboard_layout_/, '').split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  return { id, label };
}

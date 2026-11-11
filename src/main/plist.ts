// Minimal XML property list encoder/decoder. usbmuxd and lockdownd speak XML
// plists; a full plist library is not worth its size for the handful of types
// these protocols use.

export type PlistValue =
  | string
  | number
  | boolean
  | Buffer
  | Date
  | PlistValue[]
  | { [key: string]: PlistValue };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

function encode(v: PlistValue): string {
  if (typeof v === 'string') return `<string>${esc(v)}</string>`;
  if (typeof v === 'boolean') return v ? '<true/>' : '<false/>';
  if (typeof v === 'number') return Number.isInteger(v) ? `<integer>${v}</integer>` : `<real>${v}</real>`;
  if (Buffer.isBuffer(v)) return `<data>${v.toString('base64')}</data>`;
  if (v instanceof Date) return `<date>${v.toISOString().replace(/\.\d{3}Z$/, 'Z')}</date>`;
  if (Array.isArray(v)) return `<array>${v.map(encode).join('')}</array>`;
  return `<dict>${Object.entries(v)
    .map(([k, x]) => `<key>${esc(k)}</key>${encode(x)}`)
    .join('')}</dict>`;
}

export function buildPlist(v: PlistValue): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<plist version="1.0">${encode(v)}</plist>\n`
  );
}

interface Token {
  kind: 'open' | 'close' | 'empty' | 'text';
  name: string;
}

function tokenize(xml: string): Token[] {
  const body = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>]*>/gi, '');
  const out: Token[] = [];
  const re = /<(\/?)([A-Za-z]+)[^>]*?(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[4] !== undefined) out.push({ kind: 'text', name: m[4] });
    else out.push({ kind: m[1] ? 'close' : m[3] ? 'empty' : 'open', name: m[2] });
  }
  return out;
}

export function parsePlist(xml: string): PlistValue {
  const toks = tokenize(xml);
  let i = 0;
  const skipWs = () => {
    while (i < toks.length && toks[i].kind === 'text' && !toks[i].name.trim()) i++;
  };
  const textUntilClose = (name: string): string => {
    let s = '';
    while (i < toks.length && !(toks[i].kind === 'close' && toks[i].name === name)) s += toks[i++].name;
    i++; // closing tag
    return unesc(s);
  };

  const value = (): PlistValue => {
    skipWs();
    const t = toks[i++];
    if (!t) throw new Error('plist: unexpected end');
    if (t.kind === 'empty') {
      switch (t.name) {
        case 'true': return true;
        case 'false': return false;
        case 'string': return '';
        case 'dict': return {};
        case 'array': return [];
        case 'data': return Buffer.alloc(0);
        default: throw new Error(`plist: unexpected <${t.name}/>`);
      }
    }
    if (t.kind !== 'open') throw new Error(`plist: unexpected token ${t.kind} ${t.name}`);
    switch (t.name) {
      case 'string': return textUntilClose('string');
      case 'integer': return Number(textUntilClose('integer').trim());
      case 'real': return Number(textUntilClose('real').trim());
      case 'data': return Buffer.from(textUntilClose('data').replace(/\s+/g, ''), 'base64');
      case 'date': return new Date(textUntilClose('date').trim());
      case 'array': {
        const arr: PlistValue[] = [];
        for (;;) {
          skipWs();
          if (toks[i]?.kind === 'close' && toks[i].name === 'array') { i++; return arr; }
          arr.push(value());
        }
      }
      case 'dict': {
        const obj: { [k: string]: PlistValue } = {};
        for (;;) {
          skipWs();
          const k = toks[i++];
          if (!k) throw new Error('plist: unterminated dict');
          if (k.kind === 'close' && k.name === 'dict') return obj;
          if (k.kind !== 'open' || k.name !== 'key') throw new Error(`plist: expected <key>, got ${k.name}`);
          const key = textUntilClose('key');
          obj[key] = value();
        }
      }
      case 'plist': {
        const v = value();
        return v;
      }
      default:
        throw new Error(`plist: unsupported <${t.name}>`);
    }
  };
  return value();
}

export function asDict(v: PlistValue | undefined): { [k: string]: PlistValue } {
  return v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Date)
    ? (v as { [k: string]: PlistValue })
    : {};
}

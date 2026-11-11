// Inline SVG device illustrations (no image assets, ~1 KB each). When a
// preview screenshot exists it is drawn into the illustration's screen.

import type { Device, Preview } from '../shared/types';

type Kind = 'android' | 'iphone-notch' | 'iphone-home' | 'ipad';

export function mockupKind(d: Device): Kind {
  if (d.platform === 'android') return 'android';
  const m = /^(iPhone|iPad)(\d+),(\d+)/.exec(d.model ?? '');
  if (m?.[1] === 'iPad') return 'ipad';
  if (!m) return 'iphone-notch';
  const major = Number(m[2]);
  const minor = Number(m[3]);
  // iPhone X (10,3 / 10,6) and newer have a notch; SE models (12,8 / 14,6) keep the home button.
  const homeButton = major < 10 || (major === 10 && minor !== 3 && minor !== 6) || (major === 12 && minor === 8) || (major === 14 && minor === 6);
  return homeButton ? 'iphone-home' : 'iphone-notch';
}

interface Screen { x: number; y: number; w: number; h: number; r: number }

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** Gradient wallpaper, or the preview screenshot clipped to the screen shape. */
function screenFill(id: string, s: Screen, colors: [string, string, string], preview?: Preview, dim?: boolean): string {
  const shape = `x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.r}"`;
  if (preview) {
    const clip = `<defs><clipPath id="${id}-clip"><rect ${shape}/></clipPath></defs><rect ${shape} fill="#000"/>`;
    const href = escAttr(preview.url);
    if (preview.width > preview.height) {
      // Landscape shot: the illustration is drawn turned a quarter turn (see
      // mockupSvg), so turn the image back to read upright in it.
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      // The clip sits on a group: on the image itself it would turn with it.
      return `${clip}<g clip-path="url(#${id}-clip)"><image href="${href}" x="${cx - s.h / 2}" y="${cy - s.w / 2}" width="${s.h}" height="${s.w}" transform="rotate(90 ${cx} ${cy})" preserveAspectRatio="xMidYMid slice"/></g>`;
    }
    return `${clip}<image href="${href}" x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" clip-path="url(#${id}-clip)" preserveAspectRatio="xMidYMid slice"/>`;
  }
  const [a, b, c] = colors;
  return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="0.55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient></defs>
    <rect ${shape} fill="url(#${id})"/>${dim ? `<rect ${shape} fill="#000" fill-opacity="0.72"/>` : ''}`;
}

/**
 * The device illustration. With a landscape screenshot (the phone was on its
 * side) the whole drawing is turned a quarter turn counter-clockwise and the
 * shot inside is shown upright.
 */
export function mockupSvg(d: Device, uid: string): string {
  const svg = portraitSvg(d, uid);
  if (!d.preview || d.preview.width <= d.preview.height) return svg;
  const m = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (!m) return svg;
  const w = Number(m[1]), h = Number(m[2]);
  return svg
    .replace(m[0], `viewBox="0 0 ${h} ${w}" class="landscape"`)
    .replace(/(<svg[^>]*>)/, `$1<g transform="translate(0 ${w}) rotate(-90)">`)
    .replace(/<\/svg>\s*$/, '</g></svg>');
}

function portraitSvg(d: Device, uid: string): string {
  const id = `scr-${uid}`;
  const p = d.preview;
  const dim = d.screenOff;
  switch (mockupKind(d)) {
    case 'android':
      return `<svg viewBox="0 0 110 220" aria-hidden="true">
        <rect x="3" y="2" width="104" height="216" rx="14" fill="#111"/>
        ${screenFill(id, { x: 7, y: 6, w: 96, h: 208, r: 11 }, ['#2b5cff', '#21c7c9', '#c8f56a'], p, dim)}
        <circle cx="55" cy="14" r="3" fill="#111"/>
        <rect x="107" y="58" width="2" height="22" rx="1" fill="#333"/><rect x="107" y="88" width="2" height="34" rx="1" fill="#333"/></svg>`;
    case 'iphone-home':
      return `<svg viewBox="0 0 110 220" aria-hidden="true">
        <rect x="3" y="2" width="104" height="216" rx="16" fill="#f4f4f6" stroke="#cfcfd4"/>
        ${screenFill(id, { x: 9, y: 30, w: 92, h: 160, r: 0 }, ['#f2a541', '#2c3e50', '#c0392b'], p, dim)}
        <rect x="42" y="15" width="26" height="3" rx="1.5" fill="#cfcfd4"/><circle cx="33" cy="16.5" r="2" fill="#cfcfd4"/>
        <circle cx="55" cy="204" r="8" fill="none" stroke="#cfcfd4" stroke-width="1.5"/></svg>`;
    case 'ipad':
      return `<svg viewBox="0 0 180 220" aria-hidden="true">
        <rect x="4" y="4" width="172" height="212" rx="14" fill="#1a1a1c"/>
        ${screenFill(id, { x: 11, y: 11, w: 158, h: 198, r: 8 }, ['#7f5af0', '#2cb67d', '#f9d371'], p, dim)}
        <circle cx="90" cy="7.5" r="1.6" fill="#444"/></svg>`;
    default:
      return `<svg viewBox="0 0 110 220" aria-hidden="true">
        <rect x="3" y="2" width="104" height="216" rx="20" fill="#16161a"/>
        ${screenFill(id, { x: 7, y: 6, w: 96, h: 208, r: 16 }, ['#3a7bd5', '#f6c453', '#2e5c8a'], p, dim)}
        <rect x="35" y="6" width="40" height="11" rx="5.5" fill="#16161a"/>
        <rect x="0.5" y="50" width="2.5" height="14" rx="1" fill="#2a2a2e"/><rect x="0.5" y="72" width="2.5" height="24" rx="1" fill="#2a2a2e"/><rect x="107" y="70" width="2.5" height="32" rx="1" fill="#2a2a2e"/></svg>`;
  }
}

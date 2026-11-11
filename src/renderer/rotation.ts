// Geometry for the mirror window's rotate button.
//
// The button turns the phone the way a hand would: each press is another 90°
// counter-clockwise ("quarter turns", k = 0…3). The device is told about it,
// and apps that support the new orientation redraw for it (their frames turn
// landscape); apps that do not (home screens) keep drawing portrait, so the
// picture has to be turned on screen to look like a phone lying on its side.
//
// Everything here is plain math so it can be unit tested.

export type QuarterTurns = 0 | 1 | 2 | 3;

export interface Orientation {
  /** How far the picture is turned on screen, counter-clockwise quarter turns. */
  contentRot: QuarterTurns;
  /** How far the device itself turned its picture (deviceRot + contentRot = k); unknown (0) when keysShown is false. */
  deviceRot: QuarterTurns;
  /** Side keys can be placed (false while a landscape-only app runs with the phone upright). */
  keysShown: boolean;
}

/**
 * k: quarter turns the user applied. fw/fh: size of the frames the device sends.
 * A landscape frame while the phone lies on its side means the app turned with
 * it; a portrait frame means it did not. Upside down is assumed not to be
 * followed (iPhones and most Android apps do not support it).
 */
export function orientationFor(k: QuarterTurns, fw: number, fh: number): Orientation {
  const frameLandscape = fw > fh;
  const sideways = k % 2 === 1;
  if (frameLandscape === sideways) {
    // The frame already matches how the phone is held.
    return sideways ? { contentRot: 0, deviceRot: k, keysShown: true } : { contentRot: k, deviceRot: 0, keysShown: true };
  }
  if (sideways) return { contentRot: k, deviceRot: 0, keysShown: true }; // portrait app, phone on its side
  // A landscape-only app with the phone upright (or upside down): show the
  // frame as it comes; the device turned it, we do not know which way.
  return { contentRot: 0, deviceRot: 0, keysShown: false };
}

/** Size of the picture on screen (before scaling) for a frame turned contentRot. */
export function displaySize(fw: number, fh: number, contentRot: QuarterTurns): { w: number; h: number } {
  return contentRot % 2 ? { w: fh, h: fw } : { w: fw, h: fh };
}

/**
 * A point in the on-screen picture (pixels from its top-left, at scale s) back
 * to frame pixels.
 */
export function viewToFrame(px: number, py: number, s: number, contentRot: QuarterTurns, fw: number, fh: number): { x: number; y: number } {
  const u = px / s, v = py / s;
  switch (contentRot) {
    case 1: return { x: fw - v, y: u };
    case 2: return { x: fw - u, y: fh - v };
    case 3: return { x: v, y: fh - u };
    default: return { x: u, y: v };
  }
}

/**
 * iOS input goes to the panel in its natural portrait coordinates (normalized
 * 0…1). A frame turned by the device (deviceRot) is mapped back to them.
 */
export function frameToPortrait(nx: number, ny: number, deviceRot: QuarterTurns): { x: number; y: number } {
  switch (deviceRot) {
    case 1: return { x: 1 - ny, y: nx };
    case 2: return { x: 1 - nx, y: 1 - ny };
    case 3: return { x: ny, y: 1 - nx };
    default: return { x: nx, y: ny };
  }
}

export type Edge = 'left' | 'right' | 'top' | 'bottom';

/**
 * Where a side key goes once the phone has turned k quarter turns: its portrait
 * edge and offset (fraction of that edge from the top) move with the body.
 * Returns the new edge and the offset along it (from the left for top/bottom,
 * from the top for left/right).
 */
export function placeKey(side: 'left' | 'right', top: number, length: number, k: QuarterTurns): { edge: Edge; start: number } {
  const rev = 1 - top - length;
  const turns: Record<QuarterTurns, { left: [Edge, number]; right: [Edge, number] }> = {
    0: { left: ['left', top], right: ['right', top] },
    1: { left: ['bottom', top], right: ['top', top] },
    2: { left: ['right', rev], right: ['left', rev] },
    3: { left: ['top', rev], right: ['bottom', rev] },
  };
  const [edge, start] = turns[k][side];
  return { edge, start };
}

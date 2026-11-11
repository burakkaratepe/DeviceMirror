import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displaySize, frameToPortrait, orientationFor, placeKey, viewToFrame } from '../renderer/rotation';

test('a portrait home screen on a phone lying on its side is turned on screen', () => {
  assert.deepEqual(orientationFor(1, 1080, 2340), { contentRot: 1, deviceRot: 0, keysShown: true });
  assert.deepEqual(displaySize(1080, 2340, 1), { w: 2340, h: 1080 });
});

test('an app that turned with the phone is shown as it comes', () => {
  assert.deepEqual(orientationFor(1, 2340, 1080), { contentRot: 0, deviceRot: 1, keysShown: true });
  assert.deepEqual(orientationFor(3, 2340, 1080), { contentRot: 0, deviceRot: 3, keysShown: true });
  assert.deepEqual(orientationFor(2, 1080, 2340), { contentRot: 2, deviceRot: 0, keysShown: true });
});

test('clicks map back to the frame for every turn', () => {
  const fw = 100, fh = 200, s = 2;
  // The frame corner (0,0) sits at a different screen corner after each turn.
  assert.deepEqual(viewToFrame(0, 0, s, 0, fw, fh), { x: 0, y: 0 });
  assert.deepEqual(viewToFrame(0, fw * s, s, 1, fw, fh), { x: 0, y: 0 }); // CCW: top-left goes to bottom-left
  assert.deepEqual(viewToFrame(fw * s, fh * s, s, 2, fw, fh), { x: 0, y: 0 });
  assert.deepEqual(viewToFrame(fh * s, 0, s, 3, fw, fh), { x: 0, y: 0 });
});

test('a turned iOS frame maps back to portrait panel coordinates', () => {
  // Phone turned CCW (landscape left): the frame's top-left is the panel's top-right.
  assert.deepEqual(frameToPortrait(0, 0, 1), { x: 1, y: 0 });
  assert.deepEqual(frameToPortrait(0, 0, 3), { x: 0, y: 1 });
  assert.deepEqual(frameToPortrait(0.25, 0.5, 0), { x: 0.25, y: 0.5 });
});

test('side keys move with the body', () => {
  assert.deepEqual(placeKey('right', 0.3, 0.1, 1), { edge: 'top', start: 0.3 });
  assert.deepEqual(placeKey('left', 0.3, 0.1, 1), { edge: 'bottom', start: 0.3 });
  const r2 = placeKey('right', 0.3, 0.1, 2);
  assert.equal(r2.edge, 'left');
  assert.ok(Math.abs(r2.start - 0.6) < 1e-9);
});

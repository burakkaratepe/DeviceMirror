import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { AdbTracker, parseDeviceList, type AdbDeviceEntry } from '../main/android/adb';
import { UsbmuxDecoder } from '../main/ios/usbmux';
import { buildPlist, parsePlist } from '../main/plist';

test('plist round-trips the types usbmuxd uses', () => {
  const v = { MessageType: 'Attached', DeviceID: 7, Ok: true, No: false, Data: Buffer.from([1, 2, 3]), Arr: ['a & <b>', 2.5], Empty: {} };
  assert.deepEqual(parsePlist(buildPlist(v)), v);
});

test('plist parses self-closing and whitespace-formatted documents', () => {
  const xml = `<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n\t<key>A</key>\n\t<string/>\n\t<key>B</key>\n\t<array/>\n\t<key>C</key>\n\t<integer> 42 </integer>\n</dict>\n</plist>`;
  assert.deepEqual(parsePlist(xml), { A: '', B: [], C: 42 });
});

test('finds the layout Android assigned to the virtual keyboard', async () => {
  const { parseKeyboardLayout } = await import('../main/keyboardLayout');
  const dump = `  107: Device Mirror Keyboard\n      Classes: KEYBOARD | ALPHAKEY\n      Overlay KeyCharacterMapFile: com.android.inputdevices/com.android.inputdevices.InputDeviceReceiver/keyboard_layout_turkish\n`;
  assert.deepEqual(parseKeyboardLayout(dump), { id: 'keyboard_layout_turkish', label: 'Turkish Q' });
  assert.equal(parseKeyboardLayout('  12: Some Other Keyboard\n')?.id, undefined);
  assert.equal(parseKeyboardLayout('  9: Device Mirror Keyboard\n      Classes: KEYBOARD\n')?.id, 'keyboard_layout_english_us');
});

test('parses track-devices-l output', () => {
  const list = parseDeviceList(
    'R58N12ABCDE            device usb:0-1.1 product:r9sxtur model:SM_G990E device:r9s transport_id:21\nemulator-5554 unauthorized transport_id:3\n',
  );
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { serial: 'R58N12ABCDE', state: 'device', props: { usb: '0-1.1', product: 'r9sxtur', model: 'SM_G990E', device: 'r9s', transport_id: '21' } });
  assert.equal(list[1].state, 'unauthorized');
  assert.deepEqual(parseDeviceList(''), []);
});

test('usbmux decoder splits messages across chunk boundaries', () => {
  const mk = (n: number) => {
    const body = Buffer.from(buildPlist({ MessageType: 'Detached', DeviceID: n }));
    const h = Buffer.alloc(16);
    h.writeUInt32LE(16 + body.length, 0);
    h.writeUInt32LE(1, 4);
    h.writeUInt32LE(8, 8);
    h.writeUInt32LE(n, 12);
    return Buffer.concat([h, body]);
  };
  const all = Buffer.concat([mk(1), mk(2)]);
  const dec = new UsbmuxDecoder();
  const got = [...dec.push(all.subarray(0, 20)), ...dec.push(all.subarray(20, all.length - 3)), ...dec.push(all.subarray(all.length - 3))];
  assert.deepEqual(got.map((m) => m.msg.DeviceID), [1, 2]);
});

test('adb tracker receives pushed device lists from the server', async () => {
  const frame = (s: string) => Buffer.from(s.length.toString(16).padStart(4, '0') + s);
  const server = net.createServer((sock) => {
    sock.once('data', (d) => {
      assert.equal(d.subarray(4).toString(), 'host:track-devices-l');
      sock.write('OKAY');
      sock.write(frame('ABC device model:Pixel_8\n'));
      setTimeout(() => sock.write(frame('')), 20); // device unplugged
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;

  const seen: AdbDeviceEntry[][] = [];
  let ok = false;
  const tracker = new AdbTracker({ onDevices: (l) => seen.push(l), onStatus: (s) => { ok = s; } }, () => undefined, port);
  tracker.start();
  await new Promise((r) => setTimeout(r, 150));
  tracker.stop();
  server.close();

  assert.equal(ok, true);
  assert.equal(seen[0][0].serial, 'ABC');
  assert.equal(seen[0][0].props.model, 'Pixel_8');
  assert.deepEqual(seen[1], []);
});

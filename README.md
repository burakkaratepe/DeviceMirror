# Device Mirror

Mirror and control Android and iOS devices connected over USB, from a small
desktop app.

- **Device list** with live plug/unplug tracking, retail device names and
  screenshots of each screen (refreshed while the list is on screen).
- **Android:** mirroring with mouse and keyboard control (any keyboard layout,
  including Turkish), hover, Back/Home/Recents, power and volume keys.
- **iOS (macOS):** mirroring; touch control (tap, long press, drag, scroll,
  typing, Home, power and volume keys) through a small XCUITest runner signed
  with your own development certificate.
- **Rotate** the device either way; apps that support landscape follow, and
  clicks land correctly in every orientation. Mirroring starts in the way the
  device is held.
- **Screenshots and screen recordings** from the mirror window, collected on
  a Captures page with filters, a viewer and export.
- Up to 2 devices at a time, one window each, Low / Medium / High quality per
  device.

Status: macOS is the main platform today. Android mirroring is written to run
on Windows and Linux as well but has not been packaged or tested there yet;
iOS mirroring on Windows/Linux is not implemented.

## Requirements

| | Android | iOS |
| --- | --- | --- |
| Device | USB debugging on | Trusted this computer |
| Mirroring | adb (bundled, or one already installed) | macOS, camera permission for the app |
| Touch control | — | macOS with Xcode, Developer Mode on the device, an Apple development certificate and a provisioning profile that includes the device |

## Getting started

```bash
npm install
node scripts/fetch-scrcpy.mjs        # pinned scrcpy-server (required for Android)
./scripts/build-ios-helper.sh        # macOS: native iOS screen-capture helper (needs Xcode)
node scripts/fetch-adb.mjs           # optional: bundle adb (otherwise a system adb is used)
npm start                            # build and run
```

Other commands:

```bash
npm test                             # unit tests
npm run typecheck
npm run dist                         # package for the current OS into release/
npm run probe 30                     # headless: print device changes for 30 s
node scripts/build-model-names.mjs   # refresh resources/android-models.tsv.gz
```

## How it works

- **Small footprint:** no runtime npm dependencies and no UI framework; the
  app's own code is a few hundred KB. The installer is almost entirely
  Electron itself.
- **Android:** talks to the adb server over its host protocol (TCP 5037). For
  mirroring it pushes scrcpy-server, reads H.264 over an adb forward and
  decodes it with WebCodecs; input goes back over scrcpy's control socket
  (mouse events, UHID keyboard). Card screenshots use a raw `screencap`.
- **iOS device list:** speaks the usbmuxd protocol directly
  (`/var/run/usbmuxd`, or `127.0.0.1:27015` on Windows) and reads basic
  lockdown values; no libimobiledevice or go-ios.
- **iOS mirroring (macOS):** `native/ios-capture` (Swift) turns on CoreMediaIO
  screen-capture devices, opens the iPhone as an AVCaptureDevice, re-encodes
  with VideoToolbox (low-latency H.264) and streams packets over stdout.
- **iOS touch (macOS + Xcode):** `native/ios-runner` is one XCUITest bundle
  that listens on a device port reached through usbmuxd (small binary
  protocol) and synthesizes events through the XCTest daemon. The daemon runs
  one event at a time (~260 ms each), so a gesture travels as one event. The
  app builds the runner once, re-signs it with your keychain identity or a
  .p12, installs it and keeps it running between sessions.
- **Captures** are stored in the app's data folder (`Captures/`); screenshots
  are WebP, recordings H.264 MP4 encoded by Chromium.

The iOS touch runner and the screen-capture switch use private or
undocumented Apple interfaces; they work with current Xcode and iOS releases
but may need updates after Apple changes them.

## License

[Apache License 2.0](LICENSE) — see also [NOTICE](NOTICE). Bundled
third-party components keep their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

# Device Mirror

Mirror and control Android and iOS devices from macOS, Windows and Linux.

Status: **Phase 1** — live list of USB-connected Android and iOS devices (plug/unplug tracking, per-device quality setting, one-shot screenshot preview for Android devices). Mirroring arrives in Phase 2 (Android) and Phase 3 (iOS on macOS).

## Development

```bash
npm install
node scripts/fetch-adb.mjs   # optional: bundle adb (otherwise a system/SDK adb is used)
npm start                    # build and run the app
npm test                     # unit tests
npm run probe 30             # headless: print device changes for 30 s (plug/unplug devices)
npm run dist                 # package for the current OS into release/
```

## Design notes

- **Small footprint:** no runtime npm dependencies, no UI framework. Our own code is ~30 KB; the installer size is almost entirely Electron itself.
- **Android:** talks to the adb server over its host protocol (TCP 5037, `host:track-devices-l`); the `adb` binary is only used to start the server.
- **iOS:** speaks the usbmuxd protocol directly (`/var/run/usbmuxd`, or `127.0.0.1:27015` on Windows) for attach/detach events, pair-record checks and basic lockdown values. No libimobiledevice or go-ios needed for listing.

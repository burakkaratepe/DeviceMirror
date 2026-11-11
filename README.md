# Device Mirror

Mirror and control Android and iOS devices from macOS, Windows and Linux.

Status: **Phase 2** — live device list (Android + iOS) and Android mirroring with touch control: one window per device, up to 2 at a time, Low/Medium/High quality per device. iOS mirroring arrives in Phase 3 (macOS).

## Development

```bash
npm install
node scripts/fetch-scrcpy.mjs   # required: pinned scrcpy-server for Android mirroring
node scripts/fetch-adb.mjs   # optional: bundle adb (otherwise a system/SDK adb is used)
npm start                    # build and run the app
npm test                     # unit tests
npm run probe 30             # headless: print device changes for 30 s (plug/unplug devices)
npm run dist                 # package for the current OS into release/
```

## Design notes

- **Small footprint:** no runtime npm dependencies, no UI framework. Our own code is ~30 KB; the installer size is almost entirely Electron itself.
- **Android:** talks to the adb server over its host protocol (TCP 5037, `host:track-devices-l`); the `adb` binary is only used to start the server.
- **Android mirroring:** pushes scrcpy-server 5.0.1 (adb sync protocol), starts it with `app_process`, reads H.264 over an adb forward and decodes it with WebCodecs in the mirror window. Touch, scroll and Back/Home/Recents go back over scrcpy's control socket. `node dist/probeMirror.js <serial>` checks the stream headlessly.
- **iOS:** speaks the usbmuxd protocol directly (`/var/run/usbmuxd`, or `127.0.0.1:27015` on Windows) for attach/detach events, pair-record checks and basic lockdown values. No libimobiledevice or go-ios needed for listing.

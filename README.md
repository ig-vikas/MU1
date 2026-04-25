# MU1 JanVaani

MU1 is a Vite-based, plain JavaScript offline PWA. The main app stays an installable web app. The Android code in `android-companion/` is only a small localhost bridge for BLE advertising and scanning.

## Emergency BLE Alert System

This feature provides nearby offline emergency alert propagation using BLE advertisement local names. It does not use a backend, cloud service, login, pairing, GATT connection, internet messaging, or normal chat.

Architecture:

```text
Device A PWA
  -> http://127.0.0.1:8765/advertise
  -> Android companion
  -> BLE advertisement includes device name JV_FIRE_GATE
  -> nearby Android companion or browser BLE scan
  -> Device B PWA saves JV_FIRE_GATE in IndexedDB
  -> optional rate-limited rebroadcast through Device B companion
```

The PWA cannot reliably advertise BLE names by itself, so the native Android app temporarily changes the Bluetooth adapter name, starts BLE advertising with `setIncludeDeviceName(true)`, stops after TTL, and restores the original Bluetooth name.

## Alert Names

Only strict short names are transported:

- Must start with `JV_`
- Uppercase only
- Allowed characters: `A-Z`, `0-9`, `_`
- Maximum length: 24 characters
- No spaces, symbols, HTML, script tags, emojis, or private personal data

Examples:

- `JV_FIRE_GATE`
- `JV_MED_NEED`
- `JV_EVAC_SCH`
- `JV_FLOOD_RD`
- `JV_HELP_BRDG`
- `JV_SAFE_ZONE`

The PWA converts short text into safe names, such as `fire near market` to `JV_FIRE_MKT`.

## PWA Run

Install dependencies once:

```powershell
npm.cmd install --cache .\.npm-cache
```

Build the offline PWA:

```powershell
npm.cmd run build
```

Run the production preview on port `4173`:

```powershell
npm.cmd run preview
```

Open:

- `https://localhost:4173/#home`
- `https://<your-ip-address>:4173/#home`

## Install Offline PWA

1. Open the PWA once while the server is reachable.
2. Use the browser install button or browser menu to install it.
3. Wait for the app to show/cache offline readiness.
4. Disconnect internet.
5. Reopen the installed PWA.
6. Open `Emergency Alert`; alert history and UI should load offline.

The service worker precaches the app shell, JS, CSS, icons, manifest, and emergency alert modules.

## Android Companion

The companion app lives in `android-companion/`.

It exposes only localhost:

- `GET http://127.0.0.1:8765/status`
- `POST http://127.0.0.1:8765/advertise`
- `POST http://127.0.0.1:8765/stop`
- `POST http://127.0.0.1:8765/scan/start`
- `POST http://127.0.0.1:8765/scan/stop`
- `GET http://127.0.0.1:8765/scan/status`
- `GET http://127.0.0.1:8765/alerts`

The HTTP server binds to `127.0.0.1` only. It does not bind to `0.0.0.0` and is not exposed to LAN/Wi-Fi.

The companion returns CORS headers:

```text
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

## Build Android Companion

Open `android-companion/` in Android Studio and build/run the `app` configuration, or use an installed Android Gradle setup:

```powershell
cd android-companion
gradle assembleDebug
```

Install the generated debug APK on the Android phone, open it, grant Bluetooth permissions, and keep the bridge running while using the PWA.

Required permissions:

- Android 12+: `BLUETOOTH_ADVERTISE`, `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`
- Older Android: legacy Bluetooth permissions plus location for BLE scanning
- Foreground service permission for reliable bridge operation
- Notification permission on Android 13+ for the foreground service notification

## Emergency Screen

The PWA Emergency Alerts screen includes:

- Short alert input with generated BLE name preview
- Presets like FIRE, MEDICAL HELP, EVACUATE, WATER NEEDED, ROAD BLOCKED, SAFE ZONE
- TTL selection: 15 minutes, 30 minutes, 1 hour, 2 hours, or custom
- Start/stop broadcast
- Browser BLE scan controls
- Android companion scan fallback controls
- Rebroadcast on/off, duration, cooldown, and counters
- Offline IndexedDB alert history with duplicate protection
- Companion status for permissions, Bluetooth, advertising, scanning, name change, and errors

## Testing

Test 1: PWA offline

1. Open the PWA once.
2. Install it.
3. Disconnect internet.
4. Reopen it.
5. `Emergency Alert` should load and existing alert history should persist.

Test 2: Companion status

1. Install and open the Android companion.
2. Open the PWA on the same Android device.
3. Open `Emergency Alert`.
4. Companion status should show connected, or a clear error if blocked.

Test 3: Sender advertising

1. Type `fire test` or use a preset.
2. Select TTL `1` custom minute.
3. Press Start Broadcast.
4. The companion should advertise the generated `JV_` name.
5. After TTL, advertising stops and original Bluetooth name is restored.

Test 4: Receiver browser scan

1. On a second Android device, open the PWA.
2. Start browser scan if supported.
3. Detect `JV_FIRE_TEST`.
4. Confirm it appears in alert history.

Test 5: Receiver companion scan fallback

1. On a second Android device, open the companion.
2. In the PWA, start companion fallback scan.
3. The PWA polls `/alerts`.
4. Valid `JV_` names are saved offline.

Test 6: Rebroadcast

1. Enable rebroadcast on Device B.
2. Device B receives a valid alert.
3. Device B sends that name to its companion for limited TTL.
4. Device C detects it.
5. Duplicate names update one history row instead of spamming.

Test 7: Invalid names

Try:

- `HELLO`
- `ABC_FIRE`
- `JV hello world`
- `JV<script>`
- `JV_VERY_LONG_EMERGENCY_MESSAGE_THAT_EXCEEDS_LIMIT`
- `JV_FIRE🔥`

Expected: invalid names are rejected, sanitized, or ignored without crashing.

Test 8: Permission failure

1. Deny Bluetooth permissions.
2. `/status` should show permissions missing.
3. `/advertise` and `/scan/start` should fail clearly.
4. The PWA should show the error.

Test 9: Bluetooth disabled

1. Turn off Bluetooth.
2. `/status` should show `bluetoothEnabled: false`.
3. The PWA should show Bluetooth disabled or companion error.

## Known Limitations

- BLE range is short and local.
- Browser BLE advertisement scanning is not supported in many browsers.
- Android may block Bluetooth name changes on some devices.
- Background operation may require a foreground notification.
- BLE local names are tiny, so messages must be short codes.
- This is for demo/local alert propagation, not guaranteed rescue or city-wide communication.
- iOS support is limited because browser BLE scanning and localhost companion behavior differ by platform.

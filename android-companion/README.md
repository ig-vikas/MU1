# JanVaani Android BLE Bridge

This Android app is only a companion bridge for the MU1 offline PWA. It is not the main app and does not contain chat, login, backend, or internet communication.

## What It Does

- Runs a foreground service.
- Starts an HTTP server bound only to `127.0.0.1:8765`.
- Accepts short `JV_` alert names from the PWA.
- Temporarily sets the Bluetooth adapter name to that alert.
- Starts BLE advertising with `AdvertiseData.Builder.setIncludeDeviceName(true)`.
- Stops after TTL and restores the original Bluetooth name.
- Scans nearby BLE advertisements and returns only valid `JV_` names to the PWA.

## Build

Open this folder in Android Studio and run the `app` configuration, or use an installed Gradle/Android SDK:

```powershell
gradle assembleDebug
```

Debug APK path:

```text
android-companion/app/build/outputs/apk/debug/app-debug.apk
```

## Permissions

Android 12+:

- `BLUETOOTH_ADVERTISE`
- `BLUETOOTH_SCAN`
- `BLUETOOTH_CONNECT`

Older Android versions:

- legacy Bluetooth permissions
- location permission for BLE scanning

Android 13+:

- notification permission for the foreground service notification

## Localhost API

The server binds only to loopback:

```text
127.0.0.1:8765
```

It never binds to `0.0.0.0`.

Endpoints:

- `GET /status`
- `POST /advertise`
- `POST /stop`
- `POST /scan/start`
- `POST /scan/stop`
- `GET /scan/status`
- `GET /alerts`

All responses are JSON and include CORS headers for the PWA.

## Safety Notes

The bridge only accepts names matching:

```text
^JV_[A-Z0-9_]{1,21}$
```

If Android blocks Bluetooth name changes or BLE advertising, the API returns an error and does not claim success.

# JanVaani — जनवाणी

Offline-first P2P alert mesh for civilians during internet blackouts.
No internet. No server. No central point of failure.

Built for **418 Hackathon 2026 — Web Development Track**.

## What it does

- Share emergency, medical, food/water, safe-route, and missing-person
  alerts with people nearby — with zero internet.
- Alerts propagate hop-by-hop across devices and physical locations.
- Each message is cryptographically signed with an ephemeral Ed25519 key.
- Alerts expire automatically (TTL). One-tap panic wipe destroys all local data.

## Three transport layers

| Transport | When it works | Range |
|---|---|---|
| **BroadcastChannel** | Same device — multiple browser tabs | Instant |
| **WebRTC + hotspot** | Nearby devices on shared LAN | ~50 m |
| **QR handoff** | Physical scan — fully air-gapped | 1 m |

The system degrades gracefully. If WebRTC fails, QR still works.
If there is no hotspot, three tabs on one laptop still demonstrate
full A→B→C propagation with real hop counting.

## Features

- [x] Local alert creation with 6 categories
- [x] QR share — animated multi-frame for large payloads (pako compressed)
- [x] QR scan — import alerts from any device
- [x] WebRTC gossip mesh — SYNC_HASHES → diff → SYNC_ALERTS → SYNC_DONE
- [x] BroadcastChannel mesh — zero-setup multi-tab sync
- [x] Community chat over WebRTC data channel (persisted to IndexedDB)
- [x] Local news broadcast screen
- [x] Village Board poster — printable QR for physical notice boards
- [x] Ed25519 signing — alerts signed with ephemeral per-device keypair
- [x] TTL expiry with fresh/aging/expiring/expired visual states
- [x] Hop badge — 📡 N visible on every relayed alert
- [x] Panic wipe — one tap deletes all local data
- [x] Shake to wipe — physical gesture triggers panic wipe
- [x] PWA — installs offline, service worker caches all assets
- [x] Hindi (हिंदी) and Telugu (తెలుగు) language support

## Run locally

```bash
npm install
npm run dev
# Opens https://localhost:5173
# Accept the self-signed cert warning on every demo device
```

## Demo — A → B → C propagation (3 browser tabs)

1. Open `https://localhost:5173` in **three browser tabs**
2. In **Tab A**: Create an Emergency alert
3. Watch **Tab B** receive it with `📡 1`
4. Watch **Tab C** receive it with `📡 2`

No hotspot. No QR. No setup. BroadcastChannel connects the tabs instantly.

## Demo — Real cross-device (3 phones)

1. Phone 1 enables **mobile hotspot** (no SIM data needed)
2. Phones 2 & 3 join the hotspot and open `https://PHONE1_IP:5173`
3. Accept the cert warning on each phone
4. Phone 1 → `#connect` → choose **Share (A)** → QR appears
5. Phone 2 → `#connect` → choose **Receive (B)** → scan QR → sync
6. Phone 2 → repeat as **Share (A)** with Phone 3 as **Receive (B)**
7. Phone 3 shows the original alert with `📡 2`

## Security model

- No account. No login. Ephemeral Ed25519 keypair generated per device,
  stored only in `localStorage`. Fingerprint shown as `XXXX-XXXX`.
- Each alert carries a detached Ed25519 signature and the sender's public key.
- Loss of one device exposes only the alerts stored on that device —
  not the full network.
- Panic wipe: Settings → Clear All Data. Deletes IndexedDB + localStorage.

## Stack

`Vite` · `vite-plugin-pwa` · `idb` · `pako` · `tweetnacl` ·
`qrcode` · `html5-qrcode` · Vanilla JS (no framework)

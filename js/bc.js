/**
 * BroadcastChannel transport for JanVaani.
 *
 * Wraps the browser BroadcastChannel API in a fake RTCDataChannel-compatible
 * interface so gossip.js can run over it without any changes. Three browser
 * tabs open the same channel name and automatically form a mesh - no QR,
 * no hotspot, no pairing required. Used alongside WebRTC, not instead of it.
 */

const BC_CHANNEL_NAME = 'janvaani-mesh';
const BC_SYNC_DELAY_MS = 1200; // stagger so tabs don't all sync simultaneously

let bcInstance = null;
let bcFakeChannel = null;
let bcSyncScheduled = false;
let bcStartSyncCallback = null;

/**
 * Creates a fake RTCDataChannel-compatible object backed by BroadcastChannel.
 * Satisfies assertChannel() in p2p.js: needs .send(), .addEventListener(),
 * .removeEventListener(), and .readyState === 'open'.
 */
function createFakeChannel(bc) {
  const listeners = new Map(); // eventType -> Set of handlers

  const fakeChannel = {
    readyState: 'open',
    send(data) {
      try {
        bc.postMessage({ _jv: true, data });
      } catch (err) {
        console.warn('bc.js send failed:', err);
      }
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    _dispatch(type, event) {
      listeners.get(type)?.forEach((fn) => fn(event));
    }
  };

  return fakeChannel;
}

/**
 * Initialises the BroadcastChannel mesh transport.
 * Call once from bootJanVaani(). Passes a fake channel to startSyncCallback
 * so gossip.js can run a full SYNC_HASHES -> SYNC_ALERTS -> SYNC_DONE cycle
 * with every other tab that opens the same channel.
 *
 * @param {(fakeChannel: object) => Promise<void>} startSyncCallback
 *   Called with the fake channel whenever a new peer tab is detected.
 *   Should be: (ch) => startSync(ch).catch(console.warn)
 */
export function initBroadcastMesh(startSyncCallback) {
  if (typeof BroadcastChannel === 'undefined') return;
  if (bcInstance) return; // already initialised

  bcStartSyncCallback = startSyncCallback;
  bcInstance = new BroadcastChannel(BC_CHANNEL_NAME);
  bcFakeChannel = createFakeChannel(bcInstance);

  bcInstance.onmessage = (event) => {
    const payload = event.data;
    if (!payload?._jv) return;

    // Deliver to gossip.js as a fake MessageEvent
    bcFakeChannel._dispatch('message', { data: payload.data });

    // If another tab is broadcasting, schedule a sync with them
    scheduleBcSync();
  };

  // Announce presence so other tabs know to sync with us
  try {
    bcInstance.postMessage({ _jv: true, data: JSON.stringify({ type: 'BC_HELLO' }) });
  } catch (_) { /* ignore */ }
}

/**
 * Schedule a single gossip sync run, debounced to avoid stampede when
 * multiple tabs open at once.
 */
function scheduleBcSync() {
  if (bcSyncScheduled || !bcFakeChannel || !bcStartSyncCallback) return;
  bcSyncScheduled = true;
  setTimeout(() => {
    bcSyncScheduled = false;
    if (bcFakeChannel && bcStartSyncCallback) {
      bcStartSyncCallback(bcFakeChannel).catch((err) => {
        console.warn('BroadcastChannel gossip sync failed:', err);
      });
    }
  }, BC_SYNC_DELAY_MS);
}

/**
 * Sends a live alert to all other tabs immediately via BroadcastChannel.
 * Call after broadcastLiveAlert() so tabs get new alerts without waiting
 * for a full gossip sync cycle.
 *
 * @param {object} alert - Fully formed JanVaani alert object.
 */
export function broadcastAlertViaBc(alert) {
  if (!bcFakeChannel) return;
  try {
    bcFakeChannel.send(JSON.stringify({ type: 'LIVE_ALERT', alert }));
  } catch (_) { /* ignore */ }
}

import {
  getCompanionDetectedAlerts,
  getCompanionScanStatus,
  startCompanionScan,
  stopCompanionScan
} from './companionService.js';
import { isValidJVAlertName } from './alertEncoding.js';

const detectedCallbacks = new Set();
const COMPANION_POLL_MS = 3000;

let browserScan = null;
let browserAdvertisementHandler = null;
let companionPollId = null;
let companionFallbackRunning = false;

/**
 * Checks whether browser BLE advertisement scanning is available.
 * @returns {boolean} True when Web Bluetooth LE scan is available.
 */
export function isBrowserBleScanSupported() {
  return Boolean(globalThis.navigator?.bluetooth?.requestLEScan);
}

/**
 * Starts browser Web Bluetooth scanning for JV_ advertisement names.
 * @returns {Promise<{ok: boolean, mode: string}>} Scan result.
 */
export async function startBrowserScanning() {
  if (!isBrowserBleScanSupported()) {
    throw new Error('Browser BLE advertisement scanning is unsupported here. Use companion scan fallback.');
  }

  if (browserScan?.active) {
    return { ok: true, mode: 'browser' };
  }

  browserAdvertisementHandler = (event) => {
    const name = parseAdvertisementName(event);

    if (isValidJVAlertName(name)) {
      emitAlertDetected({
        name,
        source: 'browser',
        rssi: Number.isFinite(Number(event.rssi)) ? Number(event.rssi) : null,
        seenAt: Date.now()
      });
    }
  };

  navigator.bluetooth.addEventListener('advertisementreceived', browserAdvertisementHandler);
  browserScan = await navigator.bluetooth.requestLEScan({
    acceptAllAdvertisements: true,
    keepRepeatedDevices: true
  });

  return { ok: true, mode: 'browser' };
}

/**
 * Stops browser Web Bluetooth scanning.
 * @returns {Promise<void>} Resolves when stopped.
 */
export async function stopBrowserScanning() {
  if (browserScan?.active && typeof browserScan.stop === 'function') {
    browserScan.stop();
  }

  browserScan = null;

  if (browserAdvertisementHandler && navigator.bluetooth?.removeEventListener) {
    navigator.bluetooth.removeEventListener('advertisementreceived', browserAdvertisementHandler);
  }

  browserAdvertisementHandler = null;
}

/**
 * Starts Android companion native scan fallback and polling.
 * @returns {Promise<object>} Companion response.
 */
export async function startCompanionFallbackScanning() {
  const response = await startCompanionScan();
  companionFallbackRunning = true;
  startCompanionPolling();
  return response;
}

/**
 * Stops Android companion native scan fallback and polling.
 * @returns {Promise<object>} Companion response.
 */
export async function stopCompanionFallbackScanning() {
  stopCompanionPolling();
  companionFallbackRunning = false;
  return stopCompanionScan();
}

/**
 * Registers a callback for detected JV_ alerts.
 * @param {(alert: {name: string, source: string, rssi: number | null, seenAt: number}) => void} callback - Handler.
 * @returns {() => void} Unsubscribe function.
 */
export function onAlertDetected(callback) {
  if (typeof callback !== 'function') {
    return () => {};
  }

  detectedCallbacks.add(callback);
  return () => {
    detectedCallbacks.delete(callback);
  };
}

/**
 * Extracts a BLE local/device name from browser advertisement events.
 * @param {object} event - BluetoothAdvertisingEvent-like event.
 * @returns {string} Candidate name.
 */
export function parseAdvertisementName(event) {
  return String(event?.name || event?.localName || event?.device?.name || '').trim().toUpperCase();
}

export { isValidJVAlertName };

function startCompanionPolling() {
  if (companionPollId) {
    return;
  }

  companionPollId = window.setInterval(() => {
    void pollCompanionAlerts();
  }, COMPANION_POLL_MS);
  void pollCompanionAlerts();
}

function stopCompanionPolling() {
  if (!companionPollId) {
    return;
  }

  window.clearInterval(companionPollId);
  companionPollId = null;
}

async function pollCompanionAlerts() {
  if (!companionFallbackRunning) {
    return;
  }

  try {
    const [alertsResponse] = await Promise.all([getCompanionDetectedAlerts(), getCompanionScanStatus().catch(() => null)]);
    const alerts = Array.isArray(alertsResponse?.alerts) ? alertsResponse.alerts : [];

    for (const alert of alerts) {
      const name = String(alert?.name || '').trim().toUpperCase();

      if (isValidJVAlertName(name)) {
        emitAlertDetected({
          name,
          source: 'companion',
          rssi: Number.isFinite(Number(alert.rssi)) ? Number(alert.rssi) : null,
          seenAt: Number.isFinite(Number(alert.seenAt)) ? Number(alert.seenAt) : Date.now()
        });
      }
    }
  } catch (error) {
    console.warn('Companion scan poll failed:', error);
  }
}

function emitAlertDetected(alert) {
  for (const callback of detectedCallbacks) {
    try {
      callback(alert);
    } catch (error) {
      console.warn('Alert detection callback failed:', error);
    }
  }
}

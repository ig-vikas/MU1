import { openDB } from 'idb';
import { decodeAlertNameForDisplay, getAlertTypeFromName, isValidJVAlertName } from './alertEncoding.js';
import { hashString } from './hash.js';

const DB_NAME = 'janvaani-emergency-ble';
const DB_VERSION = 1;
const ALERT_STORE = 'alerts';
const SETTINGS_KEY = 'janvaani-emergency-settings';
const DEFAULT_TTL_MINUTES = 60;
const DEFAULT_REBROADCAST_MINUTES = 60;
const DEFAULT_COOLDOWN_MS = 60000;

let dbPromise = null;

export const DEFAULT_EMERGENCY_SETTINGS = Object.freeze({
  ttlMinutes: DEFAULT_TTL_MINUTES,
  customTtlMinutes: DEFAULT_TTL_MINUTES,
  rebroadcastEnabled: false,
  rebroadcastMinutes: DEFAULT_REBROADCAST_MINUTES,
  customRebroadcastMinutes: DEFAULT_REBROADCAST_MINUTES,
  cooldownMs: DEFAULT_COOLDOWN_MS
});

/**
 * Opens the emergency BLE alert IndexedDB store.
 * @returns {Promise<import('idb').IDBPDatabase>} Database.
 */
export async function initEmergencyAlertDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(ALERT_STORE)) {
          const store = db.createObjectStore(ALERT_STORE, { keyPath: 'name' });
          store.createIndex('expiresAt', 'expiresAt');
          store.createIndex('lastSeenAt', 'lastSeenAt');
          store.createIndex('source', 'source');
          store.createIndex('active', 'active');
        }
      }
    });
  }

  return dbPromise;
}

/**
 * Saves or merges one emergency alert.
 * @param {object} alert - Alert object.
 * @returns {Promise<object>} Stored alert.
 */
export async function saveAlert(alert) {
  const normalized = normalizeAlert(alert);
  const db = await initEmergencyAlertDB();
  const existing = await db.get(ALERT_STORE, normalized.name);
  const now = Date.now();

  if (!existing) {
    await db.put(ALERT_STORE, normalized);
    return normalized;
  }

  const merged = {
    ...existing,
    displayText: existing.displayText || normalized.displayText,
    type: existing.type || normalized.type,
    source: existing.source === 'manual' ? 'manual' : normalized.source,
    firstSeenAt: Math.min(Number(existing.firstSeenAt), Number(normalized.firstSeenAt)),
    lastSeenAt: Math.max(Number(existing.lastSeenAt), Number(normalized.lastSeenAt), now),
    expiresAt: Math.max(Number(existing.expiresAt), Number(normalized.expiresAt)),
    rebroadcastUntil: Math.max(Number(existing.rebroadcastUntil || 0), Number(normalized.rebroadcastUntil || 0)),
    seenCount: Number(existing.seenCount || 1) + 1,
    active: Number(existing.expiresAt) > now || Number(normalized.expiresAt) > now,
    rssi: Number.isFinite(Number(normalized.rssi)) ? Number(normalized.rssi) : existing.rssi ?? null
  };

  await db.put(ALERT_STORE, merged);
  return merged;
}

/**
 * Saves or updates an alert by JV_ name.
 * @param {string} name - Alert name.
 * @param {object} options - Save options.
 * @returns {Promise<object>} Stored alert.
 */
export async function saveOrUpdateAlertName(name, options = {}) {
  return saveAlert(createAlertFromName(name, options));
}

/**
 * Returns all active alerts.
 * @returns {Promise<object[]>} Active alerts.
 */
export async function getActiveAlerts() {
  await markExpiredAlerts();
  const all = await getAllAlerts();
  return all.filter((alert) => alert.active);
}

/**
 * Returns all alert history entries.
 * @returns {Promise<object[]>} Alerts.
 */
export async function getAllAlerts() {
  const db = await initEmergencyAlertDB();
  const alerts = await db.getAll(ALERT_STORE);
  return alerts.sort((left, right) => Number(right.lastSeenAt) - Number(left.lastSeenAt));
}

/**
 * Marks expired alerts inactive without deleting their history.
 * @returns {Promise<number>} Count changed.
 */
export async function markExpiredAlerts() {
  const db = await initEmergencyAlertDB();
  const tx = db.transaction(ALERT_STORE, 'readwrite');
  const alerts = await tx.store.getAll();
  const now = Date.now();
  let changed = 0;

  for (const alert of alerts) {
    if (alert.active && Number(alert.expiresAt) <= now) {
      await tx.store.put({ ...alert, active: false });
      changed += 1;
    }
  }

  await tx.done;
  return changed;
}

/**
 * Increments seen count for one alert.
 * @param {string} name - JV_ name.
 * @returns {Promise<object | null>} Updated alert.
 */
export async function incrementSeenCount(name) {
  const existing = await getAlertByName(name);

  if (!existing) {
    return null;
  }

  const updated = {
    ...existing,
    seenCount: Number(existing.seenCount || 0) + 1,
    lastSeenAt: Date.now()
  };
  const db = await initEmergencyAlertDB();
  await db.put(ALERT_STORE, updated);
  return updated;
}

/**
 * Updates last seen time for one alert.
 * @param {string} name - JV_ name.
 * @returns {Promise<object | null>} Updated alert.
 */
export async function updateLastSeen(name) {
  const existing = await getAlertByName(name);

  if (!existing) {
    return null;
  }

  const updated = { ...existing, lastSeenAt: Date.now() };
  const db = await initEmergencyAlertDB();
  await db.put(ALERT_STORE, updated);
  return updated;
}

/**
 * Reads one alert by name.
 * @param {string} name - JV_ name.
 * @returns {Promise<object | null>} Alert.
 */
export async function getAlertByName(name) {
  if (!isValidJVAlertName(name)) {
    return null;
  }

  const db = await initEmergencyAlertDB();
  return (await db.get(ALERT_STORE, name)) ?? null;
}

/**
 * Checks whether one alert is eligible for rebroadcast.
 * @param {object} alert - Alert object.
 * @param {object} options - Optional settings.
 * @returns {boolean} True when eligible.
 */
export function shouldRebroadcast(alert, options = {}) {
  const now = Number(options.now ?? Date.now());
  const cooldownMs = Number(options.cooldownMs ?? DEFAULT_COOLDOWN_MS);

  return (
    Boolean(alert) &&
    isValidJVAlertName(alert.name) &&
    Number(alert.expiresAt) > now &&
    Number(alert.rebroadcastUntil) > now &&
    (!Number.isFinite(Number(alert.lastRebroadcastAt)) || now - Number(alert.lastRebroadcastAt) >= cooldownMs)
  );
}

/**
 * Records a successful rebroadcast.
 * @param {string} name - JV_ name.
 * @returns {Promise<object | null>} Updated alert.
 */
export async function recordRebroadcast(name) {
  const existing = await getAlertByName(name);

  if (!existing) {
    return null;
  }

  const updated = {
    ...existing,
    rebroadcastCount: Number(existing.rebroadcastCount || 0) + 1,
    lastRebroadcastAt: Date.now()
  };
  const db = await initEmergencyAlertDB();
  await db.put(ALERT_STORE, updated);
  return updated;
}

/**
 * Deletes expired alert history entries.
 * @returns {Promise<number>} Deleted count.
 */
export async function clearExpiredAlerts() {
  const db = await initEmergencyAlertDB();
  const tx = db.transaction(ALERT_STORE, 'readwrite');
  const alerts = await tx.store.getAll();
  const now = Date.now();
  let deleted = 0;

  for (const alert of alerts) {
    if (Number(alert.expiresAt) <= now) {
      await tx.store.delete(alert.name);
      deleted += 1;
    }
  }

  await tx.done;
  return deleted;
}

/**
 * Reads emergency settings from local storage.
 * @returns {object} Settings.
 */
export function getEmergencySettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return normalizeSettings({ ...DEFAULT_EMERGENCY_SETTINGS, ...raw });
  } catch (error) {
    return { ...DEFAULT_EMERGENCY_SETTINGS };
  }
}

/**
 * Saves emergency settings to local storage.
 * @param {object} patch - Settings patch.
 * @returns {object} Stored settings.
 */
export function saveEmergencySettings(patch) {
  const settings = normalizeSettings({ ...getEmergencySettings(), ...patch });
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  return settings;
}

/**
 * Creates a normalized alert object from a JV_ name.
 * @param {string} name - JV_ name.
 * @param {object} options - Alert metadata.
 * @returns {object} Alert object.
 */
export function createAlertFromName(name, options = {}) {
  if (!isValidJVAlertName(name)) {
    throw new Error('Invalid JV_ alert name.');
  }

  const now = Number(options.seenAt ?? Date.now());
  const ttlMinutes = clampMinutes(options.ttlMinutes ?? DEFAULT_TTL_MINUTES, 1, 120);
  const rebroadcastMinutes = clampMinutes(options.rebroadcastMinutes ?? DEFAULT_REBROADCAST_MINUTES, 1, 120);
  const firstSeenAt = Number(options.firstSeenAt ?? now);
  const expiresAt = Number(options.expiresAt ?? now + ttlMinutes * 60000);
  const rebroadcastUntil = Number(options.rebroadcastUntil ?? now + rebroadcastMinutes * 60000);

  return {
    id: `jvble_${hashString(`${name}|${Math.floor(firstSeenAt / 300000)}`)}`,
    name,
    displayText: decodeAlertNameForDisplay(name),
    type: getAlertTypeFromName(name),
    source: options.source === 'manual' ? 'manual' : 'scanned',
    firstSeenAt,
    lastSeenAt: now,
    expiresAt,
    rebroadcastUntil,
    seenCount: Number(options.seenCount ?? 1),
    rebroadcastCount: Number(options.rebroadcastCount ?? 0),
    lastRebroadcastAt: Number.isFinite(Number(options.lastRebroadcastAt)) ? Number(options.lastRebroadcastAt) : null,
    active: expiresAt > Date.now(),
    rssi: Number.isFinite(Number(options.rssi)) ? Number(options.rssi) : null
  };
}

function normalizeAlert(alert) {
  if (!isValidJVAlertName(alert?.name)) {
    throw new Error('Invalid JV_ alert name.');
  }

  return createAlertFromName(alert.name, alert);
}

function normalizeSettings(settings) {
  return {
    ttlMinutes: clampMinutes(settings.ttlMinutes, 1, 120),
    customTtlMinutes: clampMinutes(settings.customTtlMinutes, 1, 120),
    rebroadcastEnabled: Boolean(settings.rebroadcastEnabled),
    rebroadcastMinutes: clampMinutes(settings.rebroadcastMinutes, 1, 120),
    customRebroadcastMinutes: clampMinutes(settings.customRebroadcastMinutes, 1, 120),
    cooldownMs: Math.max(15000, Math.min(300000, Number(settings.cooldownMs) || DEFAULT_COOLDOWN_MS))
  };
}

function clampMinutes(value, min, max) {
  const number = Math.floor(Number(value));
  return Math.max(min, Math.min(max, Number.isFinite(number) ? number : DEFAULT_TTL_MINUTES));
}

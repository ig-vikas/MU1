import { openDB } from 'idb';
import { ALERT_STORE, DB_NAME, DB_VERSION, META_STORE } from './constants.js';
import { countHashOverlap } from './hash.js';
import { normalizeIncomingAlert } from './alerts.js';

let dbPromise;

/**
 * Opens the JanVaani IndexedDB database.
 * @returns {Promise<import('idb').IDBPDatabase>} Open database.
 */
export async function getJanVaaniDb() {
  try {
    if (!dbPromise) {
      dbPromise = openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(ALERT_STORE)) {
            const store = db.createObjectStore(ALERT_STORE, { keyPath: 'hash' });
            store.createIndex('category', 'category');
            store.createIndex('createdAt', 'createdAt');
            store.createIndex('expiresAt', 'expiresAt');
            store.createIndex('severity', 'severity');
          }

          if (!db.objectStoreNames.contains(META_STORE)) {
            db.createObjectStore(META_STORE);
          }
        }
      });
    }

    return await dbPromise;
  } catch (error) {
    dbPromise = undefined;
    throw new Error(`Unable to open JanVaani offline store: ${error.message}`);
  }
}

/**
 * Reads all alerts from offline storage.
 * @returns {Promise<object[]>} Stored alerts.
 */
export async function readAlerts() {
  try {
    const db = await getJanVaaniDb();
    const alerts = await db.getAll(ALERT_STORE);
    return alerts.map((alert) => normalizeIncomingAlert(alert));
  } catch (error) {
    throw new Error(`Unable to read alerts: ${error.message}`);
  }
}

/**
 * Reads one alert by hash.
 * @param {string} hash - Alert hash.
 * @returns {Promise<object | undefined>} Stored alert.
 */
export async function readAlert(hash) {
  try {
    const db = await getJanVaaniDb();
    const alert = await db.get(ALERT_STORE, hash);
    return alert ? normalizeIncomingAlert(alert) : undefined;
  } catch (error) {
    throw new Error(`Unable to read alert ${hash}: ${error.message}`);
  }
}

/**
 * Saves alerts with hash-array deduplication and relay metadata merging.
 * @param {object[]} incomingAlerts - Alerts to save.
 * @returns {Promise<{created: number, updated: number, skipped: number}>} Save stats.
 */
export async function saveAlerts(incomingAlerts) {
  try {
    const db = await getJanVaaniDb();
    const tx = db.transaction(ALERT_STORE, 'readwrite');
    const store = tx.objectStore(ALERT_STORE);
    const stats = {
      created: 0,
      updated: 0,
      skipped: 0
    };

    for (const rawAlert of incomingAlerts) {
      const alert = normalizeIncomingAlert(rawAlert);

      if (!alert.title || !alert.location || !alert.details) {
        stats.skipped += 1;
        continue;
      }

      const existing = await store.get(alert.hash);

      if (!existing) {
        await store.put(alert);
        stats.created += 1;
        continue;
      }

      const overlap = countHashOverlap(existing.hashTrail ?? [], alert.hashTrail ?? []);
      const shouldUpdate =
        overlap >= 6 ||
        Number(alert.relayCount) > Number(existing.relayCount ?? 0) ||
        Boolean(alert.verification?.valid && !existing.verification?.valid);

      if (shouldUpdate) {
        await store.put({
          ...existing,
          ...alert,
          relayCount: Math.max(Number(existing.relayCount ?? 0), Number(alert.relayCount ?? 0)),
          importedAt: existing.importedAt || alert.importedAt,
          lastSeenAt: new Date().toISOString()
        });
        stats.updated += 1;
      } else {
        stats.skipped += 1;
      }
    }

    await tx.done;
    return stats;
  } catch (error) {
    throw new Error(`Unable to save alerts: ${error.message}`);
  }
}

/**
 * Deletes expired alerts from storage.
 * @param {number} now - Current epoch milliseconds.
 * @returns {Promise<number>} Number of deleted alerts.
 */
export async function deleteExpiredAlerts(now = Date.now()) {
  try {
    const db = await getJanVaaniDb();
    const tx = db.transaction(ALERT_STORE, 'readwrite');
    const store = tx.objectStore(ALERT_STORE);
    const alerts = await store.getAll();
    let deleted = 0;

    for (const alert of alerts) {
      const expiresAt = new Date(alert.expiresAt).getTime();

      if (Number.isFinite(expiresAt) && expiresAt <= now) {
        await store.delete(alert.hash);
        deleted += 1;
      }
    }

    await tx.done;
    return deleted;
  } catch (error) {
    throw new Error(`Unable to delete expired alerts: ${error.message}`);
  }
}

/**
 * Reads a metadata value from offline storage.
 * @param {string} key - Metadata key.
 * @returns {Promise<unknown>} Stored metadata value.
 */
export async function readMeta(key) {
  try {
    const db = await getJanVaaniDb();
    return await db.get(META_STORE, key);
  } catch (error) {
    throw new Error(`Unable to read metadata ${key}: ${error.message}`);
  }
}

/**
 * Writes a metadata value to offline storage.
 * @param {string} key - Metadata key.
 * @param {unknown} value - Metadata value.
 * @returns {Promise<void>} Resolves when stored.
 */
export async function writeMeta(key, value) {
  try {
    const db = await getJanVaaniDb();
    await db.put(META_STORE, value, key);
  } catch (error) {
    throw new Error(`Unable to write metadata ${key}: ${error.message}`);
  }
}

import { openDB } from 'idb';

const DB_NAME = 'janvaani';
const DB_VERSION = 1;
const ALERT_STORE = 'alerts';
const PURGE_INTERVAL_KEY = '__janvaaniPurgeIntervalId';
let dbPromise;

function isExpired(alert) {
  return Number.isFinite(Number(alert?.expiresAt)) && Number(alert.expiresAt) <= Date.now();
}

function cloneAlert(alert) {
  return {
    ...alert,
    priority: Number(alert.priority),
    created: Number(alert.created),
    expiresAt: Number(alert.expiresAt)
  };
}

function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Unable to delete database ${name}`));
    request.onblocked = () => reject(new Error(`Database ${name} deletion is blocked by another tab.`));
  });
}

/**
 * Opens and initializes the JanVaani IndexedDB database.
 * @returns {Promise<import('idb').IDBPDatabase>} Open database instance.
 */
export async function initDB() {
  try {
    if (!dbPromise) {
      dbPromise = openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(ALERT_STORE)) {
            const store = db.createObjectStore(ALERT_STORE, { keyPath: 'id' });
            store.createIndex('type', 'type');
            store.createIndex('priority', 'priority');
            store.createIndex('created', 'created');
            store.createIndex('expiresAt', 'expiresAt');
            store.createIndex('region', 'region');
          }
        }
      });
    }

    return await dbPromise;
  } catch (error) {
    dbPromise = undefined;
    throw new Error(`Failed to initialize JanVaani database: ${error.message}`);
  }
}

/**
 * Saves a new alert if its id does not already exist.
 * @param {object} alert - Alert to save.
 * @returns {Promise<boolean>} True when saved, false when skipped.
 */
export async function saveAlert(alert) {
  try {
    if (!alert?.id) {
      throw new Error('Alert id is required.');
    }

    const db = await initDB();
    const existing = await db.get(ALERT_STORE, alert.id);

    if (existing) {
      return false;
    }

    await db.add(ALERT_STORE, cloneAlert(alert));
    return true;
  } catch (error) {
    throw new Error(`Failed to save alert: ${error.message}`);
  }
}

/**
 * Reads one alert by id, lazily deleting it if expired.
 * @param {string} id - Alert id.
 * @returns {Promise<object | null>} Alert or null.
 */
export async function getAlert(id) {
  try {
    if (!id) {
      return null;
    }

    const db = await initDB();
    const alert = await db.get(ALERT_STORE, id);

    if (!alert) {
      return null;
    }

    if (isExpired(alert)) {
      await db.delete(ALERT_STORE, id);
      return null;
    }

    return alert;
  } catch (error) {
    throw new Error(`Failed to get alert: ${error.message}`);
  }
}

/**
 * Reads all non-expired alerts, optionally filtered by type.
 * @param {string | null} typeFilter - Optional alert type filter.
 * @returns {Promise<object[]>} Sorted active alerts.
 */
export async function getAllAlerts(typeFilter = null) {
  try {
    await purgeExpired();
    const db = await initDB();
    const alerts = typeFilter
      ? await db.getAllFromIndex(ALERT_STORE, 'type', typeFilter)
      : await db.getAll(ALERT_STORE);

    return alerts
      .filter((alert) => !isExpired(alert))
      .sort((left, right) => {
        const priorityDiff = Number(right.priority ?? 0) - Number(left.priority ?? 0);

        if (priorityDiff !== 0) {
          return priorityDiff;
        }

        return Number(right.created ?? 0) - Number(left.created ?? 0);
      });
  } catch (error) {
    throw new Error(`Failed to get alerts: ${error.message}`);
  }
}

/**
 * Deletes an alert by id.
 * @param {string} id - Alert id.
 * @returns {Promise<void>} Resolves when deleted.
 */
export async function deleteAlert(id) {
  try {
    if (!id) {
      return;
    }

    const db = await initDB();
    await db.delete(ALERT_STORE, id);
  } catch (error) {
    throw new Error(`Failed to delete alert: ${error.message}`);
  }
}

/**
 * Purges all expired alerts using the expiresAt index.
 * @returns {Promise<number>} Number of purged alerts.
 */
export async function purgeExpired() {
  try {
    const db = await initDB();
    const tx = db.transaction(ALERT_STORE, 'readwrite');
    const index = tx.store.index('expiresAt');
    let cursor = await index.openCursor(IDBKeyRange.upperBound(Date.now()));
    let deleted = 0;

    while (cursor) {
      await cursor.delete();
      deleted += 1;
      cursor = await cursor.continue();
    }

    await tx.done;
    return deleted;
  } catch (error) {
    throw new Error(`Failed to purge expired alerts: ${error.message}`);
  }
}

/**
 * Counts all stored alerts.
 * @returns {Promise<number>} Alert count.
 */
export async function getAlertCount() {
  try {
    await purgeExpired();
    const db = await initDB();
    return await db.count(ALERT_STORE);
  } catch (error) {
    throw new Error(`Failed to count alerts: ${error.message}`);
  }
}

/**
 * Clears all JanVaani data by deleting and reinitializing the database.
 * @returns {Promise<import('idb').IDBPDatabase>} Fresh database instance.
 */
export async function clearAllData() {
  try {
    if (dbPromise) {
      const db = await dbPromise;
      db.close();
      dbPromise = undefined;
    }

    await deleteDatabase(DB_NAME);
    return await initDB();
  } catch (error) {
    dbPromise = undefined;
    throw new Error(`Failed to clear JanVaani data: ${error.message}`);
  }
}

/**
 * Reads every alert id from storage.
 * @returns {Promise<string[]>} Alert id list.
 */
export async function getAllAlertIds() {
  try {
    const db = await initDB();
    const keys = await db.getAllKeys(ALERT_STORE);
    return keys.map((key) => String(key));
  } catch (error) {
    throw new Error(`Failed to get alert ids: ${error.message}`);
  }
}

/**
 * Saves many alerts, skipping duplicate ids.
 * @param {object[]} alerts - Alerts to save.
 * @returns {Promise<{saved: number, skipped: number}>} Bulk save stats.
 */
export async function bulkSave(alerts) {
  try {
    if (!Array.isArray(alerts)) {
      throw new Error('bulkSave expects an array.');
    }

    let saved = 0;
    let skipped = 0;

    for (const alert of alerts) {
      const didSave = await saveAlert(alert);

      if (didSave) {
        saved += 1;
      } else {
        skipped += 1;
      }
    }

    return { saved, skipped };
  } catch (error) {
    throw new Error(`Failed to bulk save alerts: ${error.message}`);
  }
}

if (typeof indexedDB !== 'undefined') {
  initDB().catch((error) => {
    console.warn(error);
  });

  if (!globalThis[PURGE_INTERVAL_KEY]) {
    globalThis[PURGE_INTERVAL_KEY] = setInterval(() => {
      purgeExpired().catch((error) => {
        console.warn(error);
      });
    }, 300000);
  }
}

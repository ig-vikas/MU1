import { ALERT_BLUEPRINTS, CATEGORY_BY_ID, CATEGORY_DEFINITIONS, DEFAULT_FORM_VALUES } from './constants.js';
import { getDeviceFingerprint, signAlert, verifyAlertSignature } from './crypto.js';
import { buildHashArray, deriveAlertHash, normalizeForHash } from './hash.js';

const OFFICIAL_SOURCE_TYPES = new Set(['District Control Room', 'PHC Staff', 'Police Desk', 'Relief Camp Desk']);

/**
 * Removes control characters and limits text length for safe UI rendering.
 * @param {unknown} value - Raw value.
 * @param {number} maxLength - Maximum output length.
 * @returns {string} Sanitized text.
 */
export function sanitizeText(value, maxLength = 500) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Escapes text for safe insertion into template strings.
 * @param {unknown} value - Raw value.
 * @returns {string} HTML-safe text.
 */
export function escapeHtml(value) {
  return sanitizeText(value, 1000)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Returns the fixed JanVaani category definition.
 * @param {string} categoryId - Category identifier.
 * @returns {{id: string, label: string, icon: string, color: string, surface: string, weight: number}} Category definition.
 */
export function getCategoryDefinition(categoryId) {
  return CATEGORY_BY_ID[categoryId] ?? CATEGORY_BY_ID['official-notice'];
}

/**
 * Returns all fixed alert categories in display order.
 * @returns {{id: string, label: string, icon: string, color: string, surface: string, weight: number}[]} Category definitions.
 */
export function getCategoryOptions() {
  return [...CATEGORY_DEFINITIONS];
}

/**
 * Formats an ISO timestamp for compact local display.
 * @param {string} isoValue - ISO timestamp.
 * @returns {string} Date and time text.
 */
export function formatDateTime(isoValue) {
  const date = new Date(isoValue);

  if (Number.isNaN(date.getTime())) {
    return 'Unknown time';
  }

  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

/**
 * Formats a relative timestamp without relying on external services.
 * @param {string} isoValue - ISO timestamp.
 * @param {number} now - Current epoch milliseconds.
 * @returns {string} Relative time text.
 */
export function formatRelativeTime(isoValue, now = Date.now()) {
  const timestamp = new Date(isoValue).getTime();

  if (Number.isNaN(timestamp)) {
    return 'time unknown';
  }

  const diffMinutes = Math.round((now - timestamp) / 60000);

  if (Math.abs(diffMinutes) < 1) {
    return 'just now';
  }

  if (diffMinutes < 0) {
    return `in ${Math.abs(diffMinutes)} min`;
  }

  if (diffMinutes < 60) {
    return `${diffMinutes} min ago`;
  }

  const diffHours = Math.round(diffMinutes / 60);

  if (diffHours < 24) {
    return `${diffHours} hr ago`;
  }

  return `${Math.round(diffHours / 24)} day ago`;
}

/**
 * Checks whether an alert has expired.
 * @param {object} alert - Alert-like object.
 * @param {number} now - Current epoch milliseconds.
 * @returns {boolean} True when expired.
 */
export function isExpired(alert, now = Date.now()) {
  const expiresAt = new Date(alert.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

/**
 * Validates a user-created alert draft.
 * @param {object} draft - Draft values from the composer.
 * @returns {{valid: boolean, errors: string[]}} Validation result.
 */
export function validateAlertDraft(draft) {
  const errors = [];
  const category = getCategoryDefinition(draft.category);
  const title = sanitizeText(draft.title, 84);
  const location = sanitizeText(draft.location, 96);
  const details = sanitizeText(draft.details, 360);
  const severity = Number(draft.severity);
  const ttlHours = Number(draft.ttlHours);
  const sourceName = sanitizeText(draft.sourceName, 64);

  if (!category.id) {
    errors.push('Choose a valid alert category.');
  }

  if (title.length < 6) {
    errors.push('Alert title needs at least 6 characters.');
  }

  if (location.length < 4) {
    errors.push('Location needs at least 4 characters.');
  }

  if (details.length < 18) {
    errors.push('Details need at least 18 characters.');
  }

  if (!Number.isInteger(severity) || severity < 1 || severity > 5) {
    errors.push('Severity must be between 1 and 5.');
  }

  if (!Number.isFinite(ttlHours) || ttlHours < 1 || ttlHours > 72) {
    errors.push('Expiry must be between 1 and 72 hours.');
  }

  if (sourceName.length < 3) {
    errors.push('Source name needs at least 3 characters.');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Creates a signed JanVaani alert from a user draft.
 * @param {object} draft - Draft values.
 * @param {{publicKeyBase64: string, secretKey: Uint8Array, fingerprint: string}} keyPair - Local signing key.
 * @returns {object} Fully signed alert.
 */
export function createSignedAlert(draft, keyPair) {
  const mergedDraft = {
    ...DEFAULT_FORM_VALUES,
    ...draft
  };
  const validation = validateAlertDraft(mergedDraft);

  if (!validation.valid) {
    throw new Error(validation.errors.join(' '));
  }

  const createdAtBase = Date.parse(mergedDraft.createdAt);
  const createdAt = Number.isFinite(createdAtBase) ? new Date(createdAtBase).toISOString() : new Date().toISOString();
  const ttlHours = Math.max(1, Math.min(72, Number(mergedDraft.ttlHours)));
  const expiresAt =
    typeof mergedDraft.expiresAt === 'string' && Number.isFinite(Date.parse(mergedDraft.expiresAt))
      ? new Date(mergedDraft.expiresAt).toISOString()
      : new Date(new Date(createdAt).getTime() + ttlHours * 60 * 60 * 1000).toISOString();
  const category = getCategoryDefinition(mergedDraft.category);
  const sourceType = sanitizeText(mergedDraft.sourceType || DEFAULT_FORM_VALUES.sourceType, 48);

  const alert = {
    version: 1,
    category: category.id,
    title: sanitizeText(mergedDraft.title, 84),
    location: sanitizeText(mergedDraft.location, 96),
    details: sanitizeText(mergedDraft.details, 360),
    severity: Math.max(1, Math.min(5, Number(mergedDraft.severity))),
    createdAt,
    expiresAt,
    sourceType,
    sourceName: sanitizeText(mergedDraft.sourceName, 64),
    publicKey: keyPair.publicKeyBase64,
    deviceFingerprint: keyPair.fingerprint,
    relayCount: Math.max(0, Number(mergedDraft.relayCount ?? 0)),
    importedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };

  alert.hashTrail = buildHashArray(alert);
  alert.hash = deriveAlertHash(alert);
  alert.signature = signAlert(alert, keyPair);
  alert.verification = verifyAlertSignature(alert);
  alert.trustLevel = getTrustLevel(alert, alert.verification);

  return alert;
}

/**
 * Normalizes an incoming packet alert and recomputes its dedupe hash array.
 * @param {object} rawAlert - Alert from storage or packet.
 * @returns {object} Normalized alert.
 */
export function normalizeIncomingAlert(rawAlert) {
  const nowIso = new Date().toISOString();
  const createdAt = Number.isFinite(Date.parse(rawAlert.createdAt))
    ? new Date(rawAlert.createdAt).toISOString()
    : nowIso;
  const expiresAt = Number.isFinite(Date.parse(rawAlert.expiresAt))
    ? new Date(rawAlert.expiresAt).toISOString()
    : new Date(new Date(createdAt).getTime() + 6 * 60 * 60 * 1000).toISOString();
  const category = getCategoryDefinition(rawAlert.category);

  const alert = {
    version: 1,
    category: category.id,
    title: sanitizeText(rawAlert.title, 84),
    location: sanitizeText(rawAlert.location, 96),
    details: sanitizeText(rawAlert.details, 360),
    severity: Math.max(1, Math.min(5, Number(rawAlert.severity) || 1)),
    createdAt,
    expiresAt,
    sourceType: sanitizeText(rawAlert.sourceType || 'Community Volunteer', 48),
    sourceName: sanitizeText(rawAlert.sourceName || 'Unknown public source', 64),
    publicKey: sanitizeText(rawAlert.publicKey, 120),
    signature: sanitizeText(rawAlert.signature, 140),
    relayCount: Math.max(0, Math.min(999, Number(rawAlert.relayCount) || 0)),
    importedAt: sanitizeText(rawAlert.importedAt || nowIso, 40),
    lastSeenAt: nowIso
  };

  const incomingHashTrail =
    Array.isArray(rawAlert.hashTrail) && rawAlert.hashTrail.length >= 6
      ? rawAlert.hashTrail.map((hash) => sanitizeText(hash, 16))
      : [];
  alert.hashTrail = buildHashArray(alert);
  alert.hashTrailMismatch =
    incomingHashTrail.length > 0 && incomingHashTrail.join('|') !== alert.hashTrail.join('|');
  alert.hash = deriveAlertHash(alert);
  alert.packetHash = sanitizeText(rawAlert.hash, 80);
  alert.hashMismatch = Boolean(alert.packetHash && alert.packetHash !== alert.hash) || alert.hashTrailMismatch;
  alert.deviceFingerprint = alert.publicKey ? getDeviceFingerprint(alert.publicKey) : 'NO-KEY';
  alert.verification = verifyAlertSignature(alert);
  alert.trustLevel = getTrustLevel(alert, alert.verification);

  return alert;
}

/**
 * Converts an alert to the compact packet-safe representation.
 * @param {object} alert - Alert object.
 * @returns {object} Packet-safe alert.
 */
export function serializeAlertForPacket(alert) {
  return {
    version: 1,
    hash: alert.hash,
    hashTrail: Array.isArray(alert.hashTrail) ? alert.hashTrail : buildHashArray(alert),
    category: alert.category,
    title: alert.title,
    location: alert.location,
    details: alert.details,
    severity: Number(alert.severity),
    createdAt: alert.createdAt,
    expiresAt: alert.expiresAt,
    sourceType: alert.sourceType,
    sourceName: alert.sourceName,
    publicKey: alert.publicKey,
    signature: alert.signature,
    relayCount: Math.max(0, Number(alert.relayCount) || 0)
  };
}

/**
 * Builds the realistic India-focused starter alerts for a new device.
 * @param {{publicKeyBase64: string, secretKey: Uint8Array, fingerprint: string}} keyPair - Local signing key.
 * @param {number} now - Current epoch milliseconds.
 * @returns {object[]} Seed alerts.
 */
export function buildSeedAlerts(keyPair, now = Date.now()) {
  return ALERT_BLUEPRINTS.map((blueprint) =>
    createSignedAlert(
      {
        ...blueprint,
        createdAt: new Date(now - blueprint.createdAtOffsetMinutes * 60000).toISOString()
      },
      keyPair
    )
  );
}

/**
 * Calculates a display priority score for sorting alerts.
 * @param {object} alert - Alert object.
 * @param {number} now - Current epoch milliseconds.
 * @returns {number} Priority score.
 */
export function calculatePriorityScore(alert, now = Date.now()) {
  const category = getCategoryDefinition(alert.category);
  const ageHours = Math.max(0, (now - new Date(alert.createdAt).getTime()) / 3600000);
  const expiryHours = Math.max(0, (new Date(alert.expiresAt).getTime() - now) / 3600000);
  const recencyBoost = Math.max(0, 10 - ageHours);
  const expiryBoost = expiryHours < 3 ? 4 : 0;
  const relayBoost = Math.min(6, Number(alert.relayCount) || 0);
  const signatureBoost = alert.verification?.valid ? 3 : 0;

  return category.weight + Number(alert.severity) * 8 + recencyBoost + expiryBoost + relayBoost + signatureBoost;
}

/**
 * Filters and sorts alerts for the board.
 * @param {object[]} alerts - Alert list.
 * @param {{category: string, query: string, sort: string}} filters - Filter values.
 * @returns {object[]} Filtered alerts.
 */
export function filterAndSortAlerts(alerts, filters) {
  const now = Date.now();
  const query = normalizeForHash(filters.query);
  const category = filters.category || 'all';

  const filtered = alerts.filter((alert) => {
    if (isExpired(alert, now)) {
      return false;
    }

    if (category !== 'all' && alert.category !== category) {
      return false;
    }

    if (!query) {
      return true;
    }

    const haystack = normalizeForHash(
      `${alert.title} ${alert.location} ${alert.details} ${alert.sourceName} ${getCategoryDefinition(alert.category).label}`
    );
    return haystack.includes(query);
  });

  return filtered.sort((left, right) => {
    if (filters.sort === 'newest') {
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    }

    if (filters.sort === 'expiry') {
      return new Date(left.expiresAt).getTime() - new Date(right.expiresAt).getTime();
    }

    return calculatePriorityScore(right, now) - calculatePriorityScore(left, now);
  });
}

/**
 * Returns a trust label from source and signature details.
 * @param {object} alert - Alert object.
 * @param {{valid: boolean, status: string, label: string}} verification - Verification result.
 * @returns {string} Trust level.
 */
export function getTrustLevel(alert, verification) {
  if (verification.valid && OFFICIAL_SOURCE_TYPES.has(alert.sourceType)) {
    return 'signed official';
  }

  if (verification.valid) {
    return 'signed community';
  }

  if (alert.hashMismatch) {
    return 'hash changed';
  }

  return 'checksum only';
}

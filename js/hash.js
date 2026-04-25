const HASH_MOD = 0x100000000;

/**
 * Normalizes arbitrary text into a compact, deterministic hash input.
 * @param {unknown} value - Value to normalize.
 * @returns {string} Lowercase normalized string.
 */
export function normalizeForHash(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Creates a fast non-cryptographic hash for local alert deduplication.
 * @param {unknown} value - Input value to hash.
 * @returns {string} Stable hexadecimal hash.
 */
export function hashString(value) {
  const input = normalizeForHash(value);
  let fnv = 0x811c9dc5;
  let djb = 5381;

  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    fnv ^= code;
    fnv = Math.imul(fnv, 0x01000193) >>> 0;
    djb = ((djb << 5) + djb + code) >>> 0;
  }

  const mixed = (fnv ^ djb ^ input.length) >>> 0;
  return mixed.toString(16).padStart(8, '0');
}

/**
 * Builds the simple hash array used by JanVaani to spot duplicate alerts.
 * @param {object} alert - Alert-like object.
 * @returns {string[]} Hashes for the canonical alert fields.
 */
export function buildHashArray(alert) {
  const fields = [
    alert.category,
    alert.title,
    alert.location,
    alert.details,
    alert.createdAt,
    alert.expiresAt,
    alert.sourceType,
    alert.sourceName,
    alert.severity
  ];

  return fields.map((field) => hashString(field));
}

/**
 * Derives the stable JanVaani alert hash from a simple hash array.
 * @param {object} alert - Alert-like object.
 * @returns {string} Stable JanVaani alert identifier.
 */
export function deriveAlertHash(alert) {
  const hashArray = Array.isArray(alert.hashTrail) ? alert.hashTrail : buildHashArray(alert);
  const joined = hashArray.join('|');
  const bodyHash = hashString(joined);
  const titleHash = hashString(`${alert.category}|${alert.title}|${alert.location}`);
  return `jv_${bodyHash}_${titleHash}`;
}

/**
 * Finds overlap between two JanVaani hash arrays.
 * @param {string[]} left - First hash array.
 * @param {string[]} right - Second hash array.
 * @returns {number} Count of shared hashes.
 */
export function countHashOverlap(left, right) {
  const rightSet = new Set(right);
  return left.reduce((count, hash) => count + (rightSet.has(hash) ? 1 : 0), 0);
}

/**
 * Converts a byte count to a compact display string.
 * @param {number} bytes - Number of bytes.
 * @returns {string} Human-readable byte size.
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 bytes';
  }

  if (bytes < 1024) {
    return `${Math.round(bytes)} bytes`;
  }

  return `${(bytes / 1024).toFixed(1)} KB`;
}

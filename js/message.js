import { deflate, inflate } from 'pako';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const VERSION = 1;
const DEFAULT_TTL_SECONDS = 172800;
const EMERGENCY_TTL_SECONDS = 345600;
const DEFAULT_MAX_HOPS = 10;
const EMERGENCY_MAX_HOPS = 50;
const COMPRESSED_PREFIX = 'JV1C:';

function sanitizeText(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function clampPriority(priority) {
  const numericPriority = Number(priority);

  if (!Number.isFinite(numericPriority)) {
    return 1;
  }

  return Math.max(1, Math.min(5, Math.round(numericPriority)));
}

function normalizeType(type) {
  return sanitizeText(type || 'notice', 40).toLowerCase() || 'notice';
}

function getDefaultLanguage(lang) {
  return sanitizeText(lang || globalThis.navigator?.language || 'en-IN', 16) || 'en-IN';
}

function getSourceId() {
  try {
    const bytes = new Uint8Array(12);
    globalThis.crypto.getRandomValues(bytes);
    return `src_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  } catch (error) {
    return `src_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function bytesToBase64Url(bytes) {
  let binary = '';
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  if (typeof globalThis.btoa === 'function') {
    return globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  return Buffer.from(bytes).toString('base64url');
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');

  if (typeof globalThis.atob !== 'function') {
    return new Uint8Array(Buffer.from(padded, 'base64'));
  }

  const binary = globalThis.atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  return `${(bytes / 1024).toFixed(1)} KB`;
}

function normalizeForValidation(alert) {
  return {
    ...alert,
    id: sanitizeText(alert?.id, 96),
    type: normalizeType(alert?.type),
    title: sanitizeText(alert?.title, 100),
    body: sanitizeText(alert?.body, 500),
    priority: Number(alert?.priority),
    region: sanitizeText(alert?.region, 80),
    created: Number(alert?.created),
    ttl: Number(alert?.ttl),
    expiresAt: Number(alert?.expiresAt),
    hops: Number(alert?.hops),
    maxHops: Number(alert?.maxHops),
    prev: alert?.prev ? sanitizeText(alert.prev, 96) : null,
    source: sanitizeText(alert?.source, 96),
    lang: sanitizeText(alert?.lang, 16),
    version: Number(alert?.version)
  };
}

/**
 * Creates a complete JanVaani alert message with a SHA-256 id.
 * @param {{type: string, title: string, body: string, priority: number, region: string, lang?: string, prev?: string | null, source?: string}} input - Alert input fields.
 * @returns {Promise<object>} Complete alert object.
 */
export async function createAlert({ type, title, body, priority, region, lang, prev, source } = {}) {
  try {
    const normalizedType = normalizeType(type);
    const created = Math.floor(Date.now() / 1000);
    const isEmergency = normalizedType === 'emergency';
    const ttl = isEmergency ? EMERGENCY_TTL_SECONDS : DEFAULT_TTL_SECONDS;
    const alertWithoutId = {
      type: normalizedType,
      title: sanitizeText(title, 100),
      body: sanitizeText(body, 500),
      priority: clampPriority(priority),
      region: sanitizeText(region || 'local', 80),
      created,
      ttl,
      expiresAt: (created + ttl) * 1000,
      hops: 0,
      maxHops: isEmergency ? EMERGENCY_MAX_HOPS : DEFAULT_MAX_HOPS,
      prev: prev ? sanitizeText(prev, 96) : null,
      source: source ? sanitizeText(source, 96) : getSourceId(),
      lang: getDefaultLanguage(lang),
      version: VERSION
    };
    const id = await hashContent(JSON.stringify(alertWithoutId));
    const alert = {
      id,
      ...alertWithoutId
    };
    const validation = validateAlert(alert);

    if (!validation.valid) {
      throw new Error(validation.errors.join(' '));
    }

    return alert;
  } catch (error) {
    throw new Error(`Failed to create alert: ${error.message}`);
  }
}

/**
 * Creates a SHA-256 hex hash from text.
 * @param {string} str - String to hash.
 * @returns {Promise<string>} Hex encoded SHA-256 digest.
 */
export async function hashContent(str) {
  try {
    if (!globalThis.crypto?.subtle) {
      throw new Error('Web Crypto SHA-256 is unavailable.');
    }

    const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(String(str ?? '')));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch (error) {
    throw new Error(`Failed to hash content: ${error.message}`);
  }
}

/**
 * Validates a JanVaani alert against the v1 schema.
 * @param {object} alert - Alert to validate.
 * @returns {{valid: boolean, errors: string[]}} Validation result.
 */
export function validateAlert(alert) {
  try {
    const normalized = normalizeForValidation(alert);
    const errors = [];

    if (!/^[a-f0-9]{64}$/i.test(normalized.id)) {
      errors.push('id must be a SHA-256 hex string.');
    }

    if (!normalized.type) {
      errors.push('type is required.');
    }

    if (!normalized.title || normalized.title.length > 100) {
      errors.push('title is required and must be 100 characters or fewer.');
    }

    if (!normalized.body || normalized.body.length > 500) {
      errors.push('body is required and must be 500 characters or fewer.');
    }

    if (!Number.isInteger(normalized.priority) || normalized.priority < 1 || normalized.priority > 5) {
      errors.push('priority must be an integer from 1 to 5.');
    }

    if (!normalized.region) {
      errors.push('region is required.');
    }

    if (!Number.isInteger(normalized.created) || normalized.created <= 0) {
      errors.push('created must be a Unix timestamp in seconds.');
    }

    if (!Number.isInteger(normalized.ttl) || normalized.ttl <= 0) {
      errors.push('ttl must be a positive number of seconds.');
    }

    if (!Number.isInteger(normalized.expiresAt) || normalized.expiresAt <= 0) {
      errors.push('expiresAt must be a Unix timestamp in milliseconds.');
    }

    if (!Number.isInteger(normalized.hops) || normalized.hops < 0) {
      errors.push('hops must be a non-negative integer.');
    }

    if (!Number.isInteger(normalized.maxHops) || normalized.maxHops < 1) {
      errors.push('maxHops must be a positive integer.');
    }

    if (normalized.hops > normalized.maxHops) {
      errors.push('hops cannot be greater than maxHops.');
    }

    if (!normalized.source) {
      errors.push('source is required.');
    }

    if (!normalized.lang) {
      errors.push('lang is required.');
    }

    if (normalized.version !== VERSION) {
      errors.push('version must be 1.');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  } catch (error) {
    return {
      valid: false,
      errors: [`Validation failed: ${error.message}`]
    };
  }
}

/**
 * Returns a copy of an alert with hops incremented, or null at max hops.
 * @param {object} alert - Alert to increment.
 * @returns {object | null} Incremented alert or null.
 */
export function incrementHop(alert) {
  try {
    const hops = Number(alert?.hops ?? 0);
    const maxHops = Number(alert?.maxHops ?? DEFAULT_MAX_HOPS);

    if (!Number.isFinite(hops) || !Number.isFinite(maxHops) || hops >= maxHops) {
      return null;
    }

    return {
      ...alert,
      hops: hops + 1
    };
  } catch (error) {
    throw new Error(`Failed to increment hop: ${error.message}`);
  }
}

/**
 * Returns an expiry freshness bucket for an alert.
 * @param {object} alert - Alert to inspect.
 * @returns {'fresh' | 'recent' | 'aging' | 'expiring' | 'expired'} Expiry status.
 */
export function getExpiryStatus(alert) {
  try {
    const now = Date.now();
    const expiresAt = Number(alert?.expiresAt);

    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      return 'expired';
    }

    const createdMs = Number(alert?.created) * 1000;
    const totalMs = Number.isFinite(createdMs) && createdMs > 0 ? expiresAt - createdMs : Number(alert?.ttl) * 1000;
    const remainingMs = expiresAt - now;

    if (!Number.isFinite(totalMs) || totalMs <= 0) {
      return remainingMs <= 3600000 ? 'expiring' : 'recent';
    }

    const elapsedRatio = 1 - remainingMs / totalMs;

    if (remainingMs <= 3600000 || elapsedRatio >= 0.85) {
      return 'expiring';
    }

    if (elapsedRatio >= 0.55) {
      return 'aging';
    }

    if (elapsedRatio >= 0.2) {
      return 'recent';
    }

    return 'fresh';
  } catch (error) {
    throw new Error(`Failed to get expiry status: ${error.message}`);
  }
}

/**
 * Serializes one alert or many alerts for QR transfer.
 * @param {object | object[]} alertOrAlerts - Alert or alert array.
 * @returns {{data: string, bytes: number, compressed: boolean}} QR payload details.
 */
export function serializeForQR(alertOrAlerts) {
  try {
    const payload = Array.isArray(alertOrAlerts) ? alertOrAlerts : alertOrAlerts;
    const alerts = Array.isArray(payload) ? payload : [payload];
    const invalid = alerts
      .map((alert, index) => ({ index, result: validateAlert(alert) }))
      .filter((item) => !item.result.valid);

    if (invalid.length > 0) {
      const message = invalid
        .map((item) => `alert ${item.index + 1}: ${item.result.errors.join(', ')}`)
        .join(' ');
      throw new Error(message);
    }

    const json = JSON.stringify(payload);
    const rawBytes = encoder.encode(json).byteLength;

    if (rawBytes > 1024) {
      const compressedBytes = deflate(encoder.encode(json));
      const data = `${COMPRESSED_PREFIX}${bytesToBase64Url(compressedBytes)}`;
      return {
        data,
        bytes: encoder.encode(data).byteLength,
        compressed: true
      };
    }

    return {
      data: json,
      bytes: rawBytes,
      compressed: false
    };
  } catch (error) {
    throw new Error(`Failed to serialize QR data: ${error.message}`);
  }
}

/**
 * Deserializes, decompresses when needed, and validates QR alert data.
 * @param {string} str - QR payload string.
 * @returns {object | object[]} Valid alert or alert array.
 */
export function deserializeFromQR(str) {
  try {
    const input = String(str ?? '').trim();

    if (!input) {
      throw new Error('QR data is empty.');
    }

    const json = input.startsWith(COMPRESSED_PREFIX)
      ? decoder.decode(inflate(base64UrlToBytes(input.slice(COMPRESSED_PREFIX.length))))
      : input;
    const parsed = JSON.parse(json);
    const alerts = Array.isArray(parsed) ? parsed : [parsed];
    const invalid = alerts
      .map((alert, index) => ({ index, result: validateAlert(alert) }))
      .filter((item) => !item.result.valid);

    if (invalid.length > 0) {
      const message = invalid
        .map((item) => `alert ${item.index + 1}: ${item.result.errors.join(', ')}`)
        .join(' ');
      throw new Error(message);
    }

    return parsed;
  } catch (error) {
    throw new Error(`Failed to deserialize QR data: ${error.message}`);
  }
}

/**
 * Estimates QR payload size for an alert array.
 * @param {object[]} alerts - Alerts to estimate.
 * @returns {{bytes: number, display: string}} Size estimate.
 */
export function estimateSize(alerts = []) {
  try {
    if (!Array.isArray(alerts)) {
      throw new Error('estimateSize expects an array.');
    }

    const serialized = serializeForQR(alerts);
    const label = alerts.length === 1 ? '1 alert' : `${alerts.length} alerts`;

    return {
      bytes: serialized.bytes,
      display: `${label} · ${formatBytes(serialized.bytes)}`
    };
  } catch (error) {
    throw new Error(`Failed to estimate size: ${error.message}`);
  }
}

/**
 * Formats a Unix timestamp in seconds as relative time.
 * @param {number} unixSec - Unix timestamp in seconds.
 * @returns {string} Relative time text.
 */
export function timeAgo(unixSec) {
  try {
    const timestampMs = Number(unixSec) * 1000;

    if (!Number.isFinite(timestampMs)) {
      return 'just now';
    }

    const diffSeconds = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));

    if (diffSeconds < 60) {
      return `${diffSeconds}s ago`;
    }

    const diffMinutes = Math.floor(diffSeconds / 60);

    if (diffMinutes < 60) {
      return `${diffMinutes}m ago`;
    }

    const diffHours = Math.floor(diffMinutes / 60);

    if (diffHours < 24) {
      return `${diffHours}h ago`;
    }

    return `${Math.floor(diffHours / 24)}d ago`;
  } catch (error) {
    throw new Error(`Failed to format time ago: ${error.message}`);
  }
}

/**
 * Formats the remaining TTL for an alert.
 * @param {object} alert - Alert to inspect.
 * @returns {string} Countdown text.
 */
export function ttlCountdown(alert) {
  try {
    const remainingMs = Number(alert?.expiresAt) - Date.now();

    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      return 'Expired';
    }

    const totalMinutes = Math.floor(remainingMs / 60000);

    if (totalMinutes < 1) {
      return 'Expires in <1m';
    }

    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    if (days > 0) {
      return `Expires in ${days}d ${hours}h`;
    }

    if (hours > 0) {
      return `Expires in ${hours}h ${minutes}m`;
    }

    return `Expires in ${minutes}m`;
  } catch (error) {
    throw new Error(`Failed to format TTL countdown: ${error.message}`);
  }
}

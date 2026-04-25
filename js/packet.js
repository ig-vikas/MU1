import pako from 'pako';
import { PACKET_PREFIX } from './constants.js';
import { decodeBase64, encodeBase64 } from './crypto.js';
import { normalizeIncomingAlert, sanitizeText, serializeAlertForPacket } from './alerts.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeBase64Url(bytes) {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return decodeBase64(padded);
}

function extractPacketBody(packetText) {
  const clean = sanitizeText(packetText, 30000);

  if (clean.startsWith('janvaani://relay?')) {
    const url = new URL(clean);
    return url.searchParams.get('packet') || '';
  }

  if (clean.startsWith(`${PACKET_PREFIX}.`)) {
    return clean.slice(PACKET_PREFIX.length + 1);
  }

  const prefixIndex = clean.indexOf(`${PACKET_PREFIX}.`);

  if (prefixIndex >= 0) {
    return clean.slice(prefixIndex + PACKET_PREFIX.length + 1);
  }

  return clean;
}

/**
 * Creates a compressed JanVaani packet for QR or clipboard relay.
 * @param {object[]} alerts - Alerts to package.
 * @param {{originFingerprint?: string}} options - Packet options.
 * @returns {string} Relay packet text.
 */
export function createAlertPacket(alerts, options = {}) {
  if (!Array.isArray(alerts) || alerts.length === 0) {
    throw new Error('Choose at least one alert to relay.');
  }

  const payload = {
    v: 1,
    app: 'JanVaani',
    createdAt: new Date().toISOString(),
    originFingerprint: options.originFingerprint || '',
    alerts: alerts.map((alert) => serializeAlertForPacket(alert))
  };
  const json = JSON.stringify(payload);
  const compressed = pako.deflate(encoder.encode(json), { level: 9 });

  return `${PACKET_PREFIX}.${encodeBase64Url(compressed)}`;
}

/**
 * Parses and verifies a JanVaani relay packet.
 * @param {string} packetText - Packet text from QR or clipboard.
 * @returns {{payload: object, alerts: object[], warnings: string[]}} Parsed packet.
 */
export function parseAlertPacket(packetText) {
  try {
    const body = extractPacketBody(packetText);

    if (!body) {
      throw new Error('Packet is empty.');
    }

    let payload;

    if (body.startsWith('{')) {
      payload = JSON.parse(body);
    } else {
      const compressed = decodeBase64Url(body);
      const inflated = pako.inflate(compressed);
      payload = JSON.parse(decoder.decode(inflated));
    }

    if (!payload || payload.v !== 1 || !Array.isArray(payload.alerts)) {
      throw new Error('Packet is not a JanVaani v1 relay.');
    }

    const nowIso = new Date().toISOString();
    const alerts = payload.alerts.map((alert) =>
      normalizeIncomingAlert({
        ...alert,
        relayCount: Number(alert.relayCount || 0) + 1,
        importedAt: nowIso
      })
    );
    const warnings = alerts.flatMap((alert) => {
      const alertWarnings = [];

      if (alert.hashMismatch) {
        alertWarnings.push(`${alert.title}: hash was recomputed`);
      }

      if (alert.verification.status === 'invalid') {
        alertWarnings.push(`${alert.title}: signature did not verify`);
      }

      return alertWarnings;
    });

    return {
      payload,
      alerts,
      warnings
    };
  } catch (error) {
    throw new Error(`Unable to parse JanVaani packet: ${error.message}`);
  }
}

/**
 * Estimates the encoded size of a JanVaani packet.
 * @param {object[]} alerts - Alerts to package.
 * @returns {number} Packet size in bytes.
 */
export function estimatePacketSize(alerts) {
  try {
    const packet = createAlertPacket(alerts);
    return encoder.encode(packet).byteLength;
  } catch (error) {
    console.warn('Unable to estimate JanVaani packet size.', error);
    return 0;
  }
}

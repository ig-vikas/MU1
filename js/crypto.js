import nacl from 'tweetnacl';

const KEY_STORAGE = 'janvaani-signing-key-v1';
const encoder = new TextEncoder();

/**
 * Encodes bytes as base64 for compact packet storage.
 * @param {Uint8Array} bytes - Bytes to encode.
 * @returns {string} Base64 string.
 */
export function encodeBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

/**
 * Decodes a base64 string into bytes.
 * @param {string} value - Base64 encoded value.
 * @returns {Uint8Array} Decoded bytes.
 */
export function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

/**
 * Returns a stable short device fingerprint from a public key.
 * @param {string} publicKeyBase64 - Base64 encoded public key.
 * @returns {string} Human-friendly fingerprint.
 */
export function getDeviceFingerprint(publicKeyBase64) {
  const compact = publicKeyBase64.replace(/[^a-zA-Z0-9]/g, '');
  const head = compact.slice(0, 4).toUpperCase();
  const tail = compact.slice(-4).toUpperCase();
  return `${head}-${tail}`;
}

/**
 * Loads or creates the local signing key pair used for alert authenticity.
 * @returns {{publicKey: Uint8Array, secretKey: Uint8Array, publicKeyBase64: string, secretKeyBase64: string, fingerprint: string}} Signing key pair.
 */
export function getOrCreateSigningKeyPair() {
  try {
    const stored = localStorage.getItem(KEY_STORAGE);

    if (stored) {
      const parsed = JSON.parse(stored);
      const publicKey = decodeBase64(parsed.publicKeyBase64);
      const secretKey = decodeBase64(parsed.secretKeyBase64);

      if (publicKey.length === nacl.sign.publicKeyLength && secretKey.length === nacl.sign.secretKeyLength) {
        return {
          publicKey,
          secretKey,
          publicKeyBase64: parsed.publicKeyBase64,
          secretKeyBase64: parsed.secretKeyBase64,
          fingerprint: getDeviceFingerprint(parsed.publicKeyBase64)
        };
      }
    }
  } catch (error) {
    console.warn('Unable to load local JanVaani signing key. Creating a fresh key.', error);
  }

  const keyPair = nacl.sign.keyPair();
  const publicKeyBase64 = encodeBase64(keyPair.publicKey);
  const secretKeyBase64 = encodeBase64(keyPair.secretKey);
  const output = {
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
    publicKeyBase64,
    secretKeyBase64,
    fingerprint: getDeviceFingerprint(publicKeyBase64)
  };

  try {
    localStorage.setItem(
      KEY_STORAGE,
      JSON.stringify({
        publicKeyBase64,
        secretKeyBase64
      })
    );
  } catch (error) {
    console.warn('Unable to persist local JanVaani signing key.', error);
  }

  return output;
}

/**
 * Creates the canonical string that JanVaani signs and verifies.
 * @param {object} alert - Alert-like object.
 * @returns {string} Canonical signing payload.
 */
export function createCanonicalAlertPayload(alert) {
  return JSON.stringify({
    v: 1,
    category: alert.category,
    title: alert.title,
    location: alert.location,
    details: alert.details,
    severity: Number(alert.severity),
    createdAt: alert.createdAt,
    expiresAt: alert.expiresAt,
    sourceType: alert.sourceType,
    sourceName: alert.sourceName
  });
}

/**
 * Signs an alert with the local JanVaani signing key.
 * @param {object} alert - Alert-like object.
 * @param {{secretKey: Uint8Array}} keyPair - Local signing key pair.
 * @returns {string} Base64 detached signature.
 */
export function signAlert(alert, keyPair) {
  const payload = encoder.encode(createCanonicalAlertPayload(alert));
  return encodeBase64(nacl.sign.detached(payload, keyPair.secretKey));
}

/**
 * Verifies an incoming JanVaani alert signature.
 * @param {object} alert - Alert-like object containing signature and publicKey.
 * @returns {{valid: boolean, status: string, label: string}} Verification result.
 */
export function verifyAlertSignature(alert) {
  try {
    if (!alert.signature || !alert.publicKey) {
      return {
        valid: false,
        status: 'unsigned',
        label: 'Checksum only'
      };
    }

    const signature = decodeBase64(alert.signature);
    const publicKey = decodeBase64(alert.publicKey);
    const payload = encoder.encode(createCanonicalAlertPayload(alert));
    const valid = nacl.sign.detached.verify(payload, signature, publicKey);

    return {
      valid,
      status: valid ? 'signed' : 'invalid',
      label: valid ? `Signed ${getDeviceFingerprint(alert.publicKey)}` : 'Signature mismatch'
    };
  } catch (error) {
    console.warn('Unable to verify JanVaani alert signature.', error);
    return {
      valid: false,
      status: 'invalid',
      label: 'Signature unreadable'
    };
  }
}

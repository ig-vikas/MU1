import { deflate, inflate } from 'pako';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ICE_WAIT_MS = 5000;
const CHANNEL_LABEL = 'janvaani-gossip';
const SDP_PREFIX = 'JVSDP1:';
const PEER_CONFIG = Object.freeze({
  iceServers: [],
  iceCandidatePoolSize: 2
});

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64ToBytes(value) {
  const clean = String(value ?? '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean.padEnd(Math.ceil(clean.length / 4) * 4, '=');
  const binary = globalThis.atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function normalizeSDP(sdp) {
  const lines = String(sdp ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  return `${lines.join('\r\n')}\r\n`;
}

function hashString(value) {
  let hash = 0x811c9dc5;
  const text = String(value ?? '');

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
}

function validateSDP(sdp, kind) {
  const normalized = normalizeSDP(sdp);
  const lines = normalized.trimEnd().split('\r\n');
  const invalidLine = lines.find((line) => !/^[a-z]=/i.test(line));

  if (invalidLine) {
    throw new Error(`Invalid SDP line "${invalidLine.slice(0, 48)}".`);
  }

  if (!lines.includes('v=0')) {
    throw new Error('SDP is missing v=0.');
  }

  if (!lines.some((line) => line.startsWith('m=application'))) {
    throw new Error('SDP does not contain a WebRTC data-channel media section.');
  }

  if (!lines.some((line) => line.startsWith('a=mid:'))) {
    throw new Error('SDP is missing a media id.');
  }

  if (!lines.some((line) => line.startsWith('a=sctp-port:') || line.startsWith('a=sctpmap:'))) {
    throw new Error('SDP is missing the data-channel SCTP transport line.');
  }

  if (kind === 'offer' && !lines.some((line) => line === 'a=setup:actpass')) {
    throw new Error('Scanned QR is not a Device A offer.');
  }

  if (kind === 'answer' && !lines.some((line) => line === 'a=setup:active' || line === 'a=setup:passive')) {
    throw new Error('Scanned QR is not a Device B answer.');
  }

  return normalized;
}

function assertGatheredLANCandidates(sdp) {
  const hasCandidate = normalizeSDP(sdp)
    .trimEnd()
    .split('\r\n')
    .some((line) => line.startsWith('a=candidate:'));

  if (!hasCandidate) {
    throw new Error('No LAN ICE candidates were gathered. Keep both phones on the same Wi-Fi/hotspot and regenerate the QR.');
  }
}

function createPeer() {
  if (typeof globalThis.RTCPeerConnection !== 'function') {
    throw new Error('WebRTC is not available in this browser.');
  }

  return new RTCPeerConnection(PEER_CONFIG);
}

function assertPeer(pc) {
  if (!pc || typeof pc.setRemoteDescription !== 'function' || typeof pc.close !== 'function') {
    throw new Error('A valid RTCPeerConnection is required.');
  }
}

function assertChannel(ch) {
  if (!ch || typeof ch.send !== 'function' || typeof ch.addEventListener !== 'function') {
    throw new Error('A valid RTCDataChannel is required.');
  }
}

async function waitForIce(pc, timeoutMs = ICE_WAIT_MS) {
  try {
    if (pc.iceGatheringState === 'complete') {
      return;
    }

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        globalThis.clearTimeout(timeoutId);
        pc.removeEventListener('icegatheringstatechange', handleStateChange);
        pc.removeEventListener('icecandidate', handleCandidate);
        resolve();
      };
      const handleStateChange = () => {
        if (pc.iceGatheringState === 'complete') {
          finish();
        }
      };
      const handleCandidate = (event) => {
        if (!event.candidate) {
          finish();
        }
      };
      const timeoutId = globalThis.setTimeout(finish, timeoutMs);

      pc.addEventListener('icegatheringstatechange', handleStateChange);
      pc.addEventListener('icecandidate', handleCandidate);
    });
  } catch (error) {
    throw new Error(`Failed while waiting for ICE candidates: ${error.message}`);
  }
}

/**
 * Compresses an SDP string into a QR-safe JanVaani connection payload.
 * @param {string} sdp - Session description protocol text.
 * @param {'offer' | 'answer' | 'sdp'} kind - SDP role stored in the payload.
 * @returns {string} Deflated SDP envelope encoded as base64url.
 */
export function compressSDP(sdp, kind = 'sdp') {
  try {
    const cleanKind = ['offer', 'answer', 'sdp'].includes(kind) ? kind : 'sdp';
    const cleanSdp = validateSDP(sdp, cleanKind === 'sdp' ? null : cleanKind);

    if (!cleanSdp) {
      throw new Error('SDP text is required.');
    }

    const envelope = JSON.stringify({
      v: 2,
      kind: cleanKind,
      checksum: hashString(cleanSdp),
      sdpLength: cleanSdp.length,
      created: Date.now(),
      sdp: cleanSdp
    });

    return `${SDP_PREFIX}${bytesToBase64(deflate(encoder.encode(envelope)))}`;
  } catch (error) {
    throw new Error(`Failed to compress SDP: ${error.message}`);
  }
}

/**
 * Decompresses base64 QR SDP back into text.
 * @param {string} b64 - Base64 deflated SDP.
 * @param {'offer' | 'answer' | null} expectedKind - Expected SDP role.
 * @returns {string} Decompressed SDP text.
 */
export function decompressSDP(b64, expectedKind = null) {
  try {
    const input = String(b64 ?? '').trim();

    if (!input) {
      throw new Error('Compressed SDP is required.');
    }

    if (!input.startsWith(SDP_PREFIX)) {
      if (expectedKind) {
        throw new Error('Old connection QR format. Reload both devices, generate a fresh JanVaani QR, and scan the new low-res chunks.');
      }

      const legacySdp = decoder.decode(inflate(base64ToBytes(input)));
      return validateSDP(legacySdp, expectedKind);
    }

    const json = decoder.decode(inflate(base64ToBytes(input.slice(SDP_PREFIX.length))));
    const envelope = JSON.parse(json);

    if (![1, 2].includes(envelope?.v) || typeof envelope.sdp !== 'string') {
      throw new Error('Connection QR payload is malformed.');
    }

    if (expectedKind && envelope.kind !== expectedKind) {
      throw new Error(`Scanned ${envelope.kind || 'connection'} QR, expected ${expectedKind}.`);
    }

    const normalized = validateSDP(envelope.sdp, expectedKind);

    if (envelope.v >= 2) {
      if (envelope.sdpLength !== normalized.length) {
        throw new Error('Connection QR SDP length check failed. Scan the current QR chunks again.');
      }

      if (envelope.checksum !== hashString(normalized)) {
        throw new Error('Connection QR checksum failed. Scan the current QR chunks again.');
      }
    }

    return normalized;
  } catch (error) {
    throw new Error(`Failed to decompress SDP: ${error.message}`);
  }
}

/**
 * Creates a Device A WebRTC offer and data channel.
 * @returns {Promise<{pc: RTCPeerConnection, channel: RTCDataChannel, compressed: string}>} Offer peer, data channel, and QR-ready SDP.
 */
export async function createOffer() {
  try {
    const pc = createPeer();
    const channel = pc.createDataChannel(CHANNEL_LABEL, {
      ordered: true
    });
    const offer = await pc.createOffer();

    await pc.setLocalDescription(offer);
    await waitForIce(pc);

    const sdp = pc.localDescription?.sdp;

    if (!sdp) {
      throw new Error('Local offer SDP was not created.');
    }

    assertGatheredLANCandidates(sdp);

    return {
      pc,
      channel,
      compressed: compressSDP(sdp, 'offer')
    };
  } catch (error) {
    throw new Error(`Failed to create WebRTC offer: ${error.message}`);
  }
}

/**
 * Accepts a Device A offer, creates a Device B answer, and waits for the data channel event.
 * @param {string} compressed - QR-scanned compressed offer SDP.
 * @returns {Promise<{pc: RTCPeerConnection, channel: RTCDataChannel | null, channelPromise: Promise<RTCDataChannel>, compressed: string}>} Answer peer and QR-ready answer SDP.
 */
export async function acceptOffer(compressed) {
  let pc = null;

  try {
    pc = createPeer();
    const offerSdp = decompressSDP(compressed, 'offer');
    let resolvedChannel = null;
    const channelPromise = new Promise((resolve) => {
      pc.addEventListener(
        'datachannel',
        (event) => {
          resolvedChannel = event.channel;
          resolve(event.channel);
        },
        { once: true }
      );
    });

    try {
      await pc.setRemoteDescription({
        type: 'offer',
        sdp: offerSdp
      });
    } catch (error) {
      throw new Error(`Scanned Device A QR is stale or corrupted. Reload both devices, generate a fresh offer, and scan every current low-res chunk. Browser detail: ${error.message}`);
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIce(pc);

    const sdp = pc.localDescription?.sdp;

    if (!sdp) {
      throw new Error('Local answer SDP was not created.');
    }

    assertGatheredLANCandidates(sdp);

    return {
      pc,
      channel: resolvedChannel,
      channelPromise,
      compressed: compressSDP(sdp, 'answer')
    };
  } catch (error) {
    if (pc) {
      pc.close();
    }

    throw new Error(`Failed to accept WebRTC offer: ${error.message}`);
  }
}

/**
 * Completes Device A by applying a Device B answer.
 * @param {RTCPeerConnection} pc - Offerer's peer connection.
 * @param {string} compressed - QR-scanned compressed answer SDP.
 * @returns {Promise<RTCPeerConnection>} Completed peer connection.
 */
export async function completeConnection(pc, compressed) {
  try {
    assertPeer(pc);
    const answerSdp = decompressSDP(compressed, 'answer');

    try {
      await pc.setRemoteDescription({
        type: 'answer',
        sdp: answerSdp
      });
    } catch (error) {
      throw new Error(`Scanned Device B QR is stale or corrupted. Ask Device B to keep the current answer on screen and scan every low-res chunk again. Browser detail: ${error.message}`);
    }

    return pc;
  } catch (error) {
    throw new Error(`Failed to complete WebRTC connection: ${error.message}`);
  }
}

/**
 * Sends a JSON message object over an open data channel.
 * @param {RTCDataChannel} ch - Open data channel.
 * @param {object} obj - JSON-serializable message.
 * @returns {boolean} True when the message was queued for sending.
 */
export function sendMessage(ch, obj) {
  try {
    assertChannel(ch);

    if (ch.readyState !== 'open') {
      throw new Error(`Data channel is ${ch.readyState}.`);
    }

    ch.send(JSON.stringify(obj ?? {}));
    return true;
  } catch (error) {
    throw new Error(`Failed to send P2P message: ${error.message}`);
  }
}

/**
 * Registers a JSON message callback on a data channel.
 * @param {RTCDataChannel} ch - Data channel to observe.
 * @param {(message: object, event: MessageEvent) => void | Promise<void>} cb - Message callback.
 * @returns {() => void} Unsubscribe function.
 */
export function onMessage(ch, cb) {
  try {
    assertChannel(ch);

    if (typeof cb !== 'function') {
      throw new Error('Message callback is required.');
    }

    const handler = (event) => {
      try {
        const raw =
          typeof event.data === 'string'
            ? event.data
            : event.data instanceof ArrayBuffer
              ? decoder.decode(new Uint8Array(event.data))
              : String(event.data ?? '');
        const message = raw ? JSON.parse(raw) : {};

        void cb(message, event);
      } catch (error) {
        void cb(
          {
            kind: 'janvaani:p2p-decode-error',
            error: error.message,
            raw: String(event.data ?? '')
          },
          event
        );
      }
    };

    ch.addEventListener('message', handler);
    return () => {
      ch.removeEventListener('message', handler);
    };
  } catch (error) {
    throw new Error(`Failed to register P2P message handler: ${error.message}`);
  }
}

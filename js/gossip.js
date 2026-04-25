import { getAllAlerts, bulkSave } from './store.js';
import { incrementHop, validateAlert } from './message.js';
import { onMessage, sendMessage } from './p2p.js';

const SYNC_TIMEOUT_MS = 30000;
const NORMAL_ALERT_BUDGET = 50;
const BATCH_SIZE = 10;

function isExpired(alert) {
  return Number.isFinite(Number(alert?.expiresAt)) && Number(alert.expiresAt) <= Date.now();
}

function sortByRelayPriority(alerts) {
  return [...alerts].sort((left, right) => {
    const priorityDiff = Number(right.priority ?? 0) - Number(left.priority ?? 0);

    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    return Number(right.created ?? 0) - Number(left.created ?? 0);
  });
}

function batchAlerts(alerts) {
  const batches = [];

  for (let index = 0; index < alerts.length; index += BATCH_SIZE) {
    batches.push(alerts.slice(index, index + BATCH_SIZE));
  }

  return batches;
}

function selectMissingAlerts(localAlerts, peerIds) {
  const missing = localAlerts.filter((alert) => alert?.id && !peerIds.has(alert.id) && !isExpired(alert));
  const emergencies = sortByRelayPriority(missing.filter((alert) => Number(alert.priority) === 5));
  const regular = sortByRelayPriority(missing.filter((alert) => Number(alert.priority) !== 5)).slice(
    0,
    NORMAL_ALERT_BUDGET
  );

  return [...emergencies, ...regular];
}

function emitProgress(detail) {
  if (typeof globalThis.dispatchEvent !== 'function' || typeof globalThis.CustomEvent !== 'function') {
    return;
  }

  globalThis.dispatchEvent(
    new CustomEvent('janvaani:gossip-progress', {
      detail
    })
  );
}

function normalizeIds(ids) {
  if (!Array.isArray(ids)) {
    return [];
  }

  return ids.map((id) => String(id ?? '').trim()).filter(Boolean);
}

function normalizeAlerts(alerts) {
  if (!Array.isArray(alerts)) {
    return [];
  }

  return alerts.filter((alert) => alert && typeof alert === 'object');
}

async function saveIncomingAlerts(alerts) {
  try {
    const relayedAlerts = [];
    let skipped = 0;

    for (const alert of normalizeAlerts(alerts)) {
      if (isExpired(alert)) {
        skipped += 1;
        continue;
      }

      const relayedAlert = incrementHop(alert);

      if (!relayedAlert) {
        skipped += 1;
        continue;
      }

      const validation = validateAlert(relayedAlert);

      if (!validation.valid) {
        skipped += 1;
        continue;
      }

      relayedAlerts.push(relayedAlert);
    }

    if (!relayedAlerts.length) {
      return {
        saved: 0,
        skipped
      };
    }

    const stats = await bulkSave(relayedAlerts);

    return {
      saved: stats.saved,
      skipped: stats.skipped + skipped
    };
  } catch (error) {
    throw new Error(`Failed to save incoming gossip alerts: ${error.message}`);
  }
}

/**
 * Starts a hash-list gossip sync over an open WebRTC data channel.
 * @param {RTCDataChannel} channel - Open JanVaani data channel.
 * @returns {Promise<{sent: number, received: number}>} Sync result, partial on timeout.
 */
export async function startSync(channel) {
  try {
    if (!channel || typeof channel.addEventListener !== 'function') {
      throw new Error('A valid RTCDataChannel is required.');
    }

    const localAlerts = sortByRelayPriority(await getAllAlerts());
    const localIds = localAlerts.map((alert) => alert.id).filter(Boolean);
    const result = {
      sent: 0,
      received: 0
    };

    emitProgress({
      phase: 'hashes',
      message: `Sending ${localIds.length} local alert hashes...`,
      sent: result.sent,
      received: result.received
    });

    return await new Promise((resolve, reject) => {
      let doneSent = false;
      let peerDone = false;
      let settled = false;
      let messageQueue = Promise.resolve();
      let cleanupMessages = () => {};

      const finish = (reason = 'complete') => {
        if (settled) {
          return;
        }

        const messageByReason = {
          complete: `Sync complete. Sent ${result.sent}, received ${result.received}.`,
          timeout: `Sync timed out. Partial: sent ${result.sent}, received ${result.received}.`,
          closed: `Sync closed early. Partial: sent ${result.sent}, received ${result.received}.`,
          'channel-error': `Sync channel error. Partial: sent ${result.sent}, received ${result.received}.`
        };

        settled = true;
        globalThis.clearTimeout(timeoutId);
        cleanupMessages();
        channel.removeEventListener('close', handleClose);
        channel.removeEventListener('error', handleError);
        emitProgress({
          phase: reason,
          message: messageByReason[reason] ?? messageByReason.complete,
          sent: result.sent,
          received: result.received
        });
        resolve({ ...result });
      };

      const fail = (error) => {
        if (settled) {
          return;
        }

        settled = true;
        globalThis.clearTimeout(timeoutId);
        cleanupMessages();
        channel.removeEventListener('close', handleClose);
        channel.removeEventListener('error', handleError);
        reject(error);
      };

      const maybeFinish = () => {
        if (doneSent && peerDone) {
          finish('complete');
        }
      };

      const sendDone = () => {
        if (doneSent) {
          return;
        }

        sendMessage(channel, {
          type: 'SYNC_DONE',
          sent: result.sent,
          received: result.received
        });
        doneSent = true;
        emitProgress({
          phase: 'done',
          message: `Done sent. Local sent ${result.sent}, received ${result.received}.`,
          sent: result.sent,
          received: result.received
        });
        maybeFinish();
      };

      const sendMissingAlerts = (peerIds) => {
        const selectedAlerts = selectMissingAlerts(localAlerts, peerIds);
        const batches = batchAlerts(selectedAlerts);
        const totalBatches = batches.length;

        emitProgress({
          phase: 'diff',
          message: `${selectedAlerts.length} missing alert${selectedAlerts.length === 1 ? '' : 's'} selected for peer.`,
          sent: result.sent,
          received: result.received
        });

        batches.forEach((alerts, index) => {
          sendMessage(channel, {
            type: 'SYNC_ALERTS',
            alerts,
            batch: index + 1,
            totalBatches
          });
          result.sent += alerts.length;
          emitProgress({
            phase: 'send',
            message: `Sent batch ${index + 1}/${totalBatches} (${result.sent} alerts).`,
            batch: index + 1,
            totalBatches,
            sent: result.sent,
            received: result.received
          });
        });

        sendDone();
      };

      const handleMessage = async (message) => {
        try {
          if (settled || !message || typeof message !== 'object') {
            return;
          }

          if (message.type === 'SYNC_HASHES') {
            const peerIds = new Set(normalizeIds(message.ids));

            emitProgress({
              phase: 'hashes',
              message: `Received ${peerIds.size} peer hashes. Computing diff...`,
              sent: result.sent,
              received: result.received
            });
            sendMissingAlerts(peerIds);
            return;
          }

          if (message.type === 'SYNC_ALERTS') {
            const batch = Number(message.batch) || 1;
            const totalBatches = Number(message.totalBatches) || 1;
            const stats = await saveIncomingAlerts(message.alerts);

            result.received += stats.saved;
            emitProgress({
              phase: 'receive',
              message: `Received batch ${batch}/${totalBatches}. Saved ${stats.saved}, skipped ${stats.skipped}.`,
              batch,
              totalBatches,
              sent: result.sent,
              received: result.received
            });
            return;
          }

          if (message.type === 'SYNC_DONE') {
            peerDone = true;
            emitProgress({
              phase: 'peer-done',
              message: `Peer done. They sent ${Number(message.sent ?? 0)}, received ${Number(message.received ?? 0)}.`,
              sent: result.sent,
              received: result.received
            });
            maybeFinish();
          }
        } catch (error) {
          fail(new Error(`Gossip message handling failed: ${error.message}`));
        }
      };

      const handleClose = () => {
        finish('closed');
      };

      const handleError = () => {
        finish('channel-error');
      };

      const timeoutId = globalThis.setTimeout(() => {
        finish('timeout');
      }, SYNC_TIMEOUT_MS);

      channel.addEventListener('close', handleClose);
      channel.addEventListener('error', handleError);
      cleanupMessages = onMessage(channel, (message) => {
        messageQueue = messageQueue.then(() => handleMessage(message));
        messageQueue.catch((error) => {
          fail(error);
        });
      });

      try {
        sendMessage(channel, {
          type: 'SYNC_HASHES',
          ids: localIds
        });
      } catch (error) {
        fail(new Error(`Failed to send local hashes: ${error.message}`));
      }
    });
  } catch (error) {
    throw new Error(`Failed to start gossip sync: ${error.message}`);
  }
}

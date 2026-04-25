import {
  MAX_BLE_NAME_LENGTH,
  PRESET_ALERTS,
  encodeAlertToBleName,
  isValidJVAlertName
} from './alertEncoding.js';
import {
  checkCompanionStatus,
  getActiveCompanionEndpoint,
  startBleAdvertising,
  stopBleAdvertising
} from './companionService.js';
import {
  isBrowserBleScanSupported,
  onAlertDetected,
  startBrowserScanning,
  startCompanionFallbackScanning,
  stopBrowserScanning,
  stopCompanionFallbackScanning
} from './bleScannerService.js';
import {
  clearExpiredAlerts,
  getAllAlerts,
  getEmergencySettings,
  markExpiredAlerts,
  recordRebroadcast,
  saveEmergencySettings,
  saveOrUpdateAlertName,
  shouldRebroadcast
} from './emergencyAlertStore.js';

let emergencyDraftText = '';
let emergencyStatus = 'Ready. Connect the Android companion for BLE advertising.';
let emergencyStatusType = 'info';
let browserScanStatus = 'Not started.';
let companionScanStatus = 'Not started.';
let companionStatus = null;
let companionStatusError = null;
let currentBroadcast = null;
let detectionUnsubscribe = null;

/**
 * Renders the BLE-name emergency alert screen.
 * @returns {Promise<string>} HTML.
 */
export async function renderEmergencyAlerts() {
  ensureDetectionHandler();
  await markExpiredAlerts();
  await refreshCompanionStatus(false);
  const settings = getEmergencySettings();
  const alerts = await getAllAlerts();
  const preview = encodeAlertToBleName(emergencyDraftText);

  return `
    ${renderEmergencyPageHeader()}
    <main class="emergency-page" aria-label="Emergency Alerts">
      <section class="emergency-panel companion-panel">
        <div class="section-heading">
          <h1>Emergency Alerts</h1>
          <button class="btn-secondary compact-btn" type="button" data-emergency-refresh-companion>Refresh</button>
        </div>
        <p class="emergency-muted">Nearby offline emergency alert propagation using short BLE local names.</p>
        ${renderCompanionStatus()}
      </section>

      <form class="emergency-panel" id="emergencyBroadcastForm" autocomplete="off" novalidate>
        <div class="section-heading">
          <h2>Create Alert</h2>
          <span class="emergency-counter" id="emergencyNameCounter">${preview.length}/${MAX_BLE_NAME_LENGTH}</span>
        </div>
        <label class="form-label" for="emergencyAlertInput">Short emergency message</label>
        <input
          class="form-input"
          id="emergencyAlertInput"
          name="message"
          type="text"
          inputmode="text"
          maxlength="80"
          value="${escapeHtml(emergencyDraftText)}"
          placeholder="fire near gate"
        />
        <div class="ble-preview ${preview.valid ? 'valid' : 'invalid'}" id="emergencyBlePreview">
          <span>BLE name</span>
          <strong>${escapeHtml(preview.name || 'JV_')}</strong>
        </div>
        <div class="validation-line ${preview.valid ? 'valid' : 'invalid'}" id="emergencyValidation">
          ${escapeHtml(preview.valid ? 'Valid short JV_ alert name.' : preview.error)}
        </div>

        <div class="preset-grid" aria-label="Preset emergency alerts">
          ${PRESET_ALERTS.map((preset) => `
            <button class="preset-btn" type="button" data-emergency-preset="${escapeHtml(preset.name)}">
              ${escapeHtml(preset.label)}
            </button>
          `).join('')}
        </div>

        ${renderTtlSelector(settings)}

        <div class="control-row">
          <button class="btn-primary" type="submit">Start Broadcast</button>
          <button class="btn-secondary" type="button" data-emergency-stop-broadcast>Stop Broadcast</button>
        </div>
        ${renderBroadcastStatus()}
      </form>

      <section class="emergency-panel">
        <div class="section-heading">
          <h2>Scanner Controls</h2>
          <span class="support-pill ${isBrowserBleScanSupported() ? 'valid' : 'invalid'}">
            Browser BLE ${isBrowserBleScanSupported() ? 'available' : 'unsupported'}
          </span>
        </div>
        <div class="scanner-grid">
          <div>
            <h3>Browser scan</h3>
            <p class="emergency-muted">Uses Web Bluetooth advertisement scanning only when the browser supports it.</p>
            <div class="control-row">
              <button class="btn-primary" type="button" data-emergency-start-browser-scan>Start Scan</button>
              <button class="btn-secondary" type="button" data-emergency-stop-browser-scan>Stop Scan</button>
            </div>
            <div class="scan-status" id="browserBleScanStatus">${escapeHtml(browserScanStatus)}</div>
          </div>
          <div>
            <h3>Companion scan fallback</h3>
            <p class="emergency-muted">Uses the Android bridge to scan BLE names and lets the PWA poll localhost.</p>
            <div class="control-row">
              <button class="btn-primary" type="button" data-emergency-start-companion-scan>Start Fallback</button>
              <button class="btn-secondary" type="button" data-emergency-stop-companion-scan>Stop Fallback</button>
            </div>
            <div class="scan-status" id="companionBleScanStatus">${escapeHtml(companionScanStatus)}</div>
          </div>
        </div>
      </section>

      <section class="emergency-panel">
        <div class="section-heading">
          <h2>Rebroadcast</h2>
          <span class="support-pill">Cooldown 60s</span>
        </div>
        <label class="toggle-row">
          <input
            type="checkbox"
            id="rebroadcastEnabled"
            data-emergency-setting
            ${settings.rebroadcastEnabled ? 'checked' : ''}
          />
          <span>Rebroadcast valid scanned alerts through this phone companion</span>
        </label>
        ${renderRebroadcastSelector(settings)}
        <div class="scan-status" id="rebroadcastStatus">
          Same alert rebroadcast is rate limited to once per 60 seconds and stops after its rebroadcast duration.
        </div>
      </section>

      <section class="emergency-panel">
        <div class="section-heading">
          <h2>Alert History</h2>
          <button class="btn-secondary compact-btn" type="button" data-emergency-clear-expired>Clear Expired</button>
        </div>
        <div class="alert-history" id="emergencyAlertHistory">
          ${renderAlertHistory(alerts)}
        </div>
      </section>
    </main>
  `;
}

/**
 * Handles clicks from the emergency screen.
 * @param {Element} target - Click target.
 * @returns {Promise<boolean>} True if handled.
 */
export async function handleEmergencyClick(target) {
  const presetButton = target.closest('[data-emergency-preset]');

  if (presetButton) {
    emergencyDraftText = presetButton.dataset.emergencyPreset || '';
    const input = document.querySelector('#emergencyAlertInput');

    if (input instanceof HTMLInputElement) {
      input.value = emergencyDraftText;
    }

    updatePreview();
    return true;
  }

  if (target.closest('[data-emergency-refresh-companion]')) {
    await refreshCompanionStatus(true);
    updateCompanionStatusPanel();
    return true;
  }

  if (target.closest('[data-emergency-stop-broadcast]')) {
    await stopEmergencyBroadcast();
    return true;
  }

  if (target.closest('[data-emergency-start-browser-scan]')) {
    await startEmergencyBrowserScan();
    return true;
  }

  if (target.closest('[data-emergency-stop-browser-scan]')) {
    await stopBrowserScanning();
    browserScanStatus = 'Browser scan stopped.';
    updateText('#browserBleScanStatus', browserScanStatus);
    return true;
  }

  if (target.closest('[data-emergency-start-companion-scan]')) {
    await startEmergencyCompanionScan();
    return true;
  }

  if (target.closest('[data-emergency-stop-companion-scan]')) {
    await stopEmergencyCompanionScan();
    return true;
  }

  if (target.closest('[data-emergency-clear-expired]')) {
    const deleted = await clearExpiredAlerts();
    emergencyStatus = `Cleared ${deleted} expired alert${deleted === 1 ? '' : 's'}.`;
    emergencyStatusType = 'success';
    await refreshHistory();
    updateBroadcastStatus();
    return true;
  }

  return false;
}

/**
 * Handles emergency input events.
 * @param {Event} event - Input event.
 * @returns {boolean} True if handled.
 */
export function handleEmergencyInput(event) {
  const target = event.target;

  if (!(target instanceof HTMLInputElement)) {
    return false;
  }

  if (target.id === 'emergencyAlertInput') {
    emergencyDraftText = target.value;
    updatePreview();
    return true;
  }

  if (target.id === 'customTtlMinutes' || target.id === 'customRebroadcastMinutes') {
    saveSettingsFromDom();
    return true;
  }

  return false;
}

/**
 * Handles emergency change events.
 * @param {Event} event - Change event.
 * @returns {boolean} True if handled.
 */
export function handleEmergencyChange(event) {
  const target = event.target;

  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
    return false;
  }

  if (target.matches('[data-emergency-setting]')) {
    saveSettingsFromDom();
    toggleCustomInputs();
    return true;
  }

  return false;
}

/**
 * Handles the emergency broadcast form.
 * @param {HTMLFormElement} form - Form.
 * @returns {Promise<boolean>} True if handled.
 */
export async function handleEmergencySubmit(form) {
  if (form.id !== 'emergencyBroadcastForm') {
    return false;
  }

  const settings = saveSettingsFromDom();
  const input = form.elements.namedItem('message');
  const draft = input instanceof HTMLInputElement ? input.value : emergencyDraftText;
  const encoded = encodeAlertToBleName(draft);

  if (!encoded.valid) {
    throw new Error(encoded.error || 'Invalid JV_ alert name.');
  }

  const response = await startBleAdvertising(encoded.name, settings.ttlMinutes);

  if (!response?.ok) {
    throw new Error(response?.error || 'Android companion did not start advertising.');
  }

  currentBroadcast = {
    name: encoded.name,
    expiresAt: Number(response.expiresAt || Date.now() + settings.ttlMinutes * 60000)
  };
  await saveOrUpdateAlertName(encoded.name, {
    source: 'manual',
    ttlMinutes: settings.ttlMinutes,
    rebroadcastMinutes: settings.rebroadcastMinutes,
    expiresAt: currentBroadcast.expiresAt
  });

  emergencyStatus = `Advertising ${encoded.name}.`;
  emergencyStatusType = 'success';
  await refreshCompanionStatus(false);
  updateBroadcastStatus();
  updateCompanionStatusPanel();
  await refreshHistory();
  return true;
}

async function startEmergencyBrowserScan() {
  ensureDetectionHandler();
  await startBrowserScanning();
  browserScanStatus = 'Browser scan active. Only valid JV_ names are saved.';
  updateText('#browserBleScanStatus', browserScanStatus);
}

async function startEmergencyCompanionScan() {
  ensureDetectionHandler();
  const response = await startCompanionFallbackScanning();

  if (!response?.ok) {
    throw new Error(response?.error || 'Companion scanner did not start.');
  }

  companionScanStatus = 'Companion fallback scan active. Polling localhost every few seconds.';
  updateText('#companionBleScanStatus', companionScanStatus);
  await refreshCompanionStatus(false);
  updateCompanionStatusPanel();
}

async function stopEmergencyCompanionScan() {
  const response = await stopCompanionFallbackScanning();

  if (!response?.ok) {
    throw new Error(response?.error || 'Companion scanner did not stop.');
  }

  companionScanStatus = 'Companion fallback scan stopped.';
  updateText('#companionBleScanStatus', companionScanStatus);
  await refreshCompanionStatus(false);
  updateCompanionStatusPanel();
}

async function stopEmergencyBroadcast() {
  const response = await stopBleAdvertising();

  if (!response?.ok) {
    throw new Error(response?.error || 'Android companion did not stop advertising.');
  }

  currentBroadcast = null;
  emergencyStatus = response.restoredOriginalName === false
    ? 'Broadcast stopped, but Android could not confirm original Bluetooth name restore.'
    : 'Broadcast stopped and original Bluetooth name restore was requested.';
  emergencyStatusType = response.restoredOriginalName === false ? 'error' : 'success';
  await refreshCompanionStatus(false);
  updateBroadcastStatus();
  updateCompanionStatusPanel();
}

function ensureDetectionHandler() {
  if (detectionUnsubscribe) {
    return;
  }

  detectionUnsubscribe = onAlertDetected((detected) => {
    void handleDetectedAlert(detected);
  });
}

async function handleDetectedAlert(detected) {
  const name = String(detected?.name || '').trim().toUpperCase();

  if (!isValidJVAlertName(name)) {
    return;
  }

  const settings = getEmergencySettings();
  const alert = await saveOrUpdateAlertName(name, {
    source: 'scanned',
    seenAt: Number(detected.seenAt || Date.now()),
    ttlMinutes: settings.ttlMinutes,
    rebroadcastMinutes: settings.rebroadcastMinutes,
    rssi: detected.rssi
  });

  emergencyStatus = `Detected ${name} from ${detected.source || 'scan'}.`;
  emergencyStatusType = 'success';

  if (settings.rebroadcastEnabled && shouldRebroadcast(alert, settings)) {
    try {
      const response = await startBleAdvertising(name, settings.rebroadcastMinutes);

      if (response?.ok) {
        await recordRebroadcast(name);
        currentBroadcast = {
          name,
          expiresAt: Number(response.expiresAt || Date.now() + settings.rebroadcastMinutes * 60000)
        };
        emergencyStatus = `Detected and rebroadcasting ${name}.`;
      } else {
        emergencyStatus = `Detected ${name}, but rebroadcast failed: ${response?.error || 'unknown error'}.`;
        emergencyStatusType = 'error';
      }
    } catch (error) {
      emergencyStatus = `Detected ${name}, but rebroadcast failed: ${error.message}`;
      emergencyStatusType = 'error';
    }
  }

  await refreshCompanionStatus(false);
  updateBroadcastStatus();
  updateCompanionStatusPanel();
  await refreshHistory();
}

async function refreshCompanionStatus(force) {
  try {
    companionStatus = await checkCompanionStatus();
    companionStatusError = null;

    if (force) {
      emergencyStatus = 'Companion status refreshed.';
      emergencyStatusType = 'success';
    }
  } catch (error) {
    companionStatus = null;
    companionStatusError = error.message;

    if (force) {
      emergencyStatus = error.message;
      emergencyStatusType = 'error';
    }
  }
}

async function refreshHistory() {
  const container = document.querySelector('#emergencyAlertHistory');

  if (!container) {
    return;
  }

  await markExpiredAlerts();
  container.innerHTML = renderAlertHistory(await getAllAlerts());
}

function renderEmergencyPageHeader() {
  return `
    <header class="header">
      <div class="header-title">Emergency</div>
      <span class="offline-badge">Offline PWA</span>
      <div class="header-actions">
        <button class="header-icon-btn" type="button" data-route="#alerts" aria-label="Show alerts" title="Show alerts">!</button>
        <button class="header-icon-btn" type="button" data-route="#settings" aria-label="Settings" title="Settings">S</button>
        <button class="header-icon-btn" type="button" data-route="#home" aria-label="Back home" title="Back home">H</button>
      </div>
    </header>
  `;
}

function renderCompanionStatus() {
  if (!companionStatus) {
    return `
      <div class="companion-status error" id="companionStatusPanel">
        <strong>Not running</strong>
        <span>${escapeHtml(companionStatusError || 'Android companion not installed, not open, or blocked by browser/CORS.')}</span>
      </div>
    `;
  }

  return `
    <div class="companion-status ${companionStatus.error ? 'error' : 'valid'}" id="companionStatusPanel">
      ${renderStatusItem('Connected', companionStatus.running)}
      ${renderStatusItem('BLE supported', companionStatus.bleSupported)}
      ${renderStatusItem('Advertising supported', companionStatus.advertiseSupported)}
      ${renderStatusItem('Scanning supported', companionStatus.scanSupported)}
      ${renderStatusItem('Permissions granted', companionStatus.permissionsGranted)}
      ${renderStatusItem('Bluetooth enabled', companionStatus.bluetoothEnabled)}
      ${renderStatusItem('Name change supported', companionStatus.nameChangeSupported)}
      ${renderStatusItem('Advertising active', companionStatus.advertising)}
      ${renderStatusItem('Scanning active', companionStatus.currentlyScanning)}
      <div><span>Endpoint</span><strong>${escapeHtml(getActiveCompanionEndpoint() || 'localhost')}</strong></div>
      <div><span>Current BLE name</span><strong>${escapeHtml(companionStatus.currentName || 'none')}</strong></div>
      <div><span>Original Bluetooth name</span><strong>${escapeHtml(companionStatus.originalName || 'unknown')}</strong></div>
      <div><span>Expiry</span><strong>${escapeHtml(formatTime(companionStatus.expiresAt))}</strong></div>
      ${companionStatus.error ? `<div class="status-wide"><span>Error</span><strong>${escapeHtml(companionStatus.error)}</strong></div>` : ''}
    </div>
  `;
}

function renderStatusItem(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${value ? 'yes' : 'no'}</strong></div>`;
}

function renderTtlSelector(settings) {
  const value = isStandardTtl(settings.ttlMinutes) ? String(settings.ttlMinutes) : 'custom';

  return `
    <div class="settings-grid">
      <label>
        <span>Broadcast TTL</span>
        <select class="form-input" id="emergencyTtlSelect" data-emergency-setting>
          ${renderOption('15', '15 minutes', value)}
          ${renderOption('30', '30 minutes', value)}
          ${renderOption('60', '1 hour', value)}
          ${renderOption('120', '2 hours', value)}
          ${renderOption('custom', 'Custom minutes', value)}
        </select>
      </label>
      <label>
        <span>Custom TTL</span>
        <input class="form-input" id="customTtlMinutes" data-emergency-setting type="number" min="1" max="120" value="${settings.customTtlMinutes}" ${value === 'custom' ? '' : 'disabled'} />
      </label>
    </div>
  `;
}

function renderRebroadcastSelector(settings) {
  const value = isStandardTtl(settings.rebroadcastMinutes) ? String(settings.rebroadcastMinutes) : 'custom';

  return `
    <div class="settings-grid">
      <label>
        <span>Rebroadcast duration</span>
        <select class="form-input" id="rebroadcastMinutesSelect" data-emergency-setting>
          ${renderOption('15', '15 minutes', value)}
          ${renderOption('30', '30 minutes', value)}
          ${renderOption('60', '1 hour', value)}
          ${renderOption('120', '2 hours', value)}
          ${renderOption('custom', 'Custom minutes', value)}
        </select>
      </label>
      <label>
        <span>Custom duration</span>
        <input class="form-input" id="customRebroadcastMinutes" data-emergency-setting type="number" min="1" max="120" value="${settings.customRebroadcastMinutes}" ${value === 'custom' ? '' : 'disabled'} />
      </label>
    </div>
  `;
}

function renderOption(value, label, selectedValue) {
  return `<option value="${value}" ${value === selectedValue ? 'selected' : ''}>${label}</option>`;
}

function renderBroadcastStatus() {
  return `
    <div class="broadcast-status ${emergencyStatusType}" id="emergencyBroadcastStatus">
      <div><span>Status</span><strong>${escapeHtml(emergencyStatus)}</strong></div>
      <div><span>BLE name</span><strong>${escapeHtml(currentBroadcast?.name || companionStatus?.currentName || 'none')}</strong></div>
      <div><span>Expiry</span><strong>${escapeHtml(formatTime(currentBroadcast?.expiresAt || companionStatus?.expiresAt))}</strong></div>
    </div>
  `;
}

function renderAlertHistory(alerts) {
  if (!alerts.length) {
    return '<div class="empty-history">No BLE emergency alerts saved yet.</div>';
  }

  return alerts.map((alert) => `
    <article class="emergency-alert-row ${alert.active ? 'active' : 'expired'}">
      <div class="alert-row-main">
        <strong>${escapeHtml(alert.displayText)}</strong>
        <span>${escapeHtml(alert.name)}</span>
      </div>
      <div class="alert-row-meta">
        <span>source: ${escapeHtml(alert.source)}</span>
        <span>first: ${escapeHtml(formatTime(alert.firstSeenAt))}</span>
        <span>last: ${escapeHtml(formatTime(alert.lastSeenAt))}</span>
        <span>seen: ${Number(alert.seenCount || 0)}</span>
        <span>rebroadcasts: ${Number(alert.rebroadcastCount || 0)}</span>
        <span>${alert.active ? 'active' : 'expired'}</span>
      </div>
    </article>
  `).join('');
}

function updatePreview() {
  const preview = encodeAlertToBleName(emergencyDraftText);
  const previewElement = document.querySelector('#emergencyBlePreview');
  const validationElement = document.querySelector('#emergencyValidation');
  const counterElement = document.querySelector('#emergencyNameCounter');

  if (previewElement) {
    previewElement.classList.toggle('valid', preview.valid);
    previewElement.classList.toggle('invalid', !preview.valid);
    previewElement.innerHTML = `<span>BLE name</span><strong>${escapeHtml(preview.name || 'JV_')}</strong>`;
  }

  if (validationElement) {
    validationElement.classList.toggle('valid', preview.valid);
    validationElement.classList.toggle('invalid', !preview.valid);
    validationElement.textContent = preview.valid ? 'Valid short JV_ alert name.' : preview.error;
  }

  if (counterElement) {
    counterElement.textContent = `${preview.length}/${MAX_BLE_NAME_LENGTH}`;
  }
}

function updateBroadcastStatus() {
  const status = document.querySelector('#emergencyBroadcastStatus');

  if (status) {
    status.outerHTML = renderBroadcastStatus();
  }
}

function updateCompanionStatusPanel() {
  const panel = document.querySelector('#companionStatusPanel');

  if (panel) {
    panel.outerHTML = renderCompanionStatus();
  }
}

function updateText(selector, text) {
  const element = document.querySelector(selector);

  if (element) {
    element.textContent = text;
  }
}

function saveSettingsFromDom() {
  const ttlSelect = document.querySelector('#emergencyTtlSelect');
  const customTtl = document.querySelector('#customTtlMinutes');
  const rebroadcastSelect = document.querySelector('#rebroadcastMinutesSelect');
  const customRebroadcast = document.querySelector('#customRebroadcastMinutes');
  const rebroadcastEnabled = document.querySelector('#rebroadcastEnabled');
  const ttlValue = ttlSelect instanceof HTMLSelectElement ? ttlSelect.value : '60';
  const rebroadcastValue = rebroadcastSelect instanceof HTMLSelectElement ? rebroadcastSelect.value : '60';

  return saveEmergencySettings({
    ttlMinutes: ttlValue === 'custom' ? Number(customTtl?.value || 60) : Number(ttlValue),
    customTtlMinutes: Number(customTtl?.value || 60),
    rebroadcastEnabled: rebroadcastEnabled instanceof HTMLInputElement ? rebroadcastEnabled.checked : false,
    rebroadcastMinutes: rebroadcastValue === 'custom' ? Number(customRebroadcast?.value || 60) : Number(rebroadcastValue),
    customRebroadcastMinutes: Number(customRebroadcast?.value || 60)
  });
}

function toggleCustomInputs() {
  const ttlSelect = document.querySelector('#emergencyTtlSelect');
  const customTtl = document.querySelector('#customTtlMinutes');
  const rebroadcastSelect = document.querySelector('#rebroadcastMinutesSelect');
  const customRebroadcast = document.querySelector('#customRebroadcastMinutes');

  if (customTtl instanceof HTMLInputElement && ttlSelect instanceof HTMLSelectElement) {
    customTtl.disabled = ttlSelect.value !== 'custom';
  }

  if (customRebroadcast instanceof HTMLInputElement && rebroadcastSelect instanceof HTMLSelectElement) {
    customRebroadcast.disabled = rebroadcastSelect.value !== 'custom';
  }
}

function isStandardTtl(value) {
  return ['15', '30', '60', '120'].includes(String(value));
}

function formatTime(value) {
  const timestamp = Number(value);

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return 'none';
  }

  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(timestamp));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const COMPANION_ENDPOINTS = Object.freeze(['http://127.0.0.1:8765', 'http://localhost:8765']);
const DEFAULT_TIMEOUT_MS = 3500;

let activeEndpoint = null;

/**
 * Checks whether the Android BLE bridge is reachable.
 * @returns {Promise<object>} Companion status.
 */
export async function checkCompanionStatus() {
  return companionRequest('/status', { method: 'GET', timeoutMs: 2500 });
}

/**
 * Starts BLE local-name advertising through the Android companion.
 * @param {string} name - Strict JV_ alert name.
 * @param {number} ttlMinutes - Advertising TTL in minutes.
 * @returns {Promise<object>} Companion response.
 */
export async function startBleAdvertising(name, ttlMinutes) {
  return companionRequest('/advertise', {
    method: 'POST',
    body: {
      name,
      ttlMinutes: Number(ttlMinutes)
    }
  });
}

/**
 * Stops BLE advertising through the Android companion.
 * @returns {Promise<object>} Companion response.
 */
export async function stopBleAdvertising() {
  return companionRequest('/stop', { method: 'POST' });
}

/**
 * Starts native Android BLE scanning fallback.
 * @returns {Promise<object>} Companion response.
 */
export async function startCompanionScan() {
  return companionRequest('/scan/start', { method: 'POST' });
}

/**
 * Stops native Android BLE scanning fallback.
 * @returns {Promise<object>} Companion response.
 */
export async function stopCompanionScan() {
  return companionRequest('/scan/stop', { method: 'POST' });
}

/**
 * Reads Android companion scanner state.
 * @returns {Promise<object>} Scanner status.
 */
export async function getCompanionScanStatus() {
  return companionRequest('/scan/status', { method: 'GET', timeoutMs: 2500 });
}

/**
 * Reads JV_ alerts detected by the Android companion scanner.
 * @returns {Promise<object>} Detected alerts response.
 */
export async function getCompanionDetectedAlerts() {
  return companionRequest('/alerts', { method: 'GET', timeoutMs: 2500 });
}

/**
 * Returns true when the companion can be reached.
 * @returns {Promise<boolean>} Availability result.
 */
export async function isCompanionAvailable() {
  try {
    const status = await checkCompanionStatus();
    return Boolean(status?.running);
  } catch (error) {
    return false;
  }
}

/**
 * Returns the endpoint that worked most recently.
 * @returns {string | null} Endpoint.
 */
export function getActiveCompanionEndpoint() {
  return activeEndpoint;
}

async function companionRequest(path, options = {}) {
  const endpoints = activeEndpoint
    ? [activeEndpoint, ...COMPANION_ENDPOINTS.filter((endpoint) => endpoint !== activeEndpoint)]
    : COMPANION_ENDPOINTS;
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const response = await fetchJson(`${endpoint}${path}`, options);
      activeEndpoint = endpoint;
      return response;
    } catch (error) {
      lastError = error;
    }
  }

  activeEndpoint = null;
  throw normalizeCompanionError(lastError);
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      mode: 'cors',
      cache: 'no-store',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });

    const text = await response.text();
    const json = text ? JSON.parse(text) : {};

    if (!response.ok || json?.ok === false) {
      throw new Error(json?.error || `Companion returned HTTP ${response.status}.`);
    }

    return json;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('REQUEST_TIMEOUT');
    }

    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function normalizeCompanionError(error) {
  const message = String(error?.message || error || 'COMPANION_NOT_RUNNING');

  if (message === 'REQUEST_TIMEOUT') {
    return new Error('Request timeout. The Android companion did not answer on localhost.');
  }

  if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
    return new Error('Companion not installed, not running, blocked by CORS, or blocked by the browser.');
  }

  return new Error(message);
}

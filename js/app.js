import {
  createAlert,
  deserializeFromQR,
  estimateSize,
  getExpiryStatus,
  incrementHop,
  serializeForQR,
  timeAgo,
  ttlCountdown,
  validateAlert
} from './message.js';
import { bulkSave, clearAllData, getAllAlerts, getAllChatMessages, saveAlert, saveChatMessage } from './store.js';
import { generateChunks, renderQR, startScanner, stopScanner } from './qr.js';
import {
  acceptOffer,
  completeConnection,
  createOffer as createP2POffer,
  onMessage,
  sendMessage
} from './p2p.js';
import { startSync } from './gossip.js';
import { getLang, setLang, t } from './i18n.js';
import { clearDevelopmentServiceWorkers, registerJanVaaniServiceWorker } from './pwa.js';

const ROUTES = new Set(['#home', '#alerts', '#scan', '#share', '#create', '#news', '#connect', '#settings']);
const APP_ORIGIN = window.location.origin || 'http://127.0.0.1:5173';
const CONNECT_TIMEOUT_MS = 60000;
const SHARE_QR_MAX_SIZE = 620;
const CONNECT_QR_MAX_SIZE = 260;
const CONNECT_QR_FRAME_MS = 900;
const LIVE_ALERT_MESSAGE_TYPE = 'LIVE_ALERT';
const COMMUNITY_CHAT_MESSAGE_TYPE = 'COMMUNITY_CHAT';
const COMMUNITY_HEARTBEAT_MESSAGE_TYPE = 'COMMUNITY_HEARTBEAT';
const COMMUNITY_CHAT_MAX_LENGTH = 180;
const COMMUNITY_CHAT_MAX_MESSAGES = 80;
const COMMUNITY_CHAT_TTL_SECONDS = 1800;
const COMMUNITY_HEARTBEAT_MS = 10000;
const LOCAL_NEWS_SOURCE = 'local-news';
const DEMO_MODE_KEY = 'janvaani-demo-mode';
const DEMO_DEVICE_KEY = 'janvaani-demo-device';
const SHAKE_HANDLER_KEY = '__janvaaniShakeHandler';
const CATEGORIES = Object.freeze([
  { type: 'emergency', icon: '🚨', labelKey: 'category.emergency' },
  { type: 'medical', icon: '🏥', labelKey: 'category.medical' },
  { type: 'route', icon: '🛣️', labelKey: 'category.route' },
  { type: 'food', icon: '🍚', labelKey: 'category.food' },
  { type: 'missing', icon: '👤', labelKey: 'category.missing' },
  { type: 'notice', icon: '📋', labelKey: 'category.notice' }
]);
const FILTERS = Object.freeze([
  { type: 'all', labelKey: 'filter.all' },
  { type: 'emergency', labelKey: 'filter.emergency' },
  { type: 'medical', labelKey: 'filter.medical' },
  { type: 'route', labelKey: 'filter.route' },
  { type: 'food', labelKey: 'filter.food' },
  { type: 'missing', labelKey: 'filter.missing' },
  { type: 'notice', labelKey: 'filter.notice' }
]);

let appEventsBound = false;
let activeAlertFilter = 'all';
let alertRefreshIntervalId = undefined;
let shareQrIntervalId = undefined;
let shareQrFrameIndex = 0;
let newsQrIntervalId = undefined;
let newsQrFrameIndex = 0;
let connectQrIntervalId = undefined;
let connectQrFrameIndex = 0;
let shareSelectionInitialized = false;
let shareSelectionTouched = false;
let scannerActive = false;
let scanChunkTotal = 0;
let connectRole = null;
let connectPc = null;
let connectChannel = null;
let connectChannelCleanup = null;
let meshPeerCounter = 0;
const meshPeers = new Map();
const syncingChannels = new WeakSet();
const communityChatMessages = [];
const communityChatSeenIds = new Set();
let connectTimeoutId = undefined;
let connectScannerActive = false;
let connectScanMode = null;
let connectScanBusy = false;
let connectChunkSession = null;
let connectChunkTotal = 0;
let connectChunkLength = 0;
let connectGossipStarted = false;
let connectPreparingNextOffer = false;
let connectStatusText = t('connect.chooseRole');
let connectStatusType = 'info';
let connectSyncText = t('connect.syncIdle');
let connectLastSyncPhase = 'idle';
let demoModeActive = false;
let demoDevice = 'a';
let deferredInstallPrompt = null;
try {
  const storedDemoMode = localStorage.getItem(DEMO_MODE_KEY);
  demoModeActive = storedDemoMode === null ? false : storedDemoMode === 'true';
  demoDevice = localStorage.getItem(DEMO_DEVICE_KEY) || 'a';
} catch (error) {
  demoModeActive = false;
  demoDevice = 'a';
}
let shakePermissionRequested = false;
let shakeConfirmOpen = false;
const shakeHits = [];
const expandedAlertIds = new Set();
const shareSelectedIds = new Set();
const scanChunks = new Map();
const connectScanChunks = new Map();

/**
 * Navigates JanVaani to a hash route and renders the matching screen.
 * @param {string} hash - Target route hash.
 * @returns {void}
 */
export function navigate(hash) {
  const targetHash = ROUTES.has(hash) ? hash : '#home';

  if (window.location.hash === targetHash) {
    void render();
    return;
  }

  window.location.hash = targetHash;
}

/**
 * Renders the current JanVaani SPA route into the root app container.
 * @returns {Promise<void>} Resolves after the current route is rendered.
 */
export async function render() {
  try {
    const app = getAppRoot();
    bindAppEvents(app);
    applyDemoMode();
    const currentHash = ROUTES.has(window.location.hash) ? window.location.hash : '#home';

    if (window.location.hash !== currentHash) {
      window.location.hash = currentHash;
      return;
    }

    if (currentHash !== '#alerts') {
      stopAlertAutoRefresh();
    }

    if (currentHash !== '#share') {
      stopShareQrAnimation();
    }

    if (currentHash !== '#news') {
      stopNewsQrAnimation();
    }

    if (currentHash !== '#connect') {
      stopConnectQrAnimation();
    }

    if (currentHash !== '#scan') {
      await stopActiveScanner();
    }

    if (currentHash !== '#connect') {
      await stopConnectScanner();
      clearConnectScanChunks();
      connectScanMode = null;
      connectScanBusy = false;
    }

    const routeRenderers = {
      '#home': renderHomeScreen,
      '#alerts': renderAlerts,
      '#scan': renderScan,
      '#share': renderShare,
      '#create': renderCreate,
      '#news': renderLocalNewsBroadcast,
      '#connect': renderConnect,
      '#settings': renderSettings
    };

    app.innerHTML = await routeRenderers[currentHash]();

    if (currentHash === '#alerts') {
      startAlertAutoRefresh();
    }

    if (currentHash === '#share') {
      await refreshShareCounter();
    }
  } catch (error) {
    showToast(t('error.render', { message: error.message }), 'error');
  }
}

/**
 * Renders the complete Alerts board for the #alerts route.
 * @returns {Promise<string>} Alerts route HTML.
 */
export async function renderAlerts() {
  try {
    const allAlerts = getPublicAlerts(sortAlerts(await getAllAlerts()));
    const replacedIds = new Set(allAlerts.map((alert) => alert.prev).filter(Boolean));
    const visibleAlerts =
      activeAlertFilter === 'all'
        ? allAlerts
        : allAlerts.filter((alert) => normalizeAlertType(alert.type) === activeAlertFilter);

    return `
      ${renderHeader()}
      <main>
        ${renderFilterBar()}
        ${visibleAlerts.length > 0
        ? visibleAlerts.map((alert) => renderAlertCard(alert, replacedIds.has(alert.id))).join('')
        : renderAlertsEmptyState(allAlerts.length === 0)
      }
      </main>
      <button class="fab" type="button" data-route="#create" aria-label="${escapeHtml(t('alerts.create'))}">+</button>
    `;
  } catch (error) {
    showToast(t('error.alertLoad', { message: error.message }), 'error');
    return `
      ${renderHeader()}
      <main>
        ${renderFilterBar()}
        <section class="empty-state">
          <div class="empty-state-icon">⚠️</div>
          <h2>${escapeHtml(t('alerts.unavailableTitle'))}</h2>
          <p>${escapeHtml(t('alerts.unavailableBody'))}</p>
          <button class="btn-primary" type="button" data-route="#home">${escapeHtml(t('app.backHomeButton'))}</button>
        </section>
      </main>
    `;
  }
}

/**
 * Renders the Smart Bundle sharing route.
 * @returns {Promise<string>} Share route HTML.
 */
export async function renderShare() {
  try {
    const alerts = getPublicAlerts(sortAlerts(await getAllAlerts()));
    ensureSmartShareSelection(alerts);
    const selectedAlerts = getSelectedAlertsFromList(alerts);
    const counter = getBundleCounter(selectedAlerts);

    return `
      ${renderHeader()}
      <main>
        <h1 class="page-title">
          <button class="back-btn" type="button" data-route="#home" aria-label="${escapeHtml(t('app.backHome'))}">←</button>
          <span>📤</span>
          <span>${escapeHtml(t('share.title'))}</span>
        </h1>
        ${alerts.length === 0
        ? renderShareEmptyState()
        : `
              <section class="bundle-info" aria-live="polite">
                <span>${escapeHtml(t('share.smartBundle'))}</span>
                <span class="bundle-size" id="shareBundleCounter">${escapeHtml(counter)}</span>
              </section>
              <section aria-label="${escapeHtml(t('share.alertChecklist'))}">
                ${alerts.map((alert) => renderShareChecklistItem(alert, shareSelectedIds.has(alert.id))).join('')}
              </section>
              <div class="qr-nav">
                <button class="btn-primary" type="button" data-share-qr>${escapeHtml(t('share.asQr'))}</button>
                <button class="btn-secondary" type="button" data-village-poster>${escapeHtml(t('share.posterButton'))}</button>
              </div>
              <section class="qr-container" id="shareQrPanel" aria-live="polite">
                <div class="qr-card">
                  <canvas id="shareQrCanvas" width="320" height="320" aria-label="${escapeHtml(t('share.canvasLabel'))}"></canvas>
                </div>
                <div class="chunk-progress" id="shareQrIndicator">${escapeHtml(t('share.selectThenShare'))}</div>
                <div class="qr-info">${escapeHtml(t('share.nearbyInfo'))}</div>
              </section>
              <section
                class="poster"
                id="villagePoster"
                style="display:none;background:white;color:black;margin:16px;padding:24px;border-radius:16px;text-align:center"
              >
                <div class="poster-title">${escapeHtml(t('share.posterTitle'))}</div>
                <div class="poster-subtitle" id="posterSubtitle">${escapeHtml(t('share.posterSubtitle'))}</div>
                <div class="poster-qr-list" id="posterQrList">
                  <canvas class="poster-qr" id="posterQrCanvas" width="320" height="320" aria-label="${escapeHtml(t('share.posterTitle'))}"></canvas>
                </div>
                <div class="poster-meta" id="posterMeta"></div>
                <div class="poster-footer">${escapeHtml(t('share.posterFooter'))}</div>
              </section>
            `
      }
      </main>
    `;
  } catch (error) {
    showToast(t('error.shareLoad', { message: error.message }), 'error');
    return renderUnavailable('📤', t('share.title'), t('error.shareLoad', { message: error.message }));
  }
}

/**
 * Renders the camera scan route.
 * @returns {string} Scan route HTML.
 */
export function renderScan() {
  try {
    return `
      ${renderHeader()}
      <main>
        <h1 class="page-title">
          <button class="back-btn" type="button" data-route="#home" aria-label="${escapeHtml(t('app.backHome'))}">←</button>
          <span>📷</span>
          <span>${escapeHtml(t('scan.title'))}</span>
        </h1>
        <section class="connect-step">
          <h3>${escapeHtml(t('scan.camera'))}</h3>
          <div class="connect-instructions">
            ${escapeHtml(t('scan.instructions'))}
          </div>
          <div id="qrScanner" style="min-height:280px;border-radius:16px;overflow:hidden;background:rgba(255,255,255,0.05)"></div>
          <div class="connect-status" id="scanStatus">${escapeHtml(t('scan.ready'))}</div>
          <div class="chunk-progress" id="scanChunkProgress"></div>
          <div class="qr-nav">
            <button class="btn-primary" type="button" data-start-scan>${escapeHtml(t('scan.start'))}</button>
            <button class="btn-secondary" type="button" data-stop-scan>${escapeHtml(t('scan.stop'))}</button>
            <button class="btn-secondary" type="button" data-scan-done>${escapeHtml(t('scan.done'))}</button>
          </div>
        </section>
      </main>
    `;
  } catch (error) {
    showToast(t('error.scanLoad', { message: error.message }), 'error');
    return renderUnavailable('📷', t('scan.title'), t('error.scanLoad', { message: error.message }));
  }
}

/**
 * Renders the manual SDP-over-QR WebRTC connect route.
 * @returns {string} Connect route HTML.
 */
export function renderConnect() {
  try {
    const statusClass = connectStatusType === 'success' || connectStatusType === 'error' ? ` ${connectStatusType}` : '';

    return `
      ${renderHeader()}
      <main>
        <h1 class="page-title">
          <button class="back-btn" type="button" data-route="#home" aria-label="${escapeHtml(t('app.backHome'))}">←</button>
          <span>🔗</span>
          <span>${escapeHtml(t('connect.title'))}</span>
        </h1>
        <section class="connect-step">
          <h3>${escapeHtml(t('connect.heading'))}</h3>
          <div class="connect-instructions">
            ${escapeHtml(t('connect.instructions'))}
          </div>
          <div class="device-select" role="group" aria-label="${escapeHtml(t('connect.chooseGroup'))}">
            <button
              class="device-btn ${connectRole === 'a' ? 'active' : ''}"
              type="button"
              data-connect-role="a"
              style="color: var(--accent)"
            >
              ${escapeHtml(t('connect.deviceA'))}
            </button>
            <button
              class="device-btn ${connectRole === 'b' ? 'active' : ''}"
              type="button"
              data-connect-role="b"
              style="color: var(--medical)"
            >
              ${escapeHtml(t('connect.deviceB'))}
            </button>
          </div>
          <div class="connect-status${statusClass}" id="connectStatus">${escapeHtml(connectStatusText)}</div>
          <div class="chunk-progress" id="connectSyncProgress">${escapeHtml(connectSyncText)}</div>
          ${renderConnectPanel()}
          ${renderCommunityChatPanel()}
        </section>
      </main>
    `;
  } catch (error) {
    showToast(t('error.connectLoad', { message: error.message }), 'error');
    return renderUnavailable('🔗', t('connect.title'), t('error.connectLoad', { message: error.message }));
  }
}

/**
 * Renders JanVaani settings.
 * @returns {string} Settings route HTML.
 */
export function renderSettings() {
  try {
    const currentLang = getLang();

    return `
      ${renderHeader()}
      <main class="settings-page">
        <h1 class="page-title" style="padding:0 0 12px">
          <button class="back-btn" type="button" data-route="#home" aria-label="${escapeHtml(t('app.backHome'))}">←</button>
          <span>⚙️</span>
          <span>${escapeHtml(t('settings.title'))}</span>
        </h1>

        <section class="settings-section">
          <div class="settings-section-title">${escapeHtml(t('settings.language'))}</div>
          <div class="settings-row">
            <label>${escapeHtml(t('settings.language'))}</label>
            <div class="lang-toggle" role="group" aria-label="${escapeHtml(t('settings.language'))}">
              ${renderLangButton('en', 'EN', currentLang)}
              ${renderLangButton('hi', 'हिं', currentLang)}
              ${renderLangButton('te', 'తె', currentLang)}
            </div>
          </div>
        </section>

        <section class="settings-section">
          <div class="settings-section-title">${escapeHtml(t('settings.demo'))}</div>
          <div class="settings-row">
            <label>${escapeHtml(t('settings.demoMode'))}</label>
            <button
              class="toggle-switch ${demoModeActive ? 'on' : ''}"
              type="button"
              role="switch"
              aria-checked="${demoModeActive ? 'true' : 'false'}"
              data-demo-toggle
            ></button>
          </div>
          <label class="form-label" style="margin:12px 0 6px">${escapeHtml(t('settings.demoDevice'))}</label>
          <div class="device-select">
            ${['a', 'b', 'c'].map((device) => renderDemoDeviceButton(device)).join('')}
          </div>
        </section>

        <section class="settings-section">
          <div class="settings-section-title">${escapeHtml(t('settings.shareApp'))}</div>
          <div class="settings-row settings-share-row">
            <label>${escapeHtml(t('settings.shareAppBody'))}</label>
            <div class="settings-action-group">
              <button class="btn-primary" type="button" data-install-app>
                ${escapeHtml(t('pwa.installApp'))}
              </button>
              <button class="btn-secondary" type="button" data-share-app>
                ${escapeHtml(t('settings.showQr'))}
              </button>
            </div>
          </div>
        </section>

        <section class="settings-section">
          <div class="settings-section-title">${escapeHtml(t('settings.shake'))}</div>
          <div class="settings-row">
            <label>${escapeHtml(t('settings.shakeBody'))}</label>
            <button class="btn-secondary" style="width:auto;margin:0" type="button" data-motion-permission>
              ${escapeHtml(t('settings.enableShake'))}
            </button>
          </div>
        </section>

        <section class="settings-section">
          <div class="settings-section-title">${escapeHtml(t('settings.panic'))}</div>
          <div class="settings-row">
            <label>${escapeHtml(t('settings.panicBody'))}</label>
          </div>
          <button class="btn-danger" type="button" data-panic-clear>${escapeHtml(t('settings.clearButton'))}</button>
        </section>
      </main>
    `;
  } catch (error) {
    showToast(t('error.settingsLoad', { message: error.message }), 'error');
    return renderUnavailable('⚙️', t('settings.title'), t('error.settingsLoad', { message: error.message }));
  }
}

/**
 * Renders the complete Create Alert form for the #create route.
 * @returns {Promise<string>} Create route HTML.
 */
export async function renderCreate() {
  try {
    const alerts = getPublicAlerts(await getAllAlerts());
    const options = alerts.length
      ? alerts
        .map(
          (alert) =>
            `<option value="${escapeHtml(alert.id)}">${escapeHtml(alert.title)} · ${escapeHtml(alert.region)}</option>`
        )
        .join('')
      : `<option value="">${escapeHtml(t('create.noCurrentAlerts'))}</option>`;

    return `
      ${renderHeader()}
      <main>
        <h1 class="page-title">
          <button class="back-btn" type="button" data-route="#home" aria-label="${escapeHtml(t('app.backHome'))}">←</button>
          <span>${escapeHtml(t('create.title'))}</span>
        </h1>

        <form id="createAlertForm" autocomplete="off" novalidate>
          <input type="hidden" name="type" id="createTypeInput" value="emergency" />
          <input type="hidden" name="priority" id="createPriorityInput" value="3" />
          <input type="hidden" name="prev" id="createPrevInput" value="" />

          <section class="category-grid" aria-label="${escapeHtml(t('create.category'))}">
            ${CATEGORIES.map((category) => renderCategoryButton(category, category.type === 'emergency')).join('')}
          </section>

          <div class="form-group">
            <label class="form-label" for="createTitle">${escapeHtml(t('create.titleLabel'))}</label>
            <input
              class="form-input"
              id="createTitle"
              name="title"
              type="text"
              maxlength="100"
              required
              placeholder="${escapeHtml(t('create.titlePlaceholder'))}"
            />
          </div>

          <div class="form-group">
            <label class="form-label" for="createBody">${escapeHtml(t('create.details'))}</label>
            <textarea
              class="form-textarea"
              id="createBody"
              name="body"
              maxlength="500"
              required
              placeholder="${escapeHtml(t('create.detailsPlaceholder'))}"
            ></textarea>
            <div class="char-count" id="bodyCharCount">0 / 500</div>
          </div>

          <div class="priority-row" aria-label="${escapeHtml(t('create.priority'))}">
            ${[1, 2, 3, 4, 5]
        .map(
          (priority) => `
                  <button
                    class="priority-btn ${priority === 3 ? 'selected' : ''} ${priority === 5 ? 'p5' : ''}"
                    type="button"
                    data-priority="${priority}"
                    aria-pressed="${priority === 3 ? 'true' : 'false'}"
                  >
                    ${priority === 5 ? escapeHtml(t('create.critical')) : priority}
                  </button>
                `
        )
        .join('')}
          </div>

          <div class="form-group" style="margin-top:16px">
            <label class="form-label" for="createRegion">${escapeHtml(t('create.region'))}</label>
            <input
              class="form-input"
              id="createRegion"
              name="region"
              type="text"
              maxlength="80"
              required
              placeholder="${escapeHtml(t('create.regionPlaceholder'))}"
            />
          </div>

          <section class="form-group settings-row" aria-label="${escapeHtml(t('create.replacementOptions'))}">
            <label for="replaceToggle">${escapeHtml(t('create.replaces'))}</label>
            <button
              class="toggle-switch"
              id="replaceToggle"
              type="button"
              role="switch"
              aria-checked="false"
              data-toggle-replace
            ></button>
          </section>

          <div class="form-group" id="replaceSelectGroup" hidden>
            <label class="form-label" for="replaceSelect">${escapeHtml(t('create.currentAlert'))}</label>
            <select class="form-input" id="replaceSelect" ${alerts.length ? '' : 'disabled'}>
              ${options}
            </select>
          </div>

          <button class="btn-primary" type="submit">${escapeHtml(t('create.submit'))}</button>
        </form>
      </main>
    `;
  } catch (error) {
    showToast(t('error.createLoad', { message: error.message }), 'error');
    return renderUnavailable('+', t('create.title'), t('error.createLoad', { message: error.message }));
  }
}

/**
 * Renders the offline local news broadcast route.
 * @returns {Promise<string>} Local news broadcast HTML.
 */
export async function renderLocalNewsBroadcast() {
  try {
    const broadcasts = await getLocalNewsBroadcasts();

    return `
      ${renderHeader()}
      <main>
        <h1 class="page-title">
          <button class="back-btn" type="button" data-route="#home" aria-label="${escapeHtml(t('app.backHome'))}">←</button>
          <span>📣</span>
          <span>${escapeHtml(t('news.title'))}</span>
        </h1>

        <section class="connect-instructions">
          ${escapeHtml(t('news.instructions'))}
        </section>

        <form id="localNewsBroadcastForm" autocomplete="off" novalidate>
          <div class="form-group">
            <label class="form-label" for="newsTitle">${escapeHtml(t('news.headline'))}</label>
            <input
              class="form-input"
              id="newsTitle"
              name="title"
              type="text"
              maxlength="100"
              required
              placeholder="${escapeHtml(t('news.headlinePlaceholder'))}"
            />
          </div>

          <div class="form-group">
            <label class="form-label" for="createBody">${escapeHtml(t('news.update'))}</label>
            <textarea
              class="form-textarea"
              id="createBody"
              name="body"
              maxlength="500"
              required
              placeholder="${escapeHtml(t('news.updatePlaceholder'))}"
            ></textarea>
            <div class="char-count" id="bodyCharCount">0 / 500</div>
          </div>

          <div class="form-group">
            <label class="form-label" for="newsRegion">${escapeHtml(t('news.region'))}</label>
            <input
              class="form-input"
              id="newsRegion"
              name="region"
              type="text"
              maxlength="80"
              required
              placeholder="${escapeHtml(t('news.regionPlaceholder'))}"
            />
          </div>

          <button class="btn-primary" type="submit">${escapeHtml(t('news.submit'))}</button>
        </form>

        <section class="news-list" aria-label="${escapeHtml(t('news.savedTitle'))}">
          <div class="news-list-header">
            <h2>${escapeHtml(t('news.savedTitle'))}</h2>
            <span class="badge badge-confidence">${escapeHtml(t('news.savedCount', { count: broadcasts.length }))}</span>
          </div>
          ${broadcasts.length
        ? `
              ${broadcasts.map((broadcast) => renderLocalNewsCard(broadcast)).join('')}
              <button class="btn-secondary" type="button" data-news-share-qr>${escapeHtml(t('news.shareQr'))}</button>
              <section class="qr-container" id="newsQrPanel" aria-live="polite">
                <div class="qr-card">
                  <canvas id="newsQrCanvas" width="320" height="320" aria-label="${escapeHtml(t('news.qrLabel'))}"></canvas>
                </div>
                <div class="chunk-progress" id="newsQrIndicator">${escapeHtml(t('news.qrIdle'))}</div>
              </section>
            `
        : `
              <div class="empty-state news-empty">
                <div class="empty-state-icon">📣</div>
                <h2>${escapeHtml(t('news.emptyTitle'))}</h2>
                <p>${escapeHtml(t('news.emptyBody'))}</p>
              </div>
            `
      }
        </section>
      </main>
    `;
  } catch (error) {
    showToast(t('error.newsLoad', { message: error.message }), 'error');
    return renderUnavailable('📣', t('news.title'), t('error.newsLoad', { message: error.message }));
  }
}

/**
 * Shows a temporary JanVaani toast notification.
 * @param {string} message - Toast message.
 * @param {'success' | 'error' | 'info'} type - Toast visual type.
 * @returns {HTMLDivElement} Created toast element.
 */
export function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  const safeType = ['success', 'error', 'info'].includes(type) ? type : 'info';
  toast.className = `toast toast-${safeType}`;
  toast.textContent = message;
  document.body.append(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 3000);

  return toast;
}

/**
 * Creates and opens a QR modal for sharing the PWA install URL.
 * @returns {Promise<void>} Resolves after the modal is rendered.
 */
export async function showShareAppModal() {
  try {
    closeModal();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="shareAppTitle">
        <div class="modal-title" id="shareAppTitle">${escapeHtml(t('share.qrAppTitle'))}</div>
        <div class="modal-body">
          ${escapeHtml(t('share.qrAppBody'))}
          <div class="qr-container">
            <div class="qr-card">
              <canvas id="shareAppQr" width="260" height="260" aria-label="${escapeHtml(t('share.qrAppLabel'))}"></canvas>
            </div>
            <div class="qr-info">${escapeHtml(APP_ORIGIN)}</div>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn-primary" type="button" data-install-app>${escapeHtml(t('pwa.installApp'))}</button>
          <button class="btn-secondary" type="button" data-close-modal>${escapeHtml(t('app.close'))}</button>
        </div>
      </section>
    `;

    document.body.append(overlay);
    overlay.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : undefined;

      if (event.target === overlay || target?.closest('[data-close-modal]')) {
        closeModal();
        return;
      }

      if (target?.closest('[data-install-app]')) {
        void promptInstallJanVaani();
      }
    });

    await renderQR(APP_ORIGIN, 'shareAppQr');
  } catch (error) {
    showToast(t('error.appQr', { message: error.message }), 'error');
  }
}

/**
 * Prompts the browser to install JanVaani when the PWA install event is available.
 * @returns {Promise<void>} Resolves after the install prompt flow completes.
 */
export async function promptInstallJanVaani() {
  try {
    if (isRunningStandalone()) {
      showToast(t('pwa.alreadyInstalled'), 'info');
      return;
    }

    if (!deferredInstallPrompt) {
      showToast(t('pwa.installUnavailable'), 'info');
      return;
    }

    const installPrompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;

    if (choice?.outcome === 'accepted') {
      showToast(t('pwa.installAccepted'), 'success');
      return;
    }

    showToast(t('pwa.installDismissed'), 'info');
  } catch (error) {
    showToast(t('pwa.installFailed', { message: error.message }), 'error');
  }
}

/**
 * Closes any open JanVaani modal.
 * @returns {void}
 */
export function closeModal() {
  document.querySelectorAll('.modal-overlay').forEach((modal) => {
    modal.remove();
  });
  shakeConfirmOpen = false;
}

function showClearDataModal(fromShake) {
  closeModal();
  shakeConfirmOpen = Boolean(fromShake);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="clearDataTitle">
      <div class="modal-title" id="clearDataTitle">
        ${escapeHtml(t(fromShake ? 'settings.shakeDetectedTitle' : 'settings.confirmClearTitle'))}
      </div>
      <div class="modal-body">
        ${escapeHtml(t(fromShake ? 'settings.shakeDetectedBody' : 'settings.confirmClearBody'))}
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" type="button" data-close-modal>${escapeHtml(t('app.cancel'))}</button>
        <button class="btn-danger" type="button" data-confirm-clear>${escapeHtml(t('settings.confirmClearAction'))}</button>
      </div>
    </section>
  `;
  overlay.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : undefined;

    const confirmButton = target?.closest('[data-confirm-clear]');

    if (confirmButton) {
      if (confirmButton instanceof HTMLButtonElement) {
        confirmButton.disabled = true;
      }

      void clearLocalDataFromModal();
      return;
    }

    if (event.target === overlay || target?.closest('[data-close-modal]')) {
      shakeConfirmOpen = false;
      closeModal();
    }
  });
  document.body.append(overlay);
}

async function clearLocalDataFromModal() {
  try {
    await clearAllData();
    closeModal();
    shakeConfirmOpen = false;
    showToast(t('settings.cleared'), 'success');
    await render();
  } catch (error) {
    showToast(t('settings.clearFailed', { message: error.message }), 'error');
  }
}

function toggleDemoMode() {
  demoModeActive = !demoModeActive;
  localStorage.setItem(DEMO_MODE_KEY, String(demoModeActive));
  applyDemoMode();
}

function setDemoDevice(device) {
  demoDevice = ['a', 'b', 'c'].includes(device) ? device : 'a';
  localStorage.setItem(DEMO_DEVICE_KEY, demoDevice);
  applyDemoMode();
}

function applyDemoMode() {
  document.body.classList.toggle('demo-active', demoModeActive);
}

function armShakeListener() {
  const previousHandler = window[SHAKE_HANDLER_KEY];

  if (previousHandler && previousHandler !== handleShakeToWipe) {
    window.removeEventListener('devicemotion', previousHandler);
  }

  if (previousHandler !== handleShakeToWipe) {
    window.addEventListener('devicemotion', handleShakeToWipe);
  }

  window[SHAKE_HANDLER_KEY] = handleShakeToWipe;
  shakePermissionRequested = true;
}

async function requestMotionPermission() {
  try {
    if (typeof DeviceMotionEvent === 'undefined') {
      showToast(t('settings.motionUnavailable'), 'error');
      return;
    }

    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      const state = await DeviceMotionEvent.requestPermission();
      if (state !== 'granted') {
        showToast(t('settings.motionDenied'), 'error');
        return;
      }
    }

    armShakeListener();
    showToast(t('settings.motionEnabled'), 'success');
  } catch (error) {
    showToast(t('settings.motionDenied'), 'error');
  }
}

function initShakeToWipe() {
  if (shakePermissionRequested) return;
  if (typeof DeviceMotionEvent === 'undefined') return;
  if (typeof DeviceMotionEvent.requestPermission !== 'function') {
    armShakeListener();
  }
}

function handleShakeToWipe(event) {
  const a = event.accelerationIncludingGravity || event.acceleration || {};
  const magnitude = Math.hypot(Number(a.x) || 0, Number(a.y) || 0, Number(a.z) || 0);
  if (magnitude <= 25 || shakeConfirmOpen) return;
  const now = Date.now();
  shakeHits.push(now);
  while (shakeHits[0] < now - 2000) shakeHits.shift();
  if (shakeHits.length >= 5) {
    shakeHits.length = 0;
    showClearDataModal(true);
  }
}

function getAppRoot() {
  const app = document.querySelector('#app');

  if (!app) {
    throw new Error('JanVaani root element #app was not found.');
  }

  return app;
}

function bindAppEvents(app) {
  if (appEventsBound) {
    return;
  }

  app.addEventListener('click', (event) => {
    void handleAppClick(event);
  });
  app.addEventListener('input', handleAppInput);
  app.addEventListener('change', handleAppChange);
  app.addEventListener('submit', (event) => {
    void handleAppSubmit(event);
  });
  window.addEventListener('janvaani:gossip-progress', handleGossipProgress);
  appEventsBound = true;
}

async function handleAppClick(event) {
  try {
    const target = event.target instanceof Element ? event.target : undefined;

    if (!target) {
      return;
    }

    const routeButton = target.closest('[data-route]');

    if (routeButton) {
      navigate(routeButton.dataset.route);
      return;
    }

    const shareButton = target.closest('[data-share-app]');

    if (shareButton) {
      await showShareAppModal();
      return;
    }

    const installButton = target.closest('[data-install-app]');

    if (installButton) {
      await promptInstallJanVaani();
      return;
    }

    const langButton = target.closest('[data-lang]');

    if (langButton) {
      setLang(langButton.dataset.lang);
      connectStatusText = t('connect.chooseRole');
      connectSyncText = t('connect.syncIdle');
      await render();
      return;
    }

    const demoToggle = target.closest('[data-demo-toggle]');

    if (demoToggle) {
      toggleDemoMode();
      await render();
      return;
    }

    const demoDeviceButton = target.closest('[data-demo-device]');

    if (demoDeviceButton) {
      setDemoDevice(demoDeviceButton.dataset.demoDevice);
      await render();
      return;
    }

    const motionButton = target.closest('[data-motion-permission]');

    if (motionButton) {
      await requestMotionPermission();
      return;
    }

    const panicButton = target.closest('[data-panic-clear]');

    if (panicButton) {
      showClearDataModal(false);
      return;
    }

    const confirmClearButton = target.closest('[data-confirm-clear]');

    if (confirmClearButton) {
      await clearLocalDataFromModal();
      return;
    }

    const categoryButton = target.closest('[data-category-type]');

    if (categoryButton) {
      selectCategory(categoryButton.dataset.categoryType);
      return;
    }

    const priorityButton = target.closest('[data-priority]');

    if (priorityButton) {
      selectPriority(priorityButton.dataset.priority);
      return;
    }

    const replaceToggle = target.closest('[data-toggle-replace]');

    if (replaceToggle) {
      toggleReplacement();
      return;
    }

    const filterButton = target.closest('[data-alert-filter]');

    if (filterButton) {
      activeAlertFilter = normalizeFilterType(filterButton.dataset.alertFilter);
      await render();
      return;
    }

    const alertCard = target.closest('[data-alert-card]');

    if (alertCard) {
      toggleAlertExpansion(alertCard.dataset.alertCard);
      await render();
      return;
    }

    const shareQrButton = target.closest('[data-share-qr]');

    if (shareQrButton) {
      await handleShareAsQr();
      return;
    }

    const newsShareQrButton = target.closest('[data-news-share-qr]');

    if (newsShareQrButton) {
      await handleLocalNewsShareQr();
      return;
    }

    const posterButton = target.closest('[data-village-poster]');

    if (posterButton) {
      await handleVillagePoster();
      return;
    }

    const startScanButton = target.closest('[data-start-scan]');

    if (startScanButton) {
      await handleStartScan();
      return;
    }

    const stopScanButton = target.closest('[data-stop-scan]');

    if (stopScanButton) {
      await stopActiveScanner();
      updateScanStatus(t('scan.stopped'), 'info');
      return;
    }

    const scanDoneButton = target.closest('[data-scan-done]');

    if (scanDoneButton) {
      await stopActiveScanner();
      scanChunks.clear();
      scanChunkTotal = 0;
      navigate('#alerts');
      return;
    }

    const connectRoleButton = target.closest('[data-connect-role]');

    if (connectRoleButton) {
      await chooseConnectRole(connectRoleButton.dataset.connectRole);
      return;
    }

    const connectScanAnswerButton = target.closest('[data-connect-scan-answer]');

    if (connectScanAnswerButton) {
      await startConnectScanner('answer');
      return;
    }

    const connectScanOfferButton = target.closest('[data-connect-scan-offer]');

    if (connectScanOfferButton) {
      await startConnectScanner('offer');
      return;
    }

    const connectStopScanButton = target.closest('[data-connect-stop-scan]');

    if (connectStopScanButton) {
      await stopConnectScanner();
      updateConnectStatus(t('connect.scannerStopped'), 'info');
      return;
    }

    const connectResetButton = target.closest('[data-connect-reset]');

    if (connectResetButton) {
      await resetConnectSession(false);
      await render();
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function handleAppInput(event) {
  try {
    const target = event.target;

    if (!(target instanceof HTMLTextAreaElement) || target.id !== 'createBody') {
      return;
    }

    updateBodyCount(target.value.length);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function handleAppChange(event) {
  try {
    const target = event.target;

    if (target instanceof HTMLInputElement && target.matches('[data-share-alert]')) {
      shareSelectionTouched = true;

      if (target.checked) {
        shareSelectedIds.add(target.value);
      } else {
        shareSelectedIds.delete(target.value);
      }

      void refreshShareCounter();
      return;
    }

    if (!(target instanceof HTMLSelectElement) || target.id !== 'replaceSelect') {
      return;
    }

    const prevInput = document.querySelector('#createPrevInput');

    if (prevInput instanceof HTMLInputElement) {
      prevInput.value = target.value;
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function handleAppSubmit(event) {
  try {
    const form = event.target;

    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    if (form.matches('[data-community-chat-form]')) {
      event.preventDefault();
      await submitCommunityChat(form);
      return;
    }

    if (form.id === 'localNewsBroadcastForm') {
      event.preventDefault();
      await submitLocalNewsBroadcast(form);
      return;
    }

    if (form.id !== 'createAlertForm') {
      return;
    }

    event.preventDefault();
    const formData = new FormData(form);
    const draft = {
      type: String(formData.get('type') || ''),
      title: String(formData.get('title') || ''),
      body: String(formData.get('body') || ''),
      priority: Number(formData.get('priority') || 1),
      region: String(formData.get('region') || ''),
      lang: 'en-IN',
      prev: String(formData.get('prev') || '') || null
    };
    const draftErrors = validateDraft(draft);

    if (draftErrors.length > 0) {
      showToast(draftErrors[0], 'error');
      return;
    }

    const alert = await createAlert(draft);
    const validation = validateAlert(alert);

    if (!validation.valid) {
      showToast(validation.errors[0], 'error');
      return;
    }

    const saved = await saveAlert(alert);

    if (!saved) {
      showToast(t('create.duplicate'), 'info');
      navigate('#alerts');
      return;
    }

    activeAlertFilter = 'all';
    broadcastLiveAlert(alert);
    showToast(t('create.saved'), 'success');
    navigate('#alerts');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function submitLocalNewsBroadcast(form) {
  try {
    const formData = new FormData(form);
    const draft = {
      type: 'notice',
      title: String(formData.get('title') || ''),
      body: String(formData.get('body') || ''),
      priority: 2,
      region: String(formData.get('region') || ''),
      lang: getLang(),
      prev: null,
      source: LOCAL_NEWS_SOURCE
    };
    const draftErrors = validateDraft(draft);

    if (draftErrors.length > 0) {
      showToast(draftErrors[0], 'error');
      return;
    }

    const alert = await createAlert(draft);
    const validation = validateAlert(alert);

    if (!validation.valid) {
      showToast(validation.errors[0], 'error');
      return;
    }

    const saved = await saveAlert(alert);

    if (!saved) {
      showToast(t('news.duplicate'), 'info');
      navigate('#news');
      return;
    }

    broadcastLiveAlert(alert);
    showToast(t('news.saved'), 'success');
    form.reset();
    updateBodyCount(0);
    await render();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function isLocalNewsBroadcast(alert) {
  return String(alert?.source || '') === LOCAL_NEWS_SOURCE;
}

function getPublicAlerts(alerts) {
  return alerts.filter((alert) => !isLocalNewsBroadcast(alert));
}

async function getLocalNewsBroadcasts() {
  try {
    return sortAlerts((await getAllAlerts()).filter(isLocalNewsBroadcast));
  } catch (error) {
    throw new Error(t('error.newsLoad', { message: error.message }));
  }
}

function renderLocalNewsCard(broadcast) {
  return `
    <article class="news-card">
      <div class="news-card-title">${escapeHtml(broadcast.title)}</div>
      <div class="news-card-body">${escapeHtml(broadcast.body)}</div>
      <div class="news-card-meta">
        <span>${escapeHtml(broadcast.region || t('app.local'))}</span>
        <span>${escapeHtml(timeAgo(broadcast.created))}</span>
        <span>${escapeHtml(ttlCountdown(broadcast))}</span>
      </div>
    </article>
  `;
}

function renderHeader() {
  const langLabel = getLanguageDisplayLabel(getLang());

  return `
    ${renderDemoBanner()}
    <header class="header">
      <div class="header-title">${escapeHtml(t('app.name'))}</div>
      <span class="offline-badge">${escapeHtml(t('app.offline'))}</span>
      <div class="header-actions">
        <span class="lang-indicator" aria-label="${escapeHtml(t('settings.language'))}">${escapeHtml(langLabel)}</span>
        <button class="header-icon-btn" type="button" data-share-app aria-label="${escapeHtml(t('app.share'))}">📲</button>
        <button class="header-icon-btn" type="button" data-route="#settings" aria-label="${escapeHtml(t('app.settings'))}">⚙️</button>
      </div>
    </header>
  `;
}

function renderDemoBanner() {
  if (!demoModeActive) {
    return '';
  }

  return `
    <div class="demo-banner demo-${escapeHtml(demoDevice)}">
      ${escapeHtml(t('settings.demoBanner', { device: demoDevice.toUpperCase() }))}
    </div>
  `;
}

async function renderHomeScreen() {
  try {
    const alertCount = getPublicAlerts(await getAllAlerts()).length;

    return `
      ${renderHeader()}
      <main class="home-container" aria-label="${escapeHtml(t('app.primaryActions'))}">
        <button class="home-btn" type="button" data-route="#alerts">
          <span class="home-btn-icon">📋</span>
          <span class="home-btn-text">
            <h3>
              <span>${escapeHtml(t('home.viewAlerts.title'))}</span>
              <span class="home-alert-count">${escapeHtml(t('home.alertCount', { count: alertCount }))}</span>
            </h3>
            <p>${escapeHtml(t('home.viewAlerts.body'))}</p>
          </span>
        </button>
        <button class="home-btn" type="button" data-route="#scan">
          <span class="home-btn-icon">📷</span>
          <span class="home-btn-text">
            <h3>${escapeHtml(t('home.scan.title'))}</h3>
            <p>${escapeHtml(t('home.scan.body'))}</p>
          </span>
        </button>
        <button class="home-btn" type="button" data-route="#share">
          <span class="home-btn-icon">📤</span>
          <span class="home-btn-text">
            <h3>${escapeHtml(t('home.share.title'))}</h3>
            <p>${escapeHtml(t('home.share.body'))}</p>
          </span>
        </button>
        <button class="home-btn" type="button" data-route="#news">
          <span class="home-btn-icon">📣</span>
          <span class="home-btn-text">
            <h3>${escapeHtml(t('home.news.title'))}</h3>
            <p>${escapeHtml(t('home.news.body'))}</p>
          </span>
        </button>
        <button class="home-btn" type="button" data-route="#connect">
          <span class="home-btn-icon">🔗</span>
          <span class="home-btn-text">
            <h3>${escapeHtml(t('home.connect.title'))}</h3>
            <p>${escapeHtml(t('home.connect.body'))}</p>
          </span>
        </button>
      </main>
      <button class="fab" type="button" data-route="#create" aria-label="${escapeHtml(t('alerts.create'))}">+</button>
    `;
  } catch (error) {
    showToast(t('error.homeLoad', { message: error.message }), 'error');
    return renderUnavailable('📋', t('app.name'), t('error.homeLoad', { message: error.message }));
  }
}

function renderFilterBar() {
  return `
    <nav class="filter-bar" aria-label="${escapeHtml(t('alerts.filtersLabel'))}">
      ${FILTERS.map((filter) => {
    const active = activeAlertFilter === filter.type;
    return `
          <button
            class="filter-pill ${active ? 'active' : ''} type-${filter.type}"
            type="button"
            data-alert-filter="${filter.type}"
            aria-pressed="${active ? 'true' : 'false'}"
          >
            ${escapeHtml(t(filter.labelKey))}
          </button>
        `;
  }).join('')}
    </nav>
  `;
}

function renderAlertsEmptyState(noAlertsStored) {
  const filter = FILTERS.find((item) => item.type === activeAlertFilter);
  const title = noAlertsStored
    ? t('alerts.noAlerts')
    : t('alerts.noFiltered', { filter: t(filter?.labelKey ?? 'filter.all') });
  const body = noAlertsStored
    ? t('alerts.noAlertsBody')
    : t('alerts.noFilteredBody');

  return `
    <section class="empty-state">
      <div class="empty-state-icon">📭</div>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(body)}</p>
      <button class="btn-primary" type="button" data-route="#create">${escapeHtml(t('alerts.create'))}</button>
    </section>
  `;
}

function renderUnavailable(icon, title, subtitle) {
  return `
    ${renderHeader()}
    <main>
      <h1 class="page-title">
        <button class="back-btn" type="button" data-route="#home" aria-label="${escapeHtml(t('app.backHome'))}">←</button>
        <span>${escapeHtml(icon)}</span>
        <span>${escapeHtml(title)}</span>
      </h1>
      <section class="empty-state">
        <div class="empty-state-icon">${escapeHtml(icon)}</div>
        <h2>${escapeHtml(t('app.unavailable'))}</h2>
        <p>${escapeHtml(subtitle)}</p>
        <button class="btn-primary" type="button" data-route="#home">${escapeHtml(t('app.backHomeButton'))}</button>
      </section>
    </main>
  `;
}

function renderCategoryButton(category, selected) {
  return `
    <button
      class="category-card ${selected ? 'selected' : ''}"
      type="button"
      data-category-type="${category.type}"
      style="color: var(--${category.type});"
      aria-pressed="${selected ? 'true' : 'false'}"
    >
      <div class="category-card-icon">${category.icon}</div>
      <div class="category-card-label">${escapeHtml(t(category.labelKey))}</div>
    </button>
  `;
}

function renderAlertCard(alert, replaced) {
  const category = getCategory(alert.type);
  const status = getExpiryStatus(alert);
  const expanded = expandedAlertIds.has(alert.id);
  const confidence = getConfidenceLabel(alert);
  const source = String(alert.source || t('app.unknownSource'));

  return `
    <article
      class="alert-card type-${escapeHtml(normalizeAlertType(alert.type))} ${replaced ? 'replaced' : ''}"
      data-alert-card="${escapeHtml(alert.id)}"
      role="button"
      tabindex="0"
      aria-expanded="${expanded ? 'true' : 'false'}"
    >
      <div class="alert-card-header">
        <div class="alert-card-category">
          <span>${category.icon}</span>
          <span>${escapeHtml(t(category.labelKey))}</span>
        </div>
        <div class="alert-card-badges">
          ${replaced ? `<span class="badge badge-expired">${escapeHtml(t('alerts.replaced'))}</span>` : ''}
          ${Number(alert.hops ?? 0) >= 1 ? `<span class="badge badge-hops">📡 ${Number(alert.hops ?? 0)}</span>` : ''}
          <span class="badge badge-${escapeHtml(status)}">${escapeHtml(t(`expiry.${status}`))}</span>
        </div>
      </div>
      <h2 class="alert-card-title">${escapeHtml(alert.title)}</h2>
      <p class="alert-card-body ${expanded ? 'expanded' : ''}">${escapeHtml(alert.body)}</p>
      <div class="alert-card-meta">
        <span>${escapeHtml(alert.region)} · ${escapeHtml(timeAgo(alert.created))} · ${escapeHtml(ttlCountdown(alert))}</span>
      </div>
      <div class="badge badge-confidence">${escapeHtml(confidence)}</div>
      ${expanded
      ? `
            <div class="alert-card-detail">
              <div>${escapeHtml(ttlCountdown(alert))}</div>
              <div>${escapeHtml(t('app.hops'))} ${Number(alert.hops ?? 0)}/${Number(alert.maxHops ?? 0)}</div>
              <div>${escapeHtml(t('app.source'))}: ${escapeHtml(source)}</div>
              <div>${escapeHtml(t('app.region'))}: ${escapeHtml(alert.region)}</div>
            </div>
          `
      : ''
    }
    </article>
  `;
}

function renderShareEmptyState() {
  return `
    <section class="empty-state">
      <div class="empty-state-icon">📭</div>
      <h2>${escapeHtml(t('share.noAlertsTitle'))}</h2>
      <p>${escapeHtml(t('share.noAlertsBody'))}</p>
      <button class="btn-primary" type="button" data-route="#create">${escapeHtml(t('alerts.create'))}</button>
    </section>
  `;
}

function renderShareChecklistItem(alert, checked) {
  const category = getCategory(alert.type);
  const status = getExpiryStatus(alert);

  return `
    <label class="alert-card type-${escapeHtml(normalizeAlertType(alert.type))}" style="display:block">
      <div class="alert-card-header">
        <div class="alert-card-category">
          <input
            type="checkbox"
            value="${escapeHtml(alert.id)}"
            data-share-alert
            ${checked ? 'checked' : ''}
            aria-label="${escapeHtml(t('share.selectAlert', { title: alert.title }))}"
          />
          <span>${category.icon}</span>
          <span>${escapeHtml(t(category.labelKey))}</span>
        </div>
        <span class="badge badge-${escapeHtml(status)}">${escapeHtml(t(`expiry.${status}`))}</span>
      </div>
      <h2 class="alert-card-title">${escapeHtml(alert.title)}</h2>
      <p class="alert-card-body">${escapeHtml(alert.body)}</p>
      <div class="alert-card-meta">
        <span>${escapeHtml(t('app.priority'))} ${Number(alert.priority)} · ${escapeHtml(alert.region)} · ${escapeHtml(timeAgo(alert.created))}</span>
      </div>
    </label>
  `;
}

function renderLangButton(code, label, activeLang) {
  return `
    <button
      class="lang-btn ${activeLang === code ? 'active' : ''}"
      type="button"
      data-lang="${escapeHtml(code)}"
      aria-pressed="${activeLang === code ? 'true' : 'false'}"
    >
      ${escapeHtml(label)}
    </button>
  `;
}

function getLanguageDisplayLabel(code) {
  const labels = {
    en: 'EN',
    hi: 'हिं',
    te: 'తె'
  };

  return labels[code] ?? 'EN';
}

function renderDemoDeviceButton(device) {
  return `
    <button
      class="device-btn ${demoDevice === device ? 'active' : ''}"
      type="button"
      data-demo-device="${escapeHtml(device)}"
      style="color: var(--${device === 'a' ? 'accent' : device === 'b' ? 'medical' : 'missing'})"
      aria-pressed="${demoDevice === device ? 'true' : 'false'}"
    >
      ${escapeHtml(t(`connect.device${device.toUpperCase()}`))}
    </button>
  `;
}

function renderConnectPanel() {
  if (connectRole === 'a') {
    return `
      <div id="connectPanel">
        <div class="connect-instructions">
          ${escapeHtml(t('connect.aSteps'))}
        </div>
        <div class="qr-container">
          <div class="qr-card">
            <canvas id="connectOfferCanvas" width="320" height="320" aria-label="${escapeHtml(t('connect.offerQrLabel'))}"></canvas>
          </div>
          <div class="qr-info" id="connectOfferInfo">${escapeHtml(t('connect.offerCreating'))}</div>
        </div>
        <div id="connectScanner" style="min-height:260px;border-radius:16px;overflow:hidden;background:rgba(255,255,255,0.05)"></div>
        <div class="qr-nav">
          <button class="btn-primary" type="button" data-connect-scan-answer>${escapeHtml(t('connect.scanAnswer'))}</button>
          <button class="btn-secondary" type="button" data-connect-stop-scan>${escapeHtml(t('connect.stopScanner'))}</button>
          <button class="btn-secondary" type="button" data-connect-reset>${escapeHtml(t('connect.restart'))}</button>
        </div>
      </div>
    `;
  }

  if (connectRole === 'b') {
    return `
      <div id="connectPanel">
        <div class="connect-instructions">
          ${escapeHtml(t('connect.bSteps'))}
        </div>
        <div id="connectScanner" style="min-height:260px;border-radius:16px;overflow:hidden;background:rgba(255,255,255,0.05)"></div>
        <div class="qr-nav">
          <button class="btn-primary" type="button" data-connect-scan-offer>${escapeHtml(t('connect.scanOffer'))}</button>
          <button class="btn-secondary" type="button" data-connect-stop-scan>${escapeHtml(t('connect.stopScanner'))}</button>
          <button class="btn-secondary" type="button" data-connect-reset>${escapeHtml(t('connect.restart'))}</button>
        </div>
        <div class="qr-container" id="connectAnswerPanel" hidden>
          <div class="qr-card">
            <canvas id="connectAnswerCanvas" width="320" height="320" aria-label="${escapeHtml(t('connect.answerQrLabel'))}"></canvas>
          </div>
          <div class="qr-info" id="connectAnswerInfo">${escapeHtml(t('connect.answerPending'))}</div>
        </div>
      </div>
    `;
  }

  return `
    <div id="connectPanel" class="connect-instructions">
      ${escapeHtml(t('connect.panelIdle'))}
    </div>
  `;
}

function renderCommunityChatPanel() {
  const peerCount = getOpenMeshChannels().length;
  const disabled = peerCount === 0 ? 'disabled' : '';

  return `
    <section class="community-panel" aria-label="${escapeHtml(t('connect.communityTitle'))}">
      <div class="community-panel-header">
        <div>
          <h3>${escapeHtml(t('connect.communityTitle'))}</h3>
          <p id="communityPeerCount">${escapeHtml(getCommunityPeerLabel(peerCount))}</p>
        </div>
        <span class="badge badge-confidence">${escapeHtml(t('connect.communityEphemeral'))}</span>
      </div>
      <div class="community-chat-list" id="communityChatList">
        ${renderCommunityChatMessages()}
      </div>
      <form class="community-chat-form" data-community-chat-form>
        <label class="form-label" for="communityChatInput">${escapeHtml(t('connect.communityInputLabel'))}</label>
        <div class="community-chat-row">
          <input
            class="form-input"
            id="communityChatInput"
            name="message"
            maxlength="${COMMUNITY_CHAT_MAX_LENGTH}"
            autocomplete="off"
            placeholder="${escapeHtml(t('connect.communityPlaceholder'))}"
            ${disabled}
          >
          <button class="btn-primary community-send-btn" type="submit" ${disabled}>
            ${escapeHtml(t('connect.communitySend'))}
          </button>
        </div>
      </form>
    </section>
  `;
}

function renderCommunityChatMessages() {
  const activeMessages = getActiveCommunityChatMessages();

  if (!activeMessages.length) {
    return `
      <div class="community-chat-empty">
        ${escapeHtml(t('connect.communityMessagesEmpty'))}
      </div>
    `;
  }

  return activeMessages
    .map((message) => {
      const ownClass = message.own ? ' own' : '';
      const relayText = message.hops > 1 ? ` · ${escapeHtml(t('connect.communityRelays', { count: message.hops }))}` : '';

      return `
        <article class="community-message${ownClass}">
          <div class="community-message-text">${escapeHtml(message.text)}</div>
          <div class="community-message-meta">
            ${escapeHtml(getCommunitySourceLabel(message))} · ${escapeHtml(timeAgo(message.created))}${relayText}
          </div>
        </article>
      `;
    })
    .join('');
}

function selectCategory(type) {
  const typeInput = document.querySelector('#createTypeInput');

  if (!(typeInput instanceof HTMLInputElement) || !CATEGORIES.some((category) => category.type === type)) {
    return;
  }

  typeInput.value = type;
  document.querySelectorAll('[data-category-type]').forEach((button) => {
    const selected = button instanceof HTMLElement && button.dataset.categoryType === type;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
}

function selectPriority(priorityValue) {
  const priority = Number(priorityValue);
  const priorityInput = document.querySelector('#createPriorityInput');

  if (!(priorityInput instanceof HTMLInputElement) || !Number.isInteger(priority) || priority < 1 || priority > 5) {
    return;
  }

  priorityInput.value = String(priority);
  document.querySelectorAll('[data-priority]').forEach((button) => {
    const selected = button instanceof HTMLElement && Number(button.dataset.priority) === priority;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
}

function toggleReplacement() {
  const toggle = document.querySelector('[data-toggle-replace]');
  const group = document.querySelector('#replaceSelectGroup');
  const select = document.querySelector('#replaceSelect');
  const prevInput = document.querySelector('#createPrevInput');

  if (!(toggle instanceof HTMLButtonElement) || !(group instanceof HTMLElement)) {
    return;
  }

  const enabled = toggle.getAttribute('aria-checked') !== 'true';
  toggle.classList.toggle('on', enabled);
  toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
  group.hidden = !enabled;

  if (prevInput instanceof HTMLInputElement) {
    prevInput.value = enabled && select instanceof HTMLSelectElement ? select.value : '';
  }
}

function toggleAlertExpansion(alertId) {
  if (!alertId) {
    return;
  }

  if (expandedAlertIds.has(alertId)) {
    expandedAlertIds.delete(alertId);
    return;
  }

  expandedAlertIds.add(alertId);
}

function updateBodyCount(length) {
  const counter = document.querySelector('#bodyCharCount');

  if (counter) {
    counter.textContent = `${Math.min(length, 500)} / 500`;
  }
}

function validateDraft(draft) {
  const errors = [];

  if (!draft.title.trim()) {
    errors.push(t('create.titleRequired'));
  }

  if (draft.title.trim().length > 100) {
    errors.push(t('create.titleLong'));
  }

  if (!draft.body.trim()) {
    errors.push(t('create.detailsRequired'));
  }

  if (draft.body.trim().length > 500) {
    errors.push(t('create.detailsLong'));
  }

  if (!draft.region.trim()) {
    errors.push(t('create.regionRequired'));
  }

  if (!Number.isInteger(draft.priority) || draft.priority < 1 || draft.priority > 5) {
    errors.push(t('create.priorityInvalid'));
  }

  if (!CATEGORIES.some((category) => category.type === draft.type)) {
    errors.push(t('create.categoryInvalid'));
  }

  return errors;
}

function getCategory(type) {
  const normalizedType = normalizeAlertType(type);
  return CATEGORIES.find((category) => category.type === normalizedType) ?? CATEGORIES[CATEGORIES.length - 1];
}

function getConfidenceLabel(alert) {
  const source = String(alert.source || '').toLowerCase();

  if (source === 'board') {
    return t('confidence.board');
  }

  const hops = Math.max(0, Number(alert.hops ?? 0));

  if (hops === 0) {
    return t('confidence.unverified');
  }

  if (hops <= 2) {
    return t(hops === 1 ? 'confidence.relay' : 'confidence.relays', { count: hops });
  }

  return t('confidence.wide');
}

function ensureSmartShareSelection(alerts) {
  const validIds = new Set(alerts.map((alert) => alert.id));
  Array.from(shareSelectedIds).forEach((id) => {
    if (!validIds.has(id)) {
      shareSelectedIds.delete(id);
    }
  });

  if (shareSelectionInitialized && (shareSelectionTouched || shareSelectedIds.size > 0)) {
    return;
  }

  const nowSeconds = Date.now() / 1000;
  alerts.forEach((alert) => {
    const priority = Number(alert.priority ?? 0);
    const ageHours = (nowSeconds - Number(alert.created ?? 0)) / 3600;

    if (priority >= 4 || (priority === 3 && ageHours < 6)) {
      shareSelectedIds.add(alert.id);
    }
  });
  shareSelectionInitialized = true;
}

function getSelectedAlertsFromList(alerts) {
  return alerts.filter((alert) => shareSelectedIds.has(alert.id));
}

async function getSelectedShareAlerts() {
  const alerts = getPublicAlerts(sortAlerts(await getAllAlerts()));
  return getSelectedAlertsFromList(alerts);
}

function getBundleCounter(alerts) {
  if (!alerts.length) {
    return t('share.bundleCounter', { count: 0, label: t('app.alerts'), kb: '0.0' });
  }

  const size = estimateSize(alerts);
  return t('share.bundleCounter', {
    count: alerts.length,
    label: alerts.length === 1 ? t('app.alert') : t('app.alerts'),
    kb: (size.bytes / 1024).toFixed(1)
  });
}

async function refreshShareCounter() {
  if (window.location.hash !== '#share') {
    return;
  }

  const counter = document.querySelector('#shareBundleCounter');

  if (!counter) {
    return;
  }

  const selectedAlerts = await getSelectedShareAlerts();
  counter.textContent = getBundleCounter(selectedAlerts);
}

async function handleShareAsQr() {
  const selectedAlerts = await getSelectedShareAlerts();

  if (!selectedAlerts.length) {
    showToast(t('share.selectAtLeastOne'), 'error');
    return;
  }

  const payload = serializeSharePayload(selectedAlerts);
  const chunks = generateChunks(payload.data, SHARE_QR_MAX_SIZE);
  stopShareQrAnimation();

  if (chunks.length === 1) {
    await renderQR(payload.data, 'shareQrCanvas');
    updateShareQrIndicator(t('share.staticReady'));
    return;
  }

  const frames = chunks.map((chunk) => JSON.stringify(chunk));
  shareQrFrameIndex = 0;
  await renderAnimatedQrFrame(frames);
  shareQrIntervalId = window.setInterval(() => {
    void renderAnimatedQrFrame(frames);
  }, 900);
}

async function handleVillagePoster() {
  const selectedAlerts = await getSelectedShareAlerts();

  if (!selectedAlerts.length) {
    showToast(t('share.posterSelect'), 'error');
    return;
  }

  const poster = document.querySelector('#villagePoster');
  const posterList = document.querySelector('#posterQrList');
  const subtitle = document.querySelector('#posterSubtitle');
  const meta = document.querySelector('#posterMeta');
  const payload = serializeSharePayload(selectedAlerts);
  const chunks = generateChunks(payload.data, SHARE_QR_MAX_SIZE);

  if (poster instanceof HTMLElement) {
    poster.style.display = 'block';
  }

  if (subtitle) {
    subtitle.textContent = t('share.posterSubtitleCount', {
      count: selectedAlerts.length,
      label: selectedAlerts.length === 1 ? t('app.alert') : t('app.alerts')
    });
  }

  if (meta) {
    meta.textContent =
      chunks.length === 1
        ? getBundleCounter(selectedAlerts)
        : t('share.posterChunk', { counter: getBundleCounter(selectedAlerts), total: chunks.length });
  }

  if (posterList instanceof HTMLElement) {
    if (chunks.length === 1) {
      posterList.innerHTML = `
        <canvas class="poster-qr" id="posterQrCanvas" width="320" height="320" aria-label="${escapeHtml(t('share.posterTitle'))}"></canvas>
      `;
      await renderQR(payload.data, 'posterQrCanvas');
    } else {
      posterList.innerHTML = chunks
        .map(
          (chunk) => `
            <div class="poster-chunk">
              <canvas
                class="poster-qr"
                id="posterQrCanvas${chunk.c}"
                width="320"
                height="320"
                aria-label="${escapeHtml(t('share.posterChunkLabel', { current: chunk.c, total: chunk.t }))}"
              ></canvas>
              <div class="poster-meta">${escapeHtml(t('share.posterChunkLabel', { current: chunk.c, total: chunk.t }))}</div>
            </div>
          `
        )
        .join('');

      for (const chunk of chunks) {
        await renderQR(JSON.stringify(chunk), `posterQrCanvas${chunk.c}`);
      }
    }
  }

  showToast(t('share.posterReady'), 'success');
}

function serializeSharePayload(selectedAlerts) {
  return selectedAlerts.length === 1 ? serializeForQR(selectedAlerts[0]) : serializeForQR(selectedAlerts);
}

async function renderAnimatedQrFrame(frames) {
  const frameNumber = (shareQrFrameIndex % frames.length) + 1;
  await renderQR(frames[shareQrFrameIndex % frames.length], 'shareQrCanvas');
  updateShareQrIndicator(t('share.animatedFrame', { current: frameNumber, total: frames.length }));
  shareQrFrameIndex = (shareQrFrameIndex + 1) % frames.length;
}

async function handleLocalNewsShareQr() {
  try {
    const broadcasts = await getLocalNewsBroadcasts();

    if (!broadcasts.length) {
      showToast(t('news.noBroadcasts'), 'error');
      return;
    }

    const payload = serializeSharePayload(broadcasts);
    const chunks = generateChunks(payload.data, SHARE_QR_MAX_SIZE);
    stopNewsQrAnimation();

    if (chunks.length === 1) {
      await renderQR(payload.data, 'newsQrCanvas');
      updateElementText('newsQrIndicator', t('news.qrReady'));
      return;
    }

    const frames = chunks.map((chunk) => JSON.stringify(chunk));
    newsQrFrameIndex = 0;
    await renderNewsQrFrame(frames);
    newsQrIntervalId = window.setInterval(() => {
      void renderNewsQrFrame(frames);
    }, 900);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function renderNewsQrFrame(frames) {
  const frameNumber = (newsQrFrameIndex % frames.length) + 1;

  await renderQR(frames[newsQrFrameIndex % frames.length], 'newsQrCanvas');
  updateElementText('newsQrIndicator', t('share.animatedFrame', { current: frameNumber, total: frames.length }));
  newsQrFrameIndex = (newsQrFrameIndex + 1) % frames.length;
}

function updateShareQrIndicator(message) {
  const indicator = document.querySelector('#shareQrIndicator');

  if (indicator) {
    indicator.textContent = message;
  }
}

function stopShareQrAnimation() {
  if (!shareQrIntervalId) {
    return;
  }

  window.clearInterval(shareQrIntervalId);
  shareQrIntervalId = undefined;
  shareQrFrameIndex = 0;
}

function stopNewsQrAnimation() {
  if (!newsQrIntervalId) {
    return;
  }

  window.clearInterval(newsQrIntervalId);
  newsQrIntervalId = undefined;
  newsQrFrameIndex = 0;
}

function makeConnectQrFrames(payload) {
  const session = makePayloadSessionId(payload);
  const chunks = generateChunks(payload, CONNECT_QR_MAX_SIZE);
  return chunks.length === 1
    ? [payload]
    : chunks.map((chunk) =>
      JSON.stringify({
        k: 'sdp',
        s: session,
        l: payload.length,
        c: chunk.c,
        t: chunk.t,
        d: chunk.d
      })
    );
}

function makePayloadSessionId(payload) {
  let hash = 0x811c9dc5;
  const text = String(payload ?? '');

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(36).padStart(7, '0');
}

async function renderConnectPayloadQr(payload, canvasId, infoId, singleInfoKey, chunkInfoKey) {
  const frames = makeConnectQrFrames(payload);

  stopConnectQrAnimation();

  if (frames.length === 1) {
    await renderQR(payload, canvasId);
    updateElementText(infoId, t(singleInfoKey, { bytes: payload.length }));
    return;
  }

  connectQrFrameIndex = 0;
  await renderConnectQrFrame(frames, canvasId, infoId, chunkInfoKey, payload.length);
  connectQrIntervalId = window.setInterval(() => {
    void renderConnectQrFrame(frames, canvasId, infoId, chunkInfoKey, payload.length);
  }, CONNECT_QR_FRAME_MS);
}

async function renderConnectQrFrame(frames, canvasId, infoId, chunkInfoKey, bytes) {
  const frameIndex = connectQrFrameIndex % frames.length;
  const current = frameIndex + 1;

  await renderQR(frames[frameIndex], canvasId);
  updateElementText(infoId, t(chunkInfoKey, { bytes, current, total: frames.length }));
  connectQrFrameIndex = (connectQrFrameIndex + 1) % frames.length;
}

function stopConnectQrAnimation() {
  if (!connectQrIntervalId) {
    return;
  }

  window.clearInterval(connectQrIntervalId);
  connectQrIntervalId = undefined;
  connectQrFrameIndex = 0;
}

async function handleStartScan() {
  if (scannerActive) {
    updateScanStatus(t('scan.running'), 'info');
    return;
  }

  await startScanner('qrScanner', async (decodedText) => {
    await handleScanPayload(decodedText);
  });
  scannerActive = true;
  updateScanStatus(t('scan.active'), 'info');
}

async function stopActiveScanner() {
  if (!scannerActive) {
    return;
  }

  try {
    await stopScanner();
  } catch (error) {
    console.warn(error);
  } finally {
    scannerActive = false;
  }
}

async function handleScanPayload(decodedText) {
  const text = String(decodedText ?? '').trim();

  if (!text) {
    return;
  }

  const chunk = parseChunkPayload(text);

  if (chunk) {
    await handleScanChunk(chunk);
    return;
  }

  const parsed = deserializeFromQR(text);
  await saveScannedAlerts(parsed);
}

async function handleScanChunk(chunk) {
  scanChunkTotal = chunk.t;

  if (!scanChunks.has(chunk.c)) {
    scanChunks.set(chunk.c, chunk.d);
  }

  updateScanChunkProgress(t('scan.chunk', { current: chunk.c, total: chunk.t }));

  if (scanChunks.size !== chunk.t) {
    updateScanStatus(t('scan.chunksCollected', { count: scanChunks.size, total: chunk.t }), 'info');
    return;
  }

  const joined = Array.from({ length: chunk.t }, (_, index) => scanChunks.get(index + 1) ?? '').join('');
  scanChunks.clear();
  scanChunkTotal = 0;
  const parsed = deserializeFromQR(joined);
  await saveScannedAlerts(parsed);
}

async function saveScannedAlerts(parsed) {
  try {
    const stats = await saveIncomingAlerts(parsed);

    if (!stats.relayable) {
      updateScanStatus(t('scan.noRelay'), 'error');
      showToast(t('scan.noRelay'), 'error');
      return;
    }

    if (stats.saved > 0) {
      stats.alerts.forEach((alert) => {
        broadcastLiveAlert(alert);
      });
    }

    updateScanStatus(t('scan.saved', { saved: stats.saved, skipped: stats.skipped }), 'success');
    showToast(
      t('scan.savedToast', {
        count: stats.saved,
        label: stats.saved === 1 ? t('app.alert') : t('app.alerts')
      }),
      'success'
    );
  } catch (error) {
    updateScanStatus(error.message, 'error');
    showToast(error.message, 'error');
  }
}

async function saveIncomingAlerts(parsed) {
  try {
    const incomingAlerts = Array.isArray(parsed) ? parsed : [parsed];
    const relayedAlerts = [];
    let skipped = 0;

    for (const alert of incomingAlerts) {
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
        skipped,
        relayable: 0
      };
    }

    const stats = await bulkSave(relayedAlerts);

    return {
      saved: stats.saved,
      skipped: stats.skipped + skipped,
      relayable: relayedAlerts.length,
      alerts: relayedAlerts
    };
  } catch (error) {
    throw new Error(t('scan.saveIncomingFailed', { message: error.message }));
  }
}

function parseChunkPayload(text) {
  try {
    const parsed = JSON.parse(text);

    if (parsed?.k === 'sdp') {
      return null;
    }

    const c = Number(parsed?.c);
    const t = Number(parsed?.t);
    const d = String(parsed?.d ?? '');

    if (!Number.isInteger(c) || !Number.isInteger(t) || c < 1 || t < 1 || c > t || !d) {
      return null;
    }

    return { c, t, d };
  } catch (error) {
    return null;
  }
}

function parseConnectChunkPayload(text) {
  try {
    const parsed = JSON.parse(text);

    if (parsed?.k !== 'sdp') {
      return null;
    }

    const c = Number(parsed?.c);
    const t = Number(parsed?.t);
    const l = Number(parsed?.l);
    const s = String(parsed?.s ?? '');
    const d = String(parsed?.d ?? '');

    if (
      !Number.isInteger(c) ||
      !Number.isInteger(t) ||
      !Number.isInteger(l) ||
      c < 1 ||
      t < 1 ||
      l < 1 ||
      c > t ||
      !s ||
      !d
    ) {
      return null;
    }

    return { c, t, l, s, d };
  } catch (error) {
    return null;
  }
}

function handleConnectChunk(chunk) {
  if (connectChunkSession && connectChunkSession !== chunk.s) {
    clearConnectScanChunks();
  }

  connectChunkSession = chunk.s;
  connectChunkTotal = chunk.t;
  connectChunkLength = chunk.l;

  if (!connectScanChunks.has(chunk.c)) {
    connectScanChunks.set(chunk.c, chunk.d);
  }

  updateConnectStatus(
    t('connect.chunkScanned', {
      current: chunk.c,
      total: chunk.t,
      count: connectScanChunks.size
    }),
    'info'
  );

  if (connectScanChunks.size !== chunk.t) {
    return null;
  }

  const joined = Array.from({ length: chunk.t }, (_, index) => connectScanChunks.get(index + 1) ?? '').join('');

  if (joined.length !== connectChunkLength || makePayloadSessionId(joined) !== connectChunkSession) {
    clearConnectScanChunks();
    throw new Error(t('connect.chunkMismatch'));
  }

  clearConnectScanChunks();
  updateConnectStatus(t('connect.chunksComplete', { total: chunk.t }), 'info');
  return joined;
}

function clearConnectScanChunks() {
  connectScanChunks.clear();
  connectChunkSession = null;
  connectChunkTotal = 0;
  connectChunkLength = 0;
}

function updateScanStatus(message, type = 'info') {
  const status = document.querySelector('#scanStatus');

  if (!status) {
    return;
  }

  status.textContent = message;
  status.classList.toggle('success', type === 'success');
  status.classList.toggle('error', type === 'error');
}

function updateScanChunkProgress(message) {
  const progress = document.querySelector('#scanChunkProgress');

  if (progress) {
    progress.textContent = message;
  }
}

async function chooseConnectRole(role) {
  try {
    const normalizedRole = role === 'b' ? 'b' : 'a';

    await resetConnectSession(false);
    connectRole = normalizedRole;
    connectStatusText = normalizedRole === 'a' ? t('connect.aStatus') : t('connect.bStatus');
    connectStatusType = 'info';
    await render();

    if (normalizedRole === 'a') {
      await prepareDeviceAOffer();
      return;
    }

    updateConnectStatus(t('connect.bReady'), 'info');
  } catch (error) {
    updateConnectStatus(error.message, 'error');
    showToast(error.message, 'error');
  }
}

async function prepareDeviceAOffer() {
  try {
    updateConnectStatus(t('connect.aStatus'), 'info');
    const offer = await createP2POffer();

    connectPc = offer.pc;
    connectChannel = offer.channel;
    connectGossipStarted = false;
    attachConnectPeerListeners(offer.pc);
    setupConnectChannel(offer.channel, offer.pc);
    startConnectTimeout();

    await renderConnectPayloadQr(
      offer.compressed,
      'connectOfferCanvas',
      'connectOfferInfo',
      'connect.offerReadyInfo',
      'connect.offerChunkInfo'
    );
    updateConnectStatus(t('connect.offerReady'), 'info');
  } catch (error) {
    closeConnectTransport(true);
    updateConnectStatus(error.message, 'error');
    showToast(error.message, 'error');
  }
}

async function startConnectScanner(mode) {
  try {
    if (!['offer', 'answer'].includes(mode)) {
      throw new Error(t('connect.chooseScan'));
    }

    if (mode === 'answer' && (!connectPc || connectRole !== 'a')) {
      throw new Error(t('connect.needOffer'));
    }

    if (mode === 'offer' && connectRole !== 'b') {
      throw new Error(t('connect.needDeviceB'));
    }

    await stopActiveScanner();
    await stopConnectScanner();
    connectScanMode = mode;
    connectScanBusy = false;
    clearConnectScanChunks();
    await startScanner('connectScanner', async (decodedText) => {
      await handleConnectScanPayload(decodedText);
    });
    connectScannerActive = true;
    updateConnectStatus(
      mode === 'offer' ? t('connect.scanOfferActive') : t('connect.scanAnswerActive'),
      'info'
    );
  } catch (error) {
    connectScannerActive = false;
    updateConnectStatus(error.message, 'error');
    showToast(error.message, 'error');
  }
}

async function stopConnectScanner() {
  try {
    if (!connectScannerActive) {
      return;
    }

    await stopScanner();
    connectScannerActive = false;
    connectScanMode = null;
    connectScanBusy = false;
  } catch (error) {
    connectScannerActive = false;
    throw new Error(t('connect.stopScannerFailed', { message: error.message }));
  }
}

async function handleConnectScanPayload(decodedText) {
  try {
    if (connectScanBusy) {
      return;
    }

    connectScanBusy = true;
    let compressed = String(decodedText ?? '').trim();
    const mode = connectScanMode;

    if (!compressed) {
      throw new Error(t('connect.emptyQr'));
    }

    const chunk = parseConnectChunkPayload(compressed);

    if (chunk) {
      const completedPayload = handleConnectChunk(chunk);
      connectScanBusy = false;

      if (!completedPayload) {
        return;
      }

      compressed = completedPayload;
      connectScanBusy = true;
    }

    await stopConnectScanner();
    clearConnectScanChunks();

    if (mode === 'offer') {
      await acceptConnectOffer(compressed);
      return;
    }

    if (mode === 'answer') {
      await completeConnectAnswer(compressed);
      return;
    }

    throw new Error(t('connect.chooseScanStep'));
  } catch (error) {
    connectScanBusy = false;
    updateConnectStatus(error.message, 'error');
    showToast(error.message, 'error');
  }
}

async function acceptConnectOffer(compressed) {
  try {
    updateConnectStatus(t('connect.offerScanned'), 'info');
    const answer = await acceptOffer(compressed);

    connectPc = answer.pc;
    connectChannel = answer.channel;
    connectGossipStarted = false;
    attachConnectPeerListeners(answer.pc);
    startConnectTimeout();

    answer.channelPromise
      .then((channel) => {
        if (answer.pc === connectPc || findMeshPeerByPc(answer.pc)) {
          setupConnectChannel(channel, answer.pc);
        }
      })
      .catch((error) => {
        updateConnectStatus(t('connect.dataChannelFailed', { message: error.message }), 'error');
      });

    showConnectAnswerPanel();
    await renderConnectPayloadQr(
      answer.compressed,
      'connectAnswerCanvas',
      'connectAnswerInfo',
      'connect.answerReadyInfo',
      'connect.answerChunkInfo'
    );
    updateConnectStatus(t('connect.answerReady'), 'info');
  } catch (error) {
    closeConnectTransport(true);
    updateConnectStatus(error.message, 'error');
    showToast(error.message, 'error');
  }
}

async function completeConnectAnswer(compressed) {
  try {
    if (!connectPc) {
      throw new Error(t('connect.noDeviceA'));
    }

    updateConnectStatus(t('connect.answerScanned'), 'info');
    await completeConnection(connectPc, compressed);
    updateConnectStatus(t('connect.answerAccepted'), 'info');

    if (connectChannel?.readyState === 'open') {
      await handleConnectOpen(connectChannel);
    }
  } catch (error) {
    updateConnectStatus(error.message, 'error');
    showToast(error.message, 'error');
  }
}

async function resetConnectSession(keepRole = false) {
  try {
    await stopConnectScanner();
    clearConnectTimeout();
    closeConnectTransport();
    connectScanMode = null;
    connectScanBusy = false;
    connectGossipStarted = false;
    connectPreparingNextOffer = false;
    clearConnectScanChunks();
    stopConnectQrAnimation();
    connectStatusText = keepRole ? t('connect.reset') : t('connect.chooseRole');
    connectStatusType = 'info';
    connectSyncText = t('connect.syncIdle');
    connectLastSyncPhase = 'idle';

    if (!keepRole) {
      connectRole = null;
    }
  } catch (error) {
    connectStatusText = error.message;
    connectStatusType = 'error';
  }
}

function findMeshPeerByChannel(channel) {
  if (!channel) {
    return null;
  }

  for (const peer of meshPeers.values()) {
    if (peer.channel === channel) {
      return peer;
    }
  }

  return null;
}

function findMeshPeerByPc(pc) {
  if (!pc) {
    return null;
  }

  for (const peer of meshPeers.values()) {
    if (peer.pc === pc) {
      return peer;
    }
  }

  return null;
}

function isKnownConnectPc(pc) {
  return Boolean(pc && (pc === connectPc || findMeshPeerByPc(pc)));
}

function getOpenMeshChannels(excludedChannel = null) {
  const channels = [];

  for (const peer of meshPeers.values()) {
    if (peer.channel && peer.channel !== excludedChannel && peer.channel.readyState === 'open') {
      channels.push(peer.channel);
    }
  }

  return channels;
}

function updateConnectStatusForRemainingPeers(excludedChannel = null, fallbackMessage = t('connect.lost')) {
  const remainingCount = getOpenMeshChannels(excludedChannel).length;

  if (remainingCount > 0) {
    updateConnectStatus(getCommunityPeerLabel(remainingCount), 'success');
    return true;
  }

  updateConnectStatus(fallbackMessage, 'error');
  return false;
}

function removeMeshPeer(peerId, closeTransport = false) {
  const peer = meshPeers.get(peerId);

  if (!peer) {
    return;
  }

  if (typeof peer.cleanup === 'function') {
    peer.cleanup();
  }

  meshPeers.delete(peerId);

  if (closeTransport) {
    try {
      if (peer.channel && peer.channel.readyState !== 'closed') {
        peer.channel.close();
      }
    } catch (error) {
      console.warn(error);
    }

    try {
      if (peer.pc) {
        peer.pc.close();
      }
    } catch (error) {
      console.warn(error);
    }
  }

  if (connectChannel === peer.channel) {
    connectChannel = null;
    connectChannelCleanup = null;
  }

  if (connectPc === peer.pc) {
    connectPc = null;
  }

  updateCommunityChatUi();
}

function setupConnectChannel(channel, pc = connectPc) {
  if (!channel) {
    return;
  }

  const existingPeer = findMeshPeerByChannel(channel);

  if (existingPeer) {
    existingPeer.pc = pc || existingPeer.pc || connectPc;
    connectPc = existingPeer.pc;
    connectChannel = channel;
    connectChannelCleanup = existingPeer.cleanup;

    if (channel.readyState === 'open') {
      void handleConnectOpen(channel);
    }

    return;
  }

  const peer = {
    id: `mesh-peer-${meshPeerCounter += 1}`,
    pc: pc || connectPc,
    channel,
    cleanup: null,
    heartbeatId: undefined,
    connected: channel.readyState === 'open',
    gossipStarted: false
  };

  meshPeers.set(peer.id, peer);
  connectPc = peer.pc;
  connectChannel = channel;

  const handleOpen = () => {
    void handleConnectOpen(channel);
  };
  const handleClose = () => {
    const isActiveChannel = channel === connectChannel;
    const wasPending = !peer.gossipStarted;

    removeMeshPeer(peer.id, false);

    if (isActiveChannel && wasPending) {
      updateConnectStatusForRemainingPeers(channel, t('connect.channelClosed'));
    }
  };
  const handleError = () => {
    if (channel === connectChannel || findMeshPeerByChannel(channel)) {
      updateConnectStatusForRemainingPeers(channel, t('connect.channelError'));
    }
  };

  channel.addEventListener('open', handleOpen);
  channel.addEventListener('close', handleClose);
  channel.addEventListener('error', handleError);
  const cleanupLiveAlerts = onMessage(channel, (message) => {
    handleCommunityHeartbeatMessage(message, channel);
    void handleLiveAlertMessage(message, channel);
    void handleCommunityChatMessage(message, channel);
  });
  peer.cleanup = () => {
    if (peer.heartbeatId) {
      window.clearInterval(peer.heartbeatId);
      peer.heartbeatId = undefined;
    }

    channel.removeEventListener('open', handleOpen);
    channel.removeEventListener('close', handleClose);
    channel.removeEventListener('error', handleError);
    cleanupLiveAlerts();
  };
  connectChannelCleanup = peer.cleanup;

  if (channel.readyState === 'open') {
    void handleConnectOpen(channel);
  }
}

function broadcastLiveAlert(alert, excludedChannel = null) {
  try {
    const openChannels = getOpenMeshChannels(excludedChannel);

    if (
      connectChannel &&
      connectChannel !== excludedChannel &&
      connectChannel.readyState === 'open' &&
      !openChannels.includes(connectChannel)
    ) {
      openChannels.push(connectChannel);
    }

    if (openChannels.length === 0) {
      return false;
    }

    let sent = false;

    for (const channel of openChannels) {
      try {
        sendMessage(channel, {
          type: LIVE_ALERT_MESSAGE_TYPE,
          alert
        });
        sent = true;
      } catch (error) {
        console.warn(error);
      }
    }

    return sent;
  } catch (error) {
    console.warn(error);
    return false;
  }
}

async function handleLiveAlertMessage(message, channel) {
  try {
    if (!findMeshPeerByChannel(channel) || message?.type !== LIVE_ALERT_MESSAGE_TYPE) {
      return;
    }

    const relayedAlert = incrementHop(message.alert);

    if (!relayedAlert) {
      return;
    }

    const validation = validateAlert(relayedAlert);

    if (!validation.valid) {
      return;
    }

    const saved = await saveAlert(relayedAlert);

    if (!saved) {
      return;
    }

    broadcastLiveAlert(relayedAlert, channel);

    showToast(
      t('connect.liveSaved', {
        count: 1,
        label: t('app.alert')
      }),
      'success'
    );

    if (['#alerts', '#home', '#share', '#news'].includes(window.location.hash)) {
      await render();
    }
  } catch (error) {
    console.warn(error);
  }
}

async function submitCommunityChat(form) {
  try {
    const input = form.elements.namedItem('message');

    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    const text = input.value.trim();

    if (!text) {
      showToast(t('connect.communityEmpty'), 'error');
      return;
    }

    if (text.length > COMMUNITY_CHAT_MAX_LENGTH) {
      showToast(t('connect.communityTooLong', { max: COMMUNITY_CHAT_MAX_LENGTH }), 'error');
      return;
    }

    if (getOpenMeshChannels().length === 0) {
      showToast(t('connect.communityNoPeers'), 'error');
      return;
    }

    const chatMessage = createCommunityChatMessage(text);

    addCommunityChatMessage(chatMessage);
    broadcastCommunityChat(chatMessage);
    input.value = '';
    updateCommunityChatUi();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function handleCommunityChatMessage(message, channel) {
  try {
    if (!findMeshPeerByChannel(channel) || message?.type !== COMMUNITY_CHAT_MESSAGE_TYPE) {
      return;
    }

    const chatMessage = normalizeCommunityChatMessage(message.chat);

    if (!chatMessage || communityChatSeenIds.has(chatMessage.id) || isCommunityChatExpired(chatMessage)) {
      return;
    }

    if (chatMessage.hops >= chatMessage.maxHops) {
      return;
    }

    const relayedMessage = {
      ...chatMessage,
      hops: chatMessage.hops + 1,
      own: false
    };

    if (!addCommunityChatMessage(relayedMessage)) {
      return;
    }

    broadcastCommunityChat(relayedMessage, channel);
    updateCommunityChatUi();

    if (window.location.hash !== '#connect') {
      showToast(t('connect.communityReceived'), 'info');
    }
  } catch (error) {
    console.warn(error);
  }
}

function createCommunityChatMessage(text) {
  const now = Math.floor(Date.now() / 1000);

  return {
    id: createCommunityChatId(),
    text,
    created: now,
    ttl: COMMUNITY_CHAT_TTL_SECONDS,
    hops: 0,
    maxHops: 20,
    source: getCommunitySource(),
    own: true
  };
}

function normalizeCommunityChatMessage(chat) {
  if (!chat || typeof chat !== 'object') {
    return null;
  }

  const id = String(chat.id ?? '').trim();
  const text = String(chat.text ?? '').trim().slice(0, COMMUNITY_CHAT_MAX_LENGTH);
  const created = Number(chat.created);

  if (!id || !text || !Number.isFinite(created)) {
    return null;
  }

  return {
    id,
    text,
    created: Math.max(0, Math.floor(created)),
    ttl: clampNumber(chat.ttl, 60, 3600, COMMUNITY_CHAT_TTL_SECONDS),
    hops: clampNumber(chat.hops, 0, 20, 0),
    maxHops: clampNumber(chat.maxHops, 1, 20, 20),
    source: String(chat.source ?? t('connect.communityAnonymous')).slice(0, 40),
    own: false
  };
}

function createCommunityChatId() {
  const bytes = new Uint8Array(8);

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    bytes.forEach((_, index) => {
      bytes[index] = Math.floor(Math.random() * 256);
    });
  }

  return `${Date.now().toString(36)}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(number)));
}

function getCommunitySource() {
  if (demoModeActive) {
    return t(`connect.device${demoDevice.toUpperCase()}`);
  }

  return t('connect.communityAnonymous');
}

function getCommunitySourceLabel(message) {
  if (message.own) {
    return t('connect.communityYou');
  }

  return message.source || t('connect.communityAnonymous');
}

function getCommunityPeerLabel(peerCount = getOpenMeshChannels().length) {
  if (peerCount === 0) {
    return t('connect.communityNoPeers');
  }

  return t(peerCount === 1 ? 'connect.communityPeer' : 'connect.communityPeers', { count: peerCount });
}

function isCommunityChatExpired(message) {
  const expiresAt = (Number(message.created) + Number(message.ttl || COMMUNITY_CHAT_TTL_SECONDS)) * 1000;

  return Date.now() > expiresAt;
}

function addCommunityChatMessage(message) {
  if (!message?.id || communityChatSeenIds.has(message.id) || isCommunityChatExpired(message)) {
    return false;
  }

  communityChatSeenIds.add(message.id);
  communityChatMessages.push(message);
  // Persist to IndexedDB (non-blocking)
  saveChatMessage(message).catch((error) => {
    console.warn('chat persist failed:', error);
  });
  pruneCommunityChatMessages();
  return true;
}

function pruneCommunityChatMessages() {
  for (let index = communityChatMessages.length - 1; index >= 0; index -= 1) {
    if (isCommunityChatExpired(communityChatMessages[index])) {
      communityChatMessages.splice(index, 1);
    }
  }

  communityChatMessages.sort((left, right) => left.created - right.created);

  while (communityChatMessages.length > COMMUNITY_CHAT_MAX_MESSAGES) {
    communityChatMessages.shift();
  }
}

function getActiveCommunityChatMessages() {
  pruneCommunityChatMessages();
  return [...communityChatMessages];
}

function serializeCommunityChatMessage(message) {
  return {
    id: message.id,
    text: message.text,
    created: message.created,
    ttl: message.ttl,
    hops: message.hops,
    maxHops: message.maxHops,
    source: message.source
  };
}

function broadcastCommunityChat(message, excludedChannel = null) {
  const payload = {
    type: COMMUNITY_CHAT_MESSAGE_TYPE,
    chat: serializeCommunityChatMessage(message)
  };

  for (const channel of getOpenMeshChannels(excludedChannel)) {
    try {
      sendMessage(channel, payload);
    } catch (error) {
      console.warn(error);
    }
  }
}

function handleCommunityHeartbeatMessage(message, channel) {
  if (!findMeshPeerByChannel(channel) || message?.type !== COMMUNITY_HEARTBEAT_MESSAGE_TYPE) {
    return;
  }

  if (message.kind !== 'ping') {
    return;
  }

  try {
    sendMessage(channel, {
      type: COMMUNITY_HEARTBEAT_MESSAGE_TYPE,
      kind: 'pong',
      at: Date.now()
    });
  } catch (error) {
    console.warn(error);
  }
}

function startCommunityHeartbeat(peer) {
  if (!peer || peer.heartbeatId) {
    return;
  }

  peer.heartbeatId = window.setInterval(() => {
    try {
      if (!peer.channel || peer.channel.readyState !== 'open') {
        return;
      }

      sendMessage(peer.channel, {
        type: COMMUNITY_HEARTBEAT_MESSAGE_TYPE,
        kind: 'ping',
        at: Date.now()
      });
    } catch (error) {
      console.warn(error);
    }
  }, COMMUNITY_HEARTBEAT_MS);
}

function sendRecentCommunityChat(channel) {
  if (!channel || channel.readyState !== 'open') {
    return;
  }

  const recentMessages = getActiveCommunityChatMessages().slice(-20);

  recentMessages.forEach((message) => {
    try {
      sendMessage(channel, {
        type: COMMUNITY_CHAT_MESSAGE_TYPE,
        chat: serializeCommunityChatMessage(message)
      });
    } catch (error) {
      console.warn(error);
    }
  });
}

function updateCommunityChatUi() {
  const peerCount = getOpenMeshChannels().length;
  const peerElement = document.querySelector('#communityPeerCount');
  const listElement = document.querySelector('#communityChatList');
  const inputElement = document.querySelector('#communityChatInput');
  const sendButton = document.querySelector('.community-send-btn');

  if (peerElement) {
    peerElement.textContent = getCommunityPeerLabel(peerCount);
  }

  if (listElement) {
    listElement.innerHTML = renderCommunityChatMessages();
    listElement.scrollTop = listElement.scrollHeight;
  }

  if (inputElement instanceof HTMLInputElement) {
    inputElement.disabled = peerCount === 0;
  }

  if (sendButton instanceof HTMLButtonElement) {
    sendButton.disabled = peerCount === 0;
  }
}

async function handleConnectOpen(channel) {
  try {
    const peer = findMeshPeerByChannel(channel);

    if (!peer || peer.gossipStarted) {
      return;
    }

    peer.connected = true;
    peer.gossipStarted = true;
    connectPc = peer.pc;
    connectChannel = peer.channel;
    connectChannelCleanup = peer.cleanup;
    connectGossipStarted = true;
    startCommunityHeartbeat(peer);
    clearConnectTimeout();
    updateConnectStatus(t('connect.connected'), 'success');
    updateCommunityChatUi();
    showToast(t('connect.connectedToast'), 'success');
    prepareNextDeviceAOffer();
    await triggerGossipSync(channel);
    sendRecentCommunityChat(channel);
  } catch (error) {
    updateConnectStatus(error.message, 'error');
    showToast(error.message, 'error');
  }
}

function prepareNextDeviceAOffer() {
  if (connectRole !== 'a' || window.location.hash !== '#connect' || connectPreparingNextOffer) {
    return;
  }

  connectPreparingNextOffer = true;
  window.setTimeout(() => {
    void (async () => {
      try {
        if (connectRole !== 'a' || window.location.hash !== '#connect') {
          return;
        }

        await stopConnectScanner();
        clearConnectScanChunks();
        connectPc = null;
        connectChannel = null;
        connectChannelCleanup = null;
        connectGossipStarted = false;
        await prepareDeviceAOffer();
      } catch (error) {
        updateConnectStatus(error.message, 'error');
      } finally {
        connectPreparingNextOffer = false;
      }
    })();
  }, 300);
}

async function triggerGossipSync(channel) {
  try {
    if (!channel || channel.readyState !== 'open') {
      return {
        sent: 0,
        received: 0
      };
    }

    if (syncingChannels.has(channel)) {
      return {
        sent: 0,
        received: 0
      };
    }

    syncingChannels.add(channel);
    connectLastSyncPhase = 'start';
    updateConnectProgress(t('connect.startSync'));
    const stats = await startSync(channel);
    const partial = ['timeout', 'closed', 'channel-error'].includes(connectLastSyncPhase);

    if (partial) {
      updateConnectStatus(t('connect.syncPartial', stats), 'error');
      updateConnectProgress(t('connect.progressPartial', stats));
      showToast(t('connect.toastPartial', stats), 'info');
      fanoutGossipSync(channel, stats);
      return stats;
    }

    updateConnectStatus(t('connect.syncComplete', stats), 'success');
    updateConnectProgress(t('connect.progressComplete', stats));
    showToast(t('connect.toastComplete', stats), 'success');
    fanoutGossipSync(channel, stats);
    return stats;
  } catch (error) {
    updateConnectStatus(t('connect.gossipFailed', { message: error.message }), 'error');
    updateConnectProgress(t('connect.syncFailed'));
    return {
      sent: 0,
      received: 0
    };
  } finally {
    if (channel) {
      syncingChannels.delete(channel);
    }
  }
}

function fanoutGossipSync(sourceChannel, stats) {
  if (!stats || Number(stats.received) <= 0) {
    return;
  }

  for (const channel of getOpenMeshChannels(sourceChannel)) {
    if (!syncingChannels.has(channel)) {
      void triggerGossipSync(channel);
    }
  }
}

function attachConnectPeerListeners(pc) {
  pc.addEventListener('connectionstatechange', () => {
    if (!isKnownConnectPc(pc)) {
      return;
    }

    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      const peer = findMeshPeerByPc(pc);
      const isActivePeer = pc === connectPc;

      if (peer) {
        removeMeshPeer(peer.id, true);
      }

      if (updateConnectStatusForRemainingPeers(peer?.channel ?? null, t('connect.lost'))) {
        return;
      }

      if (!isActivePeer) {
        return;
      }

      updateConnectStatus(t('connect.lost'), 'error');
      return;
    }

    if (pc.connectionState === 'disconnected' && pc === connectPc && getOpenMeshChannels().length === 0) {
      updateConnectStatus(t('connect.lost'), 'error');
    }
  });
  pc.addEventListener('iceconnectionstatechange', () => {
    const peer = findMeshPeerByPc(pc);

    if (!isKnownConnectPc(pc) || peer?.gossipStarted || (pc === connectPc && connectGossipStarted)) {
      return;
    }

    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      updateConnectStatusForRemainingPeers(peer?.channel ?? null, t('connect.lanFailed'));
    }
  });
}

function startConnectTimeout() {
  clearConnectTimeout();
  connectTimeoutId = window.setTimeout(() => {
    const peer = findMeshPeerByChannel(connectChannel) || findMeshPeerByPc(connectPc);

    if (peer?.connected || peer?.gossipStarted || connectGossipStarted) {
      return;
    }

    void stopConnectScanner();
    const timeoutChannel = peer?.channel ?? connectChannel;
    closeConnectTransport(true);
    updateConnectStatusForRemainingPeers(timeoutChannel, t('connect.timeout'));
  }, CONNECT_TIMEOUT_MS);
}

function clearConnectTimeout() {
  if (!connectTimeoutId) {
    return;
  }

  window.clearTimeout(connectTimeoutId);
  connectTimeoutId = undefined;
}

function closeConnectTransport(closeMeshPeer = false) {
  const activePeer = findMeshPeerByChannel(connectChannel) || findMeshPeerByPc(connectPc);

  if (activePeer) {
    if (closeMeshPeer || (!activePeer.connected && !activePeer.gossipStarted)) {
      removeMeshPeer(activePeer.id, true);
      connectGossipStarted = false;
      return;
    }

    connectChannel = null;
    connectPc = null;
    connectChannelCleanup = null;
    connectGossipStarted = false;
    return;
  }

  if (connectChannelCleanup) {
    connectChannelCleanup();
    connectChannelCleanup = null;
  }

  if (connectChannel && connectChannel.readyState !== 'closed') {
    connectChannel.close();
  }

  if (connectPc) {
    connectPc.close();
  }

  connectChannel = null;
  connectPc = null;
}

function showConnectAnswerPanel() {
  const panel = document.querySelector('#connectAnswerPanel');

  if (panel instanceof HTMLElement) {
    panel.hidden = false;
  }
}

function updateElementText(id, text) {
  const element = document.getElementById(id);

  if (element) {
    element.textContent = text;
  }
}

function handleGossipProgress(event) {
  const detail = event?.detail ?? null;

  if (!detail || window.location.hash !== '#connect') {
    return;
  }

  const message = String(detail.message || t('connect.syncing'));
  connectLastSyncPhase = String(detail.phase || 'sync');
  updateConnectProgress(message);

  if (['complete', 'timeout', 'closed', 'channel-error'].includes(detail.phase)) {
    const type = detail.phase === 'complete' ? 'success' : 'error';
    updateConnectStatus(message, type);
  }
}

function updateConnectProgress(message) {
  connectSyncText = message;
  updateElementText('connectSyncProgress', message);
}

function updateConnectStatus(message, type = 'info') {
  connectStatusText = message;
  connectStatusType = ['success', 'error', 'info'].includes(type) ? type : 'info';
  const status = document.querySelector('#connectStatus');

  if (!status) {
    return;
  }

  status.textContent = message;
  status.classList.toggle('success', connectStatusType === 'success');
  status.classList.toggle('error', connectStatusType === 'error');
}

function sortAlerts(alerts) {
  return [...alerts].sort((left, right) => {
    const priorityDiff = Number(right.priority ?? 0) - Number(left.priority ?? 0);

    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    return Number(right.created ?? 0) - Number(left.created ?? 0);
  });
}

function normalizeAlertType(type) {
  const normalized = String(type || 'notice').toLowerCase();
  return CATEGORIES.some((category) => category.type === normalized) ? normalized : 'notice';
}

function normalizeFilterType(type) {
  const normalized = String(type || 'all').toLowerCase();
  return FILTERS.some((filter) => filter.type === normalized) ? normalized : 'all';
}

function startAlertAutoRefresh() {
  if (alertRefreshIntervalId) {
    return;
  }

  alertRefreshIntervalId = window.setInterval(() => {
    if (window.location.hash !== '#alerts') {
      stopAlertAutoRefresh();
      return;
    }

    void render();
  }, 30000);
}

function stopAlertAutoRefresh() {
  if (!alertRefreshIntervalId) {
    return;
  }

  window.clearInterval(alertRefreshIntervalId);
  alertRefreshIntervalId = undefined;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function handleBeforeInstallPrompt(event) {
  deferredInstallPrompt = event;
}

function handleAppInstalled() {
  deferredInstallPrompt = null;
  closeModal();
  showToast(t('pwa.installed'), 'success');
}

function isRunningStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: fullscreen)').matches ||
    window.navigator?.standalone === true
  );
}

function handleServiceWorkerStatus(status, error) {
  if (status === 'offline-ready') {
    showToast(t('pwa.offlineReady'), 'success');
    return;
  }

  if (status === 'update-ready') {
    showToast(t('pwa.updateReady'), 'info');
    return;
  }

  if (status === 'service-worker-error') {
    console.warn('JanVaani offline cache unavailable:', error);
  }
}

window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
window.addEventListener('appinstalled', handleAppInstalled);

window.addEventListener('hashchange', () => {
  void render();
});

window.addEventListener('DOMContentLoaded', () => {
  void bootJanVaani();
});

async function bootJanVaani() {
  try {
    await clearDevelopmentServiceWorkers();
    registerJanVaaniServiceWorker(handleServiceWorkerStatus);
    initShakeToWipe();
    applyDemoMode();

    // Hydrate community chat from IndexedDB
    try {
      const storedChats = await getAllChatMessages();
      for (const msg of storedChats) {
        if (!communityChatSeenIds.has(msg.id)) {
          communityChatSeenIds.add(msg.id);
          communityChatMessages.push(msg);
        }
      }
    } catch (error) {
      console.warn('chat hydration failed:', error);
    }

    if (!ROUTES.has(window.location.hash)) {
      window.location.hash = '#home';
      return;
    }

    await render();
  } catch (error) {
    showToast(t('error.render', { message: error.message }), 'error');
    initShakeToWipe();
    applyDemoMode();
    await render();
  }
}

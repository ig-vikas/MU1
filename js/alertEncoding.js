export const JV_PREFIX = 'JV_';
export const MAX_BLE_NAME_LENGTH = 24;
export const MIN_CODE_LENGTH = 1;

const VALID_JV_ALERT_RE = /^JV_[A-Z0-9_]+$/;
const TAG_RE = /<[^>]*>/g;
const WORD_REPLACEMENTS = new Map([
  ['MEDICAL', 'MED'],
  ['MEDICINE', 'MED'],
  ['MEDIC', 'MED'],
  ['DOCTOR', 'MED'],
  ['AMBULANCE', 'MED'],
  ['EVACUATE', 'EVAC'],
  ['EVACUATION', 'EVAC'],
  ['MARKET', 'MKT'],
  ['ROAD', 'RD'],
  ['STREET', 'RD'],
  ['SCHOOL', 'SCH'],
  ['BRIDGE', 'BRDG'],
  ['WATER', 'WTR'],
  ['SHELTER', 'SHLTR'],
  ['BLOCK', 'BLOCKED'],
  ['BLOCKAGE', 'BLOCKED'],
  ['BLOCKED', 'BLOCKED'],
  ['NEEDED', 'NEED'],
  ['NEEDS', 'NEED'],
  ['REQUIRED', 'NEED'],
  ['ASSISTANCE', 'HELP'],
  ['SAFEZONE', 'SAFE_ZONE']
]);

const STOP_WORDS = new Set([
  'A',
  'AN',
  'AND',
  'ARE',
  'AT',
  'BY',
  'FOR',
  'FROM',
  'IN',
  'IS',
  'NEAR',
  'OF',
  'ON',
  'PLEASE',
  'THE',
  'TO'
]);

const EVENT_PRIORITY = [
  'FIRE',
  'MED',
  'EVAC',
  'FLOOD',
  'HELP',
  'WTR',
  'FOOD',
  'RD',
  'SAFE',
  'SHLTR'
];

export const PRESET_ALERTS = Object.freeze([
  { label: 'FIRE', name: 'JV_FIRE' },
  { label: 'MEDICAL HELP', name: 'JV_MED_NEED' },
  { label: 'EVACUATE', name: 'JV_EVAC' },
  { label: 'WATER NEEDED', name: 'JV_WTR_NEED' },
  { label: 'FOOD NEEDED', name: 'JV_FOOD_NEED' },
  { label: 'ROAD BLOCKED', name: 'JV_RD_BLOCKED' },
  { label: 'SAFE ZONE', name: 'JV_SAFE_ZONE' },
  { label: 'HELP NEEDED', name: 'JV_HELP_NEED' },
  { label: 'FLOOD', name: 'JV_FLOOD' },
  { label: 'SHELTER NEEDED', name: 'JV_SHLTR_NEED' }
]);

/**
 * Strictly checks whether a BLE local name is a JanVaani alert.
 * @param {unknown} name - Candidate BLE name.
 * @returns {boolean} True when valid.
 */
export function isValidJVAlertName(name) {
  const value = String(name ?? '').trim();
  return (
    value.length >= JV_PREFIX.length + MIN_CODE_LENGTH &&
    value.length <= MAX_BLE_NAME_LENGTH &&
    VALID_JV_ALERT_RE.test(value) &&
    !value.includes('__')
  );
}

/**
 * Sanitizes a string into an uppercase JV_ candidate.
 * @param {unknown} input - User input or BLE name.
 * @returns {string} Sanitized candidate.
 */
export function sanitizeAlertName(input) {
  const raw = String(input ?? '')
    .normalize('NFKC')
    .replace(TAG_RE, ' ')
    .toUpperCase()
    .replace(/&[A-Z0-9#]+;/g, ' ')
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!raw) {
    return '';
  }

  const withoutPrefix = raw.startsWith(JV_PREFIX) ? raw.slice(JV_PREFIX.length) : raw;
  return `${JV_PREFIX}${withoutPrefix}`;
}

/**
 * Shortens common emergency words while preserving strict BLE-name format.
 * @param {unknown} input - User text or candidate name.
 * @returns {string} Shortened JV candidate.
 */
export function shortenAlertName(input) {
  const sanitized = sanitizeAlertName(input);

  if (!sanitized) {
    return '';
  }

  const words = sanitized
    .slice(JV_PREFIX.length)
    .split('_')
    .filter(Boolean)
    .map((word) => WORD_REPLACEMENTS.get(word) ?? word)
    .filter((word) => !STOP_WORDS.has(word));

  const compactWords = prioritizeWords(words);
  let candidate = `${JV_PREFIX}${compactWords.join('_')}`;

  while (candidate.length > MAX_BLE_NAME_LENGTH && compactWords.length > 1) {
    compactWords.pop();
    candidate = `${JV_PREFIX}${compactWords.join('_')}`;
  }

  if (candidate.length > MAX_BLE_NAME_LENGTH) {
    candidate = candidate.slice(0, MAX_BLE_NAME_LENGTH).replace(/_+$/g, '');
  }

  return candidate;
}

/**
 * Encodes user text into a safe short BLE local name.
 * @param {unknown} input - User input.
 * @returns {{name: string, displayText: string, valid: boolean, error: string | null, length: number, maxLength: number}}
 */
export function encodeAlertToBleName(input) {
  const raw = String(input ?? '').trim();

  if (!raw) {
    return buildEncodingResult('', 'Enter a short emergency message.');
  }

  if (raw.includes('<') || raw.includes('>')) {
    return buildEncodingResult('', 'HTML or script-like text is not allowed in BLE names.');
  }

  const name = shortenAlertName(raw);

  if (!name || name === JV_PREFIX) {
    return buildEncodingResult('', 'Use letters or numbers for the alert code.');
  }

  if (!name.startsWith(JV_PREFIX)) {
    return buildEncodingResult(name, 'Alert names must start with JV_.');
  }

  if (name.length > MAX_BLE_NAME_LENGTH) {
    return buildEncodingResult(name, `Keep BLE names at ${MAX_BLE_NAME_LENGTH} characters or less.`);
  }

  if (!isValidJVAlertName(name)) {
    return buildEncodingResult(name, 'Use only A-Z, 0-9, and underscores after JV_.');
  }

  return {
    name,
    displayText: decodeAlertNameForDisplay(name),
    valid: true,
    error: null,
    length: name.length,
    maxLength: MAX_BLE_NAME_LENGTH
  };
}

/**
 * Converts a JV_ BLE local name into readable display text.
 * @param {unknown} name - BLE local name.
 * @returns {string} Display label.
 */
export function decodeAlertNameForDisplay(name) {
  const value = String(name ?? '').trim().toUpperCase();

  if (!isValidJVAlertName(value)) {
    return 'Invalid alert';
  }

  return value
    .slice(JV_PREFIX.length)
    .split('_')
    .filter(Boolean)
    .map(expandDisplayWord)
    .join(' ');
}

/**
 * Returns a broad alert type from a JV_ name.
 * @param {unknown} name - BLE local name.
 * @returns {string} Alert type.
 */
export function getAlertTypeFromName(name) {
  const code = String(name ?? '').toUpperCase().slice(JV_PREFIX.length);

  if (code.startsWith('FIRE')) return 'FIRE';
  if (code.startsWith('MED')) return 'MEDICAL';
  if (code.startsWith('EVAC')) return 'EVACUATE';
  if (code.startsWith('FLOOD')) return 'FLOOD';
  if (code.startsWith('WTR') || code.startsWith('WATER')) return 'WATER';
  if (code.startsWith('FOOD')) return 'FOOD';
  if (code.startsWith('RD') || code.includes('ROAD')) return 'ROAD';
  if (code.startsWith('SAFE')) return 'SAFE';
  if (code.startsWith('SHLTR') || code.startsWith('SHELTER')) return 'SHELTER';
  if (code.startsWith('HELP')) return 'HELP';
  return 'ALERT';
}

function buildEncodingResult(name, error) {
  return {
    name,
    displayText: name ? decodeAlertNameForDisplay(name) : '',
    valid: false,
    error,
    length: name.length,
    maxLength: MAX_BLE_NAME_LENGTH
  };
}

function prioritizeWords(words) {
  const uniqueWords = [];

  for (const word of words) {
    if (word && !uniqueWords.includes(word)) {
      uniqueWords.push(word);
    }
  }

  const eventWord = EVENT_PRIORITY.find((word) => uniqueWords.includes(word));

  if (!eventWord) {
    return uniqueWords.slice(0, 3);
  }

  const remaining = uniqueWords.filter((word) => word !== eventWord);
  const selected = [eventWord];

  if (eventWord === 'MED' && remaining.includes('HELP')) {
    const locationWord = remaining.find((word) => !['HELP', 'NEED'].includes(word));
    selected.push(locationWord ?? 'NEED');
  } else if (eventWord === 'HELP' && remaining.includes('NEED')) {
    selected.push('NEED');
  } else {
    selected.push(...remaining.slice(0, 2));
  }

  return selected.filter(Boolean).slice(0, 3);
}

function expandDisplayWord(word) {
  const displayMap = {
    BRDG: 'Bridge',
    EVAC: 'Evacuate',
    MED: 'Medical',
    MKT: 'Market',
    RD: 'Road',
    SCH: 'School',
    SHLTR: 'Shelter',
    WTR: 'Water'
  };

  return displayMap[word] ?? `${word.charAt(0)}${word.slice(1).toLowerCase()}`;
}

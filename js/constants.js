export const APP_VERSION = '1.0.0';

export const CATEGORY_DEFINITIONS = Object.freeze([
  {
    id: 'emergency',
    label: 'Emergency',
    icon: '🚨',
    color: '#ff4d5d',
    surface: 'rgba(255, 77, 93, 0.16)',
    weight: 22
  },
  {
    id: 'medical',
    label: 'Medical',
    icon: '🏥',
    color: '#31d07f',
    surface: 'rgba(49, 208, 127, 0.15)',
    weight: 20
  },
  {
    id: 'safe-route',
    label: 'Safe Route',
    icon: '🛣️',
    color: '#4cc9f0',
    surface: 'rgba(76, 201, 240, 0.15)',
    weight: 14
  },
  {
    id: 'food-water',
    label: 'Food/Water',
    icon: '🍚',
    color: '#ffb84d',
    surface: 'rgba(255, 184, 77, 0.16)',
    weight: 16
  },
  {
    id: 'missing-person',
    label: 'Missing Person',
    icon: '👤',
    color: '#b387ff',
    surface: 'rgba(179, 135, 255, 0.16)',
    weight: 18
  },
  {
    id: 'official-notice',
    label: 'Official Notice',
    icon: '📋',
    color: '#a7afbd',
    surface: 'rgba(167, 175, 189, 0.14)',
    weight: 17
  }
]);

export const CATEGORY_BY_ID = Object.freeze(
  CATEGORY_DEFINITIONS.reduce((index, category) => {
    index[category.id] = category;
    return index;
  }, {})
);

export const ALERT_BLUEPRINTS = Object.freeze([
  {
    category: 'food-water',
    title: 'Water tanker at Gurudwara Sector 5',
    location: 'Sector 5, Karnal, Haryana',
    details:
      'Tanker queue is moving from the Gurudwara gate toward the community kitchen. Carry containers and keep the lane clear for elders.',
    severity: 3,
    ttlHours: 6,
    sourceType: 'Ward Volunteer',
    sourceName: 'Ward Volunteer A-12',
    createdAtOffsetMinutes: 18,
    relayCount: 2
  },
  {
    category: 'safe-route',
    title: 'NH-44 bypass road clear',
    location: 'NH-44 Bypass, Panipat side',
    details:
      'Two lanes are open for ambulances and supply vans. Avoid the old bus stand stretch because fallen cables are still being removed.',
    severity: 4,
    ttlHours: 4,
    sourceType: 'Police Desk',
    sourceName: 'Traffic Control Panipat',
    createdAtOffsetMinutes: 34,
    relayCount: 4
  },
  {
    category: 'medical',
    title: 'PHC open at Block 3',
    location: 'Primary Health Centre, Block 3, Bhuj',
    details:
      'Doctor and two nurses are available. ORS, insulin cold box, dressing kits, and fever medicines are being issued at the east entrance.',
    severity: 5,
    ttlHours: 12,
    sourceType: 'PHC Staff',
    sourceName: 'PHC Block 3 Desk',
    createdAtOffsetMinutes: 52,
    relayCount: 3
  },
  {
    category: 'emergency',
    title: 'Transformer fire near Gandhi Chowk',
    location: 'Gandhi Chowk, Mandi, Himachal Pradesh',
    details:
      'Fire team is on site. Keep a 100 metre distance from the transformer lane and do not touch standing water near the pole.',
    severity: 5,
    ttlHours: 2,
    sourceType: 'District Control Room',
    sourceName: 'Mandi Control Room',
    createdAtOffsetMinutes: 11,
    relayCount: 5
  },
  {
    category: 'missing-person',
    title: 'Missing child reported at Bus Stand Gate 2',
    location: 'Gate 2, ISBT Sector 17, Chandigarh',
    details:
      'Aarav Sharma, 8 years, blue school sweater, was last seen near the tea stall. Escort found children to the help desk only.',
    severity: 4,
    ttlHours: 24,
    sourceType: 'Police Desk',
    sourceName: 'ISBT Help Desk',
    createdAtOffsetMinutes: 77,
    relayCount: 6
  },
  {
    category: 'official-notice',
    title: 'Relief camp moved to Govt School Hall',
    location: 'Govt Senior Secondary School, Baramulla',
    details:
      'The camp has shifted from the panchayat courtyard to the school hall. Dry ration tokens issued before noon remain valid.',
    severity: 3,
    ttlHours: 24,
    sourceType: 'District Control Room',
    sourceName: 'Baramulla Relief Desk',
    createdAtOffsetMinutes: 96,
    relayCount: 1
  }
]);

export const DEFAULT_FORM_VALUES = Object.freeze({
  category: 'food-water',
  title: 'Water tanker at Gurudwara Sector 5',
  location: 'Sector 5, Karnal, Haryana',
  details:
    'Tanker queue is moving from the Gurudwara gate toward the community kitchen. Carry containers and keep the lane clear for elders.',
  severity: 3,
  ttlHours: 6,
  sourceType: 'Ward Volunteer',
  sourceName: 'Ward Volunteer A-12'
});

export const DB_NAME = 'janvaani-offline-db';
export const DB_VERSION = 1;
export const ALERT_STORE = 'alerts';
export const META_STORE = 'meta';
export const PACKET_PREFIX = 'JANVAANI1';

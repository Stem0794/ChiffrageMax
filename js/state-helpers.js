import { parseDateText } from './utils.js';

const KNOWN_PHASES = new Set(['conception', 'developpement', 'recette', 'mep']);

export function removeArchiveSuffix(name) {
  return String(name || '').replace(/\s*\[ARCH\]\s*$/, '').trim();
}

export function isValidTimelineEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (!entry.phases || typeof entry.phases !== 'object' || Array.isArray(entry.phases)) return false;
  if (!Object.keys(entry.phases).length) return false;
  return Object.entries(entry.phases).every(([key, phase]) => {
    if (!KNOWN_PHASES.has(key)) return true;
    if (!phase || typeof phase !== 'object' || Array.isArray(phase)) return false;
    const datesValid = ['start', 'end'].every((field) => {
      if (!phase[field]) return true;
      return Boolean(parseDateText(phase[field]) && /^\d{4}-\d{2}-\d{2}$/.test(String(phase[field])));
    });
    if (!datesValid) return false;
    const start = parseDateText(phase.start);
    const end = parseDateText(phase.end);
    return !start || !end || end >= start;
  });
}

// Validate and clone imported timeline data before it reaches localStorage.
// Rejecting malformed entries avoids a single null/invalid phase crashing the
// Gantt renderer later on.
export function normalizeTimelineData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Format invalide (timeline doit être un objet).');
  }
  const result = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!isValidTimelineEntry(entry)) {
      throw new Error(`Entrée timeline invalide pour « ${id} ».`);
    }
    result[id] = {
      ...entry,
      id: entry.id || id,
      phases: Object.fromEntries(Object.entries(entry.phases).map(([key, phase]) => [key, { ...phase }])),
    };
  }
  return result;
}

export function removeQuoteFromState({ active, archived, timeline }, id) {
  const remove = (list) => (Array.isArray(list) ? list.filter((item) => item.id !== id) : []);
  const nextTimeline = { ...(timeline || {}) };
  delete nextTimeline[id];
  return { active: remove(active), archived: remove(archived), timeline: nextTimeline };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDateInput, parseDateText } from '../js/utils.js';
import {
  isValidTimelineEntry, normalizeTimelineData, removeArchiveSuffix, removeQuoteFromState,
} from '../js/state-helpers.js';

process.env.TZ = 'Europe/Madrid';

test('date-only values keep their local calendar day', () => {
  const date = new Date(2026, 7, 5, 0, 0, 0);
  assert.equal(formatDateInput(date), '2026-08-05');
  assert.equal(formatDateInput(parseDateText('2026-08-05')), '2026-08-05');
});

test('slash dates are parsed day-first and invalid rollovers are rejected', () => {
  const date = parseDateText('07/03/2026');
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 2);
  assert.equal(date.getDate(), 7);
  assert.equal(parseDateText('2026-02-31'), null);
});

test('archive suffix removal only strips a trailing marker', () => {
  assert.equal(removeArchiveSuffix('Projet [ARCH] [ARCH]'), 'Projet [ARCH]');
  assert.equal(removeArchiveSuffix('Projet [ARCH] dans le nom'), 'Projet [ARCH] dans le nom');
});

test('timeline imports reject malformed entries and preserve valid ones', () => {
  const valid = {
    sheet1: { id: 'sheet1', label: 'Projet', phases: { conception: { start: '2026-02-01', end: '2026-02-03' } } },
  };
  assert.equal(isValidTimelineEntry(valid.sheet1), true);
  assert.deepEqual(normalizeTimelineData(valid), valid);
  assert.throws(() => normalizeTimelineData({ bad: null }), /Entrée timeline invalide/);
  assert.throws(() => normalizeTimelineData({ bad: { phases: { conception: { start: '2026-02-31' } } } }), /Entrée timeline invalide/);
  assert.throws(() => normalizeTimelineData({ bad: { phases: { conception: { start: '2026-02-04', end: '2026-02-03' } } } }), /Entrée timeline invalide/);
});

test('deleting a quote removes it from active, archived and timeline state', () => {
  const next = removeQuoteFromState({
    active: [{ id: 'keep' }, { id: 'gone' }],
    archived: [{ id: 'gone' }],
    timeline: { gone: { phases: {} }, keep: { phases: {} } },
  }, 'gone');
  assert.deepEqual(next.active, [{ id: 'keep' }]);
  assert.deepEqual(next.archived, []);
  assert.deepEqual(next.timeline, { keep: { phases: {} } });
});

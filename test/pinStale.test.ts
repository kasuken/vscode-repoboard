import assert from 'node:assert/strict';
import { test } from 'node:test';
import { idlePhrase, pinStaleness, stalePins, type Project } from '../src/domain/model';

const DAY = 24 * 3_600_000;
const NOW = Date.UTC(2026, 5, 30);
const pin = (extra: Partial<Project> = {}): Project => ({ id: 'a', name: 'a', path: '/a', tags: [], source: 'manual', addedAt: NOW - 100 * DAY, pinned: true, ...extra });

test('pinStaleness: stale exactly at the threshold, not a millisecond before', () => {
  assert.deepEqual(pinStaleness(pin({ lastOpenedAt: NOW - 14 * DAY }), 14, NOW), { stale: true, idleMs: 14 * DAY });
  assert.equal(pinStaleness(pin({ lastOpenedAt: NOW - 14 * DAY + 1 }), 14, NOW).stale, false);
});

test('pinStaleness: a never-opened pin ages from addedAt; the later of the two wins', () => {
  assert.deepEqual(pinStaleness(pin({ addedAt: NOW - 20 * DAY }), 14, NOW), { stale: true, idleMs: 20 * DAY });
  assert.equal(pinStaleness(pin({ addedAt: NOW - 3 * DAY }), 14, NOW).stale, false);
  assert.equal(pinStaleness(pin({ addedAt: NOW - 3 * DAY, lastOpenedAt: NOW - 30 * DAY }), 14, NOW).idleMs, 3 * DAY);
});

test('pinStaleness: 0 days is off, unpinned is never stale', () => {
  assert.equal(pinStaleness(pin({ lastOpenedAt: NOW - 90 * DAY }), 0, NOW).stale, false);
  assert.equal(pinStaleness(pin({ lastOpenedAt: NOW - 90 * DAY, pinned: false }), 14, NOW).stale, false);
  assert.equal(pinStaleness(pin({ lastOpenedAt: NOW - 90 * DAY, pinned: undefined }), 14, NOW).stale, false);
});

test('stalePins keeps only the stale pinned ones, in order', () => {
  const list = [
    pin({ id: 'fresh', lastOpenedAt: NOW - DAY }),
    pin({ id: 'old1', lastOpenedAt: NOW - 20 * DAY }),
    pin({ id: 'loose', lastOpenedAt: NOW - 90 * DAY, pinned: false }),
    pin({ id: 'old2', lastOpenedAt: NOW - 400 * DAY, addedAt: NOW - 500 * DAY }),
  ];
  assert.deepEqual(stalePins(list, 14, NOW).map((p) => p.id), ['old1', 'old2']);
  assert.deepEqual(stalePins(list, 0, NOW), []);
});

test('idlePhrase: days, weeks, months, years', () => {
  assert.equal(idlePhrase(16 * DAY), 'not opened in 16 days');
  assert.equal(idlePhrase(1 * DAY), 'not opened in 1 day');
  assert.equal(idlePhrase(21 * DAY), 'not opened in 3 weeks');
  assert.equal(idlePhrase(75 * DAY), 'not opened in 2 months');
  assert.equal(idlePhrase(800 * DAY), 'not opened in 2 years');
});

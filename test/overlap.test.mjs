import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findContested } from '../src/overlap.mjs';
import { parseTs } from '../src/model.mjs';

const jobs = [
  { job: 'J0', attempt: 'T0', project: 'P1', pool: 'north', slot: 'N4', migration: 'M7', billable: true },
  { job: 'J0', attempt: 'T1', project: 'P1', pool: 'south', slot: 'S4', migration: 'M7', billable: true },
  { job: 'J2', attempt: 'T3', project: 'P3', pool: 'south', slot: 'S8', billable: false },
];

const permit = {
  migration: 'M7',
  attempts: ['T0', 'T1'],
  effectiveFrom: '2026-11-30T23:58:00Z',
  effectiveUntil: '2026-12-01T00:03:00Z',
};

const segment = (key, slot, from, until) => ({
  key,
  slot,
  pool: slot.startsWith('N') ? 'north' : 'south',
  from: parseTs(from),
  until: parseTs(until),
  seconds: 30,
});

const attempts = { N4: 'T0', S4: 'T1', S8: 'T3' };
const attemptOf = (seg) => attempts[seg.slot];

test('许可窗口覆盖的重叠允许双侧计费', () => {
  const segments = [
    segment('N4|1|a|b', 'N4', '2026-11-30T23:56:00Z', '2026-11-30T23:59:00Z'),
    segment('S4|3|a|b', 'S4', '2026-11-30T23:58:00Z', '2026-12-01T00:00:00Z'),
  ];
  const contested = findContested(segments, attemptOf, jobs, [permit]);
  assert.equal(contested.size, 0);
});

test('许可窗口外的实际同时占用：双侧都挂起待核', () => {
  const segments = [
    segment('N4|2|a|b', 'N4', '2026-12-01T00:01:00Z', '2026-12-01T00:04:00Z'),
    segment('S4|3|c|d', 'S4', '2026-12-01T00:03:00Z', '2026-12-01T00:05:00Z'),
  ];
  const contested = findContested(segments, attemptOf, jobs, [permit]);
  assert.equal(contested.size, 2); // 不擅自只向一池计费
  assert.equal(contested.get('N4|2|a|b').migration, 'M7');
  assert.equal(contested.get('S4|3|c|d').overlaps[0].withAttempt, 'T0');
});

test('部分覆盖许可窗口也算未许可（段不可再分）', () => {
  const segments = [
    segment('N4|2|a|b', 'N4', '2026-12-01T00:01:00Z', '2026-12-01T00:04:00Z'),
    segment('S4|3|b|c', 'S4', '2026-12-01T00:02:00Z', '2026-12-01T00:05:00Z'),
  ];
  // 重叠 [00:02, 00:04)，许可只到 00:03
  const contested = findContested(segments, attemptOf, jobs, [permit]);
  assert.equal(contested.size, 2);
});

test('无迁移关系的槽位互不干扰；无许可的迁移组重叠即待核', () => {
  const segments = [
    segment('S8|1|a|b', 'S8', '2026-12-01T00:00:00Z', '2026-12-01T00:05:00Z'),
    segment('N4|2|a|b', 'N4', '2026-12-01T00:01:00Z', '2026-12-01T00:04:00Z'),
  ];
  assert.equal(findContested(segments, attemptOf, jobs, [permit]).size, 0);
  // 去掉许可后，T0/T1 重叠即未许可
  const withT1 = [
    segment('N4|2|a|b', 'N4', '2026-12-01T00:01:00Z', '2026-12-01T00:04:00Z'),
    segment('S4|3|b|c', 'S4', '2026-12-01T00:02:00Z', '2026-12-01T00:05:00Z'),
  ];
  assert.equal(findContested(withT1, attemptOf, jobs, []).size, 2);
});

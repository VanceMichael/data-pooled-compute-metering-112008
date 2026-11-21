import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSegments, normalizeRecords } from '../src/metering.mjs';

const record = (slot, generation, at, seconds) => ({ slot, generation, at, seconds });

test('重复与迟到采样：去重并按时刻重排', () => {
  const { records, anomalies } = normalizeRecords('south', '/metering/south', [
    record('S4', 3, '2026-12-01T00:05:00Z', 150),
    record('S4', 3, '2026-11-30T23:58:00Z', 0),
    record('S4', 3, '2026-12-01T00:05:00Z', 150), // 重复
    record('S4', 3, '2026-12-01T00:02:00Z', 60),
  ]);
  assert.equal(records.length, 3);
  assert.equal(anomalies.length, 0);
  assert.deepEqual(records.map((r) => r.atRaw), [
    '2026-11-30T23:58:00Z',
    '2026-12-01T00:02:00Z',
    '2026-12-01T00:05:00Z',
  ]);
});

test('同键冲突采样记异常并保留先见值', () => {
  const { records, anomalies } = normalizeRecords('south', '/metering/south', [
    record('S4', 3, '2026-12-01T00:05:00Z', 150),
    record('S4', 3, '2026-12-01T00:05:00Z', 151),
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].seconds, 150);
  assert.equal(anomalies[0].type, 'conflicting-sample');
});

test('只有同一代次相邻采样差分成段；零增量（空闲）不成段', () => {
  const { records } = normalizeRecords('north', '/metering/north', [
    record('N4', 1, '2026-11-30T23:56:00Z', 90),
    record('N4', 1, '2026-11-30T23:59:00Z', 150),
    record('N4', 1, '2026-12-01T00:00:00Z', 180),
    record('N4', 2, '2026-12-01T00:01:00Z', 0),
    record('N4', 2, '2026-12-01T00:04:00Z', 50),
    record('N4', 2, '2026-12-01T00:05:00Z', 50), // 无增量：空闲等待
  ]);
  const { segments, resets, anomalies } = buildSegments(records);
  assert.equal(anomalies.length, 0);
  assert.deepEqual(
    segments.map((s) => [s.generation, s.seconds]),
    [
      [1, 60],
      [1, 30],
      [2, 50],
    ],
  );
  // 设备重启清零：gen1 → gen2 交界窗口不可计量
  assert.equal(resets.length, 1);
  assert.deepEqual(
    [resets[0].fromGeneration, resets[0].toGeneration],
    [1, 2],
  );
});

test('同代次计数回退记异常且不成段', () => {
  const { records } = normalizeRecords('south', '/metering/south', [
    record('S8', 1, '2026-12-01T00:00:00Z', 80),
    record('S8', 1, '2026-12-01T00:05:00Z', 50),
  ]);
  const { segments, anomalies } = buildSegments(records);
  assert.equal(segments.length, 0);
  assert.equal(anomalies[0].type, 'counter-regression');
});

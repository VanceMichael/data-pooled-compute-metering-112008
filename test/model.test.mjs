import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  contains,
  formatTs,
  intersection,
  monthBoundariesInside,
  overlaps,
  parseTs,
  periodOfSegment,
} from '../src/model.mjs';

test('UTC 半开区间的重叠与包含', () => {
  const t = (s) => parseTs(`2026-11-30T${s}Z`);
  assert.equal(overlaps(t('23:00:00'), t('23:59:00'), t('23:58:00'), t('24:00:00'.replace('24:00:00', '23:59:30'))), true);
  // 半开：端点相接不算重叠
  assert.equal(overlaps(t('23:00:00'), t('23:58:00'), t('23:58:00'), t('23:59:00')), false);
  assert.deepEqual(intersection(t('23:00:00'), t('23:59:00'), t('23:58:00'), t('23:59:30')), [t('23:58:00'), t('23:59:00')]);
  assert.equal(contains(t('23:00:00'), t('23:59:00'), t('23:58:00'), t('23:59:00')), true);
  assert.equal(contains(t('23:00:00'), t('23:59:00'), t('23:58:00'), t('23:59:01')), false);
});

test('段的结算期按 UTC 半开区间判定', () => {
  // [23:59, 00:00) 完全落在 11 月
  assert.equal(
    periodOfSegment(parseTs('2026-11-30T23:59:00Z'), parseTs('2026-12-01T00:00:00Z')),
    '2026-11',
  );
  // [00:00, 00:02) 落在 12 月
  assert.equal(
    periodOfSegment(parseTs('2026-12-01T00:00:00Z'), parseTs('2026-12-01T00:02:00Z')),
    '2026-12',
  );
  // [23:58, 00:02) 跨期：没有边界读数不得随意拆
  assert.equal(
    periodOfSegment(parseTs('2026-11-30T23:58:00Z'), parseTs('2026-12-01T00:02:00Z')),
    null,
  );
});

test('跨期段列出缺失的月界分界读数', () => {
  const boundaries = monthBoundariesInside(
    parseTs('2026-11-30T23:58:00Z'),
    parseTs('2026-12-01T00:02:00Z'),
  );
  assert.deepEqual(boundaries.map(formatTs), ['2026-12-01T00:00:00Z']);
  assert.deepEqual(
    monthBoundariesInside(parseTs('2026-12-01T00:00:00Z'), parseTs('2026-12-01T00:02:00Z')),
    [],
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attributeSegment, buildTimelines } from '../src/attribution.mjs';
import { parseTs } from '../src/model.mjs';

const assignment = (id, slot, project, from, until, extra = {}) => ({
  id,
  slot,
  attempt: 'T1',
  project,
  effectiveFrom: from,
  effectiveUntil: until,
  ...extra,
});

const segment = (from, until) => ({
  key: `S4|3|${from}|${until}`,
  slot: 'S4',
  from: parseTs(from),
  until: parseTs(until),
  seconds: 30,
});

const A2 = assignment('A2', 'S4', 'P1', '2026-11-30T23:58:00Z', '2026-12-01T00:06:00Z');
const A3 = assignment('A3', 'S4', 'P2', '2026-12-01T00:03:00Z', '2026-12-01T00:06:00Z');
const A4 = assignment('A4', 'S4', 'P4', '2026-11-30T23:58:00Z', '2026-12-01T00:03:00Z', { revises: 'A2' });

test('同槽切分：effectiveFrom 晚者覆盖早者', () => {
  const timelines = buildTimelines([A2, A3]);
  const pieces = timelines.get('S4');
  // [23:58, 00:03) → P1，[00:03, 00:06) → P2
  const early = attributeSegment(segment('2026-11-30T23:58:00Z', '2026-12-01T00:00:00Z'), pieces);
  assert.equal(early.status, 'attributed');
  assert.equal(early.project, 'P1');
  const late = attributeSegment(segment('2026-12-01T00:03:00Z', '2026-12-01T00:05:00Z'), pieces);
  assert.equal(late.project, 'P2');
});

test('段横跨项目切点且无分界读数：报未归属，不按时间拆', () => {
  const timelines = buildTimelines([A2, A3]);
  const result = attributeSegment(segment('2026-12-01T00:02:00Z', '2026-12-01T00:05:00Z'), timelines.get('S4'));
  assert.equal(result.status, 'spans-cut');
  assert.equal(result.cuts.length, 1);
  assert.equal(result.cuts[0].fromProject, 'P1');
  assert.equal(result.cuts[0].toProject, 'P2');
  assert.equal(result.attempt, 'T1'); // 尝试仍可判定，供并跑重叠分析
});

test('revises 更正只替换其指向的登记窗口', () => {
  const timelines = buildTimelines([A2, A3, A4]);
  const pieces = timelines.get('S4');
  // A4 把 A2 的 [23:58, 00:03) 更正为 P4
  const revised = attributeSegment(segment('2026-11-30T23:58:00Z', '2026-12-01T00:00:00Z'), pieces);
  assert.equal(revised.project, 'P4');
  assert.deepEqual(revised.assignmentIds, ['A4']);
  // A3 的 [00:03, 00:06) 不受 A4 影响
  const untouched = attributeSegment(segment('2026-12-01T00:03:00Z', '2026-12-01T00:05:00Z'), pieces);
  assert.equal(untouched.project, 'P2');
});

test('无切分登记与登记冲突', () => {
  const timelines = buildTimelines([A2]);
  assert.equal(
    attributeSegment(segment('2026-12-02T00:00:00Z', '2026-12-02T00:01:00Z'), timelines.get('S4')).status,
    'no-slice',
  );
  const tied = buildTimelines([
    assignment('B1', 'S9', 'P1', '2026-12-01T00:00:00Z', '2026-12-01T01:00:00Z'),
    assignment('B2', 'S9', 'P2', '2026-12-01T00:00:00Z', '2026-12-01T01:00:00Z'),
  ]);
  const result = attributeSegment(
    { key: 'S9|1|a|b', slot: 'S9', from: parseTs('2026-12-01T00:10:00Z'), until: parseTs('2026-12-01T00:20:00Z'), seconds: 5 },
    tied.get('S9'),
  );
  assert.equal(result.status, 'ambiguous');
});

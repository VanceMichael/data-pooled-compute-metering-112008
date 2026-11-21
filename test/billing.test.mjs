import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeAdjustmentPair, makeCharge, planBilling } from '../src/billing.mjs';
import { emptyLedger } from '../src/ledger.mjs';
import { parseTs } from '../src/model.mjs';

const jobs = [
  { job: 'J0', attempt: 'T0', project: 'P1', pool: 'north', slot: 'N4', migration: 'M7', billable: true },
  { job: 'J2', attempt: 'T3', project: 'P3', pool: 'south', slot: 'S8', billable: false, state: 'cancelled' },
];
const rates = { north: 2, south: 3 };
const windows = { periods: ['2026-11', '2026-12'], close: ['north:2026-11'], adjustmentTarget: '2026-12' };

const segment = (key, pool, slot, from, until, seconds) => ({
  key,
  pool,
  slot,
  generation: 1,
  meteringPath: `/metering/${pool}`,
  from: parseTs(from),
  until: parseTs(until),
  seconds,
  samples: [
    { at: from, seconds: 0 },
    { at: until, seconds },
  ],
});

const attributed = (project, attempt = 'T0') => ({ status: 'attributed', project, attempt, assignmentIds: ['A1'] });

test('计费行：金额=秒×费率，业务标识确定生成', () => {
  const seg = segment('N4|1|a|b', 'north', 'N4', '2026-11-30T23:56:00Z', '2026-11-30T23:59:00Z', 60);
  const line = makeCharge(seg, attributed('P1'), '2026-11', rates.north, jobs[0]);
  assert.equal(line.amount, 120);
  assert.equal(line.scope, 'north:2026-11');
  assert.equal(line.direction, 'charge');
  const again = makeCharge(seg, attributed('P1'), '2026-11', rates.north, jobs[0]);
  assert.equal(line.businessId, again.businessId); // 幂等：重跑生成同一标识
});

test('同段已有计费行：运行重试不重复扣收', () => {
  const seg = segment('N4|1|a|b', 'north', 'N4', '2026-11-30T23:56:00Z', '2026-11-30T23:59:00Z', 60);
  const ledger = emptyLedger();
  const attributions = new Map([[seg.key, attributed('P1')]]);
  const first = planBilling({ segments: [seg], attributions, contested: new Map(), jobs, rates, windows, ledger });
  assert.equal(first.charges.length, 1);
  ledger.lines.push(...first.charges);
  const second = planBilling({ segments: [seg], attributions, contested: new Map(), jobs, rates, windows, ledger });
  assert.equal(second.charges.length, 0);
  assert.equal(second.adjustments.length, 0);
});

test('已确认行的归属更正：在允许冲回的结算期生成成对调整', () => {
  const seg = segment('S4|3|a|b', 'south', 'S4', '2026-11-30T23:58:00Z', '2026-12-01T00:00:00Z', 30);
  const ledger = emptyLedger();
  const attributions = new Map([[seg.key, attributed('P1')]]);
  const first = planBilling({ segments: [seg], attributions, contested: new Map(), jobs, rates, windows, ledger });
  ledger.lines.push(...first.charges);
  ledger.lines[0].status = 'cleared'; // 接收方已确认关账

  const revised = new Map([[seg.key, attributed('P4')]]);
  const second = planBilling({ segments: [seg], attributions: revised, contested: new Map(), jobs, rates, windows, ledger });
  assert.equal(second.charges.length, 0);
  assert.equal(second.adjustments.length, 2);
  const [credit, charge] = second.adjustments;
  assert.equal(credit.direction, 'credit');
  assert.equal(credit.project, 'P1');
  assert.equal(charge.direction, 'charge');
  assert.equal(charge.project, 'P4');
  assert.equal(credit.amount, 90);
  assert.equal(charge.amount, 90);
  assert.equal(credit.period, '2026-12'); // adjustmentTarget
  assert.equal(credit.adjusts, ledger.lines[0].businessId);
  assert.equal(charge.adjusts, ledger.lines[0].businessId);
});

test('未确认行的归属更正：只标记，不擅自调整', () => {
  const seg = segment('S4|3|a|b', 'south', 'S4', '2026-11-30T23:58:00Z', '2026-12-01T00:00:00Z', 30);
  const ledger = emptyLedger();
  const attributions = new Map([[seg.key, attributed('P1')]]);
  const first = planBilling({ segments: [seg], attributions, contested: new Map(), jobs, rates, windows, ledger });
  ledger.lines.push(...first.charges);
  ledger.lines[0].status = 'submitted'; // 接收方尚未确认

  const revised = new Map([[seg.key, attributed('P4')]]);
  const second = planBilling({ segments: [seg], attributions: revised, contested: new Map(), jobs, rates, windows, ledger });
  assert.equal(second.adjustments.length, 0);
  assert.equal(second.flags.length, 1);
  assert.equal(second.flags[0].type, 'attribution-changed-unconfirmed');
});

test('不收费尝试保有消耗凭据；跨期段挂起并列出分界读数', () => {
  const cancelled = segment('S8|1|a|b', 'south', 'S8', '2026-12-01T00:00:00Z', '2026-12-01T00:05:00Z', 30);
  const crossPeriod = segment('S4|3|a|b', 'south', 'S4', '2026-11-30T23:58:00Z', '2026-12-01T00:02:00Z', 60);
  const attributions = new Map([
    [cancelled.key, { status: 'no-slice' }],
    [crossPeriod.key, attributed('P1')],
  ]);
  const plan = planBilling({
    segments: [cancelled, crossPeriod],
    attributions,
    contested: new Map(),
    jobs,
    rates,
    windows,
    ledger: emptyLedger(),
  });
  assert.equal(plan.nonBillable.length, 1);
  assert.equal(plan.nonBillable[0].project, 'P3');
  assert.equal(plan.charges.length, 0);
  assert.equal(plan.held.length, 1);
  assert.equal(plan.held[0].reason, 'cross-period');
  assert.deepEqual(plan.held[0].neededReadings, ['2026-12-01T00:00:00Z']);
});

test('成对调整自身也幂等', () => {
  const line = {
    businessId: 'chg_south_S4_g3_x_P1',
    evidence: { assignments: ['A2'], metering: '/metering/south', samples: [] },
    pool: 'south',
    slot: 'S4',
    generation: 3,
    sourceInterval: ['2026-11-30T23:58:00Z', '2026-12-01T00:00:00Z'],
    seconds: 30,
    rate: 3,
    amount: 90,
    project: 'P1',
    segmentKey: 'S4|3|a|b',
  };
  const pair1 = makeAdjustmentPair(line, { project: 'P4', assignmentIds: ['A4'] }, windows);
  const pair2 = makeAdjustmentPair(line, { project: 'P4', assignmentIds: ['A4'] }, windows);
  assert.equal(pair1[0].businessId, pair2[0].businessId);
  assert.equal(pair1[1].businessId, pair2[1].businessId);
});

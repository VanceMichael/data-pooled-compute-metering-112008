import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSource } from '../sources/source.mjs';
import { createClient } from '../src/client.mjs';
import { loadLedger, saveLedger } from '../src/ledger.mjs';
import { runPass } from '../src/pass.mjs';

test('六阶段演练：计量→归属→并跑→关账→迟到更正→重放', async (context) => {
  const server = createSource();
  context.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = createClient(base);
  const stateDir = mkdtempSync(join(tmpdir(), 'metering-it-'));

  const setStep = async (step) => {
    const response = await fetch(`${base}/_source_clock?step=${step}`, { method: 'PUT' });
    assert.equal(response.status, 200);
    await response.json();
  };
  const pass = async () => {
    const state = await loadLedger(stateDir);
    const result = await runPass(state, client);
    await saveLedger(stateDir, state);
    return result;
  };
  const submitsAtStep = async (step) => {
    const calls = await (await fetch(`${base}/_source_calls`)).json();
    return calls.filter((call) => call.step === step && call.method === 'POST' && call.path === '/accounting/submit');
  };

  // ---- live：首次对账 ----
  await setStep('live');
  const live = await pass();
  assert.equal(live.submitted.length, 4, 'live 提交 4 行计费');
  const byProject = (lines) => Object.groupBy(lines, (line) => line.project);
  const liveLines = live.state.lines;
  assert.deepEqual(
    liveLines.map((line) => [line.scope, line.project, line.seconds, line.amount]),
    [
      ['north:2026-11', 'P1', 60, 120],
      ['north:2026-11', 'P1', 30, 60],
      ['south:2026-11', 'P1', 30, 90],
      ['south:2026-12', 'P1', 30, 90],
    ],
  );
  // S4 [00:02,00:05) 横跨 P1→P2 切点且无 00:03 分界读数：未归属，不按时间硬拆
  assert.equal(live.report.review.unattributed.length, 1);
  assert.equal(live.report.review.unattributed[0].seconds, 90);
  assert.deepEqual(live.report.review.unattributed[0].neededReadings, ['2026-12-01T00:03:00Z']);
  // N4 gen2 [00:01,00:04) 与 S4 在许可窗口外实际同时占用：挂起待核
  assert.equal(live.report.review.held.length, 1);
  assert.equal(live.report.review.held[0].reason, 'unpermitted-overlap');
  // 取消且不收费的 T3 保有消耗凭据，不计费
  assert.equal(live.state.evidence.length, 1);
  assert.equal(live.state.evidence[0].attempt, 'T3');
  assert.equal(live.state.evidence[0].seconds, 30);
  // 设备重启交界可解释
  assert.equal(live.report.review.counterResets.length, 1);
  assert.equal((await submitsAtStep('live')).length, 4);

  // ---- split：同样数据重跑，幂等不重复扣收 ----
  await setStep('split');
  const split = await pass();
  assert.equal(split.submitted.length, 0);
  assert.equal(split.state.lines.length, 4);
  assert.equal((await submitsAtStep('split')).length, 0);

  // ---- gap：南池采样断档，说明涉及哪部分、需补领哪些边界读数 ----
  await setStep('gap');
  const gap = await pass();
  assert.equal(gap.submitted.length, 0);
  const southGap = gap.report.requisitions.find((item) => item.missingWindow);
  assert.ok(southGap, '存在南池断档补领项');
  assert.deepEqual(southGap.missingWindow, ['2026-11-30T23:59:00Z', '2026-12-01T00:01:00Z']);
  assert.deepEqual(southGap.affectedPeriods.sort(), ['2026-11', '2026-12']);
  assert.equal(southGap.affectedLines.length, 2, '断档影响两条已提交行');
  // 跨期段 [23:58,00:02) 缺 00:00 分界读数
  const boundary = gap.report.requisitions.find((item) => item.neededReadings);
  assert.deepEqual(boundary.neededReadings, ['2026-12-01T00:00:00Z']);
  assert.equal(boundary.slot, 'S4');
  // 已提交行以提交时快照继续对账，但报告证据分歧
  assert.equal(gap.report.reconciliation.divergences.length, 2);
  assert.equal((await submitsAtStep('gap')).length, 0);

  // ---- close：接收方批次确认，只有 cleared 算关账 ----
  await setStep('close');
  const close = await pass();
  assert.equal(close.submitted.length, 0);
  const cleared = close.state.lines.filter((line) => line.status === 'cleared');
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].scope, 'south:2026-11');
  assert.deepEqual(cleared[0].sourceInterval, ['2026-11-30T23:58:00Z', '2026-12-01T00:00:00Z']);
  const receivedOnly = close.state.lines.filter((line) => line.status === 'received');
  assert.equal(receivedOnly.length, 2, '北池 2026-11 两行仅 received，不算关账');
  assert.ok(receivedOnly.every((line) => line.scope === 'north:2026-11'));
  const pending = close.state.lines.filter((line) => line.status === 'submitted');
  assert.equal(pending.length, 1, '南池 2026-12 行未确认，不擅自重发');

  // ---- late：迟到边界读数 + 归属更正 ----
  await setStep('late');
  const late = await pass();
  assert.equal(late.submitted.length, 3, '成对调整 2 行 + 新段计费 1 行');
  const adjustments = late.submitted.filter((line) => line.kind === 'adjustment');
  assert.equal(adjustments.length, 2);
  const credit = adjustments.find((line) => line.direction === 'credit');
  const debit = adjustments.find((line) => line.direction === 'charge');
  assert.equal(credit.project, 'P1');
  assert.equal(debit.project, 'P4');
  assert.equal(credit.amount, 90);
  assert.equal(debit.amount, 90);
  assert.equal(credit.period, '2026-12', '调整进入允许冲回的结算期');
  assert.equal(credit.adjusts, cleared[0].businessId, '调整指向原行业务标识');
  assert.equal(credit.evidence.correction.assignments.includes('A4'), true);
  // 原已接收账单保持可对账：原行仍在且状态不变
  const original = late.state.lines.find((line) => line.businessId === cleared[0].businessId);
  assert.equal(original.status, 'cleared');
  assert.equal(original.project, 'P1');
  // 新分界读数 00:03 使 [00:02,00:03) 可归属 P4 并计费
  const newCharge = late.submitted.find((line) => line.kind === 'charge');
  assert.equal(newCharge.project, 'P4');
  assert.equal(newCharge.seconds, 45);
  assert.equal(newCharge.amount, 135);
  // 未确认行（南池 2026-12 的 P1 行）归属更正：只标记，不擅自调整
  const flag = late.report.flags.find((entry) => entry.type === 'attribution-changed-unconfirmed');
  assert.ok(flag, '存在未确认行更正标记');
  assert.equal(flag.fromProject, 'P1');
  assert.equal(flag.toProject, 'P4');
  // [00:03,00:05) P2 与 N4 未许可重叠：双池凭据待核
  const held = late.report.review.held;
  assert.equal(held.length, 2);
  assert.deepEqual(
    held.map((entry) => [entry.pool, entry.project]).sort(),
    [
      ['north', 'P1'],
      ['south', 'P2'],
    ],
  );
  // 迟到重复采样（00:05 出现两次）已去重：不会多算段
  assert.equal(late.state.lines.length, 7);
  assert.equal((await submitsAtStep('late')).length, 3);

  // ---- replay：乱序/重复重放，账务稳定 ----
  await setStep('replay');
  const replay = await pass();
  assert.equal(replay.submitted.length, 0);
  assert.equal(replay.state.lines.length, 7);
  assert.equal((await submitsAtStep('replay')).length, 0);

  // 全部业务标识唯一：跨账期、跨重试没有同段重复扣收
  const ids = replay.state.lines.map((line) => line.businessId);
  assert.equal(new Set(ids).size, ids.length);

  // 项目账单可追到原始依据
  const bills = replay.report.bills;
  assert.equal(bills.P1.submittedAmount, 120 + 60 + 90 + 90 - 90);
  assert.equal(bills.P1.clearedAmount, 90);
  assert.equal(bills.P4.submittedAmount, 90 + 135);
  const p4Line = bills.P4.lines.find((line) => line.kind === 'charge' && line.seconds === 45);
  assert.equal(p4Line.evidence.metering, '/metering/south');
  assert.deepEqual(p4Line.evidence.assignments, ['A4']);
  assert.equal(p4Line.evidence.attempt, 'T1');
  assert.equal(p4Line.evidence.migration, 'M7');
});

test('提交结果不明时不重发，先与财务确认', async (context) => {
  const server = createSource();
  context.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = createClient(base);
  const stateDir = mkdtempSync(join(tmpdir(), 'metering-it-'));

  await fetch(`${base}/_source_clock?step=live`, { method: 'PUT' });
  // 第一次：提交通道故障
  const failing = {
    ...client,
    submit: () => Promise.reject(new Error('连接中断')),
  };
  let state = await loadLedger(stateDir);
  const first = await runPass(state, failing);
  await saveLedger(stateDir, state);
  assert.equal(first.state.lines.length, 4);
  assert.ok(first.state.lines.every((line) => line.status === 'unknown'));
  assert.equal(first.report.flags.filter((flag) => flag.type === 'submit-unconfirmed').length, 4);

  // 第二次：通道恢复，但台账已有这些业务标识 → 绝不自动重发
  state = await loadLedger(stateDir);
  const second = await runPass(state, client);
  await saveLedger(stateDir, state);
  assert.equal(second.submitted.length, 0);
  const calls = await (await fetch(`${base}/_source_calls`)).json();
  assert.equal(calls.filter((call) => call.method === 'POST' && call.path === '/accounting/submit').length, 0);
});

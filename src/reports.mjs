// 报告：项目账单追溯、采样缺口补领、待核/未归属、关账对账。

import { formatTs, overlaps, periodOf } from './model.mjs';

const intervalOf = (segment) => [formatTs(segment.from), formatTs(segment.until)];

// 项目账单 → 调度与网关原始依据
export function buildBills(state) {
  const bills = {};
  for (const line of state.lines) {
    const bill = (bills[line.project] ??= { lines: [], submittedAmount: 0, clearedAmount: 0 });
    const signed = line.direction === 'credit' ? -line.amount : line.amount;
    bill.lines.push({
      businessId: line.businessId,
      kind: line.kind,
      direction: line.direction,
      scope: line.scope,
      slot: line.slot,
      sourceInterval: line.sourceInterval,
      seconds: line.seconds,
      rate: line.rate,
      amount: signed,
      status: line.status,
      adjusts: line.adjusts ?? null,
      evidence: line.evidence,
    });
    bill.submittedAmount += signed;
    if (line.status === 'cleared') bill.clearedAmount += signed;
  }
  return bills;
}

// 采样缺口 → 需要向谁补领哪些边界读数、哪些账期可能受影响
export function buildRequisitions({ held, unattributed, missing, lines }) {
  const items = [];
  for (const entry of [...held, ...unattributed]) {
    if (!entry.neededReadings?.length) continue;
    const segment = entry.segment;
    items.push({
      pool: segment.pool,
      slot: segment.slot,
      sourceInterval: intervalOf(segment),
      neededReadings: entry.neededReadings,
      reason: entry.reason ?? entry.attribution?.status ?? 'unknown',
      affectedPeriods: [...new Set([periodOf(segment.from), periodOf(segment.until - 1)])],
      note: '段横跨切卡/账期边界且无分界读数，需向该机房计量网关补领边界读数后才能入账',
    });
  }
  for (const gap of missing) {
    const affectedLines = lines.filter(
      (line) =>
        line.pool === gap.pool &&
        line.sourceInterval &&
        overlaps(Date.parse(line.sourceInterval[0]), Date.parse(line.sourceInterval[1]), gap.from, gap.until),
    );
    items.push({
      pool: gap.pool,
      missingWindow: [formatTs(gap.from), formatTs(gap.until)],
      affectedLines: affectedLines.map((line) => line.businessId),
      affectedPeriods: [
        ...new Set([...affectedLines.map((line) => line.period), periodOf(gap.from), periodOf(gap.until - 1)]),
      ],
      note: '网关声明采样缺段：涉及该机房上述账期，需向网关补领缺段内边界读数',
    });
  }
  return items;
}

export function buildReport({ state, plan, missing, resets, anomalies, unmatchedAcks, windows, segments, submitted }) {
  const currentKeys = new Set(segments.map((segment) => segment.key));
  // 已提交行的计量依据当前无法从网关复现（断档/迟到读数未补齐）：以提交时快照对账
  const divergences = state.lines
    .filter((line) => line.kind === 'charge' && !currentKeys.has(line.segmentKey))
    .map((line) => ({
      businessId: line.businessId,
      segmentKey: line.segmentKey,
      note: '提交时的逐卡计量依据当前无法从网关复现，按提交快照继续对账，待边界读数补齐后复核',
    }));

  const byStatus = (status) => state.lines.filter((line) => line.status === status).map((line) => line.businessId);

  return {
    generatedAt: new Date().toISOString(),
    submittedThisPass: submitted.map((line) => ({
      businessId: line.businessId,
      kind: line.kind,
      direction: line.direction,
      scope: line.scope,
      project: line.project,
      amount: line.direction === 'credit' ? -line.amount : line.amount,
      status: line.status,
    })),
    bills: buildBills(state),
    requisitions: buildRequisitions({ held: plan.held, unattributed: plan.unattributed, missing, lines: state.lines }),
    review: {
      unattributed: plan.unattributed.map((entry) => ({
        segmentKey: entry.segment.key,
        pool: entry.segment.pool,
        slot: entry.segment.slot,
        sourceInterval: intervalOf(entry.segment),
        seconds: entry.segment.seconds,
        reason: entry.attribution.status,
        cuts: entry.attribution.cuts ?? [],
        neededReadings: entry.neededReadings,
      })),
      held: plan.held.map((entry) => ({
        segmentKey: entry.segment.key,
        pool: entry.segment.pool,
        slot: entry.segment.slot,
        sourceInterval: intervalOf(entry.segment),
        seconds: entry.segment.seconds,
        project: entry.attribution?.project ?? null,
        reason: entry.reason,
        overlap: entry.overlap ?? null,
        neededReadings: entry.neededReadings ?? [],
      })),
      nonBillableEvidence: state.evidence,
      counterResets: resets.map((reset) => ({
        ...reset,
        from: formatTs(reset.from),
        until: formatTs(reset.until),
        note: '设备重启计数清零，交界窗口内占用不可计量',
      })),
      anomalies,
    },
    reconciliation: {
      cleared: byStatus('cleared'),
      receivedOnly: byStatus('received'),
      pending: byStatus('submitted'),
      unknown: byStatus('unknown'),
      unmatchedAcks,
      divergences,
      closingScopes: windows.close,
      adjustmentTarget: windows.adjustmentTarget,
      note: 'received 仅确认接收方看到请求，只有 cleared 才算关账/已调整；未确认行不擅自重发',
    },
    flags: plan.flags,
  };
}

// 计费规划。
// 只有同一代次差分得出、且稳定归属到某个项目的占用段才进入账务；
// 业务标识由计量依据确定性生成，运行重试不会重复扣收；
// 已确认行的归属更正在允许冲回的结算期生成成对调整（一借一贷），
// 未确认行不擅自调整、不重发，先与财务确认。

import { formatTs, monthBoundariesInside, periodOfSegment } from './model.mjs';

const sanitize = (value) => value.replaceAll(/[:.]/g, '');

export function makeCharge(segment, attribution, period, rate, job) {
  const businessId = sanitize(
    `chg_${segment.pool}_${segment.slot}_g${segment.generation}_${formatTs(segment.from)}_${formatTs(segment.until)}_${attribution.project}`,
  );
  return {
    businessId,
    kind: 'charge',
    direction: 'charge',
    scope: `${segment.pool}:${period}`,
    pool: segment.pool,
    period,
    project: attribution.project,
    slot: segment.slot,
    generation: segment.generation,
    sourceInterval: [formatTs(segment.from), formatTs(segment.until)],
    seconds: segment.seconds,
    rate,
    amount: segment.seconds * rate,
    segmentKey: segment.key,
    evidence: {
      metering: segment.meteringPath,
      samples: segment.samples,
      assignments: attribution.assignmentIds,
      attempt: attribution.attempt,
      job: job?.job ?? null,
      migration: job?.migration ?? null,
    },
    status: 'new',
  };
}

// 成对调整：原项目冲回（credit）+ 新项目补记（charge），指向原行业务标识，
// 进入允许冲回的结算期（windows.adjustmentTarget），原已接收账单保持可对账。
export function makeAdjustmentPair(line, attribution, windows) {
  const target = windows.adjustmentTarget;
  const pairId = sanitize(`adj_${line.businessId}_to_${attribution.project}`);
  const common = {
    kind: 'adjustment',
    adjusts: line.businessId,
    pool: line.pool,
    period: target,
    scope: `${line.pool}:${target}`,
    slot: line.slot,
    generation: line.generation,
    sourceInterval: line.sourceInterval,
    seconds: line.seconds,
    rate: line.rate,
    amount: line.amount,
    segmentKey: line.segmentKey,
    evidence: {
      ...line.evidence,
      correction: { assignments: attribution.assignmentIds, previousProject: line.project },
    },
    status: 'new',
  };
  return [
    { ...common, businessId: `${pairId}_credit`, direction: 'credit', project: line.project },
    { ...common, businessId: `${pairId}_charge`, direction: 'charge', project: attribution.project },
  ];
}

export function planBilling({ segments, attributions, contested, jobs, rates, windows, ledger }) {
  const jobsByAttempt = new Map(jobs.map((job) => [job.attempt, job]));
  const jobsBySlot = new Map(jobs.map((job) => [job.slot, job]));
  const charges = [];
  const adjustments = [];
  const held = [];
  const unattributed = [];
  const nonBillable = [];
  const flags = [];

  for (const segment of segments) {
    const attribution = attributions.get(segment.key);
    const period = periodOfSegment(segment.from, segment.until);

    // 跨账期且没有边界读数：不按时间随意拆，挂起并列出缺失的分界读数
    if (!period) {
      held.push({
        segment,
        attribution,
        reason: 'cross-period',
        neededReadings: monthBoundariesInside(segment.from, segment.until).map(formatTs),
      });
      continue;
    }

    if (attribution.status !== 'attributed') {
      const job = jobsBySlot.get(segment.slot);
      if (attribution.status === 'no-slice' && job && job.billable === false) {
        // 失败且按规则不收费的尝试：保有消耗凭据，不计费
        nonBillable.push({ segment, attribution, project: job.project, attempt: job.attempt, reason: 'non-billable-attempt' });
      } else {
        unattributed.push({
          segment,
          attribution,
          neededReadings: (attribution.cuts ?? []).map((cut) => formatTs(cut.at)),
        });
      }
      continue;
    }

    const job = jobsByAttempt.get(attribution.attempt);
    if (job && job.billable === false) {
      nonBillable.push({ segment, attribution, project: attribution.project, attempt: attribution.attempt, reason: 'non-billable-attempt' });
      continue;
    }

    // 未经许可的同时占用：保留双池凭据待核
    if (contested.has(segment.key)) {
      held.push({ segment, attribution, reason: 'unpermitted-overlap', overlap: contested.get(segment.key) });
      continue;
    }

    const existing = ledger.lines.filter((line) => line.segmentKey === segment.key && line.kind === 'charge');
    if (existing.length) {
      const line = existing[0];
      if (line.project !== attribution.project) {
        if (line.status === 'cleared' || line.status === 'received') {
          // 已确认行的归属更正：成对调整进入允许冲回的结算期
          const pair = makeAdjustmentPair(line, attribution, windows);
          adjustments.push(...pair.filter((entry) => !ledger.lines.some((known) => known.businessId === entry.businessId)));
        } else {
          flags.push({
            type: 'attribution-changed-unconfirmed',
            businessId: line.businessId,
            segmentKey: segment.key,
            fromProject: line.project,
            toProject: attribution.project,
            message: '归属更正涉及接收方尚未确认的行：先与财务确认，不擅自调整或重发',
          });
        }
      }
      continue; // 同段已有计费行：运行重试不重复扣收
    }

    charges.push(makeCharge(segment, attribution, period, rates[segment.pool], job));
  }

  return { charges, adjustments, held, unattributed, nonBillable, flags };
}

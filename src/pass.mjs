// 单次对账 pass：抓取快照 → 计量成段 → 归属 → 并跑判定 → 计费规划 →
// 提交（幂等）→ 回执对账 → 生成报告并落台账。

import { fetchSnapshot } from './client.mjs';
import { normalizeRecords, buildSegments } from './metering.mjs';
import { buildTimelines, attributeSegment } from './attribution.mjs';
import { findContested } from './overlap.mjs';
import { planBilling } from './billing.mjs';
import { hasLine, reconcileAcks } from './ledger.mjs';
import { formatTs, parseTs } from './model.mjs';
import { buildReport } from './reports.mjs';

export async function runPass(state, client, { submit = true } = {}) {
  const snapshot = await fetchSnapshot(client);

  const anomalies = [];
  const segments = [];
  const resets = [];
  const missing = [];
  for (const [pool, data] of Object.entries(snapshot.metering)) {
    const normalized = normalizeRecords(pool, data.path, data.records);
    anomalies.push(...normalized.anomalies);
    const built = buildSegments(normalized.records);
    segments.push(...built.segments);
    resets.push(...built.resets);
    anomalies.push(...built.anomalies);
    for (const [from, until] of data.missing ?? []) {
      missing.push({ pool, from: parseTs(from), until: parseTs(until) });
    }
  }

  const timelines = buildTimelines(snapshot.assignments);
  const attributions = new Map();
  for (const segment of segments) {
    attributions.set(segment.key, attributeSegment(segment, timelines.get(segment.slot) ?? []));
  }

  const jobsBySlot = new Map(snapshot.jobs.map((job) => [job.slot, job]));
  const attemptOf = (segment) =>
    attributions.get(segment.key)?.attempt ?? jobsBySlot.get(segment.slot)?.attempt ?? null;
  const contested = findContested(segments, attemptOf, snapshot.jobs, snapshot.permits);

  const plan = planBilling({
    segments,
    attributions,
    contested,
    jobs: snapshot.jobs,
    rates: snapshot.rates,
    windows: snapshot.windows,
    ledger: state,
  });

  // 提交计费与调整行。业务标识确定性生成，已存在的行绝不重发。
  const submitted = [];
  for (const line of [...plan.charges, ...plan.adjustments]) {
    if (hasLine(state, line.businessId)) continue;
    if (submit) {
      try {
        const result = await client.submit(line);
        line.status = result.httpStatus === 202 ? 'submitted' : 'unknown';
        if (line.status !== 'submitted') {
          plan.flags.push({
            type: 'submit-unexpected-status',
            businessId: line.businessId,
            httpStatus: result.httpStatus,
            message: '提交返回异常状态：按未确认处理，与财务确认前不重发',
          });
        }
      } catch (error) {
        line.status = 'unknown';
        plan.flags.push({
          type: 'submit-unconfirmed',
          businessId: line.businessId,
          message: `提交结果不明（${error.message}）：与财务确认前不重发`,
        });
      }
    }
    state.lines.push(line);
    submitted.push(line);
  }

  const unmatchedAcks = reconcileAcks(state, snapshot.acks);

  // 非计费消耗凭据（失败/不收费尝试），按段去重留存
  for (const entry of plan.nonBillable) {
    if (state.evidence.some((known) => known.segmentKey === entry.segment.key)) continue;
    state.evidence.push({
      segmentKey: entry.segment.key,
      pool: entry.segment.pool,
      slot: entry.segment.slot,
      sourceInterval: [formatTs(entry.segment.from), formatTs(entry.segment.until)],
      seconds: entry.segment.seconds,
      project: entry.project,
      attempt: entry.attempt,
      reason: entry.reason,
      samples: entry.segment.samples,
    });
  }

  const report = buildReport({
    state,
    plan,
    missing,
    resets,
    anomalies,
    unmatchedAcks,
    windows: snapshot.windows,
    segments,
    submitted,
  });
  state.lastReport = report;
  return { state, report, submitted };
}

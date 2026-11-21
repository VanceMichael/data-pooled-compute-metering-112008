// 演练：启动本地来源，按 live → split → gap → close → late → replay 推进，
// 每个阶段跑一次对账 pass，展示账单、缺口补领、待核与关账对账的演化。

import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource } from '../sources/source.mjs';
import { createClient } from '../src/client.mjs';
import { loadLedger, saveLedger } from '../src/ledger.mjs';
import { runPass } from '../src/pass.mjs';

const server = createSource();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const stateDir = mkdtempSync(join(tmpdir(), 'metering-demo-'));
const client = createClient(base);

const line = (entry) =>
  `    ${entry.businessId}  ${entry.direction} ${entry.project} ${entry.amount}分  [${entry.scope}] ${entry.status}`;

for (const step of ['live', 'split', 'gap', 'close', 'late', 'replay']) {
  await fetch(`${base}/_source_clock?step=${step}`, { method: 'PUT' });
  const state = await loadLedger(stateDir);
  const { report } = await runPass(state, client);
  await saveLedger(stateDir, state);

  console.log(`\n=== 阶段 ${step} ===`);
  console.log(`  本阶段提交 ${report.submittedThisPass.length} 行：`);
  for (const entry of report.submittedThisPass) console.log(line(entry));
  if (report.requisitions.length) {
    console.log('  待补领边界读数：');
    for (const item of report.requisitions) {
      console.log(
        `    机房 ${item.pool}${item.slot ? ` 槽位 ${item.slot}` : ''} 缺 ${JSON.stringify(item.neededReadings ?? item.missingWindow)} 影响账期 ${item.affectedPeriods.join('/')}`,
      );
    }
  }
  if (report.review.held.length) {
    console.log('  挂起待核（保留双池凭据，不擅自计费）：');
    for (const held of report.review.held) {
      console.log(`    ${held.segmentKey} ${held.seconds}s 项目 ${held.project ?? '?'} 原因 ${held.reason}`);
    }
  }
  if (report.review.unattributed.length) {
    console.log('  未归属用量（横跨切卡无分界凭据，不按时间硬拆）：');
    for (const entry of report.review.unattributed) {
      console.log(`    ${entry.segmentKey} ${entry.seconds}s 缺分界读数 ${JSON.stringify(entry.neededReadings)}`);
    }
  }
  if (report.flags.length) {
    console.log('  财务标记：');
    for (const flag of report.flags) console.log(`    [${flag.type}] ${flag.businessId}: ${flag.message}`);
  }
  const recon = report.reconciliation;
  console.log(
    `  关账对账：cleared=${recon.cleared.length} received=${recon.receivedOnly.length} pending=${recon.pending.length} unknown=${recon.unknown.length}`,
  );
}

const finalState = await loadLedger(stateDir);
const finalReport = finalState.lastReport;
console.log('\n=== 项目账单（可追到调度与网关原始依据） ===');
for (const [project, bill] of Object.entries(finalReport.bills)) {
  console.log(`  ${project}: 已提交 ${bill.submittedAmount}分, 已关账 ${bill.clearedAmount}分`);
  for (const entry of bill.lines) {
    const correction = entry.evidence.correction
      ? ` 更正登记${JSON.stringify(entry.evidence.correction.assignments)}`
      : '';
    console.log(
      `    ${entry.businessId} ${entry.direction} ${entry.amount}分 ${entry.status} 依据: ${entry.evidence.metering} ${entry.slot} g${finalState.lines.find((l) => l.businessId === entry.businessId).generation} 采样${JSON.stringify(entry.evidence.samples)} 登记${JSON.stringify(entry.evidence.assignments)}${correction}${entry.adjusts ? ` 调整自${entry.adjusts}` : ''}`,
    );
  }
}
console.log('\n=== 非计费消耗凭据（失败/不收费尝试） ===');
for (const evidence of finalReport.review.nonBillableEvidence) {
  console.log(`    ${evidence.segmentKey} ${evidence.seconds}s 项目 ${evidence.project} 尝试 ${evidence.attempt} (${evidence.reason})`);
}

server.close();

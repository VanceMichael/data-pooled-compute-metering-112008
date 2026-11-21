// 本地台账：提交行（含提交时的逐卡计量依据快照）、非计费消耗凭据、最近一次报告。
// 接收方按自己的批次项确认（acks），只有 cleared 才算关账/已调整；
// received 仅表示接收方看到请求。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const emptyLedger = () => ({ version: 1, lines: [], evidence: [], lastReport: null });

export async function loadLedger(dir) {
  try {
    const raw = await readFile(join(dir, 'ledger.json'), 'utf8');
    const state = JSON.parse(raw);
    state.lines ??= [];
    state.evidence ??= [];
    state.lastReport ??= null;
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return emptyLedger();
    throw error;
  }
}

export async function saveLedger(dir, state) {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `ledger.json.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, join(dir, 'ledger.json'));
}

export const hasLine = (state, businessId) => state.lines.some((line) => line.businessId === businessId);

// 回执对账：按 scope+project（可精确到 slot 与 sourceInterval）匹配本台提交行。
// cleared 不被 received 降级。返回未能匹配的回执（需人工核对）。
export function reconcileAcks(state, acks) {
  const unmatched = [];
  for (const ack of acks) {
    const matches = state.lines.filter(
      (line) =>
        line.scope === ack.scope &&
        line.project === ack.project &&
        (ack.slot === undefined || line.slot === ack.slot) &&
        (ack.sourceInterval === undefined ||
          (line.sourceInterval &&
            line.sourceInterval[0] === ack.sourceInterval[0] &&
            line.sourceInterval[1] === ack.sourceInterval[1])),
    );
    if (!matches.length) {
      unmatched.push(ack);
      continue;
    }
    for (const line of matches) {
      if (ack.status === 'cleared') line.status = 'cleared';
      else if (line.status !== 'cleared') line.status = 'received';
    }
  }
  return unmatched;
}

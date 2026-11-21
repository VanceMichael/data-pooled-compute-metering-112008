// 计量网关采样处理。
// 网关按槽位和计数器代次给出“从代次开始累计的占用秒”；设备重启换代次清零。
// 部分采样会重复或迟到：同槽同代次同时刻只留一份，全部按时刻重排。

import { formatTs, parseTs } from './model.mjs';

export function normalizeRecords(pool, meteringPath, records) {
  const byKey = new Map();
  const anomalies = [];
  for (const raw of records) {
    const key = `${raw.slot}|${raw.generation}|${raw.at}`;
    const seen = byKey.get(key);
    if (seen) {
      if (seen.seconds !== raw.seconds) {
        anomalies.push({
          type: 'conflicting-sample',
          pool,
          slot: raw.slot,
          generation: raw.generation,
          at: raw.at,
          keptSeconds: seen.seconds,
          droppedSeconds: raw.seconds,
        });
      }
      continue; // 重复采样去重
    }
    byKey.set(key, {
      pool,
      meteringPath,
      slot: raw.slot,
      generation: raw.generation,
      at: parseTs(raw.at),
      atRaw: raw.at,
      seconds: raw.seconds,
    });
  }
  const sorted = [...byKey.values()].sort(
    (a, b) => a.slot.localeCompare(b.slot) || a.generation - b.generation || a.at - b.at,
  );
  return { records: sorted, anomalies };
}

// 只有同一代次内的相邻采样才能差分成段；跨代次（设备重启清零）不得差分。
export function buildSegments(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.slot}|${record.generation}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const segments = [];
  const anomalies = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.at - b.at);
    for (let index = 1; index < list.length; index += 1) {
      const before = list[index - 1];
      const after = list[index];
      const seconds = after.seconds - before.seconds;
      if (seconds < 0) {
        anomalies.push({
          type: 'counter-regression',
          slot: before.slot,
          generation: before.generation,
          from: before.atRaw,
          until: after.atRaw,
        });
        continue;
      }
      if (seconds === 0) continue; // 无占用增量：空闲等待不计费
      segments.push({
        key: `${before.slot}|${before.generation}|${formatTs(before.at)}|${formatTs(after.at)}`,
        pool: before.pool,
        meteringPath: before.meteringPath,
        slot: before.slot,
        generation: before.generation,
        from: before.at,
        until: after.at,
        seconds,
        samples: [
          { at: before.atRaw, seconds: before.seconds },
          { at: after.atRaw, seconds: after.seconds },
        ],
      });
    }
  }

  // 代次交界：设备重启清零，交界窗口内的占用无法计量，单独记录。
  const resets = [];
  const bySlot = new Map();
  for (const record of records) {
    if (!bySlot.has(record.slot)) bySlot.set(record.slot, new Map());
    const generations = bySlot.get(record.slot);
    if (!generations.has(record.generation)) generations.set(record.generation, []);
    generations.get(record.generation).push(record);
  }
  for (const [slot, generations] of bySlot) {
    const ordered = [...generations.entries()]
      .map(([generation, list]) => ({
        generation,
        first: Math.min(...list.map((record) => record.at)),
        last: Math.max(...list.map((record) => record.at)),
      }))
      .sort((a, b) => a.first - b.first);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const next = ordered[index];
      if (previous.last < next.first) {
        resets.push({
          slot,
          fromGeneration: previous.generation,
          toGeneration: next.generation,
          from: previous.last,
          until: next.first,
        });
      }
    }
  }
  return { segments, resets, anomalies };
}

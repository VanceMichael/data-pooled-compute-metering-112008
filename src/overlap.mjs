// 迁移并跑许可判定。
// 同一迁移组内不同尝试的实际占用在时间上重叠时，只有被调度许可窗口完整覆盖的
// 重叠才允许双侧同时计费；未经许可又确实同时占用的段，双侧都保留凭据待核，
// 不擅自只向一池计费。段不可再分（无分界凭据），因此整段挂起。

import { intersection, parseTs } from './model.mjs';

export function findContested(segments, attemptOf, jobs, permits) {
  const jobByAttempt = new Map(jobs.map((job) => [job.attempt, job]));
  const permitWindows = new Map(); // migration → [{from, until, attempts}]
  for (const permit of permits) {
    const list = permitWindows.get(permit.migration) ?? [];
    list.push({
      from: parseTs(permit.effectiveFrom),
      until: parseTs(permit.effectiveUntil),
      attempts: new Set(permit.attempts),
    });
    permitWindows.set(permit.migration, list);
  }

  const byMigration = new Map(); // migration → [{segment, attempt}]
  for (const segment of segments) {
    const attempt = attemptOf(segment);
    if (!attempt) continue;
    const job = jobByAttempt.get(attempt);
    if (!job?.migration) continue;
    if (!byMigration.has(job.migration)) byMigration.set(job.migration, []);
    byMigration.get(job.migration).push({ segment, attempt, migration: job.migration });
  }

  const contested = new Map(); // segmentKey → {migration, attempt, overlaps:[...]}
  for (const [migration, list] of byMigration) {
    const windows = permitWindows.get(migration) ?? [];
    for (let left = 0; left < list.length; left += 1) {
      for (let right = left + 1; right < list.length; right += 1) {
        const a = list[left];
        const b = list[right];
        if (a.attempt === b.attempt) continue;
        const hit = intersection(a.segment.from, a.segment.until, b.segment.from, b.segment.until);
        if (!hit) continue;
        const permitted = windows.some(
          (window) =>
            window.attempts.has(a.attempt) &&
            window.attempts.has(b.attempt) &&
            window.from <= hit[0] &&
            hit[1] <= window.until,
        );
        if (permitted) continue;
        for (const [self, other] of [[a, b], [b, a]]) {
          const entry = contested.get(self.segment.key) ?? { migration, attempt: self.attempt, overlaps: [] };
          entry.overlaps.push({
            withSegment: other.segment.key,
            withAttempt: other.attempt,
            withPool: other.segment.pool,
            from: hit[0],
            until: hit[1],
          });
          contested.set(self.segment.key, entry);
        }
      }
    }
  }
  return contested;
}

// 切分登记归属。
// 同一槽位可被多次切分：同一基本区间内 effectiveFrom 晚的登记覆盖早的；
// revises 更正只替换其指向的那条登记在其窗口内的归属。
// 段内项目唯一才算“稳定归属”；段横跨项目变化的切点且没有分界读数时，
// 不得按时间随意拆，按未归属用量单独报告。

import { overlaps, parseTs } from './model.mjs';

export function buildTimelines(assignments) {
  const bySlot = new Map();
  for (const raw of assignments) {
    const entry = { ...raw, from: parseTs(raw.effectiveFrom), until: parseTs(raw.effectiveUntil) };
    if (!bySlot.has(entry.slot)) bySlot.set(entry.slot, []);
    bySlot.get(entry.slot).push(entry);
  }
  const timelines = new Map();
  for (const [slot, list] of bySlot) {
    const cuts = [...new Set(list.flatMap((entry) => [entry.from, entry.until]))].sort((a, b) => a - b);
    const pieces = [];
    for (let index = 1; index < cuts.length; index += 1) {
      const from = cuts[index - 1];
      const until = cuts[index];
      const covering = list.filter((entry) => entry.from <= from && entry.until >= until);
      const base = covering.filter((entry) => !entry.revises);
      const revisions = covering.filter((entry) => entry.revises);

      let winner = null;
      let tied = [];
      for (const entry of base) {
        if (!winner || entry.from > winner.from) {
          winner = entry;
          tied = [entry];
        } else if (entry.from === winner.from) {
          tied.push(entry);
        }
      }
      let ambiguous = null;
      if (tied.length > 1 && new Set(tied.map((entry) => entry.project)).size > 1) {
        ambiguous = tied.map((entry) => entry.id);
      }
      // 更正仅在其窗口内替换其指向的登记
      for (const revision of revisions) {
        if (winner && revision.revises === winner.id) {
          winner = revision;
          ambiguous = null;
        }
      }
      pieces.push(ambiguous ? { from, until, ambiguous } : { from, until, assignment: winner });
    }
    timelines.set(slot, pieces);
  }
  return timelines;
}

// 判定一个计量段的归属。返回：
//  { status: 'attributed', project, attempt, assignmentIds }
//  { status: 'spans-cut', cuts, attempt?, assignmentIds }  段内项目发生变化，缺分界读数
//  { status: 'ambiguous', cuts }                           登记本身冲突
//  { status: 'no-slice' }                                  段内无（或部分无）切分登记
export function attributeSegment(segment, pieces) {
  const covering = pieces
    .filter((piece) => overlaps(piece.from, piece.until, segment.from, segment.until))
    .sort((a, b) => a.from - b.from);
  if (!covering.length) return { status: 'no-slice' };

  const cuts = [];
  const assignmentIds = new Set();
  const attempts = new Set();
  let current = null;
  let coveredUntil = segment.from;
  let hasGap = false;

  for (const piece of covering) {
    if (piece.from > coveredUntil) hasGap = true; // 段中间存在无登记空白
    coveredUntil = Math.max(coveredUntil, piece.until);
    if (piece.ambiguous) {
      cuts.push({ at: piece.from, kind: 'ambiguous', assignments: piece.ambiguous });
      continue;
    }
    const project = piece.assignment ? piece.assignment.project : null;
    const attempt = piece.assignment ? piece.assignment.attempt : null;
    if (piece.assignment) {
      assignmentIds.add(piece.assignment.id);
      if (attempt) attempts.add(attempt);
    }
    if (!current) {
      current = { project };
    } else if (current.project !== project) {
      cuts.push({
        at: Math.max(piece.from, segment.from),
        kind: 'project-change',
        fromProject: current.project,
        toProject: project,
      });
      current = { project };
    }
  }
  if (covering[0].from > segment.from || covering[covering.length - 1].until < segment.until) {
    hasGap = true;
  }

  const attempt = attempts.size === 1 ? [...attempts][0] : null;
  if (cuts.length) return { status: cuts[0].kind === 'ambiguous' ? 'ambiguous' : 'spans-cut', cuts, attempt, assignmentIds: [...assignmentIds] };
  if (hasGap || !current || !current.project) return { status: 'no-slice', attempt };
  return { status: 'attributed', project: current.project, attempt, assignmentIds: [...assignmentIds] };
}

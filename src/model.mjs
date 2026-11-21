// 时间与区间工具。所有采样窗口、切分登记、许可窗口均为 UTC 半开区间 [from, until)。

export const parseTs = (value) => {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`无法解析的时间: ${value}`);
  return ms;
};

export const formatTs = (ms) => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');

export const overlaps = (aFrom, aUntil, bFrom, bUntil) => aFrom < bUntil && bFrom < aUntil;

export const intersection = (aFrom, aUntil, bFrom, bUntil) => {
  if (!overlaps(aFrom, aUntil, bFrom, bUntil)) return null;
  return [Math.max(aFrom, bFrom), Math.min(aUntil, bUntil)];
};

export const contains = (outerFrom, outerUntil, innerFrom, innerUntil) =>
  outerFrom <= innerFrom && innerUntil <= outerUntil;

// 结算期：UTC 月，形如 2026-11
export const periodOf = (ms) => new Date(ms).toISOString().slice(0, 7);

// 段归属的结算期：半开区间完全落在同一 UTC 月内才返回期号；
// 跨期（内部含月界且没有边界读数把段拆开）返回 null，调用方不得按时间随意拆段。
export function periodOfSegment(from, until) {
  if (until <= from) return null;
  const start = periodOf(from);
  return periodOf(until - 1) === start ? start : null;
}

// (from, until) 内部的 UTC 月界时刻，即跨期段缺失的分界读数时刻
export function monthBoundariesInside(from, until) {
  const out = [];
  const cursor = new Date(from);
  cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);
  if (cursor.getTime() <= from) cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  while (cursor.getTime() < until) {
    out.push(cursor.getTime());
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

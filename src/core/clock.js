// 可注入的时间源。
// 内核里所有跟时间有关的判断都走这里，测试时才能把时间钉死。
// 真实环境：createClock() —— 用系统时间。
// 测试环境：createFixedClock('2026-09-23T21:00:00+08:00') —— 想拨到几点就几点。

export function createClock(nowFn = () => Date.now()) {
  return {
    now: () => nowFn(),
    date: () => new Date(nowFn()),
    /** 本地时间的小时（0-23） */
    hour: () => new Date(nowFn()).getHours(),
    /** yyyy-mm-dd，用来按天限流、按天决定天气 */
    ymd() {
      const d = new Date(nowFn());
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    },
  };
}

export function createFixedClock(start) {
  let t = typeof start === 'number' ? start : new Date(start).getTime();
  const c = createClock(() => t);
  c.set = v => { t = typeof v === 'number' ? v : new Date(v).getTime(); };
  c.advance = ms => { t += ms; };
  return c;
}

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** "09:30" -> 570（当天第几分钟）。解析不了就返回 null。 */
export function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** 判断 minutes 是否落在 [from, to) 区间里，支持跨零点（22:00–07:00）。 */
export function inWindow(minutes, from, to) {
  const a = parseHM(from), b = parseHM(to);
  if (a === null || b === null) return false;
  if (a === b) return false;             // 空区间
  if (a < b) return minutes >= a && minutes < b;
  return minutes >= a || minutes < b;    // 跨零点
}

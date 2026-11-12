import { offsetDay, shiftDateMonth } from './arrangeCore';

export interface RepeatRule {
 unit: 'day' | 'week' | 'month' | 'year';
 interval: number;
 anchor: string;
 weekdays?: number[];
}
export interface RepeatCompletion {
 id: string;
 date: string | null;
 completed_at: string;
 title: string;
 body: string;
 parent: string | null;
 reward_points: number;
 reward_awarded: number;
 archived?: boolean;
}
export function validDate(value: unknown): value is string {
 return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value+'T12:00:00Z')) && new Date(value+'T12:00:00Z').toISOString().slice(0,10) === value;
}
export function repeatRule(value: unknown): RepeatRule | null {
 if (value === null || value === undefined) return null;
 const r = value as RepeatRule;
 if (!['day','week','month','year'].includes(r.unit) || !Number.isSafeInteger(r.interval) || r.interval < 1 || !validDate(r.anchor))
  throw Error('重复间隔须为正整数，并选择日期');
 if (r.weekdays !== undefined && (r.unit !== 'week' || !Array.isArray(r.weekdays) || !r.weekdays.length
  || r.weekdays.some(n => !Number.isInteger(n) || n < 0 || n > 6))) throw Error('请选择重复的星期');
 return { unit:r.unit, interval:r.interval, anchor:r.anchor, ...(r.weekdays ? {weekdays:[...new Set(r.weekdays)].sort()} : {}) };
}
/** The anchor is persistent cadence state, not a field the rule dialog edits. */
export function sameRepeatCadence(a: RepeatRule | null, b: RepeatRule | null): boolean {
 if (!a || !b) return a === b;
 if (a.unit !== b.unit || a.interval !== b.interval) return false;
 if (a.unit !== 'week') return true;
 const days = (r: RepeatRule) => (r.weekdays ?? [new Date(r.anchor+'T12:00:00Z').getUTCDay()]).join(',');
 return days(a) === days(b);
}
/** The scheduled day drives progression, never the wall-clock completion time. */
export function nextRepeatDate(day: string, rule: RepeatRule): string {
 let next: string;
 if (rule.unit === 'week' && rule.weekdays) {
  const anchorWeek = offsetDay(rule.anchor, -((new Date(rule.anchor+'T12:00:00Z').getUTCDay()+6)%7));
  const week = offsetDay(day, -((new Date(day+'T12:00:00Z').getUTCDay()+6)%7));
  const weeks = Math.round((Date.parse(week+'T12:00:00Z')-Date.parse(anchorWeek+'T12:00:00Z'))/604800000);
  const ordered = [...rule.weekdays].sort((a,b)=>(a+6)%7-(b+6)%7);
  const current = ordered.map(n=>offsetDay(week,(n+6)%7)).find(date=>date>day);
  const remainder = ((weeks%rule.interval)+rule.interval)%rule.interval;
  next = remainder===0 && current ? current : offsetDay(week,(rule.interval-remainder)*7+(ordered[0]!+6)%7);
 } else if (rule.unit === 'day' || rule.unit === 'week') next = offsetDay(day,rule.interval*(rule.unit==='week'?7:1));
 else {
  const months = rule.interval*(rule.unit==='year'?12:1);
  const distance=(Number(day.slice(0,4))-Number(rule.anchor.slice(0,4)))*12+Number(day.slice(5,7))-Number(rule.anchor.slice(5,7));
  next=shiftDateMonth(rule.anchor,(Math.floor(distance/months)+1)*months);
 }
 if (!validDate(next) || next <= day) throw Error('重复日期超出可用范围，请缩短间隔');
 return next;
}
export function repeatLabel(rule: RepeatRule | null | undefined): string {
 if (!rule) return '不重复';
 if (rule.unit==='week' && rule.weekdays) return `${rule.interval===1?'每周':`每${rule.interval}周`} ${[...rule.weekdays].sort((a,b)=>(a+6)%7-(b+6)%7).map(n=>'一二三四五六日'[(n+6)%7]).join('、')}`;
 return rule.interval===1 ? {day:'每天',week:'每周',month:'每月',year:'每年'}[rule.unit] : `每${rule.interval}${{day:'天',week:'周',month:'个月',year:'年'}[rule.unit]}`;
}
